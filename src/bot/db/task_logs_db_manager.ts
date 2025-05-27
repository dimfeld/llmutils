import { db } from './index.js';
import { taskLogs } from './schema.js';
import { lt, and, sql } from 'drizzle-orm';
import { config } from '../config.js';

/**
 * Gets the count of task logs older than the specified date
 * @param olderThan Date threshold - logs older than this date
 * @returns Number of logs that would be deleted
 */
export async function getOldTaskLogsCount(olderThan: Date): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskLogs)
    .where(lt(taskLogs.timestamp, olderThan));

  return result[0]?.count || 0;
}

/**
 * Deletes task logs older than the specified date
 * @param olderThan Date threshold - logs older than this date will be deleted
 * @returns Number of deleted logs
 */
export async function deleteOldTaskLogs(olderThan: Date): Promise<number> {
  try {
    // Get count before deletion for reporting
    const countBeforeDelete = await getOldTaskLogsCount(olderThan);

    if (countBeforeDelete === 0) {
      return 0;
    }

    // Delete old logs
    await db.delete(taskLogs).where(lt(taskLogs.timestamp, olderThan));

    return countBeforeDelete;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to delete old task logs: ${errorMessage}`);
  }
}

/**
 * Performs automatic cleanup of old task logs based on LOG_RETENTION_DAYS config
 * @returns Result with count of deleted logs
 */
export async function autoCleanupTaskLogs(): Promise<{ deletedCount: number }> {
  const retentionDays = config.LOG_RETENTION_DAYS || 30; // Default to 30 days if not configured

  console.log(
    `[Task Logs Cleanup] Starting automatic cleanup of logs older than ${retentionDays} days`
  );

  try {
    // Calculate the cutoff date
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    // Call deleteOldTaskLogs with the cutoff date
    const deletedCount = await deleteOldTaskLogs(cutoffDate);

    if (deletedCount > 0) {
      console.log(`[Task Logs Cleanup] Deleted ${deletedCount} old task logs`);
    } else {
      console.log(`[Task Logs Cleanup] No old logs found for cleanup`);
    }

    return { deletedCount };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Task Logs Cleanup] Error: ${errorMessage}`);
    return { deletedCount: 0 };
  }
}
