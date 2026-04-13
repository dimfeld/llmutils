import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  captureRepositoryState,
  compareRepositoryStates,
  getCurrentBranchName,
  getTrunkBranch,
  getUsingJj,
  hasUncommittedChanges,
  type RepositoryState,
} from '../../common/git.js';
import { commitAll, logSpawn } from '../../common/process.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import {
  findPrimaryWorkspaceForRepository,
  getWorkspaceInfoByPath,
  patchWorkspaceInfo,
} from './workspace_info.js';
import {
  pullWorkspaceRefIfExists,
  pushWorkspaceRefToRemote,
  setWorkspaceBookmarkToCurrent,
} from '../commands/workspace.js';
import { MATERIALIZED_DIR, materializePlan, materializeRelatedPlans } from '../plan_materialize.js';
import { warn } from '../../logging.js';

export interface WorkspaceRoundTripContext {
  executionWorkspacePath: string;
  primaryWorkspacePath?: string;
  refName: string;
  branchCreatedDuringSetup?: boolean;
  preExecutionState?: RepositoryState;
}

export async function prepareWorkspaceRoundTrip(options: {
  workspacePath: string;
  workspaceSyncEnabled: boolean;
  branchCreatedDuringSetup?: boolean;
}): Promise<WorkspaceRoundTripContext | null> {
  if (!options.workspaceSyncEnabled) {
    return null;
  }

  const workspaceInfo = getWorkspaceInfoByPath(options.workspacePath);
  if (!workspaceInfo || workspaceInfo.workspaceType === 'primary') {
    return null;
  }

  const refName = (await getCurrentBranchName(options.workspacePath)) ?? workspaceInfo.branch;
  if (!refName) {
    throw new Error(
      `No current branch/bookmark detected for workspace ${options.workspacePath}. Check out or create a branch before syncing.`
    );
  }

  const restoreBranch = await getTrunkBranch(options.workspacePath);
  if (refName === restoreBranch) {
    return null;
  }

  const repositoryId =
    workspaceInfo.repositoryId ??
    (await getRepositoryIdentity({ cwd: options.workspacePath })).repositoryId;
  const primaryWorkspace = findPrimaryWorkspaceForRepository(repositoryId);
  const primaryWorkspacePath =
    primaryWorkspace && primaryWorkspace.workspacePath !== options.workspacePath
      ? primaryWorkspace.workspacePath
      : undefined;

  return {
    executionWorkspacePath: options.workspacePath,
    primaryWorkspacePath,
    refName,
    branchCreatedDuringSetup: options.branchCreatedDuringSetup,
  };
}

export async function runPreExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext
): Promise<void> {
  if (!context.branchCreatedDuringSetup) {
    await pullWorkspaceRefIfExists(context.executionWorkspacePath, context.refName, 'origin');
  }

  context.preExecutionState = await captureRepositoryState(context.executionWorkspacePath);
}

/** Wipe stale materialized plans and re-materialize the active plan (with related plans)
 * right before execution begins. This is independent of VCS operations — plans are
 * DB-only and should always be freshly materialized from the database. */
export async function materializePlansForExecution(
  workspacePath: string,
  planId: number | undefined
): Promise<string | undefined> {
  try {
    await wipeMaterializedPlans(workspacePath);
  } catch (error) {
    warn(`Failed to wipe materialized plans in ${workspacePath}: ${error as Error}`);
  }

  if (planId == null) {
    return undefined;
  }

  const planFile = await materializePlan(planId, workspacePath);
  try {
    await materializeRelatedPlans(planId, workspacePath);
  } catch (error) {
    warn(`Failed to materialize related plans for plan ${planId}: ${error as Error}`);
  }

  return planFile;
}

