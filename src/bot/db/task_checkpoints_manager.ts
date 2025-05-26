import { db, taskCheckpoints } from './index.js';
import { eq, sql } from 'drizzle-orm';
import { log, error, debugLog } from '../../logging.js';

export interface TaskCheckpoint {
  stepIndex: number;
  checkpointData: any;
}

/**
 * Saves a checkpoint for a task, allowing it to be resumed later.
 * @param taskId The task ID to save checkpoint for
 * @param stepIndex The current step index in the plan
 * @param checkpointData Any data needed to resume the task (e.g., plan file path, workspace path, etc.)
 */
export async function saveCheckpoint(
  taskId: string,
  stepIndex: number,
  checkpointData: any
): Promise<void> {
  try {
    const serializedData = JSON.stringify(checkpointData);

    await db
      .insert(taskCheckpoints)
      .values({
        taskId,
        checkpointData: serializedData,
        stepIndex,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: taskCheckpoints.taskId,
        set: {
          checkpointData: serializedData,
          stepIndex,
          updatedAt: new Date(),
        },
      });

    debugLog(`[${taskId}] Saved checkpoint at step ${stepIndex}`);
  } catch (err) {
    error(`[${taskId}] Failed to save checkpoint:`, err);
    throw err;
  }
}

/**
 * Retrieves a checkpoint for a task.
 * @param taskId The task ID to retrieve checkpoint for
 * @returns The checkpoint data including step index and deserialized data, or null if not found
 */
export async function getCheckpoint(taskId: string): Promise<TaskCheckpoint | null> {
  try {
    const results = await db
      .select()
      .from(taskCheckpoints)
      .where(eq(taskCheckpoints.taskId, taskId))
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    const checkpoint = results[0];
    return {
      stepIndex: checkpoint.stepIndex,
      checkpointData: JSON.parse(checkpoint.checkpointData),
    };
  } catch (err) {
    error(`[${taskId}] Failed to retrieve checkpoint:`, err);
    return null;
  }
}

/**
 * Deletes a checkpoint for a task (e.g., when task completes successfully).
 * @param taskId The task ID to delete checkpoint for
 */
export async function deleteCheckpoint(taskId: string): Promise<void> {
  try {
    await db.delete(taskCheckpoints).where(eq(taskCheckpoints.taskId, taskId));

    debugLog(`[${taskId}] Deleted checkpoint`);
  } catch (err) {
    error(`[${taskId}] Failed to delete checkpoint:`, err);
    // Don't throw here - checkpoint deletion failure shouldn't break the flow
  }
}

/**
 * Gets all tasks that have checkpoints (potential crash recovery candidates).
 * @returns Array of task IDs that have checkpoints
 */
export async function getTasksWithCheckpoints(): Promise<string[]> {
  try {
    const results = await db.select({ taskId: taskCheckpoints.taskId }).from(taskCheckpoints);

    return results.map((r) => r.taskId);
  } catch (err) {
    error('Failed to get tasks with checkpoints:', err);
    return [];
  }
}

/**
 * Cleans up old checkpoints for tasks that are no longer active.
 * @param activeTaskIds Array of currently active task IDs
 */
export async function cleanupStaleCheckpoints(activeTaskIds: string[]): Promise<void> {
  try {
    if (activeTaskIds.length === 0) {
      // If no active tasks, delete all checkpoints
      await db.delete(taskCheckpoints);
      log('Cleaned up all task checkpoints');
      return;
    }

    // Delete checkpoints for tasks not in the active list
    const deletedCount = await db
      .delete(taskCheckpoints)
      .where(sql`${taskCheckpoints.taskId} NOT IN ${activeTaskIds}`)
      .returning({ taskId: taskCheckpoints.taskId });

    if (deletedCount.length > 0) {
      log(`Cleaned up ${deletedCount.length} stale task checkpoints`);
    }
  } catch (err) {
    error('Failed to cleanup stale checkpoints:', err);
  }
}
