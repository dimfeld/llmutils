import * as path from 'node:path';
import chalk from 'chalk';
import { confirm } from '@inquirer/prompts';
import { log } from '../../logging.js';
import { WorkspaceLock, type LockInfo } from './workspace_lock.js';
import { createWorkspace, type Workspace } from './workspace_manager.js';
import {
  findWorkspacesByRepoUrl,
  findWorkspacesByTaskId,
  updateWorkspaceLockStatus,
  lockWorkspaceToTask,
  type WorkspaceInfo,
} from './workspace_tracker.js';
import type { RmplanConfig } from '../configSchema.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { db } from '../../bot/db/index.js';
import { tasks as tasksTable, workspaces as workspacesTable } from '../../bot/db/index.js';
import { eq, sql, and, isNull } from 'drizzle-orm';

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
    const workspaces = await findWorkspacesByRepoUrl(repositoryUrl);
    const workspacesWithLockStatus = await updateWorkspaceLockStatus(workspaces);

    // Sort workspaces:
    // 1. Prioritize workspaces where lockedByTaskId is NULL
    // 2. For available workspaces (lockedByTaskId is NULL), sort by newest createdAt first
    // 3. For locked workspaces, sort by oldest lastAccessedAt first (for reuse)
    workspacesWithLockStatus.sort((a, b) => {
      // First, prioritize unlocked workspaces
      if (a.lockedByTaskId === null && b.lockedByTaskId !== null) return -1;
      if (a.lockedByTaskId !== null && b.lockedByTaskId === null) return 1;

      // If both are unlocked, sort by newest createdAt first
      if (a.lockedByTaskId === null && b.lockedByTaskId === null) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }

      // If both are locked, sort by oldest lastAccessedAt first
      const aAccessTime = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
      const bAccessTime = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
      return aAccessTime - bAccessTime;
    });

    // Try to find an unlocked workspace
    for (const workspace of workspacesWithLockStatus) {
      // Check if workspace is locked by another task (application-level lock)
      if (workspace.lockedByTaskId && workspace.lockedByTaskId !== taskId) {
        // Check if the locking task is completed or failed - if so, we can reuse the workspace
        const lockingTask = await db
          .select()
          .from(tasksTable)
          .where(eq(tasksTable.id, workspace.lockedByTaskId))
          .limit(1);

        if (lockingTask.length > 0) {
          const taskStatus = lockingTask[0].status;
          if (taskStatus === 'completed' || taskStatus === 'failed') {
            // The locking task is done, we can clear the lock
            log(
              `Workspace locked by ${taskStatus} task ${workspace.lockedByTaskId}, clearing lock`
            );

            // Clear the application-level lock
            await db
              .update(workspacesTable)
              .set({ lockedByTaskId: null })
              .where(eq(workspacesTable.workspacePath, workspace.workspacePath));

            // Update our local copy
            workspace.lockedByTaskId = null;
          } else {
            // Task is still active, skip this workspace
            continue;
          }
        } else {
          // Task not found in DB, but workspace is locked - this is an inconsistency
          log(`Warning: Workspace locked by unknown task ${workspace.lockedByTaskId}`);
          continue;
        }
      }

      // Check filesystem lock
      const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);
      if (!lockInfo || (await WorkspaceLock.isLockStale(lockInfo))) {
        // Clear stale lock if present
        if (lockInfo) {
          await WorkspaceLock.clearStaleLock(workspace.workspacePath);
        }

        // Lock this workspace to our task and update lastAccessedAt
        try {
          await db
            .update(workspacesTable)
            .set({
              lockedByTaskId: taskId,
              lastAccessedAt: new Date(),
            })
            .where(eq(workspacesTable.workspacePath, workspace.workspacePath));
        } catch (error) {
          log(`Warning: Failed to lock workspace to task: ${String(error)}`);
          // Continue anyway
        }

        // Acquire filesystem lock
        try {
          await WorkspaceLock.acquireLock(workspace.workspacePath, `rmplan-task:${taskId}`);
        } catch (error) {
          log(`Warning: Failed to acquire filesystem lock: ${String(error)}`);
          // Continue anyway - DB lock is more important
        }

        log(`Selected unlocked workspace: ${workspace.workspacePath}`);
        return { workspace, isNew: false, clearedStaleLock: !!lockInfo };
      }

      // Handle stale lock in interactive mode
      if (lockInfo && interactive && (await WorkspaceLock.isLockStale(lockInfo))) {
        const cleared = await this.handleStaleLock(workspace, lockInfo, interactive);
        if (cleared) {
          // Lock this workspace to our task and update lastAccessedAt
          try {
            await db
              .update(workspacesTable)
              .set({
                lockedByTaskId: taskId,
                lastAccessedAt: new Date(),
              })
              .where(eq(workspacesTable.workspacePath, workspace.workspacePath));
          } catch (error) {
            log(`Warning: Failed to lock workspace to task: ${String(error)}`);
            // Continue anyway
          }

          // Acquire filesystem lock
          try {
            await WorkspaceLock.acquireLock(workspace.workspacePath, `rmplan-task:${taskId}`);
          } catch (error) {
            log(`Warning: Failed to acquire filesystem lock: ${String(error)}`);
            // Continue anyway - DB lock is more important
          }

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
      console.log(`  Filesystem lock: PID ${lockInfo.pid} on ${lockInfo.hostname}`);
      console.log(`  Lock age: ${lockAgeHours} hours`);
      if (workspace.lockedByTaskId) {
        console.log(`  Application lock: Task ${workspace.lockedByTaskId}`);
      }

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
    const workspace = await createWorkspace(this.mainRepoRoot, taskId, planFilePath, this.config);

    if (!workspace) {
      return null;
    }

    // Get the workspace info from tracker
    const workspaces = await findWorkspacesByTaskId(taskId);
    const workspaceInfo = workspaces.find((w) => w.workspacePath === workspace.path);

    if (!workspaceInfo) {
      // This shouldn't happen, but handle it gracefully
      log(
        `Warning: Could not find workspace info for newly created workspace at ${workspace.path}`
      );
      return null;
    }

    return workspaceInfo;
  }

  /**
   * List all workspaces with their lock status
   */
  static async listWorkspacesWithStatus(repositoryUrl: string): Promise<void> {
    const workspaces = await findWorkspacesByRepoUrl(repositoryUrl);
    const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);

    if (workspacesWithStatus.length === 0) {
      console.log('No workspaces found for this repository');
      return;
    }

    console.log('\nWorkspaces:');
    for (const workspace of workspacesWithStatus) {
      // Build status display based on lock information
      let status: string;
      const statusParts: string[] = [];

      // Primary status: Application-level lock (lockedByTaskId)
      if (workspace.lockedByTaskId) {
        statusParts.push(chalk.yellow(`📌 Reserved by task ${workspace.lockedByTaskId}`));
      }

      // Secondary status: Filesystem lock
      if (workspace.fileSystemLock) {
        statusParts.push(
          chalk.red(
            `🔒 Locked by PID ${workspace.fileSystemLock.pid} on ${workspace.fileSystemLock.hostname}`
          )
        );
      }

      // If no locks, it's available
      if (statusParts.length === 0) {
        status = chalk.green('🔓 Available');
      } else {
        status = statusParts.join(' | ');
      }

      console.log(`\n${status}`);
      console.log(`  Path: ${workspace.workspacePath}`);
      console.log(`  Task: ${workspace.taskId}`);
      console.log(`  Branch: ${workspace.branch}`);
      console.log(`  Created: ${new Date(workspace.createdAt).toLocaleString()}`);

      if (workspace.lastAccessedAt) {
        console.log(`  Last accessed: ${new Date(workspace.lastAccessedAt).toLocaleString()}`);
      }

      // Show filesystem lock age if present
      if (workspace.fileSystemLock) {
        const lockAge = Date.now() - new Date(workspace.fileSystemLock.startedAt).getTime();
        const lockAgeHours = Math.round(lockAge / (1000 * 60 * 60));
        console.log(`  Filesystem lock age: ${lockAgeHours} hours`);
      }
    }
  }
}
