import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { isProcessAlive } from '../db/workspace_lock.js';
import { recordWorkspace } from '../db/workspace.js';
import { WorkspaceLock } from './workspace_lock';

describe('WorkspaceLock', () => {
  let tempDir: string;
  let originalXdgConfigHome: string | undefined;
  const workspacePath = '/tmp/workspace-lock-db-1';
  const staleWorkspacePath = '/tmp/workspace-lock-db-stale';
  const cleanupWorkspacePath = '/tmp/workspace-lock-db-cleanup';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-lock-db-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;
    closeDatabaseForTesting();
    WorkspaceLock.setTestPid(undefined);

    const db = getDatabase();
    const project = getOrCreateProject(db, 'workspace-lock-db-test-repo');
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: 'task-1',
    });
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath: staleWorkspacePath,
      taskId: 'task-2',
    });
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath: cleanupWorkspacePath,
      taskId: 'task-3',
    });
  });

  afterEach(async () => {
    WorkspaceLock.setTestPid(undefined);
    closeDatabaseForTesting();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('acquireLock/getLockInfo/isLocked/releaseLock roundtrip', async () => {
    const lockInfo = await WorkspaceLock.acquireLock(workspacePath, 'tim agent run', {
      type: 'pid',
    });

    expect(lockInfo.type).toBe('pid');
    expect(lockInfo.pid).toBe(process.pid);
    expect(await WorkspaceLock.isLocked(workspacePath)).toBe(true);
    expect(await WorkspaceLock.getLockInfo(workspacePath)).not.toBeNull();

    const released = await WorkspaceLock.releaseLock(workspacePath);
    expect(released).toBe(true);
    expect(await WorkspaceLock.getLockInfo(workspacePath)).toBeNull();
    expect(await WorkspaceLock.isLocked(workspacePath)).toBe(false);
  });

  test('acquireLock fails when a persistent lock already exists', async () => {
    await WorkspaceLock.acquireLock(workspacePath, 'initial');
    await expect(WorkspaceLock.acquireLock(workspacePath, 'second')).rejects.toThrow(
      'already locked'
    );
  });

  test('releaseLock does not remove persistent lock without force', async () => {
    await WorkspaceLock.acquireLock(workspacePath, 'persistent');

    const released = await WorkspaceLock.releaseLock(workspacePath);
    expect(released).toBe(false);
    expect(await WorkspaceLock.isLocked(workspacePath)).toBe(true);

    await WorkspaceLock.releaseLock(workspacePath, { force: true });
  });

  test('getLockInfo cleans stale DB lock and returns null', async () => {
    await WorkspaceLock.acquireLock(staleWorkspacePath, 'tim agent run', { type: 'pid' });
    const db = getDatabase();
    const staleWorkspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(staleWorkspacePath) as { id: number };
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(staleWorkspace.id);

    expect(await WorkspaceLock.getLockInfo(staleWorkspacePath)).toBeNull();
    expect(
      db.prepare('SELECT 1 FROM workspace_lock WHERE workspace_id = ?').get(staleWorkspace.id)
    ).toBeNull();
  });

  test('clearStaleLock removes stale pid lock', async () => {
    await WorkspaceLock.acquireLock(staleWorkspacePath, 'tim agent run', { type: 'pid' });
    const db = getDatabase();
    const staleWorkspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(staleWorkspacePath) as { id: number };
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(staleWorkspace.id);

    await WorkspaceLock.clearStaleLock(staleWorkspacePath);
    expect(await WorkspaceLock.getLockInfo(staleWorkspacePath)).toBeNull();
  });

  test('getLockInfo stale cleanup preserves a lock replaced during cleanup', async () => {
    await WorkspaceLock.acquireLock(staleWorkspacePath, 'tim agent run', { type: 'pid' });
    const db = getDatabase();
    const staleWorkspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(staleWorkspacePath) as { id: number };

    db.prepare(
      "UPDATE workspace_lock SET pid = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(999_999, staleWorkspace.id);

    const originalIsLockStale = WorkspaceLock.isLockStale;
    let replaced = false;

    WorkspaceLock.isLockStale = async (lockInfo) => {
      if (!replaced) {
        db.prepare(
          "UPDATE workspace_lock SET pid = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), hostname = ?, command = ? WHERE workspace_id = ?"
        ).run(process.pid, 'replacement-host', 'replacement-command', staleWorkspace.id);
        replaced = true;
      }

      return originalIsLockStale.call(WorkspaceLock, lockInfo);
    };

    try {
      await WorkspaceLock.getLockInfo(staleWorkspacePath);
    } finally {
      WorkspaceLock.isLockStale = originalIsLockStale;
    }

    const lockRow = db
      .prepare('SELECT pid, command FROM workspace_lock WHERE workspace_id = ?')
      .get(staleWorkspace.id) as { pid: number; command: string } | null;
    expect(lockRow).not.toBeNull();
    expect(lockRow?.pid).toBe(process.pid);
    expect(lockRow?.command).toBe('replacement-command');
  });

  test('isLocked stale cleanup preserves a lock replaced during cleanup', async () => {
    await WorkspaceLock.acquireLock(staleWorkspacePath, 'tim agent run', { type: 'pid' });
    const db = getDatabase();
    const staleWorkspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(staleWorkspacePath) as { id: number };

    db.prepare(
      "UPDATE workspace_lock SET pid = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(999_999, staleWorkspace.id);

    const originalIsLockStale = WorkspaceLock.isLockStale;
    let replaced = false;

    WorkspaceLock.isLockStale = async (lockInfo) => {
      if (!replaced) {
        db.prepare(
          "UPDATE workspace_lock SET pid = ?, started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), hostname = ?, command = ? WHERE workspace_id = ?"
        ).run(process.pid, 'replacement-host', 'replacement-command', staleWorkspace.id);
        replaced = true;
      }

      return originalIsLockStale.call(WorkspaceLock, lockInfo);
    };

    try {
      expect(await WorkspaceLock.isLocked(staleWorkspacePath)).toBe(true);
    } finally {
      WorkspaceLock.isLockStale = originalIsLockStale;
    }

    const lockRow = db
      .prepare('SELECT pid, command FROM workspace_lock WHERE workspace_id = ?')
      .get(staleWorkspace.id) as { pid: number; command: string } | null;
    expect(lockRow).not.toBeNull();
    expect(lockRow?.pid).toBe(process.pid);
    expect(lockRow?.command).toBe('replacement-command');
  });

  test('isLockStale treats invalid startedAt as stale for pid locks', async () => {
    const stale = await WorkspaceLock.isLockStale({
      type: 'pid',
      pid: process.pid,
      command: 'tim agent run',
      startedAt: 'not-a-date',
      hostname: 'localhost',
      version: 2,
    });

    expect(stale).toBe(true);
  });

  test('setupCleanupHandlers releases pid lock through DB cleanup path', async () => {
    await WorkspaceLock.acquireLock(cleanupWorkspacePath, 'tim agent run', { type: 'pid' });

    const before = process.listeners('exit').length;
    WorkspaceLock.setupCleanupHandlers(cleanupWorkspacePath, 'pid');
    const afterListeners = process.listeners('exit');
    expect(afterListeners.length).toBe(before + 1);

    const cleanup = afterListeners[afterListeners.length - 1];
    cleanup();

    expect(await WorkspaceLock.getLockInfo(cleanupWorkspacePath)).toBeNull();
    process.off('exit', cleanup);
  });

  test('releaseLock removes registered cleanup listeners for all events', async () => {
    await WorkspaceLock.acquireLock(cleanupWorkspacePath, 'tim agent run', { type: 'pid' });

    const signals = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP'] as const;
    const beforeCounts = Object.fromEntries(
      signals.map((signal) => [signal, process.listeners(signal).length])
    );

    WorkspaceLock.setupCleanupHandlers(cleanupWorkspacePath, 'pid');

    for (const signal of signals) {
      expect(process.listeners(signal).length).toBe(beforeCounts[signal] + 1);
    }

    const released = await WorkspaceLock.releaseLock(cleanupWorkspacePath);
    expect(released).toBe(true);

    for (const signal of signals) {
      expect(process.listeners(signal).length).toBe(beforeCounts[signal]);
    }
  });

  test('isProcessAlive correctly detects running process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999999)).toBe(false);
  });
});
