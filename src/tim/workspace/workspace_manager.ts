import * as fs from 'node:fs/promises';
import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import PQueue from 'p-queue';
import { debugLog, log } from '../../logging.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { getTrunkBranch } from '../../common/git.js';
import { executePostApplyCommand } from '../actions.js';
import type { PostApplyCommand, TimConfig } from '../configSchema.js';
import { WorkspaceLock } from './workspace_lock.js';
import { getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace, setWorkspaceIssues, type WorkspaceType } from '../db/workspace.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { buildDescriptionFromPlan } from '../display_utils.js';
import { readPlanFile } from '../plans.js';
import { findPrimaryWorkspaceForRepository } from './workspace_info.js';
import type { PlanSchema } from '../planSchema.js';

/**
 * Interface representing a created workspace
 */
export interface Workspace {
  /** Absolute path to the workspace */
  path: string;
  /** Absolute path to the original plan file, if workspace is associated with a plan */
  originalPlanFilePath?: string;
  /** Expected plan file path within the workspace */
  planFilePathInWorkspace?: string;
  /** Unique identifier for the workspace */
  taskId: string;
}

/**
 * Runs configured workspace update commands for an existing workspace.
 */
export async function runWorkspaceUpdateCommands(
  workspacePath: string,
  config: TimConfig,
  taskId: string,
  planFilePath?: string
): Promise<boolean> {
  const updateCommands = config.workspaceCreation?.workspaceUpdateCommands;
  if (!updateCommands?.length) {
    return true;
  }

  log('Running workspace update commands');

  for (const commandConfig of updateCommands) {
    const envVars: Record<string, string> = {
      ...commandConfig.env,
      LLMUTILS_TASK_ID: taskId,
    };
    if (planFilePath) {
      envVars.LLMUTILS_PLAN_FILE_PATH = planFilePath;
    }

    const commandWithEnv: PostApplyCommand = {
      ...commandConfig,
      env: envVars,
    };

    log(`Running workspace update command: "${commandConfig.title || commandConfig.command}"`);
    const success = await executePostApplyCommand(commandWithEnv, workspacePath, false);
    if (!success && !commandConfig.allowFailure) {
      return false;
    }
  }

  return true;
}

const COPY_FILE_CLONE_FLAG = fsConstants?.COPYFILE_FICLONE;

function shouldRetryWithoutClone(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const err = error as NodeJS.ErrnoException;
  if (!err.code) {
    return false;
  }

  return (
    err.code === 'ENOTSUP' ||
    err.code === 'EXDEV' ||
    err.code === 'EINVAL' ||
    err.code === 'ERR_FS_COPYFILE'
  );
}

async function copyFilePreservingMode(
  sourcePath: string,
  destinationPath: string,
  mode: number,
  useCloneFlag: boolean
) {
  if (useCloneFlag && COPY_FILE_CLONE_FLAG !== undefined) {
    try {
      await fs.copyFile(sourcePath, destinationPath, COPY_FILE_CLONE_FLAG);
    } catch (error) {
      if (shouldRetryWithoutClone(error)) {
        debugLog('Falling back to standard copy for', sourcePath, '->', destinationPath);
        await fs.copyFile(sourcePath, destinationPath);
      } else {
        throw error;
      }
    }
  } else {
    await fs.copyFile(sourcePath, destinationPath);
  }

  await fs.chmod(destinationPath, mode);
}

async function collectFilesToCopy(
  sourceDir: string,
  extraGlobs: string[] | undefined
): Promise<string[] | null> {
  const files = new Set<string>();

  const trackedResult = await spawnAndLogOutput(['git', 'ls-files', '-z', '--full-name'], {
    cwd: sourceDir,
    quiet: true,
  });

  if (trackedResult.exitCode !== 0) {
    log(`Failed to list tracked files for workspace copy: ${trackedResult.stderr}`);
    return null;
  }

  for (const entry of trackedResult.stdout.split('\0')) {
    if (entry) {
      files.add(entry);
    }
  }

  if (extraGlobs?.length) {
    const extraResult = await spawnAndLogOutput(
      [
        'git',
        'ls-files',
        '-z',
        '--full-name',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--',
        ...extraGlobs,
      ],
      {
        cwd: sourceDir,
        quiet: true,
      }
    );

    if (extraResult.exitCode !== 0) {
      log(`Failed to resolve copyAdditionalGlobs: ${extraResult.stderr}`);
      return null;
    }

    for (const entry of extraResult.stdout.split('\0')) {
      if (entry) {
        files.add(entry);
      }
    }
  }

  await includeDirectoryTreeIfExists(files, sourceDir, '.git');
  await includeDirectoryTreeIfExists(files, sourceDir, '.jj');

  return Array.from(files).sort();
}

async function copyFilesToTarget(
  sourceDir: string,
  targetPath: string,
  files: string[],
  useCloneFlag: boolean
): Promise<boolean> {
  try {
    await fs.mkdir(targetPath, { recursive: true });
  } catch (error) {
    log(`Failed to create target workspace directory: ${String(error)}`);
    return false;
  }

  const queue = new PQueue({ concurrency: 64 });
  const errors: string[] = [];

  for (const relativePath of files) {
    void queue.add(async () => {
      const sourcePath = path.join(sourceDir, relativePath);
      const destinationPath = path.join(targetPath, relativePath);
      const destinationDir = path.dirname(destinationPath);

      try {
        await fs.mkdir(destinationDir, { recursive: true });
      } catch (error) {
        errors.push(`Failed to create directory ${destinationDir}: ${String(error)}`);
        return;
      }

      let stats;
      try {
        stats = await fs.lstat(sourcePath);
      } catch (error) {
        errors.push(`Failed to stat source file ${relativePath}: ${String(error)}`);
        return;
      }

      try {
        if (stats.isSymbolicLink()) {
          const linkTarget = await fs.readlink(sourcePath);
          await fs.symlink(linkTarget, destinationPath);
        } else if (stats.isDirectory()) {
          await fs.mkdir(destinationPath, { recursive: true });
        } else {
          await copyFilePreservingMode(sourcePath, destinationPath, stats.mode, useCloneFlag);
        }
      } catch (error) {
        errors.push(`Failed to copy ${relativePath}: ${String(error)}`);
      }
    });
  }

  await queue.onIdle();

  if (errors.length > 0) {
    for (const error of errors) {
      log(error);
    }
    return false;
  }

  return true;
}

/**
 * Local config files that should be symlinked instead of copied
 */
const LOCAL_CONFIG_FILES = [
  '.rmfilter/config/tim.local.yml',
  '.rmfilter/config/rmplan.local.yml',
  '.claude/settings.local.json',
];

