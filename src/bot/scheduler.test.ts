import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  startScheduledTasks,
  runCleanupService,
  autoCleanupWorkspaces,
  autoCleanupTaskLogs,
} from './scheduler.js';
import { loadConfig } from './config.js';

describe('scheduler', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test database
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scheduler-test-'));

    // Set up test environment variables
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.DISCORD_TOKEN = 'test-token';
    process.env.DATABASE_PATH = path.join(tempDir, 'test.db');
    process.env.WORKSPACE_BASE_DIR = path.join(tempDir, 'workspaces');
    process.env.LOG_RETENTION_DAYS = '1';

    // Load config to initialize the system
    loadConfig();
  });

  afterEach(async () => {
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('should export required functions', () => {
    expect(typeof startScheduledTasks).toBe('function');
    expect(typeof runCleanupService).toBe('function');
    expect(typeof autoCleanupWorkspaces).toBe('function');
    expect(typeof autoCleanupTaskLogs).toBe('function');
  });

  test('should be able to start and stop scheduled tasks', () => {
    // Start the scheduler with a very short interval for testing
    const stopFn = startScheduledTasks(0.1);

    // Verify it returns a stop function
    expect(typeof stopFn).toBe('function');

    // Stop the scheduler
    stopFn();
  });

  test('should be able to run cleanup service manually', async () => {
    // This should run without errors even with no data
    const result = await runCleanupService();

    expect(result).toHaveProperty('workspaces');
    expect(result).toHaveProperty('taskLogs');
    expect(result.workspaces).toHaveProperty('cleanedCount');
    expect(result.workspaces).toHaveProperty('failedCount');
    expect(result.taskLogs).toHaveProperty('deletedCount');
  });

  test('should be able to run workspace cleanup manually', async () => {
    // This should run without errors even with no workspaces
    const result = await autoCleanupWorkspaces();

    expect(result).toHaveProperty('cleanedCount');
    expect(result).toHaveProperty('failedCount');
    expect(result.cleanedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  test('should be able to run task log cleanup manually', async () => {
    // This should run without errors even with no logs
    const result = await autoCleanupTaskLogs();

    expect(result).toHaveProperty('deletedCount');
    expect(result.deletedCount).toBe(0);
  });
});
