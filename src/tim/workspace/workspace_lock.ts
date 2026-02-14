import * as os from 'node:os';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDatabase } from '../db/database.js';
import {
  acquireWorkspaceLock,
  getWorkspaceLock,
  isProcessAlive,
  releaseSpecificWorkspaceLock,
  releaseWorkspaceLock,
  type WorkspaceLockRow,
} from '../db/workspace_lock.js';
import { getOrCreateProject } from '../db/project.js';
import { getWorkspaceByPath, recordWorkspace } from '../db/workspace.js';

export type LockType = 'persistent' | 'pid';

export interface LockInfo {
  type: LockType;
  pid?: number;
  command: string;
  startedAt: string;
  hostname: string;
  version: number;
}

export interface AcquireLockOptions {
  /** Lock type. Defaults to 'persistent'. */
  type?: LockType;
  /** Optional user friendly identifier for the lock owner. */
  owner?: string;
}

export interface ReleaseLockOptions {
  /** Force releasing the lock even if not owned by this process (used for unlock command). */
  force?: boolean;
}

export class WorkspaceLock {
  private static readonly LOCK_VERSION = 2;
  private static readonly STALE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Allow overriding process.pid for testing
  public static pid = process.pid;

  private static readonly cleanupHandlersByWorkspace = new Map<string, () => void>();

  /**
   * Set a custom PID for testing purposes
   * @param pid The PID to use (pass undefined to reset to process.pid)
   */
  public static setTestPid(pid: number | undefined): void {
    this.pid = pid ?? process.pid;
  }