/**
 * Create symlinks for local config files from source to target directory.
 * Only creates symlinks for files that exist in the source directory.
 */
async function symlinkLocalConfigs(sourceDir: string, targetDir: string): Promise<void> {
  for (const relativePath of LOCAL_CONFIG_FILES) {
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);

    // Check if source file exists
    try {
      await fs.lstat(sourcePath);
    } catch {
      // Source file doesn't exist, skip silently
      continue;
    }

    // Ensure parent directory exists in target
    const targetParentDir = path.dirname(targetPath);
    try {
      await fs.mkdir(targetParentDir, { recursive: true });
    } catch (error) {
      log(`Failed to create directory for symlink ${relativePath}: ${String(error)}`);
      continue;
    }

    // Create symlink pointing to absolute source path
    try {
      await fs.symlink(sourcePath, targetPath);
    } catch (error) {
      log(`Failed to create symlink for ${relativePath}: ${String(error)}`);
    }
  }
}

async function cloneUsingFileList(
  sourceDir: string,
  targetPath: string,
  options: { extraGlobs?: string[]; useCloneFlag: boolean }
): Promise<boolean> {
  const files = await collectFilesToCopy(sourceDir, options.extraGlobs);
  if (!files) {
    return false;
  }

  return copyFilesToTarget(sourceDir, targetPath, files, options.useCloneFlag);
}

async function includeDirectoryTreeIfExists(
  files: Set<string>,
  sourceDir: string,
  directoryName: string
): Promise<void> {
  const fullPath = path.join(sourceDir, directoryName);

  let stats: Stats;
  try {
    stats = await fs.lstat(fullPath);
  } catch {
    return;
  }

  if (stats.isDirectory()) {
    await addDirectoryEntriesToSet(files, sourceDir, directoryName);
    return;
  }

  files.add(directoryName);
}

