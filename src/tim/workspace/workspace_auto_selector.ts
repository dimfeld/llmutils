import * as path from 'node:path';
import chalk from 'chalk';
import { promptConfirm } from '../../common/input.js';
import { log } from '../../logging.js';
import { WorkspaceLock, type LockInfo } from './workspace_lock.js';
import { createWorkspace } from './workspace_manager.js';
import {
  findWorkspacesByRepositoryId,
  findWorkspacesByTaskId,
  updateWorkspaceLockStatus,
  getDefaultTrackingFilePath,
  type WorkspaceInfo,
} from './workspace_tracker.js';
import type { TimConfig } from '../configSchema.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

export interface AutoSelectOptions {
  /** Whether to run in interactive mode (prompt for stale locks) */
  interactive?: boolean;
  /** Custom stale lock timeout in ms (default: 24 hours) */
  staleLockTimeout?: number;
  /** Whether to prefer creating new workspace over clearing stale locks */
  preferNewWorkspace?: boolean;
}

export interface SelectedWorkspace {
  /** The selected workspace info */
  workspace: WorkspaceInfo;
  /** Whether this is a newly created workspace */
  isNew: boolean;
  /** Whether a stale lock was cleared */
  clearedStaleLock: boolean;
}

/**
 * Automatically selects or creates a workspace for a task
 */
export class WorkspaceAutoSelector {
  constructor(
    private mainRepoRoot: string,
    private config: TimConfig
  ) {}

