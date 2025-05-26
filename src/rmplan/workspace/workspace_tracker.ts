import { log } from '../../logging.js';
import { WorkspaceLock, type LockInfo } from './workspace_lock.js';
import { db } from '../../bot/db/index.js';
import { workspaces as workspacesTable } from '../../bot/db/index.js';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

/**
 * Interface representing detailed information about a created workspace
 */
export interface WorkspaceInfo {
  /** Unique identifier for the workspace record */
  id: string;
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
  /** Task ID that currently has the workspace locked */
  lockedByTaskId?: string | null;
  /** ISO date string when the workspace was last accessed */
  lastAccessedAt?: string | Date | null;
  /** Filesystem lock information from .rmplan.lock file */
  fileSystemLock?: {
    pid: number;
    startedAt: string;
    hostname: string;
  } | null;
}

/**
 * Interface for recording a new workspace
 */
export interface WorkspaceRecordData {
  /** Unique identifier for the task */
  taskId: string;
  /** URL of the repository that was cloned */
  repositoryUrl: string;
  /** Absolute path to the cloned workspace */
  workspacePath: string;
  /** Name of the branch that was created */
  branch: string;
  /** Absolute path to the plan file in the main repo */
  originalPlanFile: string;
}

/**
 * Records a workspace in the database
 * @param workspaceData The workspace information to record
 * @returns The ID of the newly created workspace record
 */
export async function recordWorkspace(workspaceData: WorkspaceRecordData): Promise<string> {
  try {
    const id = randomUUID();
    await db.insert(workspacesTable).values({
      id,
      taskId: workspaceData.taskId,
      repositoryUrl: workspaceData.repositoryUrl,
      workspacePath: workspaceData.workspacePath,
      branch: workspaceData.branch,
      originalPlanFile: workspaceData.originalPlanFile,
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      lockedByTaskId: null,
    });

    log(
      `Recorded workspace in database for task ${workspaceData.taskId} at ${workspaceData.workspacePath}`
    );
    return id;
  } catch (error) {
    log(`Failed to record workspace in database: ${String(error)}`);
    throw error;
  }
}

/**
 * Gets metadata for a specific workspace
 * @param workspacePath The absolute path to the workspace
 * @returns The workspace metadata if it exists, null otherwise
 */
export async function getWorkspaceMetadata(workspacePath: string): Promise<WorkspaceInfo | null> {
  try {
    const result = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.workspacePath, workspacePath))
      .limit(1);

    if (result.length === 0) {
      return null;
    }

    const workspace = result[0];
    return {
      id: workspace.id,
      taskId: workspace.taskId,
      originalPlanFilePath: workspace.originalPlanFile || '',
      repositoryUrl: workspace.repositoryUrl,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      createdAt: workspace.createdAt.toISOString(),
      lockedByTaskId: workspace.lockedByTaskId,
      lastAccessedAt: workspace.lastAccessedAt,
    };
  } catch (error) {
    log(`Error getting workspace metadata: ${String(error)}`);
    return null;
  }
}

/**
 * Finds all workspaces associated with a specific task ID
 * @param taskId The task ID to search for
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByTaskId(taskId: string): Promise<WorkspaceInfo[]> {
  try {
    const results = await db
      .select()
      .from(workspacesTable)
      .where(eq(workspacesTable.taskId, taskId))
      .orderBy(desc(workspacesTable.createdAt));

    return results.map((workspace) => ({
      id: workspace.id,
      taskId: workspace.taskId,
      originalPlanFilePath: workspace.originalPlanFile || '',
      repositoryUrl: workspace.repositoryUrl,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      createdAt: workspace.createdAt.toISOString(),
      lockedByTaskId: workspace.lockedByTaskId,
      lastAccessedAt: workspace.lastAccessedAt,
    }));
  } catch (error) {
    log(`Error finding workspaces by task ID: ${String(error)}`);
    return [];
  }
}

/**
 * Finds all workspaces for a given repository URL
 * @param repositoryUrl The repository URL to search for
 * @returns An array of workspace information objects
 */
