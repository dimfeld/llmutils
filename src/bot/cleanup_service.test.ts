import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { runCleanupService, scheduleCleanupService } from './cleanup_service.js';
import * as workspaceManager from '../rmplan/workspace/workspace_manager.js';
import * as taskLogsManager from './db/task_logs_db_manager.js';

// Mock the cleanup functions
mock.module('../rmplan/workspace/workspace_manager.js', () => ({
  autoCleanupWorkspaces: mock(() => Promise.resolve({ cleanedCount: 2, failedCount: 1 })),
}));

mock.module('./db/task_logs_db_manager.js', () => ({
  autoCleanupTaskLogs: mock(() => Promise.resolve({ deletedCount: 100 })),
}));

describe('Cleanup Service', () => {
  beforeEach(() => {
    // Reset mocks before each test
    (workspaceManager.autoCleanupWorkspaces as any).mockClear();
    (taskLogsManager.autoCleanupTaskLogs as any).mockClear();
  });

  test('runCleanupService should run both cleanup tasks', async () => {
    const result = await runCleanupService();

    // Verify both cleanup functions were called
    expect(workspaceManager.autoCleanupWorkspaces).toHaveBeenCalledTimes(1);
    expect(taskLogsManager.autoCleanupTaskLogs).toHaveBeenCalledTimes(1);

    // Verify results
    expect(result.workspaces.cleanedCount).toBe(2);
    expect(result.workspaces.failedCount).toBe(1);
    expect(result.taskLogs.deletedCount).toBe(100);
  });

  test('runCleanupService should handle workspace cleanup errors', async () => {
    // Mock workspace cleanup to throw an error
    (workspaceManager.autoCleanupWorkspaces as any).mockImplementation(() =>
      Promise.reject(new Error('Workspace cleanup failed'))
    );

    const result = await runCleanupService();

    // Should still run task log cleanup
    expect(taskLogsManager.autoCleanupTaskLogs).toHaveBeenCalledTimes(1);

    // Verify error is captured
    expect(result.workspaces.error).toBe('Workspace cleanup failed');
    expect(result.workspaces.cleanedCount).toBe(0);
    expect(result.workspaces.failedCount).toBe(0);
    expect(result.taskLogs.deletedCount).toBe(100);
  });

  test('runCleanupService should handle task log cleanup errors', async () => {
    // Mock task log cleanup to throw an error
    (taskLogsManager.autoCleanupTaskLogs as any).mockImplementation(() =>
      Promise.reject(new Error('Task log cleanup failed'))
    );

    const result = await runCleanupService();

    // Should still run workspace cleanup
    expect(workspaceManager.autoCleanupWorkspaces).toHaveBeenCalledTimes(1);

    // Verify error is captured
    expect(result.taskLogs.error).toBe('Task log cleanup failed');
    expect(result.taskLogs.deletedCount).toBe(0);
    expect(result.workspaces.cleanedCount).toBe(2);
    expect(result.workspaces.failedCount).toBe(1);
  });

  test('scheduleCleanupService should run cleanup immediately and return stop function', async () => {
    // Schedule cleanup
    const stopCleanup = scheduleCleanupService(1); // 1 hour interval for testing

    // Wait a bit to ensure immediate execution happens
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify immediate execution
    expect(workspaceManager.autoCleanupWorkspaces).toHaveBeenCalledTimes(1);
    expect(taskLogsManager.autoCleanupTaskLogs).toHaveBeenCalledTimes(1);

    // Stop the scheduled cleanup
    stopCleanup();

    // Verify stop function works (no additional calls after stopping)
    const callCountBefore = (workspaceManager.autoCleanupWorkspaces as any).mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const callCountAfter = (workspaceManager.autoCleanupWorkspaces as any).mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore);
  });
});