async function addDirectoryEntriesToSet(
  files: Set<string>,
  baseDir: string,
  relativeDir: string
): Promise<void> {
  files.add(relativeDir);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(baseDir, relativeDir), { withFileTypes: true });
  } catch (error) {
    log(`Failed to read directory ${relativeDir}: ${String(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryRelativePath = path.join(relativeDir, entry.name);
    files.add(entryRelativePath);

    if (entry.isDirectory()) {
      await addDirectoryEntriesToSet(files, baseDir, entryRelativePath);
    }
  }
}

/**
 * Clone using git clone command
 */
async function cloneWithGit(
  repositoryUrl: string,
  targetPath: string,
  mainRepoRoot: string
): Promise<boolean> {
  try {
    log(`Cloning repository ${repositoryUrl} to ${targetPath}`);
    const { exitCode, stderr } = await spawnAndLogOutput(
      ['git', 'clone', repositoryUrl, targetPath],
      {
        cwd: mainRepoRoot,
      }
    );

    if (exitCode !== 0) {
      log(`Failed to clone repository: ${stderr}`);
      return false;
    }

    // Create symlinks for local config files from the main repo
    await symlinkLocalConfigs(mainRepoRoot, targetPath);

    return true;
  } catch (error) {
    log(`Error cloning repository: ${String(error)}`);
    return false;
  }
}

/**
 * Clone using cp command (standard file copy)
 */
async function cloneWithCp(
  sourceDir: string,
  targetPath: string,
  extraGlobs?: string[]
): Promise<boolean> {
  log(`Copying directory ${sourceDir} to ${targetPath}`);

  try {
    const copySuccess = await cloneUsingFileList(sourceDir, targetPath, {
      extraGlobs,
      useCloneFlag: false,
    });

    if (!copySuccess) {
      return false;
    }
  } catch (error) {
    log(`Error copying directory: ${String(error)}`);
    return false;
  }

  // Create symlinks for local config files
  await symlinkLocalConfigs(sourceDir, targetPath);

  const { exitCode: gitInitCode, stderr: gitInitStderr } = await spawnAndLogOutput(
    ['git', 'init'],
    {
      cwd: targetPath,
    }
  );

  if (gitInitCode !== 0) {
    log(`Failed to initialize git repository: ${gitInitStderr}`);
    return false;
  }

  return true;
}

/**
 * Clone using macOS APFS copy-on-write (fastest on compatible systems)
 */
async function cloneWithMacCow(
  sourceDir: string,
  targetPath: string,
  extraGlobs?: string[]
): Promise<boolean> {
  // Check if we're on macOS
  if (os.platform() !== 'darwin') {
    log('mac-cow clone method is only available on macOS');
    return false;
  }

  try {
    log(`Creating APFS copy-on-write clone ${sourceDir} to ${targetPath}`);
    const copySuccess = await cloneUsingFileList(sourceDir, targetPath, {
      extraGlobs,
      useCloneFlag: true,
    });

    if (!copySuccess) {
      log('Falling back to regular copy method');
      return await cloneWithCp(sourceDir, targetPath, extraGlobs);
    }
  } catch (error) {
    log(`Error creating copy-on-write clone: ${String(error)}`);
    // Fall back to regular cp method
    log('Falling back to regular copy method');
    return await cloneWithCp(sourceDir, targetPath, extraGlobs);
  }

  // Create symlinks for local config files
  await symlinkLocalConfigs(sourceDir, targetPath);

  const { exitCode: gitInitCode, stderr: gitInitStderr } = await spawnAndLogOutput(
    ['git', 'init'],
    {
      cwd: targetPath,
    }
  );

  if (gitInitCode !== 0) {
    log(`Failed to initialize git repository: ${gitInitStderr}`);
    return false;
  }

  return true;
}

/**
 * Set up git remote for copied repositories (cp and mac-cow methods)
 */
async function setupGitRemote(targetPath: string, repositoryUrl?: string): Promise<void> {
  if (!repositoryUrl) {
    return;
  }

  try {
    // Check if origin remote already exists
    const { exitCode: checkRemoteCode } = await spawnAndLogOutput(
      ['git', 'remote', 'get-url', 'origin'],
      {
        cwd: targetPath,
      }
    );

    if (checkRemoteCode === 0) {
      // Remote already exists, update it
      const { exitCode, stderr } = await spawnAndLogOutput(
        ['git', 'remote', 'set-url', 'origin', repositoryUrl],
        {
          cwd: targetPath,
        }
      );

      if (exitCode !== 0) {
        log(`Warning: Failed to update git remote: ${stderr}`);
      }
    } else {
      // Add new remote
      const { exitCode, stderr } = await spawnAndLogOutput(
        ['git', 'remote', 'add', 'origin', repositoryUrl],
        {
          cwd: targetPath,
        }
      );

      if (exitCode !== 0) {
        log(`Warning: Failed to add git remote: ${stderr}`);
      }
    }
  } catch (error) {
    log(`Warning: Error setting up git remote: ${String(error)}`);
  }
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  const result = await spawnAndLogOutput(['git', 'rev-parse', '--verify', ref], {
    cwd: repoRoot,
    quiet: true,
  });
  return result.exitCode === 0;
}

async function resolveGitBranchSource(
  repoRoot: string,
  fromBranch: string | undefined
): Promise<string | undefined> {
  if (!fromBranch) {
    return undefined;
  }

  if (await gitRefExists(repoRoot, fromBranch)) {
    return fromBranch;
  }

  const remoteRef = `origin/${fromBranch}`;
  if (await gitRefExists(repoRoot, remoteRef)) {
    return remoteRef;
  }

  return fromBranch;
}

async function commitPlanFileInPrimaryWorkspace(
  repoRoot: string,
  planFilePath: string
): Promise<{ committed: boolean; error?: string }> {
  const relativePlanPath = path.relative(repoRoot, planFilePath);
  if (relativePlanPath.startsWith('..')) {
    return { committed: false };
  }

  const statusResult = await spawnAndLogOutput(
    ['git', 'status', '--porcelain', '--', relativePlanPath],
    {
      cwd: repoRoot,
      quiet: true,
    }
  );
  if (statusResult.exitCode !== 0) {
    return { committed: false, error: statusResult.stderr };
  }
  if (!statusResult.stdout.trim()) {
    return { committed: false };
  }

  const addResult = await spawnAndLogOutput(['git', 'add', '--', relativePlanPath], {
    cwd: repoRoot,
  });
  if (addResult.exitCode !== 0) {
    return { committed: false, error: addResult.stderr };
  }

  const commitResult = await spawnAndLogOutput(
    ['git', 'commit', '-m', 'Update plan file', '--', relativePlanPath],
    {
      cwd: repoRoot,
    }
  );
  if (commitResult.exitCode !== 0) {
    return { committed: false, error: commitResult.stderr };
  }

  return { committed: true };
}

export async function ensurePrimaryWorkspaceBranch(
  mainRepoRoot: string,
  branchName: string,
  options?: {
    planFilePath?: string;
    fromBranch?: string;
  }
): Promise<{ success: boolean; error?: string }> {
  try {
    log(`Creating and pushing branch ${branchName} from primary workspace`);

    let createResult;
    const primaryJjPath = path.join(mainRepoRoot, '.jj');
    let isPrimaryJj = false;
    try {
      const stats = await fs.stat(primaryJjPath);
      isPrimaryJj = stats.isDirectory();
    } catch {
      // Not a jj repository
    }

    if (isPrimaryJj) {
      let targetRevision: string;
      if (options?.fromBranch) {
        targetRevision = options.fromBranch;
      } else {
        // Check if working copy is dirty
        const statusResult = await spawnAndLogOutput(['jj', 'status'], {
          cwd: mainRepoRoot,
          quiet: true,
        });
        if (
          statusResult.exitCode !== 0 ||
          !statusResult.stdout.includes('The working copy has no changes.')
        ) {
          return {
            success: false,
            error:
              'Working copy is dirty. Please commit or discard changes before creating a branch.',
          };
        }
        targetRevision = '@';
      }

      await ensureJjRevisionHasDescription(
        mainRepoRoot,
        targetRevision,
        options?.planFilePath,
        branchName
      );

      createResult = await spawnAndLogOutput(
        ['jj', 'bookmark', 'set', branchName, '--revision', targetRevision],
        {
          cwd: mainRepoRoot,
        }
      );
      if (createResult.exitCode === 0) {
        createResult = await spawnAndLogOutput(['jj', 'git', 'push', '--bookmark', branchName], {
          cwd: mainRepoRoot,
        });
      }

      // After successful push without fromBranch, create new working copy commit
      if (createResult.exitCode === 0 && !options?.fromBranch) {
        await spawnAndLogOutput(['jj', 'new', '@-'], {
          cwd: mainRepoRoot,
        });
      }
    } else {
      if (options?.planFilePath) {
        const commitResult = await commitPlanFileInPrimaryWorkspace(
          mainRepoRoot,
          options.planFilePath
        );
        if (commitResult.error) {
          createResult = {
            exitCode: 1,
            stdout: '',
            stderr: commitResult.error,
          };
        } else {
          const branchArgs = ['git', 'branch', '-f', branchName];
          const branchSource = await resolveGitBranchSource(mainRepoRoot, options.fromBranch);
          if (branchSource) {
            branchArgs.push(branchSource);
          }
          createResult = await spawnAndLogOutput(branchArgs, { cwd: mainRepoRoot });
        }
      } else {
        const branchArgs = ['git', 'branch', '-f', branchName];
        const branchSource = await resolveGitBranchSource(mainRepoRoot, options?.fromBranch);
        if (branchSource) {
          branchArgs.push(branchSource);
        }
        createResult = await spawnAndLogOutput(branchArgs, { cwd: mainRepoRoot });
      }

      if (createResult.exitCode === 0) {
        createResult = await spawnAndLogOutput(['git', 'push', 'origin', branchName], {
          cwd: mainRepoRoot,
        });
      }
    }

    if (createResult.exitCode !== 0) {
      return {
        success: false,
        error: createResult.stderr,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: String(error),
    };
  }
}

export async function ensureJjRevisionHasDescription(
  repoRoot: string,
  revision: string,
  planFilePath: string | undefined,
  branchName: string
): Promise<void> {
  const descriptionResult = await spawnAndLogOutput(
    ['jj', 'log', '-r', revision, '--no-graph', '-T', 'description'],
    {
      cwd: repoRoot,
      quiet: true,
    }
  );
  if (descriptionResult.exitCode !== 0) {
    throw new Error(`Failed to read jj description for ${revision}: ${descriptionResult.stderr}`);
  }

  if (descriptionResult.stdout.trim().length > 0) {
    return;
  }

  const fallbackDescription = await buildJjStartDescription(planFilePath, branchName);
  const describeResult = await spawnAndLogOutput(
    ['jj', 'describe', '-r', revision, '-m', fallbackDescription],
    {
      cwd: repoRoot,
    }
  );
  if (describeResult.exitCode !== 0) {
    throw new Error(
      `Failed to set jj description for ${revision}: ${describeResult.stderr || describeResult.stdout}`
    );
  }
}

async function buildJjStartDescription(
  planFilePath: string | undefined,
  branchName: string
): Promise<string> {
  if (!planFilePath) {
    return `start ${branchName}`;
  }

  try {
    const plan = await readPlanFile(planFilePath);
    const title = plan.title || plan.goal || branchName;
    if (plan.id !== undefined && plan.id !== null && String(plan.id).trim().length > 0) {
      return `start plan ${plan.id}: ${title}`;
    }
    return `start ${title}`;
  } catch {
    return `start ${branchName}`;
  }
}

/**
 * Creates a new workspace for a task based on the provided configuration
 * @param mainRepoRoot The git root of the main repository
 * @param taskId Unique identifier for the task
 * @param originalPlanFilePath Absolute path to the original plan file (optional)
 * @param config Configuration for tim
 * @param options Additional options for workspace creation
 * @returns A Workspace object if successful, null otherwise
 */
export async function createWorkspace(
  mainRepoRoot: string,
  taskId: string,
  originalPlanFilePath: string | undefined,
  config: TimConfig,
  options?: {
    branchName?: string;
    planData?: PlanSchema;
    fromBranch?: string;
    targetDir?: string;
    workspaceType?: WorkspaceType;
    createBranch?: boolean;
  }
): Promise<Workspace | null> {
  // Check if workspace creation is enabled in the config
  if (!config.workspaceCreation) {
    log('Workspace creation not enabled in config');
    return null;
  }

  log('Creating workspace...');

  const workspaceConfig = config.workspaceCreation;
  const cloneMethod = workspaceConfig.cloneMethod || 'git';
  const extraCopyGlobs = workspaceConfig.copyAdditionalGlobs;

  // Validate required parameters for each clone method
  let repositoryUrl = workspaceConfig.repositoryUrl;
  let sourceDirectory = workspaceConfig.sourceDirectory;

  if (cloneMethod === 'git') {
    // For git method, infer repository URL if not provided
    if (!repositoryUrl) {
      try {
        const { exitCode, stdout, stderr } = await spawnAndLogOutput(
          ['git', 'remote', 'get-url', 'origin'],
          { cwd: mainRepoRoot }
        );

        if (exitCode !== 0 || !stdout.trim()) {
          log(`Failed to infer repository URL from origin remote: ${stderr}`);
          return null;
        }

        repositoryUrl = stdout.trim();
        log(`Inferred repository URL: ${repositoryUrl}`);
      } catch (error) {
        log(`Error getting repository URL: ${String(error)}`);
        return null;
      }
    }
  } else if (cloneMethod === 'cp' || cloneMethod === 'mac-cow') {
    // For cp and mac-cow methods, default to primary workspace or mainRepoRoot if source directory not specified
    if (!sourceDirectory) {
      // Check if there's a primary workspace for this repository we can use as the source
      try {
        const identity = await getRepositoryIdentity({ cwd: mainRepoRoot });
        const primaryWorkspace = findPrimaryWorkspaceForRepository(identity.repositoryId);
        if (primaryWorkspace) {
          sourceDirectory = primaryWorkspace.workspacePath;
          log(`Using primary workspace as source directory: ${sourceDirectory}`);
        }
      } catch {
        // Failed to resolve repository identity, fall through to mainRepoRoot
      }

      if (!sourceDirectory) {
        sourceDirectory = mainRepoRoot;
        log(`Using main repository root as source directory: ${sourceDirectory}`);
      }
    } else {
      // Resolve source directory path if one was explicitly provided
      if (!path.isAbsolute(sourceDirectory)) {
        sourceDirectory = path.resolve(mainRepoRoot, sourceDirectory);
      }
    }

    // Check if source directory exists
    try {
      const stats = await fs.stat(sourceDirectory);
      if (!stats.isDirectory()) {
        log(`Source path is not a directory: ${sourceDirectory}`);
        return null;
      }
    } catch (error) {
      log(`Source directory does not exist: ${sourceDirectory}`);
      return null;
    }

    // For copy methods, try to infer repository URL for git remote setup (optional)
    if (!repositoryUrl) {
      try {
        const { exitCode, stdout } = await spawnAndLogOutput(
          ['git', 'remote', 'get-url', 'origin'],
          { cwd: sourceDirectory }
        );

        if (exitCode === 0 && stdout.trim()) {
          repositoryUrl = stdout.trim();
          log(`Inferred repository URL from source directory: ${repositoryUrl}`);
        }
      } catch (error) {
        // It's okay if we can't infer the repository URL for copy methods
        log(`Could not infer repository URL from source directory (this is not an error)`);
      }
    }
  } else {
    log(`Unknown clone method: ${cloneMethod as string}`);
    return null;
  }

  // Step 2: Determine clone location
  if (!workspaceConfig.cloneLocation) {
    throw new Error(
      'cloneLocation must be set in workspace configuration to clone a new workspace'
    );
  }

  // If relative, resolve against mainRepoRoot
  const cloneLocationBase = path.isAbsolute(workspaceConfig.cloneLocation)
    ? workspaceConfig.cloneLocation
    : path.resolve(mainRepoRoot, workspaceConfig.cloneLocation);

  // Ensure the base clone directory exists
  try {
    await fs.mkdir(cloneLocationBase, { recursive: true });
  } catch (error) {
    log(`Error creating clone location directory: ${String(error)}`);
    return null;
  }

  // Step 3: Construct the target directory path
  let targetClonePath: string;
  if (options?.targetDir) {
    // If targetDir is provided, use it (absolute or relative to cloneLocationBase)
    targetClonePath = path.isAbsolute(options.targetDir)
      ? options.targetDir
      : path.join(cloneLocationBase, options.targetDir);
  } else {
    // Default: Extract repo name from URL or source directory
    let repoName: string;
    if (cloneMethod === 'git' && repositoryUrl) {
      repoName =
        repositoryUrl
          .split('/')
          .pop()
          ?.replace(/\.git$/, '') || 'repo';
    } else if (sourceDirectory) {
      repoName = path.basename(sourceDirectory);
    } else {
      repoName = 'workspace';
    }
    targetClonePath = path.join(cloneLocationBase, `${repoName}-${taskId}`);
  }

  // Step 4: Clone/copy the repository using the selected method
  let cloneSuccess = false;
  if (cloneMethod === 'git' && repositoryUrl) {
    cloneSuccess = await cloneWithGit(repositoryUrl, targetClonePath, mainRepoRoot);
  } else if (cloneMethod === 'cp' && sourceDirectory) {
    cloneSuccess = await cloneWithCp(sourceDirectory, targetClonePath, extraCopyGlobs);
  } else if (cloneMethod === 'mac-cow' && sourceDirectory) {
    cloneSuccess = await cloneWithMacCow(sourceDirectory, targetClonePath, extraCopyGlobs);
  }

  if (!cloneSuccess) {
    return null;
  }

  // Step 4.5: Set up git remote for copy methods
  if ((cloneMethod === 'cp' || cloneMethod === 'mac-cow') && repositoryUrl) {
    await setupGitRemote(targetClonePath, repositoryUrl);
  }

  // Detect VCS type by checking for .jj directory in the new workspace.
  const jjPath = path.join(targetClonePath, '.jj');
  let isJj = false;
  try {
    const stats = await fs.stat(jjPath);
    isJj = stats.isDirectory();
  } catch {
    // Not a jj repository
  }

  const branchName = options?.branchName ?? taskId;
  const shouldCreateBranch = options?.createBranch ?? false;
  const planFilePathInWorkspace = originalPlanFilePath
    ? path.join(targetClonePath, path.relative(mainRepoRoot, originalPlanFilePath))
    : undefined;

  // Step 5: Create the branch in the primary workspace and push it before checking it out here
  if (shouldCreateBranch) {
    try {
      const createResult = await ensurePrimaryWorkspaceBranch(mainRepoRoot, branchName, {
        planFilePath: originalPlanFilePath,
        fromBranch: options?.fromBranch,
      });
      if (!createResult.success) {
        log(`Failed to create and push branch: ${createResult.error}`);
        try {
          await fs.rm(targetClonePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }
    } catch (error) {
      log(`Error creating branch: ${String(error)}`);
      await fs.rm(targetClonePath, { recursive: true, force: true }).catch(() => {});
      return null;
    }
  }

  // Step 6: Check out the target ref in the new workspace
  try {
    if (shouldCreateBranch) {
      log(`Checking out branch ${branchName} in new workspace`);
      const checkoutResult = isJj
        ? await spawnAndLogOutput(['jj', 'git', 'fetch'], { cwd: targetClonePath }).then(
            async (fetchResult) => {
              if (fetchResult.exitCode !== 0) {
                return fetchResult;
              }

              const newResult = await spawnAndLogOutput(['jj', 'new', branchName], {
                cwd: targetClonePath,
              });
              if (newResult.exitCode !== 0) {
                return newResult;
              }

              await ensureJjRevisionHasDescription(
                targetClonePath,
                '@',
                originalPlanFilePath,
                branchName
              );

              return spawnAndLogOutput(['jj', 'bookmark', 'set', branchName], {
                cwd: targetClonePath,
              });
            }
          )
        : await spawnAndLogOutput(['git', 'fetch', 'origin'], { cwd: targetClonePath }).then(
            async (fetchResult) => {
              if (fetchResult.exitCode !== 0) {
                return fetchResult;
              }

              return spawnAndLogOutput(['git', 'checkout', branchName], {
                cwd: targetClonePath,
              });
            }
          );

      if (checkoutResult.exitCode !== 0) {
        log(`Failed to check out branch in new workspace: ${checkoutResult.stderr}`);
        try {
          await fs.rm(targetClonePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }
    } else if (options?.fromBranch) {
      log(`Checking out base branch "${options.fromBranch}"`);
      const checkoutResult = isJj
        ? await spawnAndLogOutput(['jj', 'new', options.fromBranch], {
            cwd: targetClonePath,
          })
        : await spawnAndLogOutput(['git', 'checkout', options.fromBranch], {
            cwd: targetClonePath,
          });

      if (checkoutResult.exitCode !== 0) {
        log(`Failed to checkout base branch "${options.fromBranch}": ${checkoutResult.stderr}`);
        try {
          await fs.rm(targetClonePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }
    }
  } catch (error) {
    log(`Error checking out workspace branch: ${String(error)}`);
    return null;
  }

  // Step 7: Run post-clone commands if specified
  if (workspaceConfig.postCloneCommands?.length) {
    log('Running post-clone commands');

    for (const commandConfig of workspaceConfig.postCloneCommands) {
      // Add task-specific environment variables to the command config
      // Note: We don't resolve workingDirectory here, as executePostApplyCommand
      // will resolve it against targetClonePath. This is documented in its implementation.
      const envVars: Record<string, string> = {
        ...commandConfig.env,
        LLMUTILS_TASK_ID: taskId, // This is the workspace ID
      };
      if (planFilePathInWorkspace) {
        // Check the variable holding the copied plan's path
        envVars.LLMUTILS_PLAN_FILE_PATH = planFilePathInWorkspace;
      }

      const commandWithEnv: PostApplyCommand = {
        ...commandConfig,
        env: envVars,
      };

      log(`Running post-clone command: "${commandConfig.title || commandConfig.command}"`);

      // Execute the command using executePostApplyCommand with targetClonePath as the git root
      // Note: workingDirectory will be resolved against targetClonePath by executePostApplyCommand
      const success = await executePostApplyCommand(commandWithEnv, targetClonePath, false);

      if (!success && !commandConfig.allowFailure) {
        log(`Post-clone command failed and failure is not allowed. Cleaning up workspace.`);
        // Clean up the clone
        try {
          await fs.rm(targetClonePath, { recursive: true, force: true });
        } catch (error) {
          // Ignore cleanup errors
          log(`Note: Failed to clean up workspace directory: ${String(error)}`);
        }
        return null;
      }
    }
  }

  debugLog(`Successfully created workspace at ${targetClonePath}`);

  // Create workspace object
  const workspace: Workspace = {
    path: targetClonePath,
    originalPlanFilePath,
    planFilePathInWorkspace,
    taskId,
  };

  // Record the workspace info for tracking
  let repositoryId: string | undefined;
  let repositoryRemoteUrl: string | null = null;
  try {
    const identity = await getRepositoryIdentity({ cwd: targetClonePath });
    repositoryId = identity.repositoryId;
    repositoryRemoteUrl = identity.remoteUrl;
  } catch (error) {
    log(`Warning: Failed to resolve repository identity for workspace: ${String(error)}`);
  }

  // Build description from plan data if available
  const description = options?.planData ? buildDescriptionFromPlan(options.planData) : undefined;

  const db = getDatabase();
  const project = getOrCreateProject(db, repositoryId ?? `workspace:${targetClonePath}`, {
    remoteUrl: repositoryRemoteUrl,
    lastGitRoot: targetClonePath,
  });
  const workspaceRow = recordWorkspace(db, {
    projectId: project.id,
    taskId,
    originalPlanFilePath,
    workspacePath: targetClonePath,
    name: taskId,
    description,
    branch: shouldCreateBranch ? branchName : undefined,
    planId: options?.planData?.id ? String(options.planData.id) : null,
    planTitle: options?.planData?.title || options?.planData?.goal || null,
    workspaceType: options?.workspaceType,
  });
  setWorkspaceIssues(db, workspaceRow.id, options?.planData?.issue ?? []);

  // Acquire lock for the workspace
  try {
    const lockInfo = await WorkspaceLock.acquireLock(
      targetClonePath,
      `tim agent --workspace ${taskId}`
    );
    WorkspaceLock.setupCleanupHandlers(targetClonePath, lockInfo.type);
  } catch (error) {
    log(`Warning: Failed to acquire workspace lock: ${String(error)}`);
    // Continue without lock - this isn't fatal
  }

  // Return the workspace information
  return workspace;
}

/**
 * Checks if a branch/bookmark exists in the repository.
 * Supports both Git and Jujutsu repositories.
 *
 * @param workspacePath - Path to the workspace
 * @param branchName - Name of the branch to check
 * @param isJj - Whether the workspace uses Jujutsu
 * @returns true if the branch exists, false otherwise
 */
async function branchExists(
  workspacePath: string,
  branchName: string,
  isJj: boolean
): Promise<boolean> {
  if (isJj) {
    // For jj, check if the bookmark exists
    const result = await spawnAndLogOutput(['jj', 'bookmark', 'list'], {
      cwd: workspacePath,
      quiet: true,
    });
    if (result.exitCode !== 0) {
      return false;
    }
    // Each line starts with the bookmark name followed by space or colon
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      const name = line.split(/[\s:]/)[0];
      if (name === branchName) {
        return true;
      }
    }
    return false;
  } else {
    // For git, use rev-parse --verify
    const result = await spawnAndLogOutput(['git', 'rev-parse', '--verify', branchName], {
      cwd: workspacePath,
      quiet: true,
    });
    return result.exitCode === 0;
  }
}

/**
 * Checks if a branch/bookmark exists on the remote.
 * Supports both Git and Jujutsu repositories.
 *
 * @param workspacePath - Path to the workspace
 * @param branchName - Name of the branch to check
 * @param isJj - Whether the workspace uses Jujutsu
 * @param remoteName - Name of the remote (default: 'origin')
 * @returns true if the branch exists on the remote, false otherwise
 */
async function remoteBranchExists(
  workspacePath: string,
  branchName: string,
  isJj: boolean,
  remoteName = 'origin'
): Promise<boolean> {
  if (isJj) {
    const result = await spawnAndLogOutput(['jj', 'bookmark', 'list', '--all'], {
      cwd: workspacePath,
      quiet: true,
    });
    if (result.exitCode !== 0) {
      return false;
    }
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      const name = line.split(/[\s:]/)[0];
      if (name === `${branchName}@${remoteName}`) {
        return true;
      }
    }
    return false;
  } else {
    const result = await spawnAndLogOutput(
      ['git', 'rev-parse', '--verify', `refs/remotes/${remoteName}/${branchName}`],
      {
        cwd: workspacePath,
        quiet: true,
      }
    );
    return result.exitCode === 0;
  }
}

/**
 * Finds a unique branch name by appending suffixes (-2, -3, etc.) if the name already exists.
 * Supports both Git and Jujutsu repositories.
 *
 * @param workspacePath - Path to the workspace
 * @param baseName - Base name for the branch
 * @param isJj - Whether the workspace uses Jujutsu
 * @param options - Optional settings. When checkRemote is true, also checks remote refs for conflicts.
 * @returns A unique branch name (may include suffix)
 */
export async function findUniqueBranchName(
  workspacePath: string,
  baseName: string,
  isJj: boolean,
  options?: { checkRemote?: boolean }
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;

  while (
    (await branchExists(workspacePath, candidate, isJj)) ||
    (options?.checkRemote && (await remoteBranchExists(workspacePath, candidate, isJj)))
  ) {
    candidate = `${baseName}-${suffix}`;
    suffix++;
    // Safety limit to prevent infinite loops
    if (suffix > 100) {
      throw new Error(`Could not find unique branch name after 100 attempts, base: ${baseName}`);
    }
  }

  if (candidate !== baseName) {
    log(`Branch "${baseName}" already exists, using "${candidate}" instead`);
  }

  return candidate;
}

function isMissingJjBookmarkError(message: string): boolean {
  return /No such bookmark|Revision .* doesn't exist/i.test(message);
}

/**
 * Options for preparing an existing workspace for reuse.
 */
export interface PrepareWorkspaceOptions {
  /** Branch to checkout before creating new branch (default: auto-detect trunk) */
  baseBranch?: string;
  /** Name of new branch to create */
  branchName: string;
  /** Plan file used to derive a fallback jj revision description when needed */
  planFilePath?: string;
  /** Whether to create a new branch (default: true) */
  createBranch?: boolean;
  /** Whether to log when branch creation is intentionally skipped (default: true) */
  logSkippedBranchCreation?: boolean;
  /** Whether to force the checked-out base branch to the fetched remote tip when available */
  updateBaseFromRemote?: boolean;
  /** When true, check if branchName exists locally and reuse it instead of creating new.
   *  Also checks remote when finding unique names for new branches. */
  reuseExistingBranch?: boolean;
  /** Path to the primary/current workspace where branch name decisions should be made.
   *  When provided, branch existence checks and unique name finding happen here,
   *  and the branch is created+pushed from here before being fetched+checked out
   *  in workspacePath. When omitted, all operations happen in workspacePath directly. */
  primaryWorkspacePath?: string;
}

/**
 * Result from preparing an existing workspace.
 */
export interface PrepareWorkspaceResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** The actual branch name used (may include auto-suffix) */
  actualBranchName?: string;
  /** Whether an existing local branch was reused (vs creating a new one) */
  reusedExistingBranch?: boolean;
}

async function detectIsJj(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path.join(dirPath, '.jj'));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Fetch latest from remote in a workspace. Used to sync the workspace after
 * branch decisions are made in the primary workspace.
 */
async function fetchInWorkspace(
  workspacePath: string,
  isJj: boolean,
  hasRemote: boolean | null,
  allowOffline: boolean
): Promise<void> {
  if (hasRemote === false) {
    return;
  }

  log(`Fetching latest changes in workspace...`);
  const fetchResult = isJj
    ? await spawnAndLogOutput(['jj', 'git', 'fetch'], { cwd: workspacePath })
    : await spawnAndLogOutput(['git', 'fetch', 'origin'], { cwd: workspacePath });

  if (fetchResult.exitCode !== 0) {
    if (allowOffline) {
      log(
        `Warning: Failed to fetch in workspace (continuing in offline mode): ${fetchResult.stderr}`
      );
    } else {
      log(`Warning: Failed to fetch in workspace: ${fetchResult.stderr}`);
    }
  }
}

/**
 * Checks out a base branch in a workspace and optionally fast-forwards it
 * from the remote. Used by prepareExistingWorkspace in both the
 * "no branch creation" and "create branch locally" paths.
 */
async function checkoutAndUpdateBaseBranch(
  workspacePath: string,
  baseBranch: string,
  isJj: boolean,
  hasRemote: boolean | null,
  allowOffline: boolean,
  updateFromRemote: boolean
): Promise<{ success: boolean; error?: string }> {
  log(`Checking out base branch "${baseBranch}"...`);
  const checkoutResult = isJj
    ? await spawnAndLogOutput(['jj', 'new', baseBranch], { cwd: workspacePath })
    : await spawnAndLogOutput(['git', 'checkout', baseBranch], { cwd: workspacePath });

  if (checkoutResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to checkout base branch "${baseBranch}": ${checkoutResult.stderr}`,
    };
  }

  if (updateFromRemote && hasRemote !== false) {
    log(`Updating base branch "${baseBranch}" from remote...`);
    const updateBaseResult = isJj
      ? await spawnAndLogOutput(['jj', 'bookmark', 'track', baseBranch, '--remote', 'origin'], {
          cwd: workspacePath,
          quiet: true,
        })
      : await spawnAndLogOutput(['git', 'pull', '--ff-only', 'origin', baseBranch], {
          cwd: workspacePath,
        });

    if (updateBaseResult.exitCode !== 0) {
      const updateOutput = `${updateBaseResult.stderr}\n${updateBaseResult.stdout}`.trim();
      if (isJj && isMissingJjBookmarkError(updateOutput)) {
        log(`Remote bookmark "${baseBranch}" not found; using local base branch.`);
      } else if (allowOffline) {
        log(
          `Warning: Failed to update base branch from remote (continuing in offline mode): ${updateBaseResult.stderr}`
        );
      } else {
        return {
          success: false,
          error: `Failed to update base branch "${baseBranch}" from remote: ${updateBaseResult.stderr}`,
        };
      }
    }
  }

  return { success: true };
}