  /**
   * Automatically choose an available workspace or create a new one
   * @param taskId The task ID for workspace selection
   * @param planFilePath The plan file path
   * @param options Options for workspace selection
   * @returns Selected workspace or null if cancelled/failed
   */
  async selectWorkspace(
    taskId: string,
    planFilePath: string,
    options: AutoSelectOptions = {}
  ): Promise<SelectedWorkspace | null> {
    const { interactive = true, preferNewWorkspace = false } = options;

    // Get repository ID from current git repo
    let repositoryId: string;
    try {
      const identity = await getRepositoryIdentity({ cwd: this.mainRepoRoot });
      repositoryId = identity.repositoryId;
    } catch (error) {
      log(`Failed to get repository identity: ${String(error)}`);
      return null;
    }

    if (preferNewWorkspace) {
      // Try to create new workspace first
      const newWorkspace = await this.createNewWorkspace(taskId, planFilePath);
      if (newWorkspace) {
        return { workspace: newWorkspace, isNew: true, clearedStaleLock: false };
      }
    }

    // Find existing workspaces for this repository
    const trackingFilePath = this.config.paths?.trackingFile || getDefaultTrackingFilePath();
    const workspaces = await findWorkspacesByRepositoryId(repositoryId, trackingFilePath);
    const workspacesWithLockStatus = await updateWorkspaceLockStatus(workspaces);

    // Sort workspaces: unlocked first, then by creation date (newest first)
    workspacesWithLockStatus.sort((a, b) => {
      if (!a.lockedBy && b.lockedBy) return -1;
      if (a.lockedBy && !b.lockedBy) return 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Try to find an unlocked workspace
    for (const workspace of workspacesWithLockStatus) {
      if (!workspace.lockedBy) {
        log(`Selected unlocked workspace: ${workspace.workspacePath}`);
        return { workspace, isNew: false, clearedStaleLock: false };
      }

      // Check if lock is stale
      const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);
      if (lockInfo?.type === 'pid' && (await WorkspaceLock.isLockStale(lockInfo))) {
        const cleared = await this.handleStaleLock(workspace, lockInfo, interactive);
        if (cleared) {
          log(`Selected workspace after clearing stale lock: ${workspace.workspacePath}`);
          return { workspace, isNew: false, clearedStaleLock: true };
        }
      }
    }

    // All workspaces are locked, create a new one
    log('All existing workspaces are locked, creating a new workspace');
    const newWorkspace = await this.createNewWorkspace(taskId, planFilePath);

    if (newWorkspace) {
      return { workspace: newWorkspace, isNew: true, clearedStaleLock: false };
    }

    log('Failed to select or create a workspace');
    return null;
  }

  /**
   * Handle a stale lock - prompt in interactive mode or auto-clear in non-interactive
   */
  private async handleStaleLock(
    workspace: WorkspaceInfo,
    lockInfo: LockInfo,
    interactive: boolean
  ): Promise<boolean> {
    if (lockInfo.type !== 'pid') {
      return false;
    }

    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    const lockAgeHours = Math.round(lockAge / (1000 * 60 * 60));

    if (interactive) {
      console.log(chalk.yellow('\nFound a stale lock:'));
      console.log(`  Workspace: ${workspace.workspacePath}`);
      console.log(`  Task ID: ${workspace.taskId}`);
      console.log(`  Locked by PID: ${lockInfo.pid} on ${lockInfo.hostname}`);
      console.log(`  Lock age: ${lockAgeHours} hours`);

      const shouldClear = await promptConfirm({
        message: 'Clear this stale lock and use the workspace?',
        default: true,
      });

      if (!shouldClear) {
        return false;
      }
    } else {
      log(
        `Auto-clearing stale lock for workspace ${workspace.workspacePath} (${lockAgeHours} hours old)`
      );
    }

    try {
      await WorkspaceLock.clearStaleLock(workspace.workspacePath);
      return true;
    } catch (error) {
      log(`Failed to clear stale lock: ${String(error)}`);
      return false;
    }
  }

  /**
   * Create a new workspace
   */
  private async createNewWorkspace(
    taskId: string,
    planFilePath: string
  ): Promise<WorkspaceInfo | null> {
    const workspace = await createWorkspace(this.mainRepoRoot, taskId, planFilePath, this.config);

    if (!workspace) {
      return null;
    }

    // Get the workspace info from tracker
    const trackingFilePath = this.config.paths?.trackingFile || getDefaultTrackingFilePath();
    const workspaces = await findWorkspacesByTaskId(taskId, trackingFilePath);
    return workspaces.find((w) => w.workspacePath === workspace.path) || null;
  }

  /**
   * List all workspaces with their lock status
   */
  static async listWorkspacesWithStatus(
    repositoryId: string,
    trackingFilePath?: string
  ): Promise<void> {
    const workspaces = await findWorkspacesByRepositoryId(repositoryId, trackingFilePath);
    const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);

    if (workspacesWithStatus.length === 0) {
      console.log('No workspaces found for this repository');
      return;
    }

    console.log('\nWorkspaces:');
    for (const workspace of workspacesWithStatus) {
      if (workspace.lockedBy) {
        const statusLabel = `🔒 Locked (${workspace.lockedBy.type})`;
        console.log(`\n${chalk.red(statusLabel)}`);
      } else {
        console.log(`\n${chalk.green('🔓 Available')}`);
      }
      console.log(`  Path: ${workspace.workspacePath}`);
      console.log(`  Task: ${workspace.taskId}`);
      console.log(`  Branch: ${workspace.branch}`);
      console.log(`  Created: ${new Date(workspace.createdAt).toLocaleString()}`);

      if (workspace.lockedBy) {
        if (workspace.lockedBy.pid) {
          const pidLine = workspace.lockedBy.hostname
            ? `  PID: ${workspace.lockedBy.pid} on ${workspace.lockedBy.hostname}`
            : `  PID: ${workspace.lockedBy.pid}`;
          console.log(pidLine);
        } else if (workspace.lockedBy.hostname) {
          console.log(`  Host: ${workspace.lockedBy.hostname}`);
        }

        if (workspace.lockedBy.command) {
          console.log(`  Command: ${workspace.lockedBy.command}`);
        }

        const lockAgeMs = Date.now() - new Date(workspace.lockedBy.startedAt).getTime();
        const duration = formatDuration(lockAgeMs);
        const durationLine = `  Locked for: ${duration}`;
        const highlight = lockAgeMs >= ONE_DAY_MS;
        console.log(highlight ? chalk.yellow(durationLine) : durationLine);
      }
    }
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function formatDuration(durationMs: number): string {
  if (durationMs <= 0) {
    return 'less than a minute';
  }

  const minutesTotal = Math.floor(durationMs / (60 * 1000));
  const days = Math.floor(minutesTotal / (60 * 24));
  const hours = Math.floor((minutesTotal % (60 * 24)) / 60);
  const minutes = minutesTotal % 60;

  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (parts.length === 0 || minutes > 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(' ');
}
