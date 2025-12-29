import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { log } from '../../logging.js';
import { WorkspaceLock, type LockInfo, type LockType } from './workspace_lock.js';
import { getCurrentBranchName } from '../../common/git.js';

/**
 * Interface representing detailed information about a created workspace
 */
export interface WorkspaceInfo {
  /** Unique identifier for the workspace */
  taskId: string;
  /** Absolute path to the plan file in the main repo, if workspace is associated with a plan */
  originalPlanFilePath?: string;
  /** Stable repository identity derived from the repo metadata */
  repositoryId?: string;
  /** Absolute path to the cloned workspace */
  workspacePath: string;
  /** Name of the branch that was created (optional, may not be set if createBranch was disabled) */
  branch?: string;
  /** ISO date string when the workspace was created */
  createdAt: string;
  /** Lock information if workspace is currently locked */
  lockedBy?: {
    type: LockType;
    pid?: number;
    startedAt: string;
    hostname: string;
    command: string;
  };

  // Extended metadata fields for workspace switcher
  /** Human-readable name for the workspace */
  name?: string;
  /** Description of what is being worked on in this workspace */
  description?: string;
  /** Plan ID associated with this workspace */
  planId?: string;
  /** Title of the associated plan */
  planTitle?: string;
  /** Issue URLs associated with the workspace */
  issueUrls?: string[];
  /** ISO date string when the workspace metadata was last updated */
  updatedAt?: string;
}

/**
 * Gets the default path to the global workspaces tracking file
 * @returns The default path to the tracking file
 */
export function getDefaultTrackingFilePath(): string {
  return path.join(os.homedir(), '.config', 'rmplan', 'workspaces.json');
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
 * Finds all workspaces for a given repository ID
 * @param repositoryId The repository ID to search for
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByRepositoryId(
  repositoryId: string,
  trackingFilePath?: string
): Promise<WorkspaceInfo[]> {
  const data = await readTrackingData(trackingFilePath);
  const normalizedSearchId = repositoryId.trim().toLowerCase();

  return Object.values(data).filter(
    (workspace) =>
      workspace.repositoryId && workspace.repositoryId.trim().toLowerCase() === normalizedSearchId
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
            type: lockInfo.type,
            pid: lockInfo.pid,
            startedAt: lockInfo.startedAt,
            hostname: lockInfo.hostname,
            command: lockInfo.command,
          },
        };
      }

      // Remove stale lock info if present
      const { lockedBy, ...workspaceWithoutLock } = workspace;
      return workspaceWithoutLock;
    })
  );
}

/**
 * Partial update object for workspace metadata.
 * Values of empty string ('') indicate the field should be cleared.
 * Undefined values are not changed.
 */
export interface WorkspaceMetadataPatch {
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  /** Setting to empty string clears the field */
  repositoryId?: string;
}

/**
 * Patches workspace metadata without overwriting unrelated fields.
 * If the workspace doesn't exist in the tracking file, creates a new entry
 * with minimal required fields.
 *
 * Empty strings ('') are treated as explicit clears: the field will be removed.
 * Empty arrays for issueUrls also clear that field.
 *
 * @param workspacePath The absolute path to the workspace
 * @param patch The partial metadata to merge
 * @param trackingFilePath The path to the tracking file (optional, uses default if not provided)
 * @returns The updated workspace info
 */
export async function patchWorkspaceMetadata(
  workspacePath: string,
  patch: WorkspaceMetadataPatch,
  trackingFilePath?: string
): Promise<WorkspaceInfo> {
  const data = await readTrackingData(trackingFilePath);

  let workspace = data[workspacePath];

  if (!workspace) {
    const taskId = deriveTaskIdForWorkspace(workspacePath, patch);
    // Create a new workspace entry with minimal required fields
    workspace = {
      taskId,
      workspacePath,
      createdAt: new Date().toISOString(),
    };
  }

  // Apply the patch, handling empty string as "clear"
  if (patch.name !== undefined) {
    if (patch.name === '') {
      delete workspace.name;
    } else {
      workspace.name = patch.name;
    }
  }

  if (patch.description !== undefined) {
    if (patch.description === '') {
      delete workspace.description;
    } else {
      workspace.description = patch.description;
    }
  }

  if (patch.planId !== undefined) {
    if (patch.planId === '') {
      delete workspace.planId;
    } else {
      workspace.planId = patch.planId;
    }
  }

  if (patch.planTitle !== undefined) {
    if (patch.planTitle === '') {
      delete workspace.planTitle;
    } else {
      workspace.planTitle = patch.planTitle;
    }
  }

  if (patch.issueUrls !== undefined) {
    if (patch.issueUrls.length === 0) {
      delete workspace.issueUrls;
    } else {
      workspace.issueUrls = patch.issueUrls;
    }
  }

  if (patch.repositoryId !== undefined) {
    if (patch.repositoryId === '') {
      delete workspace.repositoryId;
    } else {
      workspace.repositoryId = patch.repositoryId;
    }
  }

  // Always update the updatedAt timestamp
  workspace.updatedAt = new Date().toISOString();

  // Save back to the tracking file
  data[workspacePath] = workspace;
  await writeTrackingData(data, trackingFilePath);

  return workspace;
}

function deriveTaskIdForWorkspace(workspacePath: string, patch: WorkspaceMetadataPatch): string {
  const planId = patch.planId?.trim();
  if (planId) {
    return planId.startsWith('task-') ? planId : `task-${planId}`;
  }
  return path.basename(workspacePath);
}

/**
 * Structured entry for workspace list display and selection.
 * Contains all relevant fields for filtering and display.
 */
export interface WorkspaceListEntry {
  /** Full absolute path to the workspace */
  fullPath: string;
  /** Basename of the workspace directory */
  basename: string;
  /** Human-readable name (from metadata) */
  name?: string;
  /** Description of current work */
  description?: string;
  /** Current branch/bookmark (live computed) */
  branch?: string;
  /** Task ID */
  taskId: string;
  /** Plan title (from metadata) */
  planTitle?: string;
  /** Plan ID (from metadata) */
  planId?: string;
  /** Issue URLs (from metadata) */
  issueUrls?: string[];
  /** Repository ID */
  repositoryId?: string;
  /** Lock status */
  lockedBy?: WorkspaceInfo['lockedBy'];
  /** Created timestamp */
  createdAt: string;
  /** Updated timestamp */
  updatedAt?: string;
}

/**
 * Builds a list of workspace entries with live branch information.
 * Filters out workspaces whose directories no longer exist.
 *
 * @param workspaces Array of workspace info from the tracker
 * @returns Array of workspace list entries with computed branch info
 */
export async function buildWorkspaceListEntries(
  workspaces: WorkspaceInfo[]
): Promise<WorkspaceListEntry[]> {
  const entries: WorkspaceListEntry[] = [];

  for (const workspace of workspaces) {
    // Check if directory still exists
    try {
      const stats = await fs.stat(workspace.workspacePath);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      // Directory doesn't exist, skip
      continue;
    }

    // Get live branch info
    let branch: string | undefined;
    try {
      branch = (await getCurrentBranchName(workspace.workspacePath)) ?? undefined;
    } catch {
      // Branch detection failed, leave undefined
    }

    entries.push({
      fullPath: workspace.workspacePath,
      basename: path.basename(workspace.workspacePath),
      name: workspace.name,
      description: workspace.description,
      branch,
      taskId: workspace.taskId,
      planTitle: workspace.planTitle,
      planId: workspace.planId,
      issueUrls: workspace.issueUrls,
      repositoryId: workspace.repositoryId,
      lockedBy: workspace.lockedBy,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }

  return entries;
}
