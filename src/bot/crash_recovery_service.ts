import { db, tasks } from './db/index.js';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import {
  getTasksWithCheckpoints,
  getCheckpoint,
  deleteCheckpoint,
  saveCheckpoint,
  cleanupStaleCheckpoints,
} from './db/task_checkpoints_manager.js';
import { getAllActiveTasks } from './db/tasks_manager.js';
import { log, error, warn, debugLog } from '../logging.js';
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
  originalPlanFile?: string;
  workspaceLocked?: string | null;
  taskIndex?: number;
  stepIndex?: number;
  completedStepIndex?: number;
  executorName?: string;
  model?: string;
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
    // First, get all active tasks to identify which checkpoints are stale
    const activeTasks = await getAllActiveTasks();
    const activeTaskIds = activeTasks.map((task) => task.id);

    // Clean up stale checkpoints for inactive tasks
    await cleanupStaleCheckpoints(activeTaskIds);

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
    let skippedCount = 0;

    for (const task of taskRecords) {
      try {
        // Check task status to determine if it should be resumed
        const isActiveStatus =
          task.status && !['completed', 'failed', 'cancelled'].includes(task.status);

        if (!isActiveStatus) {
          log(
            `[Crash Recovery] Task ${task.id} is in terminal state ${task.status}, cleaning up checkpoint`
          );
          await deleteCheckpoint(task.id);
          skippedCount++;
          continue;
        }

        // Get the checkpoint data
        const checkpoint = await getCheckpoint(task.id);
        if (!checkpoint) {
          warn(
            `[Crash Recovery] No checkpoint data found for task ${task.id} despite being in active list`
          );
          skippedCount++;
          continue;
        }

        const checkpointData = checkpoint.checkpointData as TaskCheckpointData;

        log(`[Crash Recovery] Attempting to resume task ${task.id}:`);
        log(`  Type: ${task.taskType}`);
        log(`  Status: ${task.status}`);
        log(`  Step Index: ${checkpoint.stepIndex}`);

        // Notify that we're resuming
        await notifyTaskProgress(
          task.id,
          'Bot restarted - resuming task from checkpoint',
          task.status || 'resuming'
        );

        // Resume based on task type
        const resumeResult = await resumeTask(task, checkpoint.stepIndex, checkpointData);

        if (resumeResult.success) {
          recoveredCount++;
          log(`[Crash Recovery] Successfully resumed task ${task.id}`);
        } else {
          failedCount++;

          // Mark task as failed if resume strategy determines it can't continue
          if (!resumeResult.canRetry) {
            await db
              .update(tasks)
              .set({
                status: 'failed',
                errorMessage: resumeResult.error || 'Failed to resume after crash',
                updatedAt: new Date(),
              })
              .where(eq(tasks.id, task.id));

            await notifyTaskProgress(
              task.id,
              `Failed to resume: ${resumeResult.error || 'Unknown error'}`,
              'failed'
            );

            // Clean up checkpoint for failed task
            await deleteCheckpoint(task.id);
          }
        }
      } catch (err) {
        error(`[Crash Recovery] Error processing task ${task.id}:`, err);
        failedCount++;
      }
    }

    log(
      `[Crash Recovery] Recovery complete - Recovered: ${recoveredCount}, Failed: ${failedCount}, Skipped: ${skippedCount}`
    );
  } catch (err) {
    error('[Crash Recovery] Fatal error during crash recovery:', err);
  }
}

/**
 * Resumes a specific task based on its type and checkpoint data
 * @param task The task to resume
 * @param stepIndex The step index from the checkpoint
 * @param checkpointData The checkpoint data
 * @returns Object indicating success/failure and whether retry is possible
 */
async function resumeTask(
  task: any,
  stepIndex: number,
  checkpointData: TaskCheckpointData
): Promise<{ success: boolean; canRetry: boolean; error?: string }> {
  try {
    switch (task.taskType) {
      case 'responding':
        // PR response task
        debugLog(`[Crash Recovery] Resuming PR response task ${task.id}`);
        await resumePrResponseTask(task.id);
        return { success: true, canRetry: true };

      case 'planning':
      case 'implementation':
        // Planning or implementation task - use rmplan agent
        if (!checkpointData.planFile || !checkpointData.workspacePath) {
          return {
            success: false,
            canRetry: false,
            error: 'Missing required checkpoint data (planFile or workspacePath)',
          };
        }

        // Check if workspace is still available and not locked
        const lockInfo = await WorkspaceLock.getLockInfo(checkpointData.workspacePath);
        if (lockInfo && !(await WorkspaceLock.isLockStale(lockInfo))) {
          return {
            success: false,
            canRetry: true,
            error: `Workspace ${checkpointData.workspacePath} is locked by another process`,
          };
        }

        // Clear any stale lock
        if (lockInfo && (await WorkspaceLock.isLockStale(lockInfo))) {
          debugLog(
            `[Crash Recovery] Clearing stale lock for workspace ${checkpointData.workspacePath}`
          );
          await WorkspaceLock.clearStaleLock(checkpointData.workspacePath);
        }

        log(`[Crash Recovery] Resuming ${task.taskType} task ${task.id} from step ${stepIndex}`);

        // Use rmplan agent to resume from the checkpoint
        await rmplanAgent(
          checkpointData.originalPlanFile || checkpointData.planFile,
          {
            workspace: checkpointData.workspacePath,
            botTaskId: task.id,
            nonInteractive: true,
            'no-log': true,
            executor: checkpointData.executorName,
            model: checkpointData.model,
            resumeFromCheckpoint: {
              stepIndex: stepIndex,
              checkpointData: checkpointData,
            },
            progressCallback: async (details) => {
              // Update checkpoint after each step completion
              await saveCheckpoint(task.id, details.stepIndex + 1, {
                ...checkpointData,
                taskIndex: details.taskIndex,
                completedStepIndex: details.stepIndex,
              });

              // Also update task progress
              await notifyTaskProgress(
                task.id,
                `Completed step: ${details.stepPrompt.split('\n')[0]}`,
                task.status
              );
            },
          },
          { debug: false }
        );

        // If we get here, the task completed successfully
        await db
          .update(tasks)
          .set({ status: 'completed', updatedAt: new Date() })
          .where(eq(tasks.id, task.id));

        await notifyTaskProgress(task.id, 'Task resumed and completed successfully', 'completed');

        // Clean up checkpoint after successful completion
        await deleteCheckpoint(task.id);

        return { success: true, canRetry: true };

      default:
        return {
          success: false,
          canRetry: false,
          error: `Unknown task type: ${task.taskType}`,
        };
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(`[Crash Recovery] Failed to resume task ${task.id}:`, err);

    // For planning/implementation tasks, we might be able to retry later
    const canRetry = ['planning', 'implementation'].includes(task.taskType);

    return {
      success: false,
      canRetry,
      error: errorMessage,
    };
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
