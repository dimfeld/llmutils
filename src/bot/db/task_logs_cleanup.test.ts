import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import { db } from './index.js';
import { taskLogs, tasks } from './schema.js';
import { eq, and, gte } from 'drizzle-orm';
import {
  getOldTaskLogsCount,
  deleteOldTaskLogs,
  autoCleanupTaskLogs,
} from './task_logs_db_manager.js';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

describe('Task Logs Cleanup', () => {
  let testTaskId: string;
  let testLogIds: number[] = [];

  beforeAll(async () => {
    // Create a temporary test database file
    const testDbPath = path.join(tmpdir(), `test-db-${Date.now()}.sqlite`);

    // Set test environment variables
    process.env.GITHUB_TOKEN = 'test-github-token';
    process.env.DISCORD_TOKEN = 'test-discord-token';
    process.env.DATABASE_PATH = testDbPath;
    process.env.WORKSPACE_BASE_DIR = '/tmp/test-workspaces';
    process.env.LOG_RETENTION_DAYS = '30';

    // Load config before running tests
    loadConfig();

    // Run migrations using bun:sqlite
    const { migrate } = await import('drizzle-orm/bun-sqlite/migrator');
    const { Database } = await import('bun:sqlite');
    const { drizzle } = await import('drizzle-orm/bun-sqlite');
    const sqlite = new Database(testDbPath);
    const testDb = drizzle(sqlite);
    migrate(testDb, { migrationsFolder: './src/bot/db/migrations' });
    sqlite.close();
  });

  beforeEach(async () => {
    testTaskId = randomUUID();
    testLogIds = [];

    // Create a test task
    await db.insert(tasks).values({
      id: testTaskId,
      status: 'completed',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterEach(async () => {
    // Clean up test data
    if (testLogIds.length > 0) {
      await db
        .delete(taskLogs)
        .where(and(eq(taskLogs.taskId, testTaskId), gte(taskLogs.id, Math.min(...testLogIds))));
    }
    await db.delete(tasks).where(eq(tasks.id, testTaskId));
  });

  test('getOldTaskLogsCount should count logs older than specified date', async () => {
    const now = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    // Create test logs with different ages
    const results = await db
      .insert(taskLogs)
      .values([
        {
          taskId: testTaskId,
          timestamp: now,
          logLevel: 'info',
          message: 'Recent log',
        },
        {
          taskId: testTaskId,
          timestamp: thirtyDaysAgo,
          logLevel: 'info',
          message: '30 days old log',
        },
        {
          taskId: testTaskId,
          timestamp: sixtyDaysAgo,
          logLevel: 'info',
          message: '60 days old log',
        },
      ])
      .returning({ id: taskLogs.id });

    testLogIds = results.map((r) => r.id);

    // Count logs older than 45 days
    const fortyFiveDaysAgo = new Date();
    fortyFiveDaysAgo.setDate(fortyFiveDaysAgo.getDate() - 45);

    const count = await getOldTaskLogsCount(fortyFiveDaysAgo);

    // Should only count the 60-day-old log
    expect(count).toBe(1);
  });

  test('deleteOldTaskLogs should delete logs older than specified date', async () => {
    const now = new Date();
    const twentyDaysAgo = new Date();
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    const fortyDaysAgo = new Date();
    fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

    // Create test logs
    const results = await db
      .insert(taskLogs)
      .values([
        {
          taskId: testTaskId,
          timestamp: now,
          logLevel: 'info',
          message: 'Recent log - should be kept',
        },
        {
          taskId: testTaskId,
          timestamp: twentyDaysAgo,
          logLevel: 'info',
          message: '20 days old - should be kept',
        },
        {
          taskId: testTaskId,
          timestamp: fortyDaysAgo,
          logLevel: 'error',
          message: '40 days old - should be deleted',
          fullContent: 'Full error details',
        },
      ])
      .returning({ id: taskLogs.id });

    testLogIds = results.map((r) => r.id);

    // Delete logs older than 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const deletedCount = await deleteOldTaskLogs(thirtyDaysAgo);

    expect(deletedCount).toBe(1);

    // Verify correct logs remain
    const remainingLogs = await db.select().from(taskLogs).where(eq(taskLogs.taskId, testTaskId));

    expect(remainingLogs.length).toBe(2);
    expect(remainingLogs.find((log) => log.message.includes('Recent log'))).toBeTruthy();
    expect(remainingLogs.find((log) => log.message.includes('20 days old'))).toBeTruthy();
    expect(remainingLogs.find((log) => log.message.includes('40 days old'))).toBeFalsy();
  });

  test('deleteOldTaskLogs should return 0 when no old logs exist', async () => {
    const now = new Date();

    // Create only recent logs
    const results = await db
      .insert(taskLogs)
      .values([
        {
          taskId: testTaskId,
          timestamp: now,
          logLevel: 'info',
          message: 'Recent log 1',
        },
        {
          taskId: testTaskId,
          timestamp: now,
          logLevel: 'info',
          message: 'Recent log 2',
        },
      ])
      .returning({ id: taskLogs.id });

    testLogIds = results.map((r) => r.id);

    // Try to delete logs older than 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const deletedCount = await deleteOldTaskLogs(thirtyDaysAgo);

    expect(deletedCount).toBe(0);

    // Verify all logs remain
    const remainingLogs = await db.select().from(taskLogs).where(eq(taskLogs.taskId, testTaskId));

    expect(remainingLogs.length).toBe(2);
  });

  test('autoCleanupTaskLogs should use configured retention days', async () => {
    const now = new Date();
    const twentyDaysAgo = new Date();
    twentyDaysAgo.setDate(twentyDaysAgo.getDate() - 20);
    const fortyDaysAgo = new Date();
    fortyDaysAgo.setDate(fortyDaysAgo.getDate() - 40);

    // Create test logs
    const results = await db
      .insert(taskLogs)
      .values([
        {
          taskId: testTaskId,
          timestamp: now,
          logLevel: 'info',
          message: 'Recent log',
        },
        {
          taskId: testTaskId,
          timestamp: twentyDaysAgo,
          logLevel: 'info',
          message: '20 days old',
        },
        {
          taskId: testTaskId,
          timestamp: fortyDaysAgo,
          logLevel: 'info',
          message: '40 days old',
        },
      ])
      .returning({ id: taskLogs.id });

    testLogIds = results.map((r) => r.id);

    // Run auto cleanup (uses LOG_RETENTION_DAYS from config, default 30)
    const result = await autoCleanupTaskLogs();

    // Should delete the 40-day-old log
    expect(result.deletedCount).toBe(1);
  });
});
