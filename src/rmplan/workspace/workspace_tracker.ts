import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { log } from '../../logging.js';
import { WorkspaceLock, type LockInfo } from './workspace_lock.js';

/**
 * Interface representing detailed information about a created workspace
 */
export interface WorkspaceInfo {
  /** Unique identifier for the workspace */
  taskId: string;
  /** Absolute path to the plan file in the main repo, if workspace is associated with a plan */
  originalPlanFilePath?: string;
  /** URL of the repository that was cloned (optional for copy methods) */
  repositoryUrl?: string;
  /** Absolute path to the cloned workspace */
  workspacePath: string;
  /** Name of the branch that was created */
  branch: string;
  /** ISO date string when the workspace was created */
  createdAt: string;
  /** Lock information if workspace is currently locked */
  lockedBy?: {
    pid: number;
    startedAt: string;
    hostname: string;
  };
}

/**
 * Gets the default path to the global workspaces tracking file
 * @returns The default path to the tracking file
 */
export function getDefaultTrackingFilePath(): string {
  return path.join(os.homedir(), '.config', 'rmfilter', 'workspaces.json');
}

/**
 * Reads the workspace tracking data from the tracking file
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns A record mapping workspace paths to their metadata
 */
export async function readTrackingData(
  trackingFilePath?: string
): Promise<Record<string, WorkspaceInfo>> {
  try {
    const trackingPath = trackingFilePath || getDefaultTrackingFilePath();
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
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 */
export async function writeTrackingData(
  data: Record<string, WorkspaceInfo>,
  trackingFilePath?: string
): Promise<void> {
  try {
    const trackingPath = trackingFilePath || getDefaultTrackingFilePath();
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
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 */
export async function recordWorkspace(
  workspaceInfo: WorkspaceInfo,
  trackingFilePath?: string
): Promise<void> {
  try {
    // Read current tracking data
    const data = await readTrackingData(trackingFilePath);

    // Add or update the entry for this workspace
    data[workspaceInfo.workspacePath] = workspaceInfo;

    // Write updated tracking data
    await writeTrackingData(data, trackingFilePath);

    log(`Recorded workspace for task ${workspaceInfo.taskId} at ${workspaceInfo.workspacePath}`);
  } catch (error) {
    log(`Failed to record workspace: ${String(error)}`);
  }
}

/**
 * Gets metadata for a specific workspace
 * @param workspacePath The absolute path to the workspace
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns The workspace metadata if it exists, null otherwise
 */
export async function getWorkspaceMetadata(
  workspacePath: string,
  trackingFilePath?: string
): Promise<WorkspaceInfo | null> {
  const data = await readTrackingData(trackingFilePath);
  return data[workspacePath] || null;
}

/**
 * Finds all workspaces associated with a specific task ID
 * @param taskId The task ID to search for
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByTaskId(
  taskId: string,
  trackingFilePath?: string
): Promise<WorkspaceInfo[]> {
  const data = await readTrackingData(trackingFilePath);

  return Object.values(data).filter((workspace) => workspace.taskId === taskId);
}

/**
 * Finds all workspaces for a given repository URL
 * @param repositoryUrl The repository URL to search for
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByRepoUrl(
  repositoryUrl: string,
  trackingFilePath?: string
): Promise<WorkspaceInfo[]> {
  const data = await readTrackingData(trackingFilePath);

  // Normalize URLs for comparison (remove trailing .git and slashes)
  const normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '');
  const normalizedSearchUrl = normalizeUrl(repositoryUrl);

  return Object.values(data).filter(
    (workspace) => workspace.repositoryUrl && normalizeUrl(workspace.repositoryUrl) === normalizedSearchUrl
  );
}

/**
 * Updates workspace information with current lock status
 * @param workspaces Array of workspace information to update
 * @returns Updated workspace information with lock status
 */
export async function updateWorkspaceLockStatus(
  workspaces: WorkspaceInfo[]
): Promise<WorkspaceInfo[]> {
  return Promise.all(
    workspaces.map(async (workspace) => {
      const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);

      if (lockInfo && !(await WorkspaceLock.isLockStale(lockInfo))) {
        return {
          ...workspace,
          lockedBy: {
            pid: lockInfo.pid,
            startedAt: lockInfo.startedAt,
            hostname: lockInfo.hostname,
          },
        };
      }

      // Remove stale lock info if present
      const { lockedBy, ...workspaceWithoutLock } = workspace;
      return workspaceWithoutLock;
    })
  );
}
