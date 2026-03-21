import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getGitRoot, getUsingJj, getWorkingCopyStatus } from '../../common/git.js';
import { logSpawn } from '../../common/process.js';
import { error, log, sendStructured, warn } from '../../logging.js';
import { generateBranchNameFromPlan } from '../commands/branch.js';
import type { TimConfig } from '../configSchema.js';
import { updateHeadlessSessionInfo } from '../headless.js';
import { resolveConfiguredTasksPath } from '../path_resolver.js';
import { readAllPlans, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { findWorkspaceInfosByTaskId } from './workspace_info.js';
import { WorkspaceAlreadyLocked, WorkspaceLock } from './workspace_lock.js';
import {
  createWorkspace,
  prepareExistingWorkspace,
  runWorkspaceUpdateCommands,
  type Workspace,
} from './workspace_manager.js';

export interface WorkspaceSetupOptions {
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  nonInteractive?: boolean;
  requireWorkspace?: boolean;
  planUuid?: string;
  base?: string;
  createBranch?: boolean;
  allowPrimaryWorkspaceWhenLocked?: boolean;
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

async function getParentPlanBranch(
  planFile: string,
  plan: PlanSchema,
  config: TimConfig,
  currentBaseDir: string
): Promise<string | undefined> {
  if (!plan.parent) {
    return undefined;
  }

  const gitRoot = await getGitRoot(currentBaseDir);
  const tasksDir = resolveConfiguredTasksPath(config, gitRoot);
  const { plans } = await readAllPlans(tasksDir, false);
  return plans.get(plan.parent)?.branch;
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
        createBranch: options.createBranch,
        base: options.base,
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
        workspace = await createWorkspace(baseDir, options.workspace, planFile, config, {
          ...(options.createBranch !== undefined && { createBranch: options.createBranch }),
          ...(options.base && { fromBranch: options.base }),
        });
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
        workspace = await createWorkspace(baseDir, options.workspace, planFile, config, {
          ...(options.createBranch !== undefined && { createBranch: options.createBranch }),
          ...(options.base && { fromBranch: options.base }),
        });
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

      const relativePlanPath = path.relative(currentBaseDir, planFile);
      const workspacePlanFile = path.join(workspace.path, relativePlanPath);
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

      const copyPlanIntoWorkspace = async (): Promise<void> => {
        if (planFile === workspacePlanFile) {
          log(`Using plan file in workspace: ${planFile}`);
          return;
        }

        log(`Copying plan file to workspace: ${workspacePlanFile}`);
        const srcContent = await fs.readFile(planFile, 'utf8');
        await fs.mkdir(path.dirname(workspacePlanFile), { recursive: true });
        await fs.writeFile(workspacePlanFile, srcContent, 'utf8');
        planFile = workspacePlanFile;
        log(`Using plan file in workspace: ${planFile}`);
      };

      try {
        const status = await getWorkingCopyStatus(workspace.path);
        if (status.checkFailed) {
          throw new Error(
            `Failed to check working copy status for workspace at ${workspace.path}.`
          );
        }

        const workspaceIsJj = await getUsingJj(workspace.path);
        if (status.hasChanges && !workspaceIsJj) {
          throw new Error(
            `Workspace at ${workspace.path} has uncommitted changes. Please commit or stash them before reuse.`
          );
        }

        let branchName = workspace.taskId;
        let planData: PlanSchema | undefined;
        let baseBranch = options.base;
        let canRetryWithoutBaseBranch = false;
        const shouldCreateBranch =
          options.createBranch ?? config.workspaceCreation?.createBranch ?? true;
        try {
          planData = await readPlanFile(planFile);
          branchName = planData.branch ?? generateBranchNameFromPlan(planData);

          if (!baseBranch) {
            baseBranch = planData.baseBranch;
          }

          if (!baseBranch) {
            const parentBranch = await getParentPlanBranch(
              planFile,
              planData,
              config,
              currentBaseDir
            );
            if (parentBranch) {
              baseBranch = parentBranch;
              canRetryWithoutBaseBranch = true;
            }
          }
        } catch (err) {
          warn(
            `Failed to generate branch name from plan file ${planFile}. Falling back to workspace task ID: ${err as Error}`
          );
        }

        let prepareResult = await prepareExistingWorkspace(workspace.path, {
          baseBranch,
          branchName,
          planFilePath: planFile,
          createBranch: shouldCreateBranch,
        });

        if (!prepareResult.success && canRetryWithoutBaseBranch) {
          prepareResult = await prepareExistingWorkspace(workspace.path, {
            branchName,
            planFilePath: planFile,
            createBranch: shouldCreateBranch,
          });
        }

        if (!prepareResult.success) {
          throw new Error(
            `Failed to prepare workspace at ${workspace.path}: ${prepareResult.error ?? 'Unknown error'}`
          );
        }

        let planFileForUpdateCommands: string | undefined = planFile;
        try {
          await copyPlanIntoWorkspace();
          planFileForUpdateCommands = planFile;
        } catch (err) {
          error(`Failed to copy plan file to workspace: ${err as Error}`);
          error('Continuing without workspace plan file for update commands.');
          planFileForUpdateCommands = undefined;
        }

        const updateSuccess = await runWorkspaceUpdateCommands(
          workspace.path,
          config,
          workspace.taskId,
          planFileForUpdateCommands
        );
        if (!updateSuccess) {
          throw new Error(
            `Failed to run workspace update commands for workspace at ${workspace.path}`
          );
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

        if (isNewWorkspace) {
          planFile = workspace.planFilePathInWorkspace ?? workspacePlanFile;
        }

        baseDir = workspace.path;
        sendStructured({
          type: 'workspace_info',
          timestamp: timestamp(),
          workspaceId: workspace.taskId,
          path: workspace.path,
          planFile,
        });
        updateHeadlessSessionInfo({ workspacePath: workspace.path });

        log('---');

        return { baseDir, planFile, workspaceTaskId, isNewWorkspace };
      } catch (err) {
        await WorkspaceLock.releaseLock(workspace.path, { force: true });
        throw err;
      }
    }
  }

  try {
    const lockInfo = await WorkspaceLock.acquireLock(baseDir, commandLabel, { type: 'pid' });
    WorkspaceLock.setupCleanupHandlers(baseDir, lockInfo.type);
  } catch (err) {
    if (options.allowPrimaryWorkspaceWhenLocked && err instanceof WorkspaceAlreadyLocked) {
      warn(
        `Primary workspace is already locked; continuing without acquiring a lock for this run: ${err as Error}`
      );
    } else {
      throw err;
    }
  }

  return { baseDir, planFile, workspaceTaskId, isNewWorkspace };
}