export async function runPostExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext,
  commitMessage: string
): Promise<void> {
  await commitAll(commitMessage, context.executionWorkspacePath);
  const postExecutionState = await captureRepositoryState(context.executionWorkspacePath);
  const hasPendingChanges = await hasUncommittedChanges(context.executionWorkspacePath);
  const hasRepositoryChanges = context.preExecutionState
    ? compareRepositoryStates(context.preExecutionState, postExecutionState).hasDifferences
    : true;

  try {
    if (!hasRepositoryChanges && !hasPendingChanges) {
      if (context.branchCreatedDuringSetup) {
        await deleteUnusedLocalBranch(context);
      }

      // Refresh the primary workspace from origin when we skip pushing on a reused branch,
      // since pre-sync may have fast-forwarded the execution workspace from origin.
      // Skip for newly created branches — the branch was never pushed, so there's nothing to pull.
      if (context.primaryWorkspacePath && !context.branchCreatedDuringSetup) {
        await pullWorkspaceRefIfExists(
          context.primaryWorkspacePath,
          context.refName,
          'origin',
          undefined,
          {
            checkoutJjBookmark: false,
          }
        );
      }
    } else {
      if (await getUsingJj(context.executionWorkspacePath)) {
        await setWorkspaceBookmarkToCurrent(context.executionWorkspacePath, context.refName, '@-');
      }

      await pushWorkspaceRefToRemote({
        workspacePath: context.executionWorkspacePath,
        refName: context.refName,
        remoteName: 'origin',
        ensureJjBookmarkAtCurrent: false,
      });

      if (context.primaryWorkspacePath) {
        await pullWorkspaceRefIfExists(
          context.primaryWorkspacePath,
          context.refName,
          'origin',
          undefined,
          {
            checkoutJjBookmark: false,
          }
        );
      }
    }
  } finally {
    try {
      await wipeMaterializedPlans(context.executionWorkspacePath);
    } catch (error) {
      warn(
        `Failed to wipe materialized plans after workspace sync in ${context.executionWorkspacePath}: ${error as Error}`
      );
    }
  }
}

export async function wipeMaterializedPlans(workspacePath: string): Promise<void> {
  const materializedPlansPath = path.join(workspacePath, MATERIALIZED_DIR);

  let entries: string[];
  try {
    entries = await readdir(materializedPlansPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }

    throw error;
  }

  await Promise.all(
    entries
      .filter((entry) => entry !== '.gitignore' && entry !== '.gitkeep')
      .map((entry) => rm(path.join(materializedPlansPath, entry), { force: true, recursive: true }))
  );
}

async function deleteUnusedLocalBranch(context: WorkspaceRoundTripContext): Promise<void> {
  const restoreBranch = await getTrunkBranch(context.executionWorkspacePath);

  if (context.refName === restoreBranch) {
    return;
  }

  if (await getUsingJj(context.executionWorkspacePath)) {
    const editProc = logSpawn(['jj', 'new', restoreBranch], {
      cwd: context.executionWorkspacePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await editProc.exited;
    if (editProc.exitCode !== 0) {
      throw new Error(
        `Failed to restore jj workspace to ${restoreBranch} (exit code ${editProc.exitCode})`
      );
    }

    const deleteProc = logSpawn(['jj', 'bookmark', 'delete', context.refName], {
      cwd: context.executionWorkspacePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await deleteProc.exited;
    if (deleteProc.exitCode !== 0) {
      throw new Error(
        `Failed to delete jj bookmark ${context.refName} (exit code ${deleteProc.exitCode})`
      );
    }
  } else {
    const checkoutProc = logSpawn(['git', 'checkout', restoreBranch], {
      cwd: context.executionWorkspacePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await checkoutProc.exited;
    if (checkoutProc.exitCode !== 0) {
      throw new Error(
        `Failed to checkout ${restoreBranch} for branch cleanup (exit code ${checkoutProc.exitCode})`
      );
    }

    const deleteProc = logSpawn(['git', 'branch', '-D', context.refName], {
      cwd: context.executionWorkspacePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await deleteProc.exited;
    if (deleteProc.exitCode !== 0) {
      throw new Error(
        `Failed to delete git branch ${context.refName} (exit code ${deleteProc.exitCode})`
      );
    }
  }

  patchWorkspaceInfo(context.executionWorkspacePath, { branch: '' });
}
