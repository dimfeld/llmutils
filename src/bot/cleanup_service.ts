import { log, error } from '../logging.js';
import { autoCleanupWorkspaces } from '../rmplan/workspace/workspace_manager.js';
import { autoCleanupTaskLogs } from './db/task_logs_db_manager.js';

export interface CleanupServiceResult {
  workspaces: {
    cleanedCount: number;
    failedCount: number;
    error?: string;
  };
  taskLogs: {
    deletedCount: number;
    error?: string;
  };
}

/**
 * Runs all automatic cleanup tasks
 * - Cleans up inactive workspaces (not accessed for 1 week)
 * - Deletes old task logs (based on LOG_RETENTION_DAYS config)
 *
 * This function should be called periodically (e.g., daily) by a scheduler
 * @returns Results of all cleanup operations
 */
export async function runCleanupService(): Promise<CleanupServiceResult> {
  log('[Cleanup Service] Starting automatic cleanup tasks...');

  const result: CleanupServiceResult = {
    workspaces: {
      cleanedCount: 0,
      failedCount: 0,
    },
    taskLogs: {
      deletedCount: 0,
    },
  };

  // Run workspace cleanup
  try {
    log('[Cleanup Service] Running workspace cleanup...');
    const workspaceResult = await autoCleanupWorkspaces();
    result.workspaces = workspaceResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(`[Cleanup Service] Workspace cleanup failed: ${errorMessage}`);
    result.workspaces.error = errorMessage;
  }

  // Run task log cleanup
  try {
    log('[Cleanup Service] Running task log cleanup...');
    const logResult = await autoCleanupTaskLogs();
    result.taskLogs = logResult;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    error(`[Cleanup Service] Task log cleanup failed: ${errorMessage}`);
    result.taskLogs.error = errorMessage;
  }

  // Log summary
  log('[Cleanup Service] Cleanup completed:');
  log(
    `  - Workspaces: ${result.workspaces.cleanedCount} cleaned, ${result.workspaces.failedCount} failed`
  );
  log(`  - Task logs: ${result.taskLogs.deletedCount} deleted`);

  if (result.workspaces.error) {
    log(`  - Workspace cleanup error: ${result.workspaces.error}`);
  }
  if (result.taskLogs.error) {
    log(`  - Task log cleanup error: ${result.taskLogs.error}`);
  }

  return result;
}

/**
 * Schedules the cleanup service to run at regular intervals
 * @param intervalHours Number of hours between cleanup runs (default: 24)
 * @returns Function to stop the scheduled cleanup
 */
export function scheduleCleanupService(intervalHours: number = 24): () => void {
  log(`[Cleanup Service] Scheduling automatic cleanup to run every ${intervalHours} hours`);

  // Run immediately on startup
  runCleanupService().catch((err) => {
    error(
      `[Cleanup Service] Initial cleanup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  });

  // Schedule regular runs
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const intervalId = setInterval(() => {
    runCleanupService().catch((err) => {
      error(
        `[Cleanup Service] Scheduled cleanup failed: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }, intervalMs);

  // Return function to stop the scheduled cleanup
  return () => {
    clearInterval(intervalId);
    log('[Cleanup Service] Scheduled cleanup stopped');
  };
}
