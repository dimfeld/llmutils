import * as fs from 'node:fs/promises';
import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import PQueue from 'p-queue';
import { debugLog, log } from '../../logging.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { executePostApplyCommand } from '../actions.js';
import type { PostApplyCommand, RmplanConfig } from '../configSchema.js';
import { WorkspaceLock } from './workspace_lock.js';
import { getDefaultTrackingFilePath, recordWorkspace } from './workspace_tracker.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

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
  await includeDirectoryTreeIfExists(files, sourceDir, '.rmfilter/config/rmplan.local.yml');
  await includeDirectoryTreeIfExists(files, sourceDir, '.claude/settings.local.json');

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
    queue.add(async () => {
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
 * @param config Configuration for rmplan
 * @returns A Workspace object if successful, null otherwise
 */
export async function createWorkspace(
  mainRepoRoot: string,
  taskId: string,
  originalPlanFilePath: string | undefined,
  config: RmplanConfig
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
    // For cp and mac-cow methods, default to mainRepoRoot if source directory not specified
    if (!sourceDirectory) {
      sourceDirectory = mainRepoRoot;
      log(`Using main repository root as source directory: ${sourceDirectory}`);
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
    log(`Unknown clone method: ${cloneMethod}`);
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

  // Step 3: Construct the target directory name
  // Extract repo name from URL or source directory
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

  const targetClonePath = path.join(cloneLocationBase, `${repoName}-${taskId}`);

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

  // Step 5: Create and checkout a new branch (if enabled)
  const branchName = `llmutils-ws/${taskId}`;
  const shouldCreateBranch = workspaceConfig.createBranch ?? false;

  if (shouldCreateBranch) {
    try {
      log(`Creating and checking out branch ${branchName}`);
      const { exitCode, stderr } = await spawnAndLogOutput(['git', 'checkout', '-b', branchName], {
        cwd: targetClonePath,
      });

      if (exitCode !== 0) {
        log(`Failed to create and checkout branch: ${stderr}`);
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

  // Step 6: Copy plan file if provided
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
  const trackingFilePath = config.paths?.trackingFile || getDefaultTrackingFilePath();
  let repositoryId: string | undefined;
  try {
    const identity = await getRepositoryIdentity({ cwd: targetClonePath });
    repositoryId = identity.repositoryId;
  } catch (error) {
    log(`Warning: Failed to resolve repository identity for workspace: ${String(error)}`);
  }
  await recordWorkspace(
    {
      taskId,
      originalPlanFilePath,
      repositoryId,
      workspacePath: targetClonePath,
      name: taskId,
      branch: shouldCreateBranch ? branchName : undefined,
      createdAt: new Date().toISOString(),
    },
    trackingFilePath
  );

  // Acquire lock for the workspace
  try {
    const lockInfo = await WorkspaceLock.acquireLock(
      targetClonePath,
      `rmplan agent --workspace ${taskId}`
    );
    WorkspaceLock.setupCleanupHandlers(targetClonePath, lockInfo.type);
  } catch (error) {
    log(`Warning: Failed to acquire workspace lock: ${String(error)}`);
    // Continue without lock - this isn't fatal
  }

  // Return the workspace information
  return workspace;
}
