import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logSpawn } from '../../common/process.js';
import { error, log, sendStructured, warn } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { findWorkspaceInfosByTaskId } from './workspace_info.js';
import { WorkspaceLock } from './workspace_lock.js';
import { createWorkspace, type Workspace } from './workspace_manager.js';

export interface WorkspaceSetupOptions {
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  nonInteractive?: boolean;
  requireWorkspace?: boolean;
  planUuid?: string;
}

export interface WorkspaceSetupResult {
  baseDir: string;
  planFile: string;
  workspaceTaskId?: string;
  isNewWorkspace?: boolean;
}

function timestamp(): string {
  return new Date().toISOString();
}

export async function setupWorkspace(
  options: WorkspaceSetupOptions,
  currentBaseDir: string,
  currentPlanFile: string,
  config: TimConfig,
  commandLabel: string
): Promise<WorkspaceSetupResult> {
  let baseDir = currentBaseDir;
  let planFile = currentPlanFile;
  let workspaceTaskId: string | undefined;
  let isNewWorkspace: boolean | undefined;

  if (options.workspace || options.autoWorkspace) {
    let workspace: Workspace | null | undefined;
    let selectedWorkspace:
      | Awaited<ReturnType<WorkspaceAutoSelector['selectWorkspace']>>
      | undefined;

    if (options.autoWorkspace) {
      log('Auto-selecting workspace...');
      const selector = new WorkspaceAutoSelector(baseDir, config);
      const taskId =
        options.workspace || `${path.parse(baseDir).dir.split(path.sep).pop()}-${Date.now()}`;

      selectedWorkspace = await selector.selectWorkspace(taskId, planFile, {
        interactive: !options.nonInteractive,
        preferNewWorkspace: options.newWorkspace,
        ...(options.planUuid ? { preferredPlanUuid: options.planUuid } : {}),
      });

      if (selectedWorkspace) {
        workspace = {
          path: selectedWorkspace.workspace.workspacePath,
          originalPlanFilePath: selectedWorkspace.workspace.originalPlanFilePath,
          taskId: selectedWorkspace.workspace.taskId,
        };

        if (selectedWorkspace.isNew) {
          log(`Created new workspace for task: ${workspace.taskId}`);
        } else {
          log(`Selected existing workspace for task: ${selectedWorkspace.workspace.taskId}`);
          if (selectedWorkspace.clearedStaleLock) {
            log('(Cleared stale lock)');
          }
        }
      }
    } else if (options.workspace) {
      const existingWorkspaces = findWorkspaceInfosByTaskId(options.workspace);

      if (options.newWorkspace) {
        log(`Creating workspace for task: ${options.workspace}`);
        workspace = await createWorkspace(baseDir, options.workspace, planFile, config);
        isNewWorkspace = true;
      } else if (existingWorkspaces.length > 0) {
        let availableWorkspace = null;
        for (const ws of existingWorkspaces) {
          const lockInfo = await WorkspaceLock.getLockInfo(ws.workspacePath);
          if (!lockInfo) {
            availableWorkspace = ws;
            break;
          }

          if (await WorkspaceLock.isLockStale(lockInfo)) {
            await WorkspaceLock.clearStaleLock(ws.workspacePath);
            availableWorkspace = ws;
            break;
          }
        }

        if (availableWorkspace) {
          log(`Using existing workspace for task: ${options.workspace}`);
          workspace = {
            path: availableWorkspace.workspacePath,
            originalPlanFilePath: availableWorkspace.originalPlanFilePath,
            taskId: availableWorkspace.taskId,
          };
        } else {
          throw new Error(
            `Workspace with task ID '${options.workspace}' exists but is locked, and --new-workspace was not specified. Cannot proceed.`
          );
        }
      } else {
        log(`Creating workspace for task: ${options.workspace}`);
        workspace = await createWorkspace(baseDir, options.workspace, planFile, config);
        isNewWorkspace = true;
      }
    }

    if (!workspace) {
      if (options.requireWorkspace) {
        throw new Error('Workspace creation was required but failed. Exiting.');
      }
      error('Failed to create workspace. Continuing in the current directory.');
    } else {
      workspaceTaskId = workspace.taskId;
      if (selectedWorkspace?.isNew !== undefined) {
        isNewWorkspace = selectedWorkspace.isNew;
      }

      try {
        const gitStatus = logSpawn(['git', 'status'], {
          cwd: workspace.path,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        await gitStatus.exited;
        if (gitStatus.exitCode !== 0) {
          warn(
            `Workspace at ${workspace.path} may not be properly initialized. Git operations failed.`
          );
        }
      } catch (err) {
        warn(`Error validating workspace: ${err as Error}`);
      }

      const workspacePlanFile = path.join(workspace.path, path.basename(planFile));
      try {
        log(`Copying plan file to workspace: ${workspacePlanFile}`);
        const srcContent = await fs.readFile(planFile, 'utf8');
        await fs.writeFile(workspacePlanFile, srcContent, 'utf8');
        planFile = workspacePlanFile;
        log(`Using plan file in workspace: ${planFile}`);
      } catch (err) {
        error(`Failed to copy plan file to workspace: ${err as Error}`);
        error('Continuing with original plan file.');
      }

      baseDir = workspace.path;
      sendStructured({
        type: 'workspace_info',
        timestamp: timestamp(),
        workspaceId: workspace.taskId,
        path: workspace.path,
        planFile,
      });

      // createWorkspace() acquires a persistent lock. Replace it with a PID lock so
      // signal-based cleanup handlers can release it on interruption.
      if (isNewWorkspace) {
        await WorkspaceLock.releaseLock(workspace.path, { force: true });
      }
      const lockInfo = await WorkspaceLock.acquireLock(
        workspace.path,
        `${commandLabel} --workspace ${workspace.taskId}`,
        { type: 'pid' }
      );
      WorkspaceLock.setupCleanupHandlers(workspace.path, lockInfo.type);

      log('---');

      return { baseDir, planFile, workspaceTaskId, isNewWorkspace };
    }
  }

  const lockInfo = await WorkspaceLock.acquireLock(baseDir, commandLabel, { type: 'pid' });
  WorkspaceLock.setupCleanupHandlers(baseDir, lockInfo.type);

  return { baseDir, planFile, workspaceTaskId, isNewWorkspace };
}
