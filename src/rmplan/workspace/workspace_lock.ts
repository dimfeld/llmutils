import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';
import { debugLog } from '../../logging.ts';

const execAsync = promisify(exec);

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
  private static readonly LOCK_FILE_NAME = '.rmplan.lock';
  private static readonly LOCK_VERSION = 2;
  private static readonly STALE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Allow overriding process.pid for testing
  public static pid = process.pid;

  /**
   * Set a custom PID for testing purposes
   * @param pid The PID to use (pass undefined to reset to process.pid)
   */
  public static setTestPid(pid: number | undefined): void {
    this.pid = pid ?? process.pid;
  }

  private static readonly registeredCleanupHandlers = new Set<string>();

  static getLockFilePath(workspacePath: string): string {
    return path.join(workspacePath, this.LOCK_FILE_NAME);
  }

  static async acquireLock(
    workspacePath: string,
    command: string,
    options: AcquireLockOptions = {}
  ): Promise<LockInfo> {
    const lockFilePath = this.getLockFilePath(workspacePath);

    const lockType: LockType = options.type ?? 'persistent';
    const existingLock = await this.getLockInfo(workspacePath);

    if (existingLock) {
      if (existingLock.type === 'pid') {
        if (await this.isLockStale(existingLock)) {
          await this.clearStaleLock(workspacePath);
        } else {
          const pidInfo = existingLock.pid ? ` process ${existingLock.pid}` : '';
          throw new Error(`Workspace is already locked by${pidInfo}`);
        }
      } else {
        throw new Error('Workspace is already locked with a persistent lock');
      }
    }

    const lockInfo: LockInfo = {
      type: lockType,
      pid: this.pid,
      command,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: this.LOCK_VERSION,
    };

    if (options.owner) {
      // Store owner in command metadata to avoid schema changes while still surfacing info
      lockInfo.command = `${command} (owner: ${options.owner})`;
    }

    // Write lock file atomically
    const tempFile = `${lockFilePath}.${this.pid}.tmp`;
    try {
      await fs.promises.writeFile(tempFile, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });
      await fs.promises.rename(tempFile, lockFilePath);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await fs.promises.unlink(tempFile);
      } catch {
        // ignore
      }

      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Lock file already exists');
      }
      throw error;
    }

    return lockInfo;
  }

  static async releaseLock(
    workspacePath: string,
    options: ReleaseLockOptions = {}
  ): Promise<boolean> {
    const lockFilePath = this.getLockFilePath(workspacePath);
    const lockInfo = await this.getLockInfo(workspacePath);

    if (!lockInfo) {
      return false;
    }

    const force = options.force === true;

    if (lockInfo.type === 'persistent') {
      if (!force) {
        return false;
      }
    } else if (!force && lockInfo.pid !== this.pid) {
      return false;
    }

    try {
      await fs.promises.unlink(lockFilePath);
      this.registeredCleanupHandlers.delete(workspacePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  static async getLockInfo(workspacePath: string): Promise<LockInfo | null> {
    const lockFilePath = this.getLockFilePath(workspacePath);

    try {
      const content = await fs.promises.readFile(lockFilePath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<LockInfo> & { type?: LockType };
      return this.normalizeLockInfo(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  static async isLocked(workspacePath: string): Promise<boolean> {
    const lockInfo = await this.getLockInfo(workspacePath);
    if (!lockInfo) return false;

    if (lockInfo.type === 'persistent') {
      return true;
    }

    return !(await this.isLockStale(lockInfo));
  }

  static async isLockStale(lockInfo: LockInfo): Promise<boolean> {
    if (lockInfo.type === 'persistent') {
      return false;
    }

    // Check if lock is too old
    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    if (lockAge > this.STALE_LOCK_TIMEOUT_MS) {
      return true;
    }

    // Check if process is still alive
    if (!lockInfo.pid || !(await this.isProcessAlive(lockInfo.pid))) {
      return true;
    }

    return false;
  }

  static async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  static async clearStaleLock(workspacePath: string): Promise<void> {
    const lockInfo = await this.getLockInfo(workspacePath);
    if (lockInfo?.type === 'pid' && (await this.isLockStale(lockInfo))) {
      await fs.promises.unlink(this.getLockFilePath(workspacePath));
    }
  }

  static setupCleanupHandlers(workspacePath: string, type: LockType): void {
    if (type !== 'pid') {
      return;
    }

    if (this.registeredCleanupHandlers.has(workspacePath)) {
      return;
    }

    this.registeredCleanupHandlers.add(workspacePath);

    const cleanup = () => {
      try {
        // Use sync version in exit handlers
        const lockFilePath = this.getLockFilePath(workspacePath);
        const raw = fs.readFileSync(lockFilePath, 'utf-8');
        const lockInfo = this.normalizeLockInfo(JSON.parse(raw)) ?? undefined;
        if (lockInfo?.type === 'pid' && lockInfo.pid === this.pid) {
          fs.unlinkSync(lockFilePath);
        }
      } catch {
        // Ignore errors during cleanup
      }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
  }

  private static normalizeLockInfo(data: Partial<LockInfo> & { type?: LockType }): LockInfo | null {
    if (!data) {
      return null;
    }

    const startedAt = data.startedAt ?? new Date().toISOString();
    const type: LockType =
      data.type === 'pid' || data.type === 'persistent' ? data.type : 'persistent';

    return {
      type,
      pid: data.pid,
      command: data.command ?? 'unknown',
      startedAt,
      hostname: data.hostname ?? os.hostname(),
      version: data.version ?? this.LOCK_VERSION,
    };
  }
}