export async function findWorkspacesByRepoUrl(repositoryUrl: string): Promise<WorkspaceInfo[]> {
  try {
    // Normalize URLs for comparison (remove trailing .git and slashes)
    const normalizeUrl = (url: string) => url.replace(/\.git$/, '').replace(/\/$/, '');
    const normalizedSearchUrl = normalizeUrl(repositoryUrl);

    // Get all workspaces and filter in memory since SQLite doesn't have regex replace
    const results = await db.select().from(workspacesTable);

    const matchingWorkspaces = results.filter(
      (workspace) => normalizeUrl(workspace.repositoryUrl) === normalizedSearchUrl
    );

    return matchingWorkspaces.map((workspace) => ({
      id: workspace.id,
      taskId: workspace.taskId,
      originalPlanFilePath: workspace.originalPlanFile || '',
      repositoryUrl: workspace.repositoryUrl,
      workspacePath: workspace.workspacePath,
      branch: workspace.branch,
      createdAt: workspace.createdAt.toISOString(),
      lockedByTaskId: workspace.lockedByTaskId,
      lastAccessedAt: workspace.lastAccessedAt,
    }));
  } catch (error) {
    log(`Error finding workspaces by repository URL: ${String(error)}`);
    return [];
  }
}

/**
 * Updates workspace information with current lock status from the filesystem
 * @param workspaces Array of workspace information to update
 * @returns Updated workspace information with lock status
 */
export async function updateWorkspaceLockStatus(
  workspaces: WorkspaceInfo[]
): Promise<WorkspaceInfo[]> {
  // Update last accessed times for all workspaces
  const workspaceIds = workspaces.map((w) => w.id);
  await touchWorkspaces(workspaceIds);

  return Promise.all(
    workspaces.map(async (workspace) => {
      const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);

      if (lockInfo && !(await WorkspaceLock.isLockStale(lockInfo))) {
        // Populate filesystem lock info
        return {
          ...workspace,
          fileSystemLock: {
            pid: lockInfo.pid,
            startedAt: lockInfo.startedAt,
            hostname: lockInfo.hostname,
          },
        };
      }

      // No active filesystem lock
      return {
        ...workspace,
        fileSystemLock: null,
      };
    })
  );
}

/**
 * Updates the last accessed timestamp for a workspace
 * @param workspacePath The absolute path to the workspace
 */
export async function updateWorkspaceLastAccessed(workspacePath: string): Promise<void> {
  try {
    await db
      .update(workspacesTable)
      .set({ lastAccessedAt: new Date() })
      .where(eq(workspacesTable.workspacePath, workspacePath));
  } catch (error) {
    log(`Error updating workspace last accessed time: ${String(error)}`);
  }
}

/**
 * Locks a workspace to a specific task
 * @param workspacePath The absolute path to the workspace
 * @param taskId The task ID that should lock the workspace
 */
export async function lockWorkspaceToTask(workspacePath: string, taskId: string): Promise<void> {
  try {
    await db
      .update(workspacesTable)
      .set({ lockedByTaskId: taskId })
      .where(eq(workspacesTable.workspacePath, workspacePath));
  } catch (error) {
    log(`Error locking workspace to task: ${String(error)}`);
    throw error;
  }
}

/**
 * Unlocks a workspace from a task
 * @param workspacePath The absolute path to the workspace
 */
export async function unlockWorkspace(workspacePath: string): Promise<void> {
  try {
    await db
      .update(workspacesTable)
      .set({ lockedByTaskId: null })
      .where(eq(workspacesTable.workspacePath, workspacePath));
  } catch (error) {
    log(`Error unlocking workspace: ${String(error)}`);
    throw error;
  }
}

/**
 * Updates the last accessed timestamp for multiple workspaces
 * @param workspaceIds Array of workspace IDs to update
 */
export async function touchWorkspaces(workspaceIds: string[]): Promise<void> {
  if (workspaceIds.length === 0) return;

  try {
    await db
      .update(workspacesTable)
      .set({ lastAccessedAt: new Date() })
      .where(sql`${workspacesTable.id} IN ${workspaceIds}`);
  } catch (error) {
    log(`Error updating workspace last accessed times: ${String(error)}`);
  }
}
