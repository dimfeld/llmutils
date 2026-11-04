import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkingCopyStatus } from '../../common/git.js';
import { log } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { deleteWorkspace, setWorkspaceDisabledAt } from '../db/workspace.js';
import type { WorkspaceInfo } from './workspace_info.js';
import { WorkspaceLock } from './workspace_lock.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_WORKSPACE_DISABLE_AFTER_DAYS = 7;
export const DEFAULT_WORKSPACE_DELETE_AFTER_DAYS = 3;

export interface WorkspaceCleanupSettings {
  enabled: boolean;
  disableAfterDays: number;
  deleteAfterDays: number;
}

export function resolveWorkspaceCleanupSettings(config: TimConfig): WorkspaceCleanupSettings {
  const cleanup = config.workspaceCleanup;
  return {
    enabled: cleanup?.enabled ?? true,
    disableAfterDays: cleanup?.disableAfterDays ?? DEFAULT_WORKSPACE_DISABLE_AFTER_DAYS,
    deleteAfterDays: cleanup?.deleteAfterDays ?? DEFAULT_WORKSPACE_DELETE_AFTER_DAYS,
  };
}

export interface WorkspaceCleanupOptions {
  /** Report what would change without writing to the DB or deleting directories. */
  dryRun?: boolean;
  /** Reference time. Defaults to the current time. */
  now?: Date;
  /**
   * Paths that must never be deleted, such as the repository root of the running command.
   * A workspace that contains one of these paths is also kept. `process.cwd()` is always
   * protected.
   */
  protectedPaths?: string[];
}

export interface WorkspaceCleanupSkip {
  workspacePath: string;
  reason: string;
}

export interface WorkspaceCleanupResult {
  /** Workspaces that this run disabled. */
  disabled: string[];
  /** Workspaces whose directory and record this run deleted. */
  deleted: string[];
  /** Workspaces that were due for deletion but were kept. */
  skipped: WorkspaceCleanupSkip[];
}

/**
 * Disables 'auto' workspaces that are older than `disableAfterDays`, and deletes 'auto'
 * workspaces that were disabled more than `deleteAfterDays` ago.
 *
 * Only workspaces with type 'auto' are affected. A workspace is not deleted when it is
 * locked, when it has uncommitted changes, when its status check fails, or when it contains
 * a protected path.
 */
export async function cleanupWorkspaces(
  workspaces: WorkspaceInfo[],
  settings: WorkspaceCleanupSettings,
  options: WorkspaceCleanupOptions = {}
): Promise<WorkspaceCleanupResult> {
  const result: WorkspaceCleanupResult = { disabled: [], deleted: [], skipped: [] };
  if (!settings.enabled) {
    return result;
  }

  const db = getDatabase();
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const protectedPaths = [process.cwd(), ...(options.protectedPaths ?? [])].map((p) =>
    path.resolve(p)
  );

  for (const workspace of workspaces) {
    if (workspace.workspaceType !== 'auto') {
      continue;
    }

    let disabledAt = workspace.disabledAt;
    if (!disabledAt) {
      const createdMs = Date.parse(workspace.createdAt);
      if (!Number.isFinite(createdMs) || nowMs - createdMs < settings.disableAfterDays * DAY_MS) {
        continue;
      }

      disabledAt = now.toISOString();
      if (!options.dryRun) {
        setWorkspaceDisabledAt(db, workspace.workspacePath, disabledAt);
        workspace.disabledAt = disabledAt;
      }
      result.disabled.push(workspace.workspacePath);
    }

    const disabledMs = Date.parse(disabledAt);
    if (Number.isFinite(disabledMs) && nowMs - disabledMs < settings.deleteAfterDays * DAY_MS) {
      continue;
    }

    const skipReason = await deleteDisabledWorkspace(workspace, protectedPaths, options.dryRun);
    if (skipReason) {
      result.skipped.push({ workspacePath: workspace.workspacePath, reason: skipReason });
    } else {
      result.deleted.push(workspace.workspacePath);
    }
  }

  return result;
}

/**
 * Deletes the workspace directory and its DB record. Returns a reason string when the
 * workspace was kept, or null when it was deleted (or would be deleted in dry-run mode).
 */
async function deleteDisabledWorkspace(
  workspace: WorkspaceInfo,
  protectedPaths: string[],
  dryRun: boolean | undefined
): Promise<string | null> {
  const workspacePath = path.resolve(workspace.workspacePath);
  const unsafeReason = getUnsafeDeletePathReason(workspacePath, protectedPaths);
  if (unsafeReason) {
    return unsafeReason;
  }

  if (await WorkspaceLock.isLocked(workspacePath)) {
    return 'workspace is locked';
  }

  let stats: Awaited<ReturnType<typeof fs.lstat>> | null;
  try {
    stats = await fs.lstat(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `could not check directory: ${(error as Error).message}`;
    }
    stats = null;
  }

  if (stats?.isSymbolicLink()) {
    return 'workspace path is a symbolic link';
  }
  if (stats && !stats.isDirectory()) {
    return 'workspace path is not a directory';
  }

  if (stats) {
    const status = await getWorkingCopyStatus(workspacePath);
    if (status.checkFailed) {
      return 'could not check for uncommitted changes';
    }
    if (status.hasChanges) {
      return 'workspace has uncommitted changes';
    }
  }

  if (dryRun) {
    return null;
  }

  // Hold a lock while deleting so that no other process starts to use the workspace.
  try {
    await WorkspaceLock.acquireLock(workspacePath, 'tim workspace cleanup', { type: 'pid' });
  } catch (error) {
    return `could not lock workspace: ${(error as Error).message}`;
  }

  try {
    if (stats) {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  } catch (error) {
    await WorkspaceLock.releaseLock(workspacePath, { force: true });
    return `could not delete directory: ${(error as Error).message}`;
  }

  // Deleting the record also removes the lock row through ON DELETE CASCADE.
  deleteWorkspace(getDatabase(), workspacePath);
  log(`Deleted disabled workspace: ${workspacePath}`);
  return null;
}

function getUnsafeDeletePathReason(workspacePath: string, protectedPaths: string[]): string | null {
  if (!path.isAbsolute(workspacePath)) {
    return 'workspace path is not absolute';
  }

  if (workspacePath === path.parse(workspacePath).root || workspacePath === os.homedir()) {
    return 'workspace path is a root or home directory';
  }

  for (const protectedPath of protectedPaths) {
    if (isSameOrInside(protectedPath, workspacePath)) {
      return 'workspace contains the current directory or repository';
    }
  }

  return null;
}

function isSameOrInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') {
    return true;
  }
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

/** Prints a short summary of a cleanup run. Prints nothing when the run made no changes. */
export function logWorkspaceCleanupResult(result: WorkspaceCleanupResult, dryRun = false): void {
  const prefix = dryRun ? 'Would disable' : 'Disabled';
  for (const workspacePath of result.disabled) {
    log(`${prefix} old auto workspace: ${workspacePath}`);
  }
  if (dryRun) {
    for (const workspacePath of result.deleted) {
      log(`Would delete disabled workspace: ${workspacePath}`);
    }
  }
  for (const skip of result.skipped) {
    log(`Kept disabled workspace ${skip.workspacePath}: ${skip.reason}`);
  }
}
