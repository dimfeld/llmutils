import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { log } from '../logging.js';

/**
 * Interface representing detailed information about a created workspace
 */
export interface WorkspaceInfo {
  /** Unique identifier for the task */
  taskId: string;
  /** Absolute path to the plan file in the main repo */
  originalPlanFilePath: string;
  /** URL of the repository that was cloned */
  repositoryUrl: string;
  /** Absolute path to the cloned workspace */
  workspacePath: string;
  /** Name of the branch that was created */
  branch: string;
  /** ISO date string when the workspace was created */
  createdAt: string;
}

/**
 * Gets the path to the global workspaces tracking file
 * @returns The path to the tracking file
 */
export function getTrackingFilePath(): string {
  return path.join(os.homedir(), '.llmutils', 'workspaces.json');
}

/** Path to the global workspaces tracking file */
export const TRACKING_FILE_PATH = getTrackingFilePath();

/**
 * Reads the workspace tracking data from the tracking file
 * @returns A record mapping workspace paths to their metadata
 */
export async function readTrackingData(): Promise<Record<string, WorkspaceInfo>> {
  try {
    const trackingPath = getTrackingFilePath();
    const fileContents = await fs.readFile(trackingPath, 'utf-8');
    return JSON.parse(fileContents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist yet, return an empty object
      return {};
    }

    // If the file exists but can't be parsed, log an error and return an empty object
    log(`Error reading workspace tracking data: ${String(error)}`);
    return {};
  }
}

/**
 * Writes workspace tracking data to the tracking file
 * @param data The workspace data to write
 */
export async function writeTrackingData(data: Record<string, WorkspaceInfo>): Promise<void> {
  try {
    const trackingPath = getTrackingFilePath();
    // Ensure the directory exists
    await fs.mkdir(path.dirname(trackingPath), { recursive: true });
    
    // Write the data to the file, pretty-printed for readability
    await fs.writeFile(trackingPath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    log(`Error writing workspace tracking data: ${String(error)}`);
    throw error;
  }
}

/**
 * Records a workspace in the tracking file
 * @param workspaceInfo The workspace information to record
 */
export async function recordWorkspace(workspaceInfo: WorkspaceInfo): Promise<void> {
  try {
    // Read current tracking data
    const data = await readTrackingData();
    
    // Add or update the entry for this workspace
    data[workspaceInfo.workspacePath] = workspaceInfo;
    
    // Write updated tracking data
    await writeTrackingData(data);
    
    log(`Recorded workspace for task ${workspaceInfo.taskId} at ${workspaceInfo.workspacePath}`);
  } catch (error) {
    log(`Failed to record workspace: ${String(error)}`);
  }
}

/**
 * Gets metadata for a specific workspace
 * @param workspacePath The absolute path to the workspace
 * @returns The workspace metadata if it exists, null otherwise
 */
export async function getWorkspaceMetadata(workspacePath: string): Promise<WorkspaceInfo | null> {
  const data = await readTrackingData();
  return data[workspacePath] || null;
}

/**
 * Finds all workspaces associated with a specific task ID
 * @param taskId The task ID to search for
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByTaskId(taskId: string): Promise<WorkspaceInfo[]> {
  const data = await readTrackingData();
  
  return Object.values(data).filter(workspace => workspace.taskId === taskId);
}