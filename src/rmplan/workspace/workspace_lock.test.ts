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
  });

  afterEach(async () => {
    // Reset test PID
    WorkspaceLock.setTestPid(undefined);

    try {
      await fs.promises.rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('acquireLock creates lock file with correct info', async () => {
    const command = 'rmplan agent --workspace test-123';
    // Use a subdirectory to ensure no conflicts
    const lockDir = path.join(testDir, 'lock-test-1');
    await fs.promises.mkdir(lockDir, { recursive: true });
    const lockInfo = await WorkspaceLock.acquireLock(lockDir, command);

    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.command).toBe(command);
    expect(lockInfo.hostname).toBe(os.hostname());
    expect(lockInfo.version).toBe(1);
    expect(new Date(lockInfo.startedAt).getTime()).toBeCloseTo(Date.now(), -2);

    // Verify file exists
    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    const fileContent = await fs.promises.readFile(lockFilePath, 'utf-8');
    const fileLockInfo = JSON.parse(fileContent);
    expect(fileLockInfo).toEqual(lockInfo);
  });

  test('acquireLock fails when lock already exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-2');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo: LockInfo = {
      pid: process.pid,
      command: 'first command',
      startedAt: new Date().toISOString(),
      hostname: 'different-host', // Different hostname prevents isRmplanProcess check
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(lockInfo, null, 2));

    // Try to acquire lock, should fail
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(WorkspaceLock.acquireLock(lockDir, 'second command')).rejects.toThrow(
      `Workspace is already locked by process ${process.pid}`
    );
  });

  test('releaseLock removes lock file when owned by current process', async () => {
    const lockDir = path.join(testDir, 'lock-test-3');
    await fs.promises.mkdir(lockDir, { recursive: true });

    await WorkspaceLock.acquireLock(lockDir, 'test command');
    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    await WorkspaceLock.releaseLock(lockDir);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  test('releaseLock does not remove lock owned by different process', async () => {
    const lockDir = path.join(testDir, 'lock-test-4');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo: LockInfo = {
      pid: process.pid + 1,
      command: 'other command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(lockInfo));

    await WorkspaceLock.releaseLock(lockDir);

    // Lock should still exist
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('getLockInfo returns null when no lock exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-5');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const lockInfo = await WorkspaceLock.getLockInfo(lockDir);
    expect(lockInfo).toBeNull();
  });

  test('getLockInfo returns lock information when lock exists', async () => {
    const lockDir = path.join(testDir, 'lock-test-6');
    await fs.promises.mkdir(lockDir, { recursive: true });

    const originalLockInfo = await WorkspaceLock.acquireLock(lockDir, 'test command');
    const retrievedLockInfo = await WorkspaceLock.getLockInfo(lockDir);

    expect(retrievedLockInfo).toEqual(originalLockInfo);
  });

  test('isLocked returns correct status', async () => {
    const lockDir = path.join(testDir, 'lock-test-7');
    await fs.promises.mkdir(lockDir, { recursive: true });

    expect(await WorkspaceLock.isLocked(lockDir)).toBe(false);

    await WorkspaceLock.acquireLock(lockDir, 'test command');
    expect(await WorkspaceLock.isLocked(lockDir)).toBe(true);

    await WorkspaceLock.releaseLock(lockDir);
    expect(await WorkspaceLock.isLocked(lockDir)).toBe(false);
  });

  test('isProcessAlive correctly detects running process', async () => {
    expect(await WorkspaceLock.isProcessAlive(process.pid)).toBe(true);
    expect(await WorkspaceLock.isProcessAlive(999999)).toBe(false);
  });

  test('isLockStale detects old locks', async () => {
    const oldLockInfo: LockInfo = {
      pid: process.pid,
      command: 'old command',
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      hostname: os.hostname(),
      version: 1,
    };

    expect(await WorkspaceLock.isLockStale(oldLockInfo)).toBe(true);
  });

  test('isLockStale detects dead process', async () => {
    const deadProcessLock: LockInfo = {
      pid: 999999,
      command: 'dead command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    expect(await WorkspaceLock.isLockStale(deadProcessLock)).toBe(true);
  });

  test('clearStaleLock removes only stale locks', async () => {
    const lockDir = path.join(testDir, 'lock-test-8');
    await fs.promises.mkdir(lockDir, { recursive: true });

    // Create a stale lock
    const staleLockInfo: LockInfo = {
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
    await WorkspaceLock.acquireLock(lockDir, 'fresh command');
    await WorkspaceLock.clearStaleLock(lockDir);
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('acquireLock replaces stale lock', async () => {
    const lockDir = path.join(testDir, 'lock-test-9');
    await fs.promises.mkdir(lockDir, { recursive: true });

    // Create a stale lock
    const staleLockInfo: LockInfo = {
      pid: 999999,
      command: 'stale command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(lockDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLockInfo));

    // Should succeed in acquiring lock
    const newLockInfo = await WorkspaceLock.acquireLock(lockDir, 'new command');
    expect(newLockInfo.pid).toBe(process.pid);
    expect(newLockInfo.command).toBe('new command');
  });
});
