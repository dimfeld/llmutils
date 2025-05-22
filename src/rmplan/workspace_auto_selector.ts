import * as path from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { log } from '../logging.js';
import { WorkspaceLock, type LockInfo } from './workspace_lock.js';
import { WorkspaceManager } from './workspace_manager.js';
import {
  findWorkspacesByRepoUrl,
  findWorkspacesByTaskId,
  updateWorkspaceLockStatus,
  getDefaultTrackingFilePath,
  type WorkspaceInfo,
} from './workspace_tracker.js';
import type { RmplanConfig } from './configSchema.js';
import { getGitRoot } from '../rmfilter/utils.js';

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
    private workspaceManager: WorkspaceManager,
    private config: RmplanConfig
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

    // Get repository URL from config or infer from current git repo
    let repositoryUrl = this.config.workspaceCreation?.repositoryUrl;
    if (!repositoryUrl) {
      try {
        const gitRoot = await getGitRoot(process.cwd());
        const { $ } = await import('bun');
        const result = await $`git remote get-url origin`.cwd(gitRoot).text();
        repositoryUrl = result.trim();
      } catch (error) {
        log(`Failed to get repository URL: ${String(error)}`);
        return null;
      }
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
    const workspaces = await findWorkspacesByRepoUrl(repositoryUrl, trackingFilePath);
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
      if (lockInfo && (await WorkspaceLock.isLockStale(lockInfo))) {
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
    const lockAge = Date.now() - new Date(lockInfo.startedAt).getTime();
    const lockAgeHours = Math.round(lockAge / (1000 * 60 * 60));

    if (interactive) {
      console.log(chalk.yellow('\nFound a stale lock:'));
      console.log(`  Workspace: ${workspace.workspacePath}`);
      console.log(`  Task ID: ${workspace.taskId}`);
      console.log(`  Locked by PID: ${lockInfo.pid} on ${lockInfo.hostname}`);
      console.log(`  Lock age: ${lockAgeHours} hours`);

      const shouldClear = await confirm({
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
    const workspace = await this.workspaceManager.createWorkspace(
      taskId,
      planFilePath,
      this.config
    );

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
  static async listWorkspacesWithStatus(repositoryUrl: string, trackingFilePath?: string): Promise<void> {
    const workspaces = await findWorkspacesByRepoUrl(repositoryUrl, trackingFilePath);
    const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);

    if (workspacesWithStatus.length === 0) {
      console.log('No workspaces found for this repository');
      return;
    }

    console.log('\nWorkspaces:');
    for (const workspace of workspacesWithStatus) {
      const status = workspace.lockedBy
        ? chalk.red(`🔒 Locked by PID ${workspace.lockedBy.pid} on ${workspace.lockedBy.hostname}`)
        : chalk.green('🔓 Available');

      console.log(`\n${status}`);
      console.log(`  Path: ${workspace.workspacePath}`);
      console.log(`  Task: ${workspace.taskId}`);
      console.log(`  Branch: ${workspace.branch}`);
      console.log(`  Created: ${new Date(workspace.createdAt).toLocaleString()}`);

      if (workspace.lockedBy) {
        const lockAge = Date.now() - new Date(workspace.lockedBy.startedAt).getTime();
        const lockAgeHours = Math.round(lockAge / (1000 * 60 * 60));
        console.log(`  Lock age: ${lockAgeHours} hours`);
      }
    }
  }
}
