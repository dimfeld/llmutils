import { db, tasks } from './db/index.js';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import {
  getTasksWithCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  saveCheckpoint,
} from './db/task_checkpoints_manager.js';
import { log, error, warn } from '../logging.js';
import { resumePrResponseTask } from './pr_response_service.js';
import { WorkspaceLock } from '../rmplan/workspace/workspace_lock.js';
import { rmplanAgent } from '../rmplan/agent.js';
import { notifyTaskProgress } from './core/thread_manager.js';

/**
 * Interface for checkpoint data stored in the database
 */
interface TaskCheckpointData {
  taskType: string;
  planFile?: string;
  workspacePath?: string;
  taskIndex?: number;
  stepIndex?: number;
  executorOptions?: any;
  prNumber?: number;
  repositoryFullName?: string;
}

/**
 * Checks for tasks that have checkpoints and may need to be resumed
 * This is called on bot startup to recover from crashes
 */
export async function recoverCrashedTasks(): Promise<void> {
  log('[Crash Recovery] Checking for tasks that need to be resumed...');

  try {
    // Get all tasks that have checkpoints
    const tasksWithCheckpoints = await getTasksWithCheckpoints();

    if (tasksWithCheckpoints.length === 0) {
      log('[Crash Recovery] No task checkpoints found');
      return;
    }

    log(`[Crash Recovery] Found ${tasksWithCheckpoints.length} tasks with checkpoints`);

    // Get task details for all tasks with checkpoints
    const taskRecords = await db
      .select()
      .from(tasks)
      .where(inArray(tasks.id, tasksWithCheckpoints));

    let recoveredCount = 0;
    let failedCount = 0;

    for (const task of taskRecords) {
      try {
        // Skip completed or failed tasks
        if (task.status === 'completed' || task.status === 'failed') {
          log(`[Crash Recovery] Task ${task.id} is already ${task.status}, cleaning up checkpoint`);
          await deleteCheckpoint(task.id);
          continue;
        }

        // Get the checkpoint data
        const checkpoint = await getCheckpoint(task.id);
        if (!checkpoint) {
          warn(`[Crash Recovery] No checkpoint data found for task ${task.id}`);
          continue;
        }

        const checkpointData = checkpoint.checkpointData as TaskCheckpointData;

        log(`[Crash Recovery] Attempting to resume task ${task.id} (type: ${task.taskType})`);

        // Notify that we're resuming
        await notifyTaskProgress(
          task.id,
          'Bot restarted - resuming task from checkpoint',
          'resuming'
        );

        // Resume based on task type
        if (task.taskType === 'responding') {
          // PR response task
          await resumePrResponseTask(task.id);
          recoveredCount++;
        } else if (task.taskType === 'planning' || task.taskType === 'implementation') {
          // Planning or implementation task - use rmplan agent
          if (checkpointData.planFile && checkpointData.workspacePath) {
            // Check if workspace is still available and not locked
            const lockInfo = await WorkspaceLock.getLockInfo(checkpointData.workspacePath);
            if (lockInfo && !(await WorkspaceLock.isLockStale(lockInfo))) {
              warn(
                `[Crash Recovery] Workspace ${checkpointData.workspacePath} is locked, cannot resume task ${task.id}`
              );
              await notifyTaskProgress(
                task.id,
                'Cannot resume - workspace is locked by another process',
                'failed'
              );
              continue;
            }

            // Clear any stale lock
            if (lockInfo && (await WorkspaceLock.isLockStale(lockInfo))) {
              await WorkspaceLock.clearStaleLock(checkpointData.workspacePath);
            }

            log(
              `[Crash Recovery] Resuming ${task.taskType} task ${task.id} from step ${checkpoint.stepIndex}`
            );

            // Use rmplan agent to resume from the checkpoint
            try {
              await rmplanAgent(
                checkpointData.planFile,
                {
                  workspace: checkpointData.workspacePath,
                  botTaskId: task.id,
                  nonInteractive: true,
                  progressCallback: async (details) => {
                    // Save checkpoint after each step
                    await saveCheckpoint(task.id, details.stepIndex + 1, checkpointData);
                  },
                },
                { debug: false }
              );

              // Mark task as completed
              await db
                .update(tasks)
                .set({ status: 'completed', updatedAt: new Date() })
                .where(eq(tasks.id, task.id));

              await notifyTaskProgress(
                task.id,
                'Task resumed and completed successfully',
                'completed'
              );
              recoveredCount++;
            } catch (err) {
              error(`[Crash Recovery] Failed to resume task ${task.id}:`, err);
              await db
                .update(tasks)
                .set({
                  status: 'failed',
                  errorMessage: `Resume failed: ${err instanceof Error ? err.message : String(err)}`,
                  updatedAt: new Date(),
                })
                .where(eq(tasks.id, task.id));

              await notifyTaskProgress(
                task.id,
                `Failed to resume task: ${err instanceof Error ? err.message : String(err)}`,
                'failed'
              );
              failedCount++;
            }
          } else {
            warn(
              `[Crash Recovery] Task ${task.id} missing required checkpoint data (planFile or workspacePath)`
            );
            failedCount++;
          }
        } else {
          warn(`[Crash Recovery] Unknown task type ${task.taskType} for task ${task.id}`);
          failedCount++;
        }

        // Clean up checkpoint after processing
        await deleteCheckpoint(task.id);
      } catch (err) {
        error(`[Crash Recovery] Error processing task ${task.id}:`, err);
        failedCount++;
      }
    }

    log(
      `[Crash Recovery] Recovery complete - Recovered: ${recoveredCount}, Failed: ${failedCount}`
    );
  } catch (err) {
    error('[Crash Recovery] Fatal error during crash recovery:', err);
  }
}

/**
 * Saves a checkpoint for a task to enable crash recovery
 * @param taskId The task ID
 * @param stepIndex The current step index
 * @param checkpointData Additional data needed to resume the task
 */
export async function saveTaskCheckpoint(
  taskId: string,
  stepIndex: number,
  checkpointData: TaskCheckpointData
): Promise<void> {
  try {
    const { saveCheckpoint } = await import('./db/task_checkpoints_manager.js');
    await saveCheckpoint(taskId, stepIndex, checkpointData);
  } catch (err) {
    error(`[Crash Recovery] Failed to save checkpoint for task ${taskId}:`, err);
  }
}