/**
 * Prepares an existing workspace for reuse by fetching, checking out base branch,
 * and creating a new working branch.
 *
 * When primaryWorkspacePath is provided, branch name decisions (existence checks,
 * unique name finding) happen there, the branch is created+pushed from primary,
 * then fetched+checked out in workspacePath. When primaryWorkspacePath is omitted,
 * all operations happen directly in workspacePath.
 *
 * This function:
 * 1. Detects VCS type (git vs jj)
 * 2. Fetches latest from remote in the primary workspace
 * 2a. If reuseExistingBranch: checks if branchName exists in primary, and if so
 *     fetches+checks it out in workspacePath + pulls latest
 * 3. Determines the base branch
 * 4. Finds a unique branch name in the primary workspace
 * 5. Creates the branch (via primary+push when separate, or directly in workspacePath)
 * 6. Checks out the branch in workspacePath
 *
 * @param workspacePath - Absolute path to the workspace
 * @param options - Options including base branch and new branch name
 * @returns Result indicating success/failure and actual branch name used
 */
export async function prepareExistingWorkspace(
  workspacePath: string,
  options: PrepareWorkspaceOptions
): Promise<PrepareWorkspaceResult> {
  const primaryPath = options.primaryWorkspacePath ?? workspacePath;
  const hasSeparatePrimary = primaryPath !== workspacePath;

  // Detect VCS type for each path — they may differ between primary and workspace
  const workspaceIsJj = await detectIsJj(workspacePath);
  const primaryIsJj = hasSeparatePrimary ? await detectIsJj(primaryPath) : workspaceIsJj;

  const allowOffline = process.env.ALLOW_OFFLINE === 'true' || process.env.ALLOW_OFFLINE === '1';

  const logMissingRemote = () => {
    log('Warning: No remote configured; skipping fetch.');
  };

  const isMissingRemoteError = (message: string) => {
    return /no such remote|no remotes configured|unknown remote/i.test(message);
  };

  // Step 1: Fetch latest from remote in the primary workspace (for branch name decisions)
  let hasRemote: boolean | null = null;
  if (primaryIsJj) {
    const remoteList = await spawnAndLogOutput(['jj', 'git', 'remote', 'list'], {
      cwd: primaryPath,
    });
    if (remoteList.exitCode === 0) {
      hasRemote = remoteList.stdout.trim().length > 0;
    }
  } else {
    const remoteCheck = await spawnAndLogOutput(['git', 'remote', 'get-url', 'origin'], {
      cwd: primaryPath,
    });
    hasRemote = remoteCheck.exitCode === 0;
  }

  if (hasRemote === false) {
    logMissingRemote();
  } else {
    log('Fetching latest changes from remote...');
    const fetchResult = primaryIsJj
      ? await spawnAndLogOutput(['jj', 'git', 'fetch'], { cwd: primaryPath })
      : await spawnAndLogOutput(['git', 'fetch', 'origin'], { cwd: primaryPath });

    if (fetchResult.exitCode !== 0) {
      const fetchOutput = `${fetchResult.stderr}\n${fetchResult.stdout}`.trim();
      if (hasRemote === null && isMissingRemoteError(fetchOutput)) {
        logMissingRemote();
      } else if (allowOffline) {
        log(
          `Warning: Failed to fetch from remote (continuing in offline mode): ${fetchResult.stderr}`
        );
      } else {
        return {
          success: false,
          error: `Failed to fetch from remote: ${fetchResult.stderr}`,
        };
      }
    }
  }

  const shouldCreateBranch = options.createBranch ?? true;

  // Step 2: If reuseExistingBranch is enabled, check if the plan branch already exists
  // in the primary workspace
  if (options.reuseExistingBranch && shouldCreateBranch) {
    const localExists = await branchExists(primaryPath, options.branchName, primaryIsJj);

    if (localExists) {
      log(
        `Found existing branch "${options.branchName}", checking out and pulling latest in workspace...`
      );

      // Push the branch from primary so the remote has the latest version,
      // then fetch in the workspace so it's available there.
      if (hasSeparatePrimary && hasRemote !== false) {
        log(`Pushing branch "${options.branchName}" from primary workspace...`);
        const pushResult = primaryIsJj
          ? await spawnAndLogOutput(['jj', 'git', 'push', '--bookmark', options.branchName], {
              cwd: primaryPath,
            })
          : await spawnAndLogOutput(['git', 'push', 'origin', options.branchName], {
              cwd: primaryPath,
            });
        if (pushResult.exitCode !== 0) {
          log(
            `Note: Could not push "${options.branchName}" from primary (may not exist remotely yet): ${pushResult.stderr}`
          );
        }
        await fetchInWorkspace(workspacePath, workspaceIsJj, hasRemote, allowOffline);
      } else if (hasSeparatePrimary) {
        await fetchInWorkspace(workspacePath, workspaceIsJj, hasRemote, allowOffline);
      }

      if (workspaceIsJj) {
        // Track remote version if it exists
        await spawnAndLogOutput(['jj', 'bookmark', 'track', options.branchName], {
          cwd: workspacePath,
          quiet: true,
        });

        const editResult = await spawnAndLogOutput(['jj', 'new', options.branchName], {
          cwd: workspacePath,
        });
        if (editResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to check out existing bookmark "${options.branchName}": ${editResult.stderr}`,
          };
        }
      } else {
        const checkoutResult = await spawnAndLogOutput(['git', 'checkout', options.branchName], {
          cwd: workspacePath,
        });
        if (checkoutResult.exitCode !== 0) {
          return {
            success: false,
            error: `Failed to check out existing branch "${options.branchName}": ${checkoutResult.stderr}`,
          };
        }

        // Pull latest if remote exists (non-fatal if branch isn't on remote yet)
        if (hasRemote !== false) {
          const pullResult = await spawnAndLogOutput(
            ['git', 'pull', '--ff-only', 'origin', options.branchName],
            { cwd: workspacePath, quiet: true }
          );
          if (pullResult.exitCode !== 0) {
            log(
              `Note: Could not fast-forward "${options.branchName}" from remote (may not exist remotely yet)`
            );
          }
        }
      }

      log(`Successfully prepared workspace with existing branch "${options.branchName}"`);
      return {
        success: true,
        actualBranchName: options.branchName,
        reusedExistingBranch: true,
      };
    }

    // Branch doesn't exist locally — fall through to create a new branch,
    // but findUniqueBranchName will also check remote refs
  }

  // Step 3: Determine base branch (from primary workspace)
  const baseBranch = options.baseBranch || (await getTrunkBranch(primaryPath));
  log(`Using base branch: ${baseBranch}`);

  if (!shouldCreateBranch) {
    // When not creating a branch, just checkout the base in the workspace directly
    if (hasSeparatePrimary) {
      await fetchInWorkspace(workspacePath, workspaceIsJj, hasRemote, allowOffline);
    }

    const baseResult = await checkoutAndUpdateBaseBranch(
      workspacePath,
      baseBranch,
      workspaceIsJj,
      hasRemote,
      allowOffline,
      options.updateBaseFromRemote ?? true
    );
    if (!baseResult.success) {
      return baseResult;
    }

    if (options.logSkippedBranchCreation !== false) {
      log('Skipping branch creation (createBranch=false)');
    }
    return {
      success: true,
      actualBranchName: baseBranch,
    };
  }

  // Step 4: Find unique branch name in the primary workspace
  // (also checking remote when reuseExistingBranch is set)
  const actualBranchName = await findUniqueBranchName(
    primaryPath,
    options.branchName,
    primaryIsJj,
    options.reuseExistingBranch ? { checkRemote: true } : undefined
  );

  // Step 5: Create and push the branch from the primary workspace, then fetch+checkout
  // in the target workspace
  if (hasSeparatePrimary) {
    log(`Creating branch "${actualBranchName}" in primary workspace and pushing...`);
    const createResult = await ensurePrimaryWorkspaceBranch(primaryPath, actualBranchName, {
      planFilePath: options.planFilePath,
      fromBranch: baseBranch,
    });

    if (!createResult.success) {
      return {
        success: false,
        error: `Failed to create branch "${actualBranchName}" in primary workspace: ${createResult.error}`,
      };
    }

    // Fetch in the workspace to pick up the pushed branch
    await fetchInWorkspace(workspacePath, workspaceIsJj, hasRemote, allowOffline);

    // Check out the branch in the workspace
    log(`Checking out branch "${actualBranchName}" in workspace...`);
    if (workspaceIsJj) {
      const trackResult = await spawnAndLogOutput(['jj', 'bookmark', 'track', actualBranchName], {
        cwd: workspacePath,
        quiet: true,
      });
      if (trackResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to track branch "${actualBranchName}" in workspace: ${trackResult.stderr}`,
        };
      }

      const newResult = await spawnAndLogOutput(['jj', 'new', actualBranchName], {
        cwd: workspacePath,
      });
      if (newResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to check out branch "${actualBranchName}" in workspace: ${newResult.stderr}`,
        };
      }
      await ensureJjRevisionHasDescription(
        workspacePath,
        '@',
        options.planFilePath,
        actualBranchName
      );
      await spawnAndLogOutput(['jj', 'bookmark', 'set', actualBranchName], {
        cwd: workspacePath,
      });
    } else {
      const checkoutResult = await spawnAndLogOutput(['git', 'checkout', actualBranchName], {
        cwd: workspacePath,
      });
      if (checkoutResult.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to check out branch "${actualBranchName}" in workspace: ${checkoutResult.stderr}`,
        };
      }
    }
  } else {
    // No separate primary — operate directly in workspacePath (original behavior)
    const baseResult = await checkoutAndUpdateBaseBranch(
      workspacePath,
      baseBranch,
      workspaceIsJj,
      hasRemote,
      allowOffline,
      options.updateBaseFromRemote ?? true
    );
    if (!baseResult.success) {
      return baseResult;
    }

    log(`Creating new branch "${actualBranchName}"...`);
    const createBranchResult = workspaceIsJj
      ? await (async () => {
          await ensureJjRevisionHasDescription(
            workspacePath,
            '@',
            options.planFilePath,
            actualBranchName
          );
          return spawnAndLogOutput(['jj', 'bookmark', 'set', actualBranchName], {
            cwd: workspacePath,
          });
        })()
      : await spawnAndLogOutput(['git', 'checkout', '-b', actualBranchName], {
          cwd: workspacePath,
        });

    if (createBranchResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to create branch "${actualBranchName}": ${createBranchResult.stderr}`,
      };
    }
  }

  log(`Successfully prepared workspace with branch "${actualBranchName}"`);
  return {
    success: true,
    actualBranchName,
  };
}
