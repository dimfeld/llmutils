import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface WorkspaceLockRow {
  workspace_id: number;
  lock_type: 'persistent' | 'pid';
  pid: number | null;
  started_at: string;
  hostname: string;
  command: string;
}

export interface AcquireLockInput {
  lockType: 'persistent' | 'pid';
  pid?: number;
  hostname: string;
  command: string;
}

export interface ReleaseLockOptions {
  force?: boolean;
  pid?: number;
}

const STALE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseUtcDate(dateTimeText: string): number {
  const withZone = dateTimeText.endsWith('Z') ? dateTimeText : `${dateTimeText}Z`;
  return new Date(withZone).getTime();
}

function isLockStale(lock: WorkspaceLockRow): boolean {
  if (lock.lock_type !== 'pid') {
    return false;
  }

  if (lock.pid === null || !isProcessAlive(lock.pid)) {
    return true;
  }

  const startedAtMs = parseUtcDate(lock.started_at);
  if (!Number.isFinite(startedAtMs)) {
    return true;
  }

  return Date.now() - startedAtMs > STALE_LOCK_TIMEOUT_MS;
}

export function acquireWorkspaceLock(
  db: Database,
  workspaceId: number,
  input: AcquireLockInput
): WorkspaceLockRow {
  const acquireInTransaction = db.transaction(
    (nextWorkspaceId: number, nextInput: AcquireLockInput): WorkspaceLockRow => {
      const existing = getWorkspaceLock(db, nextWorkspaceId);
      if (existing) {
        if (isLockStale(existing)) {
          db.prepare('DELETE FROM workspace_lock WHERE workspace_id = ?').run(nextWorkspaceId);
        } else {
          throw new Error(`Workspace ${nextWorkspaceId} is already locked`);
        }
      }

      db.prepare(
        `
        INSERT INTO workspace_lock (
          workspace_id,
          lock_type,
          pid,
          started_at,
          hostname,
          command
        ) VALUES (?, ?, ?, ${SQL_NOW_ISO_UTC}, ?, ?)
      `
      ).run(
        nextWorkspaceId,
        nextInput.lockType,
        nextInput.lockType === 'pid' ? (nextInput.pid ?? process.pid) : null,
        nextInput.hostname,
        nextInput.command
      );

      const created = getWorkspaceLock(db, nextWorkspaceId);
      if (!created) {
        throw new Error(`Failed to create workspace lock for workspace_id=${nextWorkspaceId}`);
      }

      return created;
    }
  );

  return acquireInTransaction.immediate(workspaceId, input);
}

export function releaseWorkspaceLock(
  db: Database,
  workspaceId: number,
  options: ReleaseLockOptions = {}
): boolean {
  const releaseInTransaction = db.transaction(
    (nextWorkspaceId: number, nextOptions: ReleaseLockOptions): boolean => {
      const existing = getWorkspaceLock(db, nextWorkspaceId);
      if (!existing) {
        return false;
      }

      if (!nextOptions.force) {
        if (existing.lock_type !== 'pid') {
          return false;
        }

        const pidToMatch = nextOptions.pid ?? process.pid;
        if (existing.pid !== pidToMatch) {
          return false;
        }
      }

      const result = db
        .prepare('DELETE FROM workspace_lock WHERE workspace_id = ?')
        .run(nextWorkspaceId);
      return result.changes > 0;
    }
  );

  return releaseInTransaction.immediate(workspaceId, options);
}

export function releaseSpecificWorkspaceLock(
  db: Database,
  workspaceId: number,
  pid: number | null,
  startedAt: string
): boolean {
  const result = db
    .prepare(
      `
      DELETE FROM workspace_lock
      WHERE workspace_id = ? AND pid IS ? AND started_at = ?
    `
    )
    .run(workspaceId, pid, startedAt);

  return result.changes > 0;
}

export function getWorkspaceLock(db: Database, workspaceId: number): WorkspaceLockRow | null {
  return (
    (db
      .prepare('SELECT * FROM workspace_lock WHERE workspace_id = ?')
      .get(workspaceId) as WorkspaceLockRow | null) ?? null
  );
}

export function cleanStaleLocks(db: Database): number {
  const pidLocks = db
    .prepare(
      `
      SELECT workspace_id, lock_type, pid, started_at, hostname, command
      FROM workspace_lock
      WHERE lock_type = 'pid'
    `
    )
    .all() as WorkspaceLockRow[];

  const staleLocks = pidLocks.filter(isLockStale);

  if (staleLocks.length === 0) {
    return 0;
  }

  const deleteInTransaction = db.transaction((locks: WorkspaceLockRow[]): number => {
    const removeLock = db.prepare(
      'DELETE FROM workspace_lock WHERE workspace_id = ? AND pid = ? AND started_at = ?'
    );
    let removed = 0;
    for (const lock of locks) {
      const result = removeLock.run(lock.workspace_id, lock.pid, lock.started_at);
      removed += result.changes;
    }
    return removed;
  });

  return deleteInTransaction.immediate(staleLocks);
}
