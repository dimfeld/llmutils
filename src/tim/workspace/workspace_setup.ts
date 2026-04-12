import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  fetchRemoteBranch,
  getGitRoot,
  getJjChangeId,
  getMergeBase,
  getTrunkBranch,
  getUsingJj,
  getWorkingCopyStatus,
  remoteBranchExists,
} from '../../common/git.js';
import { logSpawn } from '../../common/process.js';
import { error, log, sendStructured, warn } from '../../logging.js';
import { generateBranchNameFromPlan, resolveBranchPrefix } from '../commands/branch.js';
import type { TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import type { PlanBaseTrackingUpdate } from '../db/plan.js';
import { setPlanBaseTracking } from '../db/plan.js';
import { updateHeadlessSessionInfo } from '../headless.js';
import { materializePlan, resolveProjectContext } from '../plan_materialize.js';
import { readPlanFile, resolvePlanFromDb } from '../plans.js';
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
  planId?: number;
  planUuid?: string;
  // Stacking base branch used for plan base tracking.
  base?: string;
  // Checkout-only branch used to prepare/select workspaces without affecting tracking.
  checkoutBranch?: string;
  createBranch?: boolean;
  allowPrimaryWorkspaceWhenLocked?: boolean;
}

export interface WorkspaceSetupResult {
  baseDir: string;
  planFile: string;
  workspaceTaskId?: string;
  isNewWorkspace?: boolean;
  branchCreatedDuringSetup?: boolean;
}

interface ResolvedWorkspaceBranchContext {
  planData?: PlanSchema;
  branchName?: string;
  baseBranch?: string;
  checkoutBranch?: string;
  baseBranchSource?: 'option' | 'plan' | 'parent';
  canRetryWithoutBaseBranch: boolean;
}

function timestamp(): string {
  return new Date().toISOString();
}

async function getParentPlanBranch(
  plan: PlanSchema,
  config: TimConfig,
  currentBaseDir: string
): Promise<string | undefined> {
  if (!plan.parent) {
    return undefined;
  }

  const gitRoot = await getGitRoot(currentBaseDir);
  const parentPlan = await resolvePlanFromDb(String(plan.parent), gitRoot);
  return parentPlan.plan.branch ?? generateBranchNameFromPlan(parentPlan.plan);
}

async function resolveWorkspaceBranchContext(
  options: Pick<WorkspaceSetupOptions, 'planId' | 'base' | 'checkoutBranch'>,
  currentBaseDir: string,
  currentPlanFile: string | undefined,
  config: TimConfig
): Promise<ResolvedWorkspaceBranchContext> {
  let planData: PlanSchema | undefined;
  let branchName: string | undefined;
  let baseBranch = options.base;
  let baseBranchSource: ResolvedWorkspaceBranchContext['baseBranchSource'];
  let canRetryWithoutBaseBranch = false;

  if (baseBranch) {
    baseBranchSource = 'option';
  }

  if (currentPlanFile) {
    try {
      planData = await readPlanFile(currentPlanFile);
    } catch (err) {
      warn(
        `Failed to generate branch name from plan file ${currentPlanFile}. Falling back to workspace task ID: ${err as Error}`
      );
    }
  } else if (typeof options.planId === 'number') {
    planData = (await resolvePlanFromDb(String(options.planId), currentBaseDir)).plan;
  }

  if (planData) {
    if (planData.branch) {
      branchName = planData.branch;
    } else {
      const projectContext = await resolveProjectContext(currentBaseDir);
      const branchPrefix = resolveBranchPrefix({
        config,
        db: getDatabase(),
        projectId: projectContext.projectId,
      });
      branchName = generateBranchNameFromPlan(planData, { branchPrefix });
    }

    if (!baseBranch) {
      // When planId is available, prefer DB state for baseBranch over file state.
      // The file may contain stale baseBranch after a trunk-fallback rebase cleared
      // the DB fields but the direct plan file wasn't updated.
      let resolvedBaseBranch = planData.baseBranch;
      if (currentPlanFile && typeof options.planId === 'number') {
        try {
          const dbPlan = (await resolvePlanFromDb(String(options.planId), currentBaseDir)).plan;
          resolvedBaseBranch = dbPlan.baseBranch;
        } catch {
          // Fall back to file-based baseBranch if DB lookup fails
        }
      }
      baseBranch = resolvedBaseBranch;
      if (baseBranch) {
        baseBranchSource = 'plan';
      }
    }

    if (!baseBranch) {
      const parentBranch = await getParentPlanBranch(planData, config, currentBaseDir);
      if (parentBranch) {
        baseBranch = parentBranch;
        baseBranchSource = 'parent';
        canRetryWithoutBaseBranch = true;
      }
    }
  }

  return {
    planData,
    branchName,
    baseBranch,
    checkoutBranch: options.checkoutBranch,
    baseBranchSource,
    canRetryWithoutBaseBranch,
  };
}

