/**
 * Scheduler module for running periodic cleanup tasks.
 *
 * This module re-exports the scheduling functionality from cleanup_service.ts
 * which already handles scheduling both workspace and task log cleanup.
 */

import { scheduleCleanupService, runCleanupService } from './cleanup_service.js';

// Re-export the scheduling function with an alias for consistency
export const startScheduledTasks = scheduleCleanupService;

// Re-export the manual cleanup function
export { runCleanupService };

// For backward compatibility or testing, provide a way to manually trigger individual cleanups
export { autoCleanupWorkspaces } from '../rmplan/workspace/workspace_manager.js';
export { autoCleanupTaskLogs } from './db/task_logs_db_manager.js';
