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
import { recordWorkspace, setWorkspaceIssues } from '../db/workspace.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { buildDescriptionFromPlan } from '../display_utils.js';
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
  /** Path to the copied plan file within the workspace, if a plan was copied */
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
  options?: { branchName?: string; planData?: PlanSchema; fromBranch?: string; targetDir?: string }
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

  // Detect VCS type by checking for .jj directory
  const jjPath = path.join(targetClonePath, '.jj');
  let isJj = false;
  try {
    const stats = await fs.stat(jjPath);
    isJj = stats.isDirectory();
  } catch {
    // Not a jj repository
  }

  const branchName = options?.branchName ?? taskId;
  const shouldCreateBranch = workspaceConfig.createBranch ?? false;
  let jjNewCreated = false;

  // Step 5: Checkout base branch if provided
  if (options?.fromBranch) {
    log(`Checking out base branch "${options.fromBranch}"`);
    const { exitCode, stderr } = isJj
      ? await spawnAndLogOutput(
          shouldCreateBranch
            ? ['jj', 'new', options.fromBranch]
            : ['jj', 'edit', options.fromBranch],
          {
            cwd: targetClonePath,
          }
        )
      : await spawnAndLogOutput(['git', 'checkout', options.fromBranch], {
          cwd: targetClonePath,
        });

    if (isJj && shouldCreateBranch) {
      jjNewCreated = exitCode === 0;
    }

    if (exitCode !== 0) {
      log(`Failed to checkout base branch "${options.fromBranch}": ${stderr}`);
      try {
        await fs.rm(targetClonePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }
  }

  // Step 6: Create and checkout a new branch (if enabled)
  if (shouldCreateBranch) {
    try {
      log(`Creating and checking out branch ${branchName}`);
      let createResult;
      if (isJj) {
        if (!jjNewCreated) {
          createResult = await spawnAndLogOutput(['jj', 'new'], { cwd: targetClonePath });
          if (createResult.exitCode !== 0) {
            log(`Failed to create new change: ${createResult.stderr}`);
            try {
              await fs.rm(targetClonePath, { recursive: true, force: true });
            } catch {
              // Ignore cleanup errors
            }
            return null;
          }
        }
        createResult = await spawnAndLogOutput(['jj', 'bookmark', 'set', branchName], {
          cwd: targetClonePath,
        });
      } else {
        createResult = await spawnAndLogOutput(['git', 'checkout', '-b', branchName], {
          cwd: targetClonePath,
        });
      }

      if (createResult.exitCode !== 0) {
        log(`Failed to create and checkout branch: ${createResult.stderr}`);
        // Consider cleaning up the clone
        try {
          await fs.rm(targetClonePath, { recursive: true, force: true });
        } catch {
          // Ignore cleanup errors
        }
        return null;
      }
    } catch (error) {
      log(`Error creating branch: ${String(error)}`);
      return null;
    }
  }

  // Step 7: Copy plan file if provided
  let planFilePathInWorkspace: string | undefined;
  if (originalPlanFilePath) {
    // Preserve the relative path structure from the original repository
    const relativePlanPath = path.relative(mainRepoRoot, originalPlanFilePath);
    planFilePathInWorkspace = path.join(targetClonePath, relativePlanPath);
    const planFileDir = path.dirname(planFilePathInWorkspace);

    try {
      // Ensure the directory structure exists in the workspace
      await fs.mkdir(planFileDir, { recursive: true });

      log(`Copying plan file to workspace: ${relativePlanPath}`);
      await fs.copyFile(originalPlanFilePath, planFilePathInWorkspace);
    } catch (error) {
      log(`Error copying plan file: ${String(error)}`);
      // Clean up the clone
      try {
        await fs.rm(targetClonePath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      return null;
    }
  }

  // Step 8: Run post-clone commands if specified
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
 * Finds a unique branch name by appending suffixes (-2, -3, etc.) if the name already exists.
 * Supports both Git and Jujutsu repositories.
 *
 * @param workspacePath - Path to the workspace
 * @param baseName - Base name for the branch
 * @param isJj - Whether the workspace uses Jujutsu
 * @returns A unique branch name (may include suffix)
 */
export async function findUniqueBranchName(
  workspacePath: string,
  baseName: string,
  isJj: boolean
): Promise<string> {
  let candidate = baseName;
  let suffix = 2;

  while (await branchExists(workspacePath, candidate, isJj)) {
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

/**
 * Options for preparing an existing workspace for reuse.
 */
export interface PrepareWorkspaceOptions {
  /** Branch to checkout before creating new branch (default: auto-detect trunk) */
  baseBranch?: string;
  /** Name of new branch to create */
  branchName: string;
  /** Whether to create a new branch (default: true) */
  createBranch?: boolean;
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
}

/**
 * Prepares an existing workspace for reuse by fetching, checking out base branch,
 * and creating a new working branch.
 *
 * This function:
 * 1. Detects VCS type (git vs jj)
 * 2. Fetches latest from remote
 * 3. Checks out the base branch
 * 4. Finds a unique branch name (auto-suffixing if needed)
 * 5. Creates and checks out the new branch (if enabled)
 *
 * @param workspacePath - Absolute path to the workspace
 * @param options - Options including base branch and new branch name
 * @returns Result indicating success/failure and actual branch name used
 */
export async function prepareExistingWorkspace(
  workspacePath: string,
  options: PrepareWorkspaceOptions
): Promise<PrepareWorkspaceResult> {
  // Detect VCS type by checking for .jj directory
  const jjPath = path.join(workspacePath, '.jj');
  let isJj = false;
  try {
    const stats = await fs.stat(jjPath);
    isJj = stats.isDirectory();
  } catch {
    // Not a jj repository
  }

  const allowOffline = process.env.ALLOW_OFFLINE === 'true' || process.env.ALLOW_OFFLINE === '1';

  const logMissingRemote = () => {
    log('Warning: No remote configured; skipping fetch.');
  };

  const isMissingRemoteError = (message: string) => {
    return /no such remote|no remotes configured|unknown remote/i.test(message);
  };

  // Step 1: Fetch latest from remote
  let hasRemote: boolean | null = null;
  if (isJj) {
    const remoteList = await spawnAndLogOutput(['jj', 'git', 'remote', 'list'], {
      cwd: workspacePath,
    });
    if (remoteList.exitCode === 0) {
      hasRemote = remoteList.stdout.trim().length > 0;
    }
  } else {
    const remoteCheck = await spawnAndLogOutput(['git', 'remote', 'get-url', 'origin'], {
      cwd: workspacePath,
    });
    hasRemote = remoteCheck.exitCode === 0;
  }

  if (hasRemote === false) {
    logMissingRemote();
  } else {
    log('Fetching latest changes from remote...');
    const fetchResult = isJj
      ? await spawnAndLogOutput(['jj', 'git', 'fetch'], { cwd: workspacePath })
      : await spawnAndLogOutput(['git', 'fetch', 'origin'], { cwd: workspacePath });

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

  // Step 2: Determine base branch
  const baseBranch = options.baseBranch || (await getTrunkBranch(workspacePath));
  log(`Using base branch: ${baseBranch}`);

  const shouldCreateBranch = options.createBranch ?? false;

  // Step 3: Checkout base branch or create a new change
  log(`Checking out base branch "${baseBranch}"...`);
  if (isJj && !shouldCreateBranch) {
    const checkoutResult = await spawnAndLogOutput(['jj', 'edit', baseBranch], {
      cwd: workspacePath,
    });
    if (checkoutResult.exitCode !== 0) {
      return {
        success: false,
        error: `Failed to checkout base branch "${baseBranch}": ${checkoutResult.stderr}`,
      };
    }

    log('Skipping branch creation (createBranch=false)');
    return {
      success: true,
      actualBranchName: baseBranch,
    };
  }

  const checkoutResult = isJj
    ? await spawnAndLogOutput(['jj', 'new', baseBranch], { cwd: workspacePath })
    : await spawnAndLogOutput(['git', 'checkout', baseBranch], { cwd: workspacePath });

  if (checkoutResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to checkout base branch "${baseBranch}": ${checkoutResult.stderr}`,
    };
  }

  if (!shouldCreateBranch) {
    log('Skipping branch creation (createBranch=false)');
    return {
      success: true,
      actualBranchName: baseBranch,
    };
  }

  // Step 4: Find unique branch name
  const actualBranchName = await findUniqueBranchName(workspacePath, options.branchName, isJj);

  // Step 5: Create new branch
  log(`Creating new branch "${actualBranchName}"...`);
  // For jj, we already created a new change with "jj new", now set the bookmark
  // For git, create and checkout a new branch
  const createBranchResult = isJj
    ? await spawnAndLogOutput(['jj', 'bookmark', 'set', actualBranchName], { cwd: workspacePath })
    : await spawnAndLogOutput(['git', 'checkout', '-b', actualBranchName], { cwd: workspacePath });

  if (createBranchResult.exitCode !== 0) {
    return {
      success: false,
      error: `Failed to create branch "${actualBranchName}": ${createBranchResult.stderr}`,
    };
  }

  log(`Successfully prepared workspace with branch "${actualBranchName}"`);
  return {
    success: true,
    actualBranchName,
  };
}