async function updateBaseCommitTracking(options: {
  baseDir: string;
  planId?: number;
  planUuid?: string;
  planBranch?: string;
  baseBranch?: string;
  baseBranchSource?: ResolvedWorkspaceBranchContext['baseBranchSource'];
  trunkBranch: string;
  isJj?: boolean;
}): Promise<void> {
  const { baseDir, planUuid, trunkBranch } = options;
  const baseBranch = options.baseBranch;

  if (!planUuid || !baseBranch || baseBranch === trunkBranch) {
    return;
  }

  // Safety net: if the user passes --base with the plan's own branch, skip tracking
  // to avoid storing the branch tip as baseCommit (merge-base of a branch with itself).
  if (options.planBranch && baseBranch === options.planBranch) {
    return;
  }

  try {
    const db = getDatabase();
    const rematerializeBestEffort = async (): Promise<void> => {
      if (typeof options.planId !== 'number') {
        return;
      }

      try {
        await materializePlan(options.planId, baseDir);
      } catch (err) {
        warn(
          `Failed to rematerialize plan ${options.planId} after base tracking update: ${err as Error}`
        );
      }
    };
    await fetchRemoteBranch(baseDir, baseBranch);
    const existsOnRemote = await remoteBranchExists(baseDir, baseBranch);
    if (!existsOnRemote) {
      return;
    }

    // Use the plan branch (not HEAD) as the source ref so tracking is correct
    // even when the plan branch isn't checked out (non-workspace mode).
    const sourceRef = options.planBranch ?? 'HEAD';
    const mergeBase = await getMergeBase(baseDir, baseBranch, sourceRef);
    // Persist baseBranch for 'parent' (auto-derived) and 'option' (explicit --base) sources.
    // 'plan' source means baseBranch is already in the plan, no need to re-persist it.
    const shouldPersistBaseBranch =
      options.baseBranchSource === 'parent' || options.baseBranchSource === 'option';

    if (!mergeBase) {
      // Don't overwrite existing tracking with nulls on transient failures
      if (shouldPersistBaseBranch) {
        setPlanBaseTracking(db, planUuid, { baseBranch });
        await rematerializeBestEffort();
      }
      return;
    }

    const usingJj = options.isJj ?? (await getUsingJj(baseDir));
    const baseChangeId = usingJj ? await getJjChangeId(baseDir, mergeBase) : undefined;
    const update: PlanBaseTrackingUpdate = {
      baseCommit: mergeBase,
      baseChangeId,
    };
    if (shouldPersistBaseBranch) {
      update.baseBranch = baseBranch;
    }
    setPlanBaseTracking(db, planUuid, update);
    await rematerializeBestEffort();
  } catch (err) {
    warn(`Failed to update base commit tracking for plan ${planUuid}: ${err as Error}`);
  }
}

