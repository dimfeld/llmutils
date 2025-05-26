import { db } from './index.js';
import { taskLogs } from './schema.js';
import { lt, and, sql } from 'drizzle-orm';
import { config } from '../config.js';

export interface TaskLogCleanupResult {
  deletedCount: number;
  error?: string;
}

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
 * Deletes task logs older than the specified number of days
 * @param retentionDays Number of days to retain logs (from config.LOG_RETENTION_DAYS)
 * @returns Result with count of deleted logs
 */
export async function deleteOldTaskLogs(retentionDays: number): Promise<TaskLogCleanupResult> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
    
    // Get count before deletion for reporting
    const countBeforeDelete = await getOldTaskLogsCount(cutoffDate);
    
    if (countBeforeDelete === 0) {
      return { deletedCount: 0 };
    }
    
    // Delete old logs
    await db
      .delete(taskLogs)
      .where(lt(taskLogs.timestamp, cutoffDate));
    
    return { deletedCount: countBeforeDelete };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { 
      deletedCount: 0, 
      error: errorMessage 
    };
  }
}

/**
 * Performs automatic cleanup of old task logs based on LOG_RETENTION_DAYS config
 * @returns Result with count of deleted logs
 */
export async function autoCleanupTaskLogs(): Promise<TaskLogCleanupResult> {
  const retentionDays = config.LOG_RETENTION_DAYS || 30; // Default to 30 days if not configured
  
  console.log(`[Task Logs Cleanup] Starting automatic cleanup of logs older than ${retentionDays} days`);
  
  const result = await deleteOldTaskLogs(retentionDays);
  
  if (result.error) {
    console.error(`[Task Logs Cleanup] Error: ${result.error}`);
  } else if (result.deletedCount > 0) {
    console.log(`[Task Logs Cleanup] Deleted ${result.deletedCount} old task logs`);
  } else {
    console.log(`[Task Logs Cleanup] No old logs found for cleanup`);
  }
  
  return result;
}