import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLock, type LockInfo } from './workspace_lock';

describe('WorkspaceLock', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-lock-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  });

  test('acquireLock creates lock file with correct info', async () => {
    const command = 'rmplan agent --workspace test-123';
    const lockInfo = await WorkspaceLock.acquireLock(testDir, command);

    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.command).toBe(command);
    expect(lockInfo.hostname).toBe(os.hostname());
    expect(lockInfo.version).toBe(1);
    expect(new Date(lockInfo.startedAt).getTime()).toBeCloseTo(Date.now(), -2);

    // Verify file exists
    const lockFilePath = WorkspaceLock.getLockFilePath(testDir);
    const fileContent = await fs.promises.readFile(lockFilePath, 'utf-8');
    const fileLockInfo = JSON.parse(fileContent);
    expect(fileLockInfo).toEqual(lockInfo);
  });

  test('acquireLock fails when lock already exists', async () => {
    await WorkspaceLock.acquireLock(testDir, 'first command');

    await expect(WorkspaceLock.acquireLock(testDir, 'second command')).rejects.toThrow(
      'Workspace is already locked'
    );
  });

  test('releaseLock removes lock file when owned by current process', async () => {
    await WorkspaceLock.acquireLock(testDir, 'test command');
    const lockFilePath = WorkspaceLock.getLockFilePath(testDir);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);

    await WorkspaceLock.releaseLock(testDir);

    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);
  });

  test('releaseLock does not remove lock owned by different process', async () => {
    const lockInfo: LockInfo = {
      pid: process.pid + 1,
      command: 'other command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(testDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(lockInfo));

    await WorkspaceLock.releaseLock(testDir);

    // Lock should still exist
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('getLockInfo returns null when no lock exists', async () => {
    const lockInfo = await WorkspaceLock.getLockInfo(testDir);
    expect(lockInfo).toBeNull();
  });

  test('getLockInfo returns lock information when lock exists', async () => {
    const originalLockInfo = await WorkspaceLock.acquireLock(testDir, 'test command');
    const retrievedLockInfo = await WorkspaceLock.getLockInfo(testDir);

    expect(retrievedLockInfo).toEqual(originalLockInfo);
  });

  test('isLocked returns correct status', async () => {
    expect(await WorkspaceLock.isLocked(testDir)).toBe(false);

    await WorkspaceLock.acquireLock(testDir, 'test command');
    expect(await WorkspaceLock.isLocked(testDir)).toBe(true);

    await WorkspaceLock.releaseLock(testDir);
    expect(await WorkspaceLock.isLocked(testDir)).toBe(false);
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
    // Create a stale lock
    const staleLockInfo: LockInfo = {
      pid: 999999,
      command: 'stale command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(testDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLockInfo));

    await WorkspaceLock.clearStaleLock(testDir);
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(false);

    // Create a fresh lock
    await WorkspaceLock.acquireLock(testDir, 'fresh command');
    await WorkspaceLock.clearStaleLock(testDir);
    expect(
      await fs.promises
        .access(lockFilePath)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('acquireLock replaces stale lock', async () => {
    // Create a stale lock
    const staleLockInfo: LockInfo = {
      pid: 999999,
      command: 'stale command',
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: 1,
    };

    const lockFilePath = WorkspaceLock.getLockFilePath(testDir);
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLockInfo));

    // Should succeed in acquiring lock
    const newLockInfo = await WorkspaceLock.acquireLock(testDir, 'new command');
    expect(newLockInfo.pid).toBe(process.pid);
    expect(newLockInfo.command).toBe('new command');
  });
});