  private static async getOrCreateWorkspaceId(workspacePath: string): Promise<number> {
    const db = getDatabase();
    const existing = getWorkspaceByPath(db, workspacePath);
    if (existing) {
      return existing.id;
    }

    let repositoryId = `workspace:${workspacePath}`;
    let remoteUrl: string | null = null;
    let gitRoot = workspacePath;

    try {
      const identity = await getRepositoryIdentity({ cwd: workspacePath });
      repositoryId = identity.repositoryId;
      remoteUrl = identity.remoteUrl;
      gitRoot = identity.gitRoot;
    } catch {
      // Some tests lock arbitrary directories that are not repositories.
    }

    const project = getOrCreateProject(db, repositoryId, {
      remoteUrl,
      lastGitRoot: gitRoot,
    });

    const created = recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: undefined,
      originalPlanFilePath: undefined,
    });

    return created.id;
  }

  private static getWorkspaceId(workspacePath: string): number | null {
    const db = getDatabase();
    const workspace = getWorkspaceByPath(db, workspacePath);
    return workspace?.id ?? null;
  }

  static async acquireLock(
    workspacePath: string,
    command: string,
    options: AcquireLockOptions = {}
  ): Promise<LockInfo> {
    const db = getDatabase();
    const workspaceId = await this.getOrCreateWorkspaceId(workspacePath);

    const lockType: LockType = options.type ?? 'persistent';
    const lockCommand = options.owner ? `${command} (owner: ${options.owner})` : command;

    const created = acquireWorkspaceLock(db, workspaceId, {
      lockType,
      pid: this.pid,
      hostname: os.hostname(),
      command: lockCommand,
    });

    return this.rowToLockInfo(created);
  }

  static async releaseLock(
    workspacePath: string,
    options: ReleaseLockOptions = {}
  ): Promise<boolean> {
    const db = getDatabase();
    const workspaceId = this.getWorkspaceId(workspacePath);

    if (!workspaceId) {
      return false;
    }

    const released = releaseWorkspaceLock(db, workspaceId, {
      force: options.force,
      pid: this.pid,
    });

    if (released) {
      this.unregisterCleanupHandlers(workspacePath);
    }

    return released;
  }

  private static async getLockInfoInternal(
    workspacePath: string,
    cleanupStale: boolean
  ): Promise<LockInfo | null> {
    const existing = this.getExistingLock(workspacePath);
    if (!existing) {
      return null;
    }

    if (cleanupStale) {
      const staleLockRemoved = await this.tryReleaseStaleLock(
        workspacePath,
        existing.workspaceId,
        existing.lock
      );
      if (staleLockRemoved) {
        return null;
      }

      const currentLock = getWorkspaceLock(getDatabase(), existing.workspaceId);
      return currentLock ? this.rowToLockInfo(currentLock) : null;
    }

    return this.rowToLockInfo(existing.lock);
  }

  static async getLockInfo(workspacePath: string): Promise<LockInfo | null> {
    return this.getLockInfoInternal(workspacePath, true);
  }

  static async getLockInfoIncludingStale(workspacePath: string): Promise<LockInfo | null> {
    return this.getLockInfoInternal(workspacePath, false);
  }

  static async isLocked(workspacePath: string): Promise<boolean> {
    const existing = this.getExistingLock(workspacePath);
    if (!existing) {
      return false;
    }

    const staleLockRemoved = await this.tryReleaseStaleLock(
      workspacePath,
      existing.workspaceId,
      existing.lock
    );
    if (staleLockRemoved) {
      return false;
    }

    return true;
  }

  static async isLockStale(lockInfo: LockInfo): Promise<boolean> {
    if (lockInfo.type === 'persistent') {
      return false;
    }

    // Check if lock is too old
    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    if (!Number.isFinite(lockAge)) {
      return true;
    }

    if (lockAge > this.STALE_LOCK_TIMEOUT_MS) {
      return true;
    }

    // Check if process is still alive
    if (!lockInfo.pid || !isProcessAlive(lockInfo.pid)) {
      return true;
    }

    return false;
  }

  static async clearStaleLock(workspacePath: string): Promise<void> {
    const existing = this.getExistingLock(workspacePath);
    if (!existing) {
      return;
    }

    await this.tryReleaseStaleLock(workspacePath, existing.workspaceId, existing.lock);
  }

  static setupCleanupHandlers(workspacePath: string, type: LockType): void {
    if (type !== 'pid') {
      return;
    }

    if (this.cleanupHandlersByWorkspace.has(workspacePath)) {
      return;
    }

    const cleanup = () => {
      try {
        const db = getDatabase();
        const workspaceId = this.getWorkspaceId(workspacePath);
        if (!workspaceId) {
          return;
        }

        const lock = getWorkspaceLock(db, workspaceId);
        if (lock?.lock_type === 'pid' && lock.pid === this.pid) {
          releaseWorkspaceLock(db, workspaceId, { force: false, pid: this.pid });
        }
      } catch {
        // Ignore errors during cleanup
      } finally {
        this.unregisterCleanupHandlers(workspacePath);
      }
    };

    this.cleanupHandlersByWorkspace.set(workspacePath, cleanup);

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
  }

  private static unregisterCleanupHandlers(workspacePath: string): void {
    const cleanup = this.cleanupHandlersByWorkspace.get(workspacePath);
    if (!cleanup) {
      return;
    }

    process.off('exit', cleanup);
    process.off('SIGINT', cleanup);
    process.off('SIGTERM', cleanup);
    process.off('SIGHUP', cleanup);
    this.cleanupHandlersByWorkspace.delete(workspacePath);
  }

  private static getExistingLock(
    workspacePath: string
  ): { workspaceId: number; lock: WorkspaceLockRow } | null {
    const db = getDatabase();
    const workspaceId = this.getWorkspaceId(workspacePath);

    if (!workspaceId) {
      return null;
    }

    const lock = getWorkspaceLock(db, workspaceId);
    if (!lock) {
      return null;
    }

    return { workspaceId, lock };
  }

  private static async tryReleaseStaleLock(
    workspacePath: string,
    workspaceId: number,
    lock: WorkspaceLockRow
  ): Promise<boolean> {
    if (lock.lock_type !== 'pid') {
      return false;
    }

    const lockInfo = this.rowToLockInfo(lock);
    if (!(await this.isLockStale(lockInfo))) {
      return false;
    }

    const removed = releaseSpecificWorkspaceLock(
      getDatabase(),
      workspaceId,
      lock.pid,
      lock.started_at
    );
    if (removed) {
      this.unregisterCleanupHandlers(workspacePath);
    }

    return removed;
  }

  private static rowToLockInfo(row: WorkspaceLockRow): LockInfo {
    return {
      type: row.lock_type,
      pid: row.pid ?? undefined,
      command: row.command,
      startedAt: row.started_at,
      hostname: row.hostname,
      version: this.LOCK_VERSION,
    };
  }
}
