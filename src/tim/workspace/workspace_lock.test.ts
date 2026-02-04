import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLock, type LockInfo } from './workspace_lock';

describe('WorkspaceLock', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a unique test directory with timestamp and random suffix to avoid conflicts
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `workspace-lock-test-`));
    // Set test lock directory to use the temp directory
    const lockDir = path.join(testDir, 'locks');
    await fs.promises.mkdir(lockDir, { recursive: true });
    WorkspaceLock.setTestLockDirectory(lockDir);
  });

  afterEach(async () => {
    // Reset test PID and lock directory
    WorkspaceLock.setTestPid(undefined);
    WorkspaceLock.setTestLockDirectory(undefined);

    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('acquireLock creates persistent lock by default', async () => {
    const command = 'tim agent --workspace test-123';
    // Use a subdirectory to ensure no conflicts
    const lockDir = path.join(testDir, 'lock-test-1');
    await fs.promises.mkdir(lockDir, { recursive: true });
    const lockInfo = await WorkspaceLock.acquireLock(lockDir, command);

    expect(lockInfo.type).toBe('persistent');
    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.command).toBe(command);
    expect(lockInfo.hostname).toBe(os.hostname());
    expect(lockInfo.version).toBeGreaterThanOrEqual(1);
    expect(new Date(lockInfo.startedAt).getTime()).toBeCloseTo(Date.now(), -2);

    // Verify file exists
    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    const fileContent = await fs.promises.readFile(lockFilePath, 'utf-8');
    const fileLockInfo = JSON.parse(fileContent);
    expect(fileLockInfo).toEqual(lockInfo);
  });

  test('acquireLock fails when persistent lock already exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-2');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo: LockInfo = {
      type: 'persistent',
      pid: process.pid,
      command: 'first command',
      startedAt: new Date().toISOString(),
      hostname: 'different-host', // Different hostname prevents isTimProcess check
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(lockInfo, null, 2));

    await expect(WorkspaceLock.acquireLock(lockDir, 'second command')).rejects.toThrow(
      'Workspace is already locked with a persistent lock'
    );
  });

  test('releaseLock removes pid lock when owned by current process', async () => {
    const lockDir = path.join(testDir, 'lock-test-3');
    await fs.promises.mkdir(lockDir, { recursive: true });

    await WorkspaceLock.acquireLock(lockDir, 'test command', { type: 'pid' });
    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    const released = await WorkspaceLock.releaseLock(lockDir);
    expect(released).toBe(true);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  test('releaseLock does not remove pid lock owned by different process', async () => {
    const lockDir = path.join(testDir, 'lock-test-4');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo: LockInfo = {
      type: 'pid',
      pid: process.pid + 1,
      command: 'other command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(lockInfo));

    const released = await WorkspaceLock.releaseLock(lockDir);
    expect(released).toBe(false);

    // Lock should still exist
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('releaseLock does not remove persistent lock without force', async () => {
    const lockDir = path.join(testDir, 'lock-test-5');
    await fs.promises.mkdir(lockDir, { recursive: true });

    await WorkspaceLock.acquireLock(lockDir, 'persistent command');

    const released = await WorkspaceLock.releaseLock(lockDir);
    expect(released).toBe(false);

    const lockExists = await fs.promises
      .access(WorkspaceLock.getLockFilePath(lockDir))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  });

  test('releaseLock force removes persistent lock', async () => {
    const lockDir = path.join(testDir, 'lock-test-6');
    await fs.promises.mkdir(lockDir, { recursive: true });

    await WorkspaceLock.acquireLock(lockDir, 'persistent command');

    const released = await WorkspaceLock.releaseLock(lockDir, { force: true });
    expect(released).toBe(true);

    const lockExists = await fs.promises
      .access(WorkspaceLock.getLockFilePath(lockDir))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test('getLockInfo returns null when no lock exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-7');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo = await WorkspaceLock.getLockInfo(lockDir);
    expect(lockInfo).toBeNull();
  });

  test('getLockInfo returns lock information when lock exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-8');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const originalLockInfo = await WorkspaceLock.acquireLock(lockDir, 'test command');
    const retrievedLockInfo = await WorkspaceLock.getLockInfo(lockDir);

    expect(retrievedLockInfo).toEqual(originalLockInfo);
  });

  test('isLocked returns correct status', async () => {
    const lockDir = path.join(testDir, 'lock-test-9');
    await fs.promises.mkdir(lockDir, { recursive: true });

    expect(await WorkspaceLock.isLocked(lockDir)).toBe(false);

    await WorkspaceLock.acquireLock(lockDir, 'test command');
    expect(await WorkspaceLock.isLocked(lockDir)).toBe(true);

    const released = await WorkspaceLock.releaseLock(lockDir, { force: true });
    expect(released).toBe(true);
    expect(await WorkspaceLock.isLocked(lockDir)).toBe(false);
  });

  test('isProcessAlive correctly detects running process', async () => {
    expect(await WorkspaceLock.isProcessAlive(process.pid)).toBe(true);
    expect(await WorkspaceLock.isProcessAlive(999999)).toBe(false);
  });

  test('isLockStale detects old pid locks', async () => {
    const oldLockInfo: LockInfo = {
      type: 'pid',
      pid: process.pid,
      command: 'old command',
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      hostname: os.hostname(),
      version: 1,
    };

    expect(await WorkspaceLock.isLockStale(oldLockInfo)).toBe(true);
  });

  test('isLockStale detects dead pid process', async () => {
    const deadProcessLock: LockInfo = {
      type: 'pid',
      pid: 999999,
      command: 'dead command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    expect(await WorkspaceLock.isLockStale(deadProcessLock)).toBe(true);
  });

  test('isLockStale returns false for persistent locks regardless of age', async () => {
    const persistentLock: LockInfo = {
      type: 'persistent',
      pid: process.pid,
      command: 'persistent command',
      startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    expect(await WorkspaceLock.isLockStale(persistentLock)).toBe(false);
  });

  test('clearStaleLock removes only stale pid locks', async () => {
    const lockDir = path.join(testDir, 'lock-test-10');
    await fs.promises.mkdir(lockDir, { recursive: true });

    // Create a stale lock
    const staleLockInfo: LockInfo = {
      type: 'pid',
      pid: 999999,
      command: 'stale command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLockInfo));

    await WorkspaceLock.clearStaleLock(lockDir);
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // Create a fresh lock
    await WorkspaceLock.acquireLock(lockDir, 'fresh command', { type: 'pid' });
    await WorkspaceLock.clearStaleLock(lockDir);
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('acquireLock replaces stale lock', async () => {
    const lockDir = path.join(testDir, 'lock-test-11');
    await fs.promises.mkdir(lockDir, { recursive: true });

    // Create a stale lock
    const staleLockInfo: LockInfo = {
      type: 'pid',
      pid: 999999,
      command: 'stale command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLockInfo));

    // Should succeed in acquiring lock
    const newLockInfo = await WorkspaceLock.acquireLock(lockDir, 'new command', { type: 'pid' });
    expect(newLockInfo.pid).toBe(process.pid);
    expect(newLockInfo.command).toBe('new command');
  });
});
