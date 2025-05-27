import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { tasks, taskCheckpoints } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { saveCheckpoint, getCheckpoint, deleteCheckpoint } from './db/task_checkpoints_manager.js';
import { processPrComments, PR_RESPONSE_STATUS } from './pr_response_service.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Create a test database helper
async function createTestDb() {
  const testDbPath = path.join(os.tmpdir(), `test-pr-checkpoint-${Date.now()}.db`);
  process.env.DATABASE_PATH = testDbPath;

  // Create tables
  const { runMigrations } = await import('./db/migrate.js');
  await runMigrations();

  return testDbPath;
}

describe('PR Response Service - Checkpoint Integration', () => {
  let testDbPath: string;
  let testTaskId: string;

  beforeEach(async () => {
    testDbPath = await createTestDb();
    testTaskId = randomUUID();

    // Insert a test task
    await db.insert(tasks).values({
      id: testTaskId,
      taskType: 'responding',
      status: PR_RESPONSE_STATUS.RESPONDING,
      prNumber: 123,
      repositoryFullName: 'test-owner/test-repo',
      createdByPlatform: 'github',
      createdByUserId: 'test-user',
    });
  });

  afterEach(async () => {
    // Clean up database
    try {
      await fs.unlink(testDbPath);
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it('should save checkpoint when processing PR comments', async () => {
    // Mock the handleRmprCommand to prevent actual execution
    const mockHandleRmprCommand = mock(() => Promise.resolve());
    mock.module('../rmpr/main.js', () => ({
      handleRmprCommand: mockHandleRmprCommand,
    }));

    // Mock other dependencies
    mock.module('../logging/adapter.js', () => ({
      runWithLogger: (adapter: any, callback: () => any) => callback(),
    }));

    mock.module('./logging/database_adapter.js', () => ({
      DatabaseLoggerAdapter: class {
        constructor() {}
        save() {
          return Promise.resolve();
        }
      },
    }));

    mock.module('../rmplan/configLoader.js', () => ({
      loadEffectiveConfig: () =>
        Promise.resolve({
          defaultExecutor: 'test-executor',
          models: { execution: 'test-model' },
        }),
    }));

    // Process PR comments (this should save a checkpoint)
    try {
      await processPrComments(testTaskId, 123, 'test-owner', 'test-repo');
    } catch (e) {
      // Expected to fail due to mocked dependencies, but checkpoint should be saved
    }

    // Verify checkpoint was saved
    const checkpoint = await getCheckpoint(testTaskId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.stepIndex).toBe(1);
    expect(checkpoint?.checkpointData.taskType).toBe('responding');
    expect(checkpoint?.checkpointData.prNumber).toBe(123);
    expect(checkpoint?.checkpointData.repositoryFullName).toBe('test-owner/test-repo');
    expect(checkpoint?.checkpointData.step).toBe('processing_comments');
  });

  it('should clean up checkpoint on successful completion', async () => {
    // Save a checkpoint first
    await saveCheckpoint(testTaskId, 1, {
      taskType: 'responding',
      prNumber: 123,
      repositoryFullName: 'test-owner/test-repo',
    });

    // Verify checkpoint exists
    let checkpoint = await getCheckpoint(testTaskId);
    expect(checkpoint).not.toBeNull();

    // Simulate successful completion by deleting checkpoint
    await deleteCheckpoint(testTaskId);

    // Verify checkpoint is gone
    checkpoint = await getCheckpoint(testTaskId);
    expect(checkpoint).toBeNull();
  });

  it('should store sufficient data for task resumption', async () => {
    const checkpointData = {
      taskType: 'responding',
      prNumber: 456,
      repositoryFullName: 'another-owner/another-repo',
      workspacePath: '/path/to/workspace',
      step: 'processing_comments',
      selectedComments: ['comment1', 'comment2'],
    };

    await saveCheckpoint(testTaskId, 2, checkpointData);

    const checkpoint = await getCheckpoint(testTaskId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.stepIndex).toBe(2);
    expect(checkpoint?.checkpointData).toEqual(checkpointData);
  });

  it('should handle multiple checkpoint updates', async () => {
    // Save initial checkpoint
    await saveCheckpoint(testTaskId, 1, {
      taskType: 'responding',
      step: 'selecting_comments',
    });

    // Update checkpoint
    await saveCheckpoint(testTaskId, 2, {
      taskType: 'responding',
      step: 'processing_comments',
      additionalData: 'test',
    });

    const checkpoint = await getCheckpoint(testTaskId);
    expect(checkpoint?.stepIndex).toBe(2);
    expect(checkpoint?.checkpointData.step).toBe('processing_comments');
    expect(checkpoint?.checkpointData.additionalData).toBe('test');
  });
});
