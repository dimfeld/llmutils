import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, debugLog } from '../logging.js';
import { spawnAndLogOutput, getGitRoot } from '../rmfilter/utils.js';
import type { RmplanConfig, WorkspaceCreationConfig } from './configSchema.js';

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
      log('LLMUtils-based workspace creation not yet implemented');
      return null;
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
      log(`Error accessing script at ${scriptPath}: ${error}`);
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
      log(`Error accessing workspace at ${workspacePath}: ${error}`);
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
}
