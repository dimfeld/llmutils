import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';
import { log, debugLog } from '../logging.js';
import { spawnAndLogOutput, getGitRoot, parseCliArgsFromString } from '../rmfilter/utils.js';
import type { RmplanConfig, WorkspaceCreationConfig, PostApplyCommand } from './configSchema.js';
import { executePostApplyCommand } from './actions.js';

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
 * Type for WorkspaceCreationConfig with required script path
 */
type WorkspaceCreationConfigRequired = WorkspaceCreationConfig & {
  scriptPath: string;
};

/**
 * Class responsible for creating and managing workspaces for rmplan agents
 */
export class WorkspaceManager {
  /**
   * Constructor for the WorkspaceManager
   * @param mainRepoRoot The git root of the main repository
   */
  constructor(private mainRepoRoot: string) {}

  /**
   * Creates a new workspace for a task based on the provided configuration
   * @param taskId Unique identifier for the task
   * @param originalPlanFilePath Absolute path to the original plan file
   * @param config Configuration for rmplan
   * @returns A Workspace object if successful, null otherwise
   */
  public async createWorkspace(
    taskId: string,
    originalPlanFilePath: string,
    config: RmplanConfig
  ): Promise<Workspace | null> {
    // Check if workspace creation is enabled in the config
    if (!config.workspaceCreation || !config.workspaceCreation.method) {
      log('Workspace creation not enabled in config');
      return null;
    }

    // Create workspace based on configured method
    if (config.workspaceCreation.method === 'script') {
      if (!config.workspaceCreation.scriptPath) {
        log('Script path not specified for script-based workspace creation');
        return null;
      }

      return this._createWithScript(
        taskId,
        originalPlanFilePath,
        config.workspaceCreation as WorkspaceCreationConfigRequired
      );
    } else if (config.workspaceCreation.method === 'llmutils') {
      return this._createWithLlmUtils(taskId, originalPlanFilePath, config.workspaceCreation);
    }

    return null;
  }

  /**
   * Creates a workspace using a user-defined script
   * @param taskId Unique identifier for the task
   * @param originalPlanFilePath Absolute path to the original plan file
   * @param workspaceConfig Workspace creation configuration
   * @returns A Workspace object if successful, null otherwise
   */
  private async _createWithScript(
    taskId: string,
    originalPlanFilePath: string,
    workspaceConfig: WorkspaceCreationConfigRequired
  ): Promise<Workspace | null> {
    log('Creating workspace using script-based method');

    // Resolve script path (if relative, it's relative to mainRepoRoot)
    const scriptPath = path.isAbsolute(workspaceConfig.scriptPath)
      ? workspaceConfig.scriptPath
      : path.resolve(this.mainRepoRoot, workspaceConfig.scriptPath);

    // Check if script exists and is executable
    try {
      const stats = await fs.stat(scriptPath);

      // On Unix-like systems, check if the file is executable
      if (process.platform !== 'win32') {
        const isExecutable = !!(stats.mode & 0o111);
        if (!isExecutable) {
          log(`Script ${scriptPath} exists but is not executable. Setting executable permission.`);
          await fs.chmod(scriptPath, stats.mode | 0o111);
        }
      }
    } catch (error) {
      log(`Error accessing script at ${scriptPath}: ${String(error)}`);
      return null;
    }

    // Execute the script with environment variables for the task
    const { exitCode, stdout, stderr } = await spawnAndLogOutput([scriptPath], {
      cwd: this.mainRepoRoot,
      env: {
        ...process.env,
        LLMUTILS_TASK_ID: taskId,
        LLMUTILS_PLAN_FILE_PATH: originalPlanFilePath,
      },
    });

    // Check if script execution was successful
    if (exitCode !== 0) {
      log(`Workspace creation script failed with exit code ${exitCode}`);
      return null;
    }

    // Script should output the workspace path to stdout
    const workspacePath = stdout.trim();
    if (!workspacePath) {
      log('Workspace creation script did not output a path');
      return null;
    }

    // Verify the workspace path exists and is a directory
    try {
      const stats = await fs.stat(workspacePath);
      if (!stats.isDirectory()) {
        log(`Path returned by script is not a directory: ${workspacePath}`);
        return null;
      }
    } catch (error) {
      log(`Error accessing workspace at ${workspacePath}: ${String(error)}`);
      return null;
    }

    debugLog(`Successfully created workspace at ${workspacePath}`);

    // Return the workspace information
    return {
      path: workspacePath,
      originalPlanFilePath,
      taskId,
    };
  }

  // For testing purposes only - allows tests to override homedir
  private _homeDirForTests?: string;

  /**
   * Creates a workspace by cloning a repository and creating a new branch using llmutils method
   * @param taskId Unique identifier for the task
   * @param originalPlanFilePath Absolute path to the original plan file
   * @param workspaceConfig Workspace creation configuration
   * @returns A Workspace object if successful, null otherwise
   */
  private async _createWithLlmUtils(
    taskId: string,
    originalPlanFilePath: string,
    workspaceConfig: WorkspaceCreationConfig
  ): Promise<Workspace | null> {
    log('Creating workspace using llmutils-based method');

    // Step 1: Infer repository URL if not provided
    let repositoryUrl = workspaceConfig.repositoryUrl;
    if (!repositoryUrl) {
      try {
        const { exitCode, stdout, stderr } = await spawnAndLogOutput(
          ['git', 'remote', 'get-url', 'origin'],
          { cwd: this.mainRepoRoot }
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
    let cloneLocationBase: string;
    if (workspaceConfig.cloneLocation) {
      // If relative, resolve against mainRepoRoot
      cloneLocationBase = path.isAbsolute(workspaceConfig.cloneLocation)
        ? workspaceConfig.cloneLocation
        : path.resolve(this.mainRepoRoot, workspaceConfig.cloneLocation);
    } else {
      // Default location is ~/.llmutils/workspaces
      // Use _homeDirForTests if provided (for testing only), otherwise use os.homedir()
      const homeDir = this._homeDirForTests || os.homedir();
      cloneLocationBase = path.join(homeDir, '.llmutils', 'workspaces');
    }

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
          cwd: this.mainRepoRoot,
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

    // Return the workspace information
    return {
      path: targetClonePath,
      originalPlanFilePath,
      taskId,
    };
  }
}