export async function setupWorkspace(
  options: WorkspaceSetupOptions,
  currentBaseDir: string,
  currentPlanFile: string | undefined,
  config: TimConfig,
  commandLabel: string
): Promise<WorkspaceSetupResult> {
  let baseDir = currentBaseDir;
  let planFile = currentPlanFile ?? '';
  let workspaceTaskId: string | undefined;
  let isNewWorkspace: boolean | undefined;
  let branchCreatedDuringSetup: boolean | undefined;
  const copyExistingPlanFile = async (targetPlanFile: string): Promise<string> => {
    if (!currentPlanFile) {
      throw new Error('No source plan file available to copy into workspace.');
    }
    if (planFile === targetPlanFile) {
      log(`Using plan file in workspace: ${planFile}`);
      return planFile;
    }

    log(`Copying plan file to workspace: ${targetPlanFile}`);
    const srcContent = await fs.readFile(currentPlanFile, 'utf8');
    await fs.mkdir(path.dirname(targetPlanFile), { recursive: true });
    await fs.writeFile(targetPlanFile, srcContent, 'utf8');
    planFile = targetPlanFile;
    log(`Using plan file in workspace: ${planFile}`);
    return planFile;
  };
  const resolveMaterializedPlanForWorkspace = async (workspaceRoot: string): Promise<string> => {
    if (typeof options.planId !== 'number') {
      return planFile;
    }

    try {
      planFile = await materializePlan(options.planId, workspaceRoot);
      log(`Using plan file in workspace: ${planFile}`);
    } catch (err) {
      if (!currentPlanFile) {
        throw err;
      }

      const fallbackTarget = path.join(
        workspaceRoot,
        path.relative(currentBaseDir, currentPlanFile)
      );
      warn(
        `Failed to materialize plan ${options.planId} in ${workspaceRoot}; falling back to copying the existing plan file: ${err as Error}`
      );
      await copyExistingPlanFile(fallbackTarget);
    }
    return planFile;
  };

  // When no plan file and no base branch, skip branch creation — use workspace as-is
  const effectiveCreateBranch =
    !currentPlanFile &&
    typeof options.planId !== 'number' &&
    !options.base &&
    !options.checkoutBranch
      ? false
      : options.createBranch;
  const branchContext = await resolveWorkspaceBranchContext(
    options,
    currentBaseDir,
    currentPlanFile,
    config
  );
  let createWorkspaceBaseBranch = branchContext.checkoutBranch ?? branchContext.baseBranch;

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

      selectedWorkspace = await selector.selectWorkspace(taskId, currentPlanFile, {
        interactive: !options.nonInteractive,
        preferNewWorkspace: options.newWorkspace,
        createBranch: effectiveCreateBranch,
        base: branchContext.checkoutBranch ?? branchContext.baseBranch,
        branchName: branchContext.branchName,
        planData: branchContext.planData,
        ...(options.planUuid ? { preferredPlanUuid: options.planUuid } : {}),
      });

      if (selectedWorkspace) {
        workspace = {
          path: selectedWorkspace.workspace.workspacePath,
          originalPlanFilePath: selectedWorkspace.workspace.originalPlanFilePath,
          taskId: selectedWorkspace.workspace.taskId,
          checkedOutRemoteBranch: selectedWorkspace.workspace.checkedOutRemoteBranch,
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
        workspace = await createWorkspace(baseDir, options.workspace, currentPlanFile, config, {
          ...(effectiveCreateBranch !== undefined && { createBranch: effectiveCreateBranch }),
          ...(branchContext.branchName && { branchName: branchContext.branchName }),
          ...(createWorkspaceBaseBranch && { fromBranch: createWorkspaceBaseBranch }),
          ...(branchContext.planData && { planData: branchContext.planData }),
        });
        if (!workspace && branchContext.canRetryWithoutBaseBranch) {
          log('Retrying workspace creation without parent-derived base branch...');
          createWorkspaceBaseBranch = undefined;
          workspace = await createWorkspace(baseDir, options.workspace, currentPlanFile, config, {
            ...(effectiveCreateBranch !== undefined && { createBranch: effectiveCreateBranch }),
            ...(branchContext.branchName && { branchName: branchContext.branchName }),
            ...(branchContext.planData && { planData: branchContext.planData }),
          });
        }
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
        workspace = await createWorkspace(baseDir, options.workspace, currentPlanFile, config, {
          ...(effectiveCreateBranch !== undefined && { createBranch: effectiveCreateBranch }),
          ...(branchContext.branchName && { branchName: branchContext.branchName }),
          ...(createWorkspaceBaseBranch && { fromBranch: createWorkspaceBaseBranch }),
          ...(branchContext.planData && { planData: branchContext.planData }),
        });
        if (!workspace && branchContext.canRetryWithoutBaseBranch) {
          log('Retrying workspace creation without parent-derived base branch...');
          createWorkspaceBaseBranch = undefined;
          workspace = await createWorkspace(baseDir, options.workspace, currentPlanFile, config, {
            ...(effectiveCreateBranch !== undefined && { createBranch: effectiveCreateBranch }),
            ...(branchContext.branchName && { branchName: branchContext.branchName }),
            ...(branchContext.planData && { planData: branchContext.planData }),
          });
        }
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
      if (isNewWorkspace) {
        branchCreatedDuringSetup = Boolean(
          effectiveCreateBranch && !workspace.checkedOutRemoteBranch
        );
      }

      const relativePlanPath = currentPlanFile
        ? path.relative(currentBaseDir, currentPlanFile)
        : undefined;
      const workspacePlanFile = relativePlanPath
        ? path.join(workspace.path, relativePlanPath)
        : undefined;
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

      const materializePlanIntoWorkspace = async (): Promise<void> => {
        if (typeof options.planId === 'number') {
          await resolveMaterializedPlanForWorkspace(workspace.path);
          return;
        }

        if (!currentPlanFile || !workspacePlanFile) {
          return;
        }

        await copyExistingPlanFile(workspacePlanFile);
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

        let branchName = branchContext.branchName ?? workspace.taskId;
        const planData = branchContext.planData;
        let baseBranch = branchContext.baseBranch;
        let effectiveCheckoutBranch = branchContext.checkoutBranch ?? baseBranch;
        const baseBranchSource = branchContext.baseBranchSource;
        const canRetryWithoutBaseBranch = branchContext.canRetryWithoutBaseBranch;
        const shouldCreateBranch = effectiveCreateBranch ?? true;
        const shouldPrepareWorkspaceBranch = Boolean(
          (currentPlanFile || typeof options.planId === 'number' || effectiveCheckoutBranch) &&
          !(isNewWorkspace && effectiveCreateBranch)
        );

        let reusedExistingBranch = false;
        if (shouldPrepareWorkspaceBranch) {
          const hasExplicitBase = Boolean(options.base || options.checkoutBranch);
          let prepareResult = await prepareExistingWorkspace(workspace.path, {
            baseBranch: effectiveCheckoutBranch,
            branchName,
            planFilePath: currentPlanFile ? planFile : undefined,
            createBranch: shouldCreateBranch,
            reuseExistingBranch: !hasExplicitBase,
            primaryWorkspacePath: currentBaseDir,
          });

          if (!prepareResult.success && canRetryWithoutBaseBranch) {
            baseBranch = undefined;
            effectiveCheckoutBranch = undefined;
            prepareResult = await prepareExistingWorkspace(workspace.path, {
              branchName,
              planFilePath: currentPlanFile ? planFile : undefined,
              createBranch: shouldCreateBranch,
              reuseExistingBranch: !hasExplicitBase,
              primaryWorkspacePath: currentBaseDir,
            });
          }

          if (!prepareResult.success) {
            throw new Error(
              `Failed to prepare workspace at ${workspace.path}: ${prepareResult.error ?? 'Unknown error'}`
            );
          }

          reusedExistingBranch = prepareResult.reusedExistingBranch ?? false;
          branchCreatedDuringSetup = shouldCreateBranch && !reusedExistingBranch;
        }

        let planFileForUpdateCommands: string | undefined = planFile;
        try {
          await materializePlanIntoWorkspace();
          planFileForUpdateCommands = planFile;
        } catch (err) {
          error(`Failed to materialize plan into workspace: ${err as Error}`);
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
          planFile = workspace.planFilePathInWorkspace ?? workspacePlanFile ?? planFile;
        }

        const trunkBranch = await getTrunkBranch(workspace.path);
        await updateBaseCommitTracking({
          baseDir: workspace.path,
          planId: options.planId,
          planUuid: planData?.uuid ?? options.planUuid,
          planBranch: branchName,
          baseBranch,
          baseBranchSource,
          trunkBranch,
          isJj: workspaceIsJj,
        });

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

        return {
          baseDir,
          planFile,
          workspaceTaskId,
          isNewWorkspace,
          branchCreatedDuringSetup,
        };
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

  if (typeof options.planId === 'number' && !currentPlanFile) {
    await resolveMaterializedPlanForWorkspace(baseDir);
  }

  const trunkBranch = await getTrunkBranch(baseDir);
  await updateBaseCommitTracking({
    baseDir,
    planId: options.planId,
    planUuid: branchContext.planData?.uuid ?? options.planUuid,
    planBranch: branchContext.branchName,
    baseBranch: branchContext.baseBranch,
    baseBranchSource: branchContext.baseBranchSource,
    trunkBranch,
  });

  return {
    baseDir,
    planFile,
    workspaceTaskId,
    isNewWorkspace,
    branchCreatedDuringSetup,
  };
}
