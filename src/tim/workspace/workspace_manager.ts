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
  /** Whether setup checked out an existing remote branch instead of creating a new local branch */
  checkedOutRemoteBranch?: boolean;
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

async function checkoutWorkspaceBranch(
  workspacePath: string,
  branchName: string,
  isJj: boolean,
  planFilePath?: string
): Promise<{ success: boolean; error?: string }> {
  log(`Checking out branch "${branchName}" in workspace...`);

  if (isJj) {
    const trackResult = await spawnAndLogOutput(['jj', 'bookmark', 'track', branchName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (trackResult.exitCode !== 0) {
      const trackOutput = `${trackResult.stderr}\n${trackResult.stdout}`.trim();
      if (!isMissingJjBookmarkError(trackOutput)) {
        return {
          success: false,
          error: `Failed to track branch "${branchName}" in workspace: ${trackResult.stderr}`,
        };
      }

      log(`Remote bookmark "${branchName}" not found; reusing local bookmark in workspace.`);
    }

    const newResult = await spawnAndLogOutput(['jj', 'new', branchName], {
      cwd: workspacePath,
    });
    if (newResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to check out branch "${branchName}" in workspace: ${newResult.stderr}`,
      };
    }

    await ensureJjRevisionHasDescription(workspacePath, '@', planFilePath, branchName);

    const bookmarkResult = await spawnAndLogOutput(['jj', 'bookmark', 'set', branchName], {
      cwd: workspacePath,
    });
    if (bookmarkResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to set branch "${branchName}" in workspace: ${bookmarkResult.stderr}`,
      };
    }

    return { success: true };
  }

  const checkoutResult = await spawnAndLogOutput(['git', 'checkout', branchName], {
    cwd: workspacePath,
  });
  if (checkoutResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to check out branch "${branchName}" in workspace: ${checkoutResult.stderr}`,
    };
  }

  return { success: true };
}

async function fastForwardWorkspaceBranchFromRemote(
  workspacePath: string,
  branchName: string,
  isJj: boolean
): Promise<boolean> {
  const pullResult = isJj
    ? await spawnAndLogOutput(['jj', 'bookmark', 'track', branchName, '--remote', 'origin'], {
        cwd: workspacePath,
        quiet: true,
      })
    : await spawnAndLogOutput(['git', 'pull', '--ff-only', 'origin', branchName], {
        cwd: workspacePath,
        quiet: true,
      });

  if (pullResult.exitCode !== 0) {
    log(`Note: Could not fast-forward "${branchName}" from remote (may not exist remotely yet)`);
    return false;
  }

  return true;
}

async function forceAlignWorkspaceBranchToRemote(
  workspacePath: string,
  branchName: string,
  isJj: boolean
): Promise<{ success: boolean; error?: string }> {
  if (isJj) {
    const trackResult = await spawnAndLogOutput(
      ['jj', 'bookmark', 'track', branchName, '--remote', 'origin'],
      {
        cwd: workspacePath,
        quiet: true,
      }
    );
    if (trackResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to align bookmark "${branchName}" with origin: ${trackResult.stderr}`,
      };
    }

    return { success: true };
  }

  const resetResult = await spawnAndLogOutput(['git', 'reset', '--hard', `origin/${branchName}`], {
    cwd: workspacePath,
  });
  if (resetResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to reset branch "${branchName}" to origin/${branchName}: ${resetResult.stderr}`,
    };
  }

  return { success: true };
}

async function syncWorkspaceBranchFromRemote(
  workspacePath: string,
  branchName: string,
  isJj: boolean
): Promise<{ success: boolean; error?: string }> {
  const fastForwarded = await fastForwardWorkspaceBranchFromRemote(workspacePath, branchName, isJj);
  if (fastForwarded) {
    return { success: true };
  }

  log(`Forcing "${branchName}" to match origin after fast-forward failed...`);
  return forceAlignWorkspaceBranchToRemote(workspacePath, branchName, isJj);
}

async function createLocalWorkspaceBranch(
  workspacePath: string,
  baseBranch: string,
  branchName: string,
  isJj: boolean,
  planFilePath: string | undefined,
  hasRemote: boolean | null,
  allowOffline: boolean,
  updateBaseFromRemote: boolean
): Promise<{ success: boolean; error?: string }> {
  const baseResult = await checkoutAndUpdateBaseBranch(
    workspacePath,
    baseBranch,
    isJj,
    hasRemote,
    allowOffline,
    updateBaseFromRemote
  );
  if (!baseResult.success) {
    return baseResult;
  }

  log(`Creating new branch "${branchName}"...`);
  const createBranchResult = isJj
    ? await (async () => {
        await ensureJjRevisionHasDescription(workspacePath, '@', planFilePath, branchName);
        return spawnAndLogOutput(['jj', 'bookmark', 'set', branchName], {
          cwd: workspacePath,
        });
      })()
    : await spawnAndLogOutput(['git', 'checkout', '-b', branchName], {
        cwd: workspacePath,
      });

  if (createBranchResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to create branch "${branchName}": ${createBranchResult.stderr}`,
    };
  }

  return { success: true };
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

  // Step 5: Set up git remote for copy methods
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

  const allowOffline = process.env.ALLOW_OFFLINE === 'true' || process.env.ALLOW_OFFLINE === '1';
  const hasRemote = await (async (): Promise<boolean> => {
    if (isJj) {
      const remoteList = await spawnAndLogOutput(['jj', 'git', 'remote', 'list'], {
        cwd: targetClonePath,
      });
      return remoteList.exitCode === 0 && remoteList.stdout.trim().length > 0;
    }

    const remoteCheck = await spawnAndLogOutput(['git', 'remote', 'get-url', 'origin'], {
      cwd: targetClonePath,
    });
    return remoteCheck.exitCode === 0;
  })();

  const branchName = options?.branchName ?? taskId;
  const shouldCreateBranch = options?.createBranch ?? false;
  const planFilePathInWorkspace = originalPlanFilePath
    ? path.join(targetClonePath, path.relative(mainRepoRoot, originalPlanFilePath))
    : undefined;

  // Step 6: Check out an existing remote branch in the workspace, or create a new local branch.
  // checkedOutRemoteBranch is true when any existing branch (local or remote) was reused
  // rather than a fresh branch being created. Used by callers to determine branchCreatedDuringSetup.
  let checkedOutRemoteBranch = false;
  try {
    if (shouldCreateBranch) {
      if (cloneMethod === 'cp' || cloneMethod === 'mac-cow') {
        const fetchResult = await fetchInWorkspace(targetClonePath, isJj, hasRemote, allowOffline);
        if (!fetchResult.success) {
          log(fetchResult.error ?? 'Failed to fetch in new workspace');
          await fs.rm(targetClonePath, { recursive: true, force: true }).catch(() => {});
          return null;
        }
      }

      const remoteExists = await remoteBranchExists(targetClonePath, branchName, isJj);
      const localExists = await branchExists(targetClonePath, branchName, isJj);
      checkedOutRemoteBranch = remoteExists || localExists;
      let branchResult;

      if (remoteExists) {
        branchResult = await checkoutWorkspaceBranch(
          targetClonePath,
          branchName,
          isJj,
          originalPlanFilePath
        );
        if (branchResult.success) {
          const fastForwarded = await fastForwardWorkspaceBranchFromRemote(
            targetClonePath,
            branchName,
            isJj
          );
          if (!fastForwarded && localExists) {
            log(
              `Preserving inherited local branch "${branchName}" in new workspace after fast-forward failed.`
            );
          }
        }
      } else {
        if (localExists) {
          branchResult = await checkoutWorkspaceBranch(
            targetClonePath,
            branchName,
            isJj,
            originalPlanFilePath
          );
        } else {
          branchResult = await createLocalWorkspaceBranch(
            targetClonePath,
            options?.fromBranch ?? (await getTrunkBranch(targetClonePath)),
            branchName,
            isJj,
            originalPlanFilePath,
            hasRemote,
            allowOffline,
            false
          );
        }
      }

      if (!branchResult.success) {
        log(branchResult.error ?? `Failed to prepare branch "${branchName}" in new workspace`);
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
    await fs.rm(targetClonePath, { recursive: true, force: true }).catch(() => {});
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
    checkedOutRemoteBranch,
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
    const result = await spawnAndLogOutput(['jj', 'bookmark', 'list', branchName], {
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
    // For git, use rev-parse --verify with refs/heads/ to check only local branches
    const result = await spawnAndLogOutput(
      ['git', 'rev-parse', '--verify', `refs/heads/${branchName}`],
      {
        cwd: workspacePath,
        quiet: true,
      }
    );
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
    const result = await spawnAndLogOutput(['jj', 'bookmark', 'list', '--all', branchName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (result.exitCode !== 0) {
      return false;
    }
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      const name = line.trimStart().split(/[\s:]/)[0];
      if (name === `${branchName}@${remoteName}`) {
        return true;
      }

      if (name === `@${remoteName}`) {
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

export async function findUniqueRemoteBranchName(
  workspacePath: string,
  baseName: string,
  isJj: boolean
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;

  while (await remoteBranchExists(workspacePath, candidate, isJj)) {
    candidate = `${baseName}-${suffix}`;
    suffix++;
    if (suffix > 100) {
      throw new Error(
        `Could not find unique remote branch name after 100 attempts, base: ${baseName}`
      );
    }
  }

  if (candidate !== baseName) {
    log(`Branch "${baseName}" already exists on remote, using "${candidate}" instead`);
  }

  return candidate;
}

export async function deleteLocalBranch(
  workspacePath: string,
  branchName: string,
  isJj: boolean,
  restoreBranch?: string
): Promise<{ success: boolean; error?: string }> {
  const trunkBranch = restoreBranch ?? (await getTrunkBranch(workspacePath));

  if (branchName === trunkBranch) {
    return {
      success: false,
      error: `Refusing to delete trunk branch "${branchName}"`,
    };
  }

  if (isJj) {
    const restoreResult = await spawnAndLogOutput(['jj', 'new', trunkBranch], {
      cwd: workspacePath,
      quiet: true,
    });
    if (restoreResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to restore jj workspace to "${trunkBranch}": ${restoreResult.stderr}`,
      };
    }

    const deleteResult = await spawnAndLogOutput(['jj', 'bookmark', 'delete', branchName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (deleteResult.exitCode !== 0) {
      return {
        success: false,
        error: deleteResult.stderr || deleteResult.stdout,
      };
    }
  } else {
    const checkoutResult = await spawnAndLogOutput(['git', 'checkout', trunkBranch], {
      cwd: workspacePath,
      quiet: true,
    });
    if (checkoutResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to checkout "${trunkBranch}" before deleting branch: ${checkoutResult.stderr}`,
      };
    }

    const deleteResult = await spawnAndLogOutput(['git', 'branch', '-D', branchName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (deleteResult.exitCode !== 0) {
      return {
        success: false,
        error: deleteResult.stderr || deleteResult.stdout,
      };
    }
  }

  return { success: true };
}

function isMissingJjBookmarkError(message: string): boolean {
  return /No such bookmark|Revision .* doesn't exist/i.test(message);
}

function isMissingLocalBranchError(message: string): boolean {
  return /error: branch .* not found/i.test(message) || isMissingJjBookmarkError(message);
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
   *  and reused branches may be pushed from here before being fetched in workspacePath.
   *  New branches are still created locally in workspacePath. When omitted,
   *  all operations happen in workspacePath directly. */
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
): Promise<{ success: boolean; error?: string; fetchSucceeded?: boolean }> {
  if (hasRemote === false) {
    return { success: true, fetchSucceeded: false };
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
      return { success: true, fetchSucceeded: false };
    } else {
      return {
        success: false,
        error: `Failed to fetch in workspace: ${fetchResult.stderr}`,
      };
    }
  }

  return { success: true, fetchSucceeded: true };
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
 * unique name finding) happen there, and reused branches may be pushed from primary
 * before being fetched in workspacePath. New branches are created locally in
 * workspacePath. When primaryWorkspacePath is omitted, all operations happen directly
 * in workspacePath.
 *
 * This function:
 * 1. Detects VCS type (git vs jj)
 * 2. Fetches latest from remote in the primary workspace
 * 2a. If reuseExistingBranch: checks if branchName exists in primary, and if so
 *     fetches+checks it out in workspacePath + pulls latest
 * 3. Determines the base branch
 * 4. Finds a unique branch name in the primary workspace
 * 5. Creates the branch locally in workspacePath or checks out an existing remote branch
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

  // Track whether we have fresh remote data — stale-branch deletion is only safe
  // when remote refs are known to be up-to-date.
  let fetchSucceeded = false;
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
    } else {
      fetchSucceeded = true;
    }
  }

  const shouldCreateBranch = options.createBranch ?? true;

  // Determine base branch early so stale-branch cleanup can restore to it
  const baseBranch = options.baseBranch || (await getTrunkBranch(primaryPath));

  // Step 2: If reuseExistingBranch is enabled, check if the plan branch already exists
  // locally in the primary workspace or on the remote
  if (options.reuseExistingBranch && shouldCreateBranch) {
    const localExists = await branchExists(primaryPath, options.branchName, primaryIsJj);
    const remoteExists = await remoteBranchExists(primaryPath, options.branchName, primaryIsJj);
    const remoteOnlyExists = !localExists && remoteExists;
    const staleLocalOnlyBranch = localExists && !remoteExists && fetchSucceeded;

    if (staleLocalOnlyBranch) {
      log(
        `Branch "${options.branchName}" exists locally but not on remote; deleting stale branch and recreating from base`
      );

      // Use undefined for restoreBranch to fall back to getTrunkBranch — baseBranch may
      // not exist yet in the execution workspace if it hasn't been fetched.
      const deleteResult = await deleteLocalBranch(
        workspacePath,
        options.branchName,
        workspaceIsJj
      );
      if (
        !deleteResult.success &&
        !(hasSeparatePrimary && isMissingLocalBranchError(deleteResult.error ?? ''))
      ) {
        return {
          success: false,
          error: `Failed to delete stale branch "${options.branchName}": ${deleteResult.error ?? 'unknown error'}`,
        };
      }
    } else if (localExists || remoteOnlyExists) {
      log(
        `Found existing branch "${options.branchName}", checking out and pulling latest in workspace...`
      );

      // Push the branch from primary so the remote has the latest version,
      // then fetch in the workspace so it's available there.
      if (hasSeparatePrimary && hasRemote !== false && localExists) {
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
        const fetchResult = await fetchInWorkspace(
          workspacePath,
          workspaceIsJj,
          hasRemote,
          allowOffline
        );
        if (!fetchResult.success) {
          return { success: false, error: fetchResult.error };
        }
      } else if (hasSeparatePrimary) {
        const fetchResult = await fetchInWorkspace(
          workspacePath,
          workspaceIsJj,
          hasRemote,
          allowOffline
        );
        if (!fetchResult.success) {
          return { success: false, error: fetchResult.error };
        }
      }

      if (workspaceIsJj) {
        // Track remote version if it exists
        await spawnAndLogOutput(['jj', 'bookmark', 'track', options.branchName], {
          cwd: workspacePath,
          quiet: true,
        });

        // In case the bookmark is conflicted, set it to the origin version
        await spawnAndLogOutput(
          ['jj', 'bookmark', 'set', options.branchName, '-r', `${options.branchName}@origin`],
          {
            cwd: workspacePath,
            quiet: true,
          }
        );

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

        if (
          hasRemote !== false &&
          (await remoteBranchExists(workspacePath, options.branchName, workspaceIsJj))
        ) {
          const syncResult = await syncWorkspaceBranchFromRemote(
            workspacePath,
            options.branchName,
            workspaceIsJj
          );
          if (!syncResult.success) {
            return syncResult;
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

    // Branch doesn't exist locally -- fall through to create a new branch
  }

  // Step 3: Log the base branch
  log(`Using base branch: ${baseBranch}`);

  if (!shouldCreateBranch) {
    // When not creating a branch, just checkout the base in the workspace directly
    if (hasSeparatePrimary) {
      const fetchResult = await fetchInWorkspace(
        workspacePath,
        workspaceIsJj,
        hasRemote,
        allowOffline
      );
      if (!fetchResult.success) {
        return { success: false, error: fetchResult.error };
      }
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

  // Step 4: Find a unique branch name in the primary workspace.
  // When reuseExistingBranch is NOT set and we have a separate primary workspace,
  // also check remote refs here to avoid collisions with branches that this workspace
  // would later push to origin. When reuseExistingBranch is set, skip remote checks
  // here because branch existence was already handled earlier.
  if (!hasSeparatePrimary && fetchSucceeded) {
    const localExists = await branchExists(primaryPath, options.branchName, primaryIsJj);
    if (localExists && !(await remoteBranchExists(primaryPath, options.branchName, primaryIsJj))) {
      log(
        `Branch "${options.branchName}" exists locally but not on remote; deleting stale branch and recreating from base`
      );
      const deleteResult = await deleteLocalBranch(
        primaryPath,
        options.branchName,
        primaryIsJj,
        baseBranch
      );
      if (!deleteResult.success) {
        return {
          success: false,
          error: `Failed to delete stale branch "${options.branchName}": ${deleteResult.error ?? 'unknown error'}`,
        };
      }
    }
  }

  let actualBranchName = hasSeparatePrimary
    ? !options.reuseExistingBranch
      ? await findUniqueRemoteBranchName(primaryPath, options.branchName, primaryIsJj)
      : options.branchName
    : await findUniqueBranchName(primaryPath, options.branchName, primaryIsJj);

  // Step 5: For a separate workspace, fetch and check if the branch already exists on
  // the remote. If it does, check it out. Otherwise, create a new local branch from
  // the base branch.
  if (hasSeparatePrimary) {
    const fetchResult = await fetchInWorkspace(
      workspacePath,
      workspaceIsJj,
      hasRemote,
      allowOffline
    );
    if (!fetchResult.success) {
      return { success: false, error: fetchResult.error };
    }
    const workspaceFetchSucceeded = fetchResult.fetchSucceeded ?? false;

    const workspaceLocalExists = await branchExists(workspacePath, actualBranchName, workspaceIsJj);
    if (workspaceLocalExists) {
      const workspaceRemoteExists = await remoteBranchExists(
        workspacePath,
        actualBranchName,
        workspaceIsJj
      );

      if (!workspaceRemoteExists && workspaceFetchSucceeded) {
        log(
          `Branch "${actualBranchName}" exists locally in workspace but not on remote; deleting stale branch and recreating from base`
        );
        const deleteResult = await deleteLocalBranch(
          workspacePath,
          actualBranchName,
          workspaceIsJj,
          baseBranch
        );
        if (!deleteResult.success) {
          return {
            success: false,
            error: `Failed to delete stale branch "${actualBranchName}": ${deleteResult.error ?? 'unknown error'}`,
          };
        }
      } else if (options.reuseExistingBranch) {
        const branchResult = await checkoutWorkspaceBranch(
          workspacePath,
          actualBranchName,
          workspaceIsJj,
          options.planFilePath
        );

        if (!branchResult.success) {
          return branchResult;
        }

        if (workspaceRemoteExists) {
          const syncResult = await syncWorkspaceBranchFromRemote(
            workspacePath,
            actualBranchName,
            workspaceIsJj
          );
          if (!syncResult.success) {
            return syncResult;
          }
        }

        log(`Successfully prepared workspace with existing local branch "${actualBranchName}"`);
        return {
          success: true,
          actualBranchName,
          reusedExistingBranch: true,
        };
      } else {
        actualBranchName = await findUniqueBranchName(
          workspacePath,
          actualBranchName,
          workspaceIsJj,
          hasSeparatePrimary ? { checkRemote: true } : undefined
        );
      }
    }

    if (options.reuseExistingBranch) {
      const remoteExists = await remoteBranchExists(workspacePath, actualBranchName, workspaceIsJj);
      if (remoteExists) {
        const branchResult = await checkoutWorkspaceBranch(
          workspacePath,
          actualBranchName,
          workspaceIsJj,
          options.planFilePath
        );

        if (!branchResult.success) {
          return branchResult;
        }

        const syncResult = await syncWorkspaceBranchFromRemote(
          workspacePath,
          actualBranchName,
          workspaceIsJj
        );
        if (!syncResult.success) {
          return syncResult;
        }

        log(`Successfully prepared workspace with branch "${actualBranchName}"`);
        return {
          success: true,
          actualBranchName,
          reusedExistingBranch: true,
        };
      }
    }
  }

  // Create the branch locally in the workspace
  const branchResult = await createLocalWorkspaceBranch(
    workspacePath,
    baseBranch,
    actualBranchName,
    workspaceIsJj,
    options.planFilePath,
    hasRemote,
    allowOffline,
    options.updateBaseFromRemote ?? true
  );
  if (!branchResult.success) {
    return branchResult;
  }

  log(`Successfully prepared workspace with branch "${actualBranchName}"`);
  return {
    success: true,
    actualBranchName,
  };
}
