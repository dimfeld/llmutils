import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

const execAsync = promisify(exec);

export interface LockInfo {
  pid: number;
  command: string;
  startedAt: string;
  hostname: string;
  version: number;
}

export class WorkspaceLock {
  private static readonly LOCK_FILE_NAME = '.rmplan.lock';
  private static readonly LOCK_VERSION = 1;
  private static readonly STALE_LOCK_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

  static getLockFilePath(workspacePath: string): string {
    return path.join(workspacePath, this.LOCK_FILE_NAME);
  }

  static async acquireLock(workspacePath: string, command: string): Promise<LockInfo> {
    const lockFilePath = this.getLockFilePath(workspacePath);
    
    // Check if lock already exists
    const existingLock = await this.getLockInfo(workspacePath);
    if (existingLock && !await this.isLockStale(existingLock)) {
      throw new Error(`Workspace is already locked by process ${existingLock.pid}`);
    }

    // Create lock info
    const lockInfo: LockInfo = {
      pid: process.pid,
      command,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      version: this.LOCK_VERSION,
    };

    // Write lock file atomically
    const tempFile = `${lockFilePath}.${process.pid}.tmp`;
    try {
      await fs.promises.writeFile(tempFile, JSON.stringify(lockInfo, null, 2), { flag: 'wx' });
      await fs.promises.rename(tempFile, lockFilePath);
    } catch (error) {
      // Clean up temp file if it exists
      try {
        await fs.promises.unlink(tempFile);
      } catch {}
      
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('Lock file already exists');
      }
      throw error;
    }

    return lockInfo;
  }

  static async releaseLock(workspacePath: string): Promise<void> {
    const lockFilePath = this.getLockFilePath(workspacePath);
    
    // Verify we own the lock before releasing
    const lockInfo = await this.getLockInfo(workspacePath);
    if (lockInfo && lockInfo.pid === process.pid) {
      try {
        await fs.promises.unlink(lockFilePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  }

  static async getLockInfo(workspacePath: string): Promise<LockInfo | null> {
    const lockFilePath = this.getLockFilePath(workspacePath);
    
    try {
      const content = await fs.promises.readFile(lockFilePath, 'utf-8');
      return JSON.parse(content) as LockInfo;
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
    
    return !await this.isLockStale(lockInfo);
  }

  static async isLockStale(lockInfo: LockInfo): Promise<boolean> {
    // Check if lock is too old
    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    if (lockAge > this.STALE_LOCK_TIMEOUT_MS) {
      return true;
    }

    // Check if process is still alive
    if (!await this.isProcessAlive(lockInfo.pid)) {
      return true;
    }

    // On same host, check if process is rmplan
    if (lockInfo.hostname === os.hostname()) {
      return !await this.isRmplanProcess(lockInfo.pid);
    }

    // Can't verify process on different host, assume not stale
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

  static async isRmplanProcess(pid: number): Promise<boolean> {
    const platform = process.platform;
    
    try {
      if (platform === 'linux') {
        const cmdlinePath = `/proc/${pid}/cmdline`;
        const cmdline = await fs.promises.readFile(cmdlinePath, 'utf-8');
        return cmdline.includes('rmplan');
      } else if (platform === 'darwin') {
        const { stdout } = await execAsync(`ps -p ${pid} -o comm=`);
        return stdout.trim().includes('node') || stdout.trim().includes('bun');
      } else if (platform === 'win32') {
        const { stdout } = await execAsync(`wmic process where ProcessId=${pid} get CommandLine`);
        return stdout.includes('rmplan');
      }
    } catch {
      // If we can't determine, assume it's not rmplan
      return false;
    }
    
    return false;
  }

  static async clearStaleLock(workspacePath: string): Promise<void> {
    const lockInfo = await this.getLockInfo(workspacePath);
    if (lockInfo && await this.isLockStale(lockInfo)) {
      await fs.promises.unlink(this.getLockFilePath(workspacePath));
    }
  }

  static setupCleanupHandlers(workspacePath: string): void {
    const cleanup = () => {
      try {
        // Use sync version in exit handlers
        const lockFilePath = this.getLockFilePath(workspacePath);
        const lockInfo = JSON.parse(fs.readFileSync(lockFilePath, 'utf-8')) as LockInfo;
        if (lockInfo.pid === process.pid) {
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
}