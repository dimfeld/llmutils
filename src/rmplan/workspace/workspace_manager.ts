import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { debugLog, log } from '../../logging.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { executePostApplyCommand } from '../actions.js';
import type { PostApplyCommand, RmplanConfig } from '../configSchema.js';
import { WorkspaceLock } from './workspace_lock.js';
import { getDefaultTrackingFilePath, recordWorkspace } from './workspace_tracker.js';

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
async function cloneWithCp(sourceDir: string, targetPath: string): Promise<boolean> {
  try {
    log(`Copying directory ${sourceDir} to ${targetPath}`);
    const { exitCode, stderr } = await spawnAndLogOutput(['cp', '-r', sourceDir, targetPath]);

    if (exitCode !== 0) {
      log(`Failed to copy directory: ${stderr}`);
      return false;
    }

    // Initialize git repository in the copied directory
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
  } catch (error) {
    log(`Error copying directory: ${String(error)}`);
    return false;
  }
}

/**
 * Clone using macOS APFS copy-on-write (fastest on compatible systems)
 */
async function cloneWithMacCow(sourceDir: string, targetPath: string): Promise<boolean> {
  // Check if we're on macOS
  if (os.platform() !== 'darwin') {
    log('mac-cow clone method is only available on macOS');
    return false;
  }

  try {
    log(`Creating APFS copy-on-write clone ${sourceDir} to ${targetPath}`);
    const { exitCode, stderr } = await spawnAndLogOutput(['cp', '-c', sourceDir, targetPath]);

    if (exitCode !== 0) {
      log(`Failed to create copy-on-write clone: ${stderr}`);
      // Fall back to regular cp if copy-on-write is not supported
      log('Falling back to regular copy method');
      return await cloneWithCp(sourceDir, targetPath);
    }

    // Initialize git repository in the copied directory
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
  } catch (error) {
    log(`Error creating copy-on-write clone: ${String(error)}`);
    // Fall back to regular cp method
    log('Falling back to regular copy method');
    return await cloneWithCp(sourceDir, targetPath);
  }
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
    // For cp and mac-cow methods, source directory is required
    if (!sourceDirectory) {
      log(`Source directory is required for '${cloneMethod}' clone method`);
      return null;
    }
    // Resolve source directory path
    if (!path.isAbsolute(sourceDirectory)) {
      sourceDirectory = path.resolve(mainRepoRoot, sourceDirectory);
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
    cloneSuccess = await cloneWithCp(sourceDirectory, targetClonePath);
  } else if (cloneMethod === 'mac-cow' && sourceDirectory) {
    cloneSuccess = await cloneWithMacCow(sourceDirectory, targetClonePath);
  }

  if (!cloneSuccess) {
    return null;
  }

  // Step 4.5: Set up git remote for copy methods
  if ((cloneMethod === 'cp' || cloneMethod === 'mac-cow') && repositoryUrl) {
    await setupGitRemote(targetClonePath, repositoryUrl);
  }

  // Step 5: Create and checkout a new branch
  const branchName = `llmutils-ws/${taskId}`;
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

  // Step 6: Copy plan file if provided
  let planFilePathInWorkspace: string | undefined;
  if (originalPlanFilePath) {
    const planFileName = path.basename(originalPlanFilePath);
    planFilePathInWorkspace = path.join(targetClonePath, planFileName);

    try {
      log(`Copying plan file to workspace: ${planFileName}`);
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
      const success = await executePostApplyCommand(commandWithEnv, targetClonePath);

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
  await recordWorkspace(
    {
      taskId,
      originalPlanFilePath,
      repositoryUrl: repositoryUrl,
      workspacePath: targetClonePath,
      branch: branchName,
      createdAt: new Date().toISOString(),
    },
    trackingFilePath
  );

  // Acquire lock for the workspace
  try {
    await WorkspaceLock.acquireLock(targetClonePath, `rmplan agent --workspace ${taskId}`);
    WorkspaceLock.setupCleanupHandlers(targetClonePath);
  } catch (error) {
    log(`Warning: Failed to acquire workspace lock: ${String(error)}`);
    // Continue without lock - this isn't fatal
  }

  // Return the workspace information
  return workspace;
}
