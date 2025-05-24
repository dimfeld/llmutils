import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { debugLog, log } from '../logging.js';
import { spawnAndLogOutput } from '../rmfilter/utils.js';
import { executePostApplyCommand } from './actions.js';
import type { PostApplyCommand, RmplanConfig } from './configSchema.js';
import { WorkspaceLock } from './workspace_lock.js';
import { getDefaultTrackingFilePath, recordWorkspace } from './workspace_tracker.js';

/**
 * Interface representing a created workspace
 */
export interface Workspace {
  /** Absolute path to the workspace */
  path: string;
  /** Absolute path to the original plan file */
  originalPlanFilePath: string;
  /** Unique identifier for the task */
  taskId: string;
}

/**
 * Creates a new workspace for a task based on the provided configuration
 * @param mainRepoRoot The git root of the main repository
 * @param taskId Unique identifier for the task
 * @param originalPlanFilePath Absolute path to the original plan file
 * @param config Configuration for rmplan
 * @returns A Workspace object if successful, null otherwise
 */
export async function createWorkspace(
  mainRepoRoot: string,
  taskId: string,
  originalPlanFilePath: string,
  config: RmplanConfig
): Promise<Workspace | null> {
  // Check if workspace creation is enabled in the config
  if (!config.workspaceCreation) {
    log('Workspace creation not enabled in config');
    return null;
  }

  log('Creating workspace...');

  const workspaceConfig = config.workspaceCreation;

  // Step 1: Infer repository URL if not provided
  let repositoryUrl = workspaceConfig.repositoryUrl;
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
  // Extract repo name from URL
  const repoName =
    repositoryUrl
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') || 'repo';

  const targetClonePath = path.join(cloneLocationBase, `${repoName}-${taskId}`);

  // Step 4: Clone the repository
  try {
    log(`Cloning repository ${repositoryUrl} to ${targetClonePath}`);
    const { exitCode, stderr } = await spawnAndLogOutput(
      ['git', 'clone', repositoryUrl, targetClonePath],
      {
        cwd: mainRepoRoot,
      }
    );

    if (exitCode !== 0) {
      log(`Failed to clone repository: ${stderr}`);
      return null;
    }
  } catch (error) {
    log(`Error cloning repository: ${String(error)}`);
    return null;
  }

  // Step 5: Create and checkout a new branch
  const branchName = `llmutils-task/${taskId}`;
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

  // Step 6: Run post-clone commands if specified
  if (workspaceConfig.postCloneCommands?.length) {
    log('Running post-clone commands');

    for (const commandConfig of workspaceConfig.postCloneCommands) {
      // Add task-specific environment variables to the command config
      // Note: We don't resolve workingDirectory here, as executePostApplyCommand
      // will resolve it against targetClonePath. This is documented in its implementation.
      const commandWithEnv: PostApplyCommand = {
        ...commandConfig,
        env: {
          ...commandConfig.env,
          LLMUTILS_TASK_ID: taskId,
          LLMUTILS_PLAN_FILE_PATH: originalPlanFilePath,
        },
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
  const workspace = {
    path: targetClonePath,
    originalPlanFilePath,
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
