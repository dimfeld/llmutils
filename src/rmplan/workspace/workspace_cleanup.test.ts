import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { db } from '../../bot/db/index.js';
import { tasks, workspaces as workspacesTable } from '../../bot/db/schema.js';
import { eq } from 'drizzle-orm';
import { 
  getUnlockableInactiveWorkspaces,
  deleteWorkspaceRecord
} from '../../bot/db/workspaces_db_manager.js';
import { 
  deleteWorkspace,
  autoCleanupWorkspaces
} from './workspace_manager.js';
import { WorkspaceLock } from './workspace_lock.js';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../../bot/config.js';

describe('Workspace Cleanup', () => {
  let testDir: string;
  let testTaskId: string;
  let testWorkspaceId: string;
  
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
    // Create a temporary directory for testing
    testDir = await mkdtemp(path.join(tmpdir(), 'workspace-cleanup-test-'));
    testTaskId = randomUUID();
    testWorkspaceId = randomUUID();
    
    // Clear test data
    await db.delete(workspacesTable).where(eq(workspacesTable.taskId, testTaskId));
    await db.delete(tasks).where(eq(tasks.id, testTaskId));
  });
  
  afterEach(async () => {
    // Clean up test data
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore errors
    }
    
    // Clean up database
    await db.delete(workspacesTable).where(eq(workspacesTable.taskId, testTaskId));
    await db.delete(tasks).where(eq(tasks.id, testTaskId));
  });
  
  test('getUnlockableInactiveWorkspaces should return workspaces not accessed for a week', async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    // Create test workspaces
    const oldWorkspaceId = randomUUID();
    const recentWorkspaceId = randomUUID();
    
    await db.insert(workspacesTable).values([
      {
        id: oldWorkspaceId,
        taskId: testTaskId,
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'old-workspace'),
        branch: 'test-branch-old',
        originalPlanFile: 'test.yml',
        createdAt: twoWeeksAgo,
        lastAccessedAt: twoWeeksAgo,
        lockedByTaskId: null,
      },
      {
        id: recentWorkspaceId,
        taskId: testTaskId,
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'recent-workspace'),
        branch: 'test-branch-recent',
        originalPlanFile: 'test.yml',
        createdAt: yesterday,
        lastAccessedAt: yesterday,
        lockedByTaskId: null,
      }
    ]);
    
    // Get inactive workspaces
    const inactiveWorkspaces = await getUnlockableInactiveWorkspaces(oneWeekAgo);
    
    // Should only return the old workspace
    expect(inactiveWorkspaces.length).toBe(1);
    expect(inactiveWorkspaces[0].id).toBe(oldWorkspaceId);
  });
  
  test('getUnlockableInactiveWorkspaces should include workspaces locked by completed tasks', async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    // Create a completed task
    const completedTaskId = randomUUID();
    await db.insert(tasks).values({
      id: completedTaskId,
      status: 'completed',
      createdAt: twoWeeksAgo,
      updatedAt: twoWeeksAgo,
    });
    
    // Create a workspace locked by the completed task
    const lockedWorkspaceId = randomUUID();
    await db.insert(workspacesTable).values({
      id: lockedWorkspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: path.join(testDir, 'locked-workspace'),
      branch: 'test-branch-locked',
      originalPlanFile: 'test.yml',
      createdAt: twoWeeksAgo,
      lastAccessedAt: twoWeeksAgo,
      lockedByTaskId: completedTaskId,
    });
    
    // Get inactive workspaces
    const inactiveWorkspaces = await getUnlockableInactiveWorkspaces(oneWeekAgo);
    
    // Should include the workspace locked by completed task
    const foundWorkspace = inactiveWorkspaces.find(w => w.id === lockedWorkspaceId);
    expect(foundWorkspace).toBeTruthy();
    expect(foundWorkspace?.lockedByTaskId).toBe(completedTaskId);
    
    // Clean up
    await db.delete(tasks).where(eq(tasks.id, completedTaskId));
  });
  
  test('getUnlockableInactiveWorkspaces should exclude workspaces locked by active tasks', async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    
    // Create an active task
    const activeTaskId = randomUUID();
    await db.insert(tasks).values({
      id: activeTaskId,
      status: 'running',
      createdAt: twoWeeksAgo,
      updatedAt: twoWeeksAgo,
    });
    
    // Create a workspace locked by the active task
    const lockedWorkspaceId = randomUUID();
    await db.insert(workspacesTable).values({
      id: lockedWorkspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: path.join(testDir, 'active-locked-workspace'),
      branch: 'test-branch-active-locked',
      originalPlanFile: 'test.yml',
      createdAt: twoWeeksAgo,
      lastAccessedAt: twoWeeksAgo,
      lockedByTaskId: activeTaskId,
    });
    
    // Get inactive workspaces
    const inactiveWorkspaces = await getUnlockableInactiveWorkspaces(oneWeekAgo);
    
    // Should NOT include the workspace locked by active task
    const foundWorkspace = inactiveWorkspaces.find(w => w.id === lockedWorkspaceId);
    expect(foundWorkspace).toBeFalsy();
    
    // Clean up
    await db.delete(tasks).where(eq(tasks.id, activeTaskId));
  });
  
  test('deleteWorkspace should remove workspace directory and database record', async () => {
    // Create a workspace directory
    const workspacePath = path.join(testDir, 'workspace-to-delete');
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, 'test.txt'), 'test content');
    
    // Create database record
    const workspaceId = randomUUID();
    await db.insert(workspacesTable).values({
      id: workspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: workspacePath,
      branch: 'test-branch',
      originalPlanFile: 'test.yml',
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      lockedByTaskId: null,
    });
    
    // Delete the workspace
    await deleteWorkspace({
      id: workspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: workspacePath,
      branch: 'test-branch',
      originalPlanFile: 'test.yml',
      createdAt: new Date(),
      lastAccessedAt: new Date(),
      lockedByTaskId: null,
    });
    
    // Verify directory is deleted
    const dirExists = await fs.access(workspacePath).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);
    
    // Verify database record is deleted
    const dbRecords = await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId));
    expect(dbRecords.length).toBe(0);
  });
  
  test('autoCleanupWorkspaces should skip workspaces with active filesystem locks', async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    // Create a workspace directory
    const workspacePath = path.join(testDir, 'locked-workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    
    // Create database record
    const workspaceId = randomUUID();
    await db.insert(workspacesTable).values({
      id: workspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: workspacePath,
      branch: 'test-branch',
      originalPlanFile: 'test.yml',
      createdAt: twoWeeksAgo,
      lastAccessedAt: twoWeeksAgo,
      lockedByTaskId: null,
    });
    
    // Acquire a filesystem lock
    await WorkspaceLock.acquireLock(workspacePath, 'test-command');
    
    // Run cleanup
    const result = await autoCleanupWorkspaces();
    
    // Should fail to clean the locked workspace
    expect(result.cleanedCount).toBe(0);
    expect(result.failedCount).toBe(1);
    
    // Verify workspace still exists
    const dirExists = await fs.access(workspacePath).then(() => true).catch(() => false);
    expect(dirExists).toBe(true);
    
    // Clean up
    await WorkspaceLock.releaseLock(workspacePath);
  });
  
  test('autoCleanupWorkspaces should clean up stale locked workspaces', async () => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
    
    // Create a workspace directory
    const workspacePath = path.join(testDir, 'stale-locked-workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    
    // Create database record
    const workspaceId = randomUUID();
    await db.insert(workspacesTable).values({
      id: workspaceId,
      taskId: testTaskId,
      repositoryUrl: 'https://github.com/test/repo.git',
      workspacePath: workspacePath,
      branch: 'test-branch',
      originalPlanFile: 'test.yml',
      createdAt: twoWeeksAgo,
      lastAccessedAt: twoWeeksAgo,
      lockedByTaskId: null,
    });
    
    // Create a stale lock (with a fake PID that doesn't exist)
    const staleLockInfo = {
      pid: 99999999, // Non-existent PID
      command: 'test-stale-command',
      startedAt: twoWeeksAgo.toISOString(),
      hostname: 'test-host',
      version: 1,
    };
    
    const lockFilePath = WorkspaceLock.getLockFilePath(workspacePath);
    await fs.writeFile(lockFilePath, JSON.stringify(staleLockInfo, null, 2));
    
    // Run cleanup
    const result = await autoCleanupWorkspaces();
    
    // Should successfully clean the workspace with stale lock
    expect(result.cleanedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    
    // Verify workspace is deleted
    const dirExists = await fs.access(workspacePath).then(() => true).catch(() => false);
    expect(dirExists).toBe(false);
  });
});