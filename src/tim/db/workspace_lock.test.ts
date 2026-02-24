import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import { recordWorkspace } from './workspace.js';
import {
  acquireWorkspaceLock,
  cleanStaleLocks,
  getWorkspaceLock,
  releaseWorkspaceLock,
} from './workspace_lock.js';

describe('tim db/workspace_lock', () => {
  let tempDir: string;
  let db: Database;
  let workspaceId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workspace-lock-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    const projectId = getOrCreateProject(db, 'repo-1').id;
    workspaceId = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    }).id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('acquireWorkspaceLock creates lock row', () => {
    const lock = acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(lock.workspace_id).toBe(workspaceId);
    expect(lock.lock_type).toBe('persistent');
    expect(lock.pid).toBeNull();
    expect(lock.hostname).toBe('test-host');
  });

  test('getWorkspaceLock returns null when no lock exists', () => {
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
  });

  test('acquireWorkspaceLock fails when lock already exists', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(() =>
      acquireWorkspaceLock(db, workspaceId, {
        lockType: 'pid',
        pid: process.pid,
        hostname: 'test-host',
        command: 'tim workspace lock',
      })
    ).toThrow(/already locked/);
  });

  test('acquireWorkspaceLock replaces stale pid lock before acquiring', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'pid',
      pid: process.pid,
      hostname: 'stale-host',
      command: 'stale-command',
    });
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(workspaceId);

    const lock = acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'new-host',
      command: 'new-command',
    });

    expect(lock.lock_type).toBe('persistent');
    expect(lock.hostname).toBe('new-host');
  });

  test('releaseWorkspaceLock enforces pid ownership unless forced', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'pid',
      pid: 12345,
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(releaseWorkspaceLock(db, workspaceId, { pid: 99999 })).toBe(false);
    expect(getWorkspaceLock(db, workspaceId)).not.toBeNull();

    expect(releaseWorkspaceLock(db, workspaceId, { pid: 12345 })).toBe(true);
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
  });

  test('releaseWorkspaceLock with force removes lock regardless of type', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(releaseWorkspaceLock(db, workspaceId, { force: true })).toBe(true);
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
  });

  test('releaseWorkspaceLock returns false for persistent locks unless forced', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(releaseWorkspaceLock(db, workspaceId)).toBe(false);
    expect(releaseWorkspaceLock(db, workspaceId, { force: true })).toBe(true);
  });

  test('releaseWorkspaceLock returns false for non-existent lock', () => {
    expect(releaseWorkspaceLock(db, workspaceId)).toBe(false);
  });

  test('cleanStaleLocks removes pid locks with dead pids', () => {
    const workspace2Id = recordWorkspace(db, {
      projectId: getOrCreateProject(db, 'repo-1').id,
      taskId: 'task-2',
      workspacePath: '/tmp/workspace-2',
    }).id;

    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'pid',
      pid: 999999,
      hostname: 'test-host',
      command: 'tim workspace lock',
    });
    acquireWorkspaceLock(db, workspace2Id, {
      lockType: 'pid',
      pid: process.pid,
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    const cleaned = cleanStaleLocks(db);
    expect(cleaned).toBe(1);
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
    expect(getWorkspaceLock(db, workspace2Id)).not.toBeNull();
  });

  test('cleanStaleLocks removes pid locks older than 24 hours', () => {
    const workspace2Id = recordWorkspace(db, {
      projectId: getOrCreateProject(db, 'repo-1').id,
      taskId: 'task-2',
      workspacePath: '/tmp/workspace-2',
    }).id;

    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'pid',
      pid: process.pid,
      hostname: 'old-host',
      command: 'old-lock',
    });
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(workspaceId);

    acquireWorkspaceLock(db, workspace2Id, {
      lockType: 'pid',
      pid: process.pid,
      hostname: 'fresh-host',
      command: 'fresh-lock',
    });

    const cleaned = cleanStaleLocks(db);
    expect(cleaned).toBe(1);
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
    expect(getWorkspaceLock(db, workspace2Id)).not.toBeNull();
  });

  test('cleanStaleLocks does not delete a lock replaced after stale check', () => {
    const stalePid = 999999;

    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'pid',
      pid: stalePid,
      hostname: 'stale-host',
      command: 'stale-command',
    });

    const originalKill = process.kill;
    let replaced = false;

    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
      if (!replaced && pid === stalePid && signal === 0) {
        replaced = true;
        db.prepare('DELETE FROM workspace_lock WHERE workspace_id = ?').run(workspaceId);
        db.prepare(
          "INSERT INTO workspace_lock (workspace_id, lock_type, pid, started_at, hostname, command) VALUES (?, 'pid', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)"
        ).run(workspaceId, process.pid, 'new-host', 'new-command');

        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }

      return originalKill(pid, signal as number | NodeJS.Signals);
    }) as typeof process.kill;

    try {
      const cleaned = cleanStaleLocks(db);
      expect(cleaned).toBe(0);
    } finally {
      process.kill = originalKill;
    }

    const lock = getWorkspaceLock(db, workspaceId);
    expect(lock).not.toBeNull();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.hostname).toBe('new-host');
  });

  test('cleanStaleLocks preserves persistent locks', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    expect(cleanStaleLocks(db)).toBe(0);
    expect(getWorkspaceLock(db, workspaceId)?.lock_type).toBe('persistent');
  });

  test('deleting workspace cascades to workspace_lock', () => {
    acquireWorkspaceLock(db, workspaceId, {
      lockType: 'persistent',
      hostname: 'test-host',
      command: 'tim workspace lock',
    });

    db.prepare('DELETE FROM workspace WHERE id = ?').run(workspaceId);
    expect(getWorkspaceLock(db, workspaceId)).toBeNull();
  });
});
