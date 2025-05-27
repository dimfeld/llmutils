import { db } from './index.js';
import { workspaces as workspacesTable, tasks } from './schema.js';
import { eq, and, lt, or, isNull, inArray } from 'drizzle-orm';

export interface Workspace {
  id: string;
  taskId: string;
  repositoryUrl: string;
  workspacePath: string;
  branch: string;
  originalPlanFile: string | null;
  createdAt: Date;
  lastAccessedAt: Date | null;
  lockedByTaskId: string | null;
}

/**
 * Gets workspaces that are inactive and can be unlocked/deleted.
 * A workspace is considered unlockable if:
 * - It hasn't been accessed since the specified date
 * - AND either:
 *   - It's not locked by any task (lockedByTaskId is NULL)
 *   - OR it's locked by a task that is in a final state (completed/failed)
 *
 * @param inactiveSince Date threshold - workspaces not accessed since this date
 * @returns Array of workspaces that can be cleaned up
 */
export async function getUnlockableInactiveWorkspaces(inactiveSince: Date): Promise<Workspace[]> {
  // First, get all workspaces that haven't been accessed since the specified date
  const inactiveWorkspaces = await db
    .select({
      id: workspacesTable.id,
      taskId: workspacesTable.taskId,
      repositoryUrl: workspacesTable.repositoryUrl,
      workspacePath: workspacesTable.workspacePath,
      branch: workspacesTable.branch,
      originalPlanFile: workspacesTable.originalPlanFile,
      createdAt: workspacesTable.createdAt,
      lastAccessedAt: workspacesTable.lastAccessedAt,
      lockedByTaskId: workspacesTable.lockedByTaskId,
    })
    .from(workspacesTable)
    .where(
      or(lt(workspacesTable.lastAccessedAt, inactiveSince), isNull(workspacesTable.lastAccessedAt))
    );

  // If no inactive workspaces, return empty array
  if (inactiveWorkspaces.length === 0) {
    return [];
  }

  // For workspaces that are locked, check if the locking task is in a final state
  const lockedWorkspaces = inactiveWorkspaces.filter((w) => w.lockedByTaskId !== null);
  const unlockedWorkspaces = inactiveWorkspaces.filter((w) => w.lockedByTaskId === null);

  // Get the task IDs for locked workspaces
  const taskIds = lockedWorkspaces.map((w) => w.lockedByTaskId!).filter(Boolean);

  let finalStateTasks: string[] = [];
  if (taskIds.length > 0) {
    // Query tasks to find which ones are in final states
    const tasksInFinalState = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          inArray(tasks.id, taskIds),
          or(eq(tasks.status, 'completed'), eq(tasks.status, 'failed'))
        )
      );

    finalStateTasks = tasksInFinalState.map((t) => t.id);
  }

  // Filter locked workspaces to only include those locked by tasks in final states
  const unlockableLockedWorkspaces = lockedWorkspaces.filter(
    (w) => w.lockedByTaskId && finalStateTasks.includes(w.lockedByTaskId)
  );

  // Combine unlocked workspaces and workspaces locked by completed/failed tasks
  return [...unlockedWorkspaces, ...unlockableLockedWorkspaces];
}

/**
 * Deletes a workspace record from the database
 * @param workspaceId The ID of the workspace to delete
 */
export async function deleteWorkspaceRecord(workspaceId: string): Promise<void> {
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
}
