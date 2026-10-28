import { $ } from 'bun';
import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  captureRepositoryState,
  getCurrentGitBranch,
  compareRepositoryStates,
  ensureJjPublishedCommitsHaveDescriptions,
  getCurrentBranchName,
  getTrunkBranch,
  getUsingJj,
  hasNonEmptyCommitsSince,
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
import { symlinkLocalConfigs } from './workspace_manager.js';
import {
  ensureMaterializeDir,
  MATERIALIZED_DIR,
  materializePlan,
  materializeRelatedPlans,
} from '../plan_materialize.js';
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
    return null;
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
  if (context.primaryWorkspacePath) {
    await symlinkLocalConfigs(context.primaryWorkspacePath, context.executionWorkspacePath);
  }

  await ensureMaterializeDir(context.executionWorkspacePath);

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

/**
 * Link the primary workspace's local config files into a workspace and create its materialized
 * plans directory. Use this for sessions that must not run the workspace round trip, such as
 * trunk chats, but that still run tim commands in the workspace.
 */
export async function prepareWorkspaceWithoutRoundTrip(workspacePath: string): Promise<void> {
  const workspaceInfo = getWorkspaceInfoByPath(workspacePath);
  if (workspaceInfo && workspaceInfo.workspaceType !== 'primary') {
    const repositoryId =
      workspaceInfo.repositoryId ??
      (await getRepositoryIdentity({ cwd: workspacePath })).repositoryId;
    const primaryWorkspace = findPrimaryWorkspaceForRepository(repositoryId);
    if (primaryWorkspace && primaryWorkspace.workspacePath !== workspacePath) {
      await symlinkLocalConfigs(primaryWorkspace.workspacePath, workspacePath);
    }
  }

  await ensureMaterializeDir(workspacePath);
}

function jjStringLiteral(value: string): string {
  return JSON.stringify(value);
}

/**
 * Throw when the workspace no longer has the session's ref checked out, for example because
 * the agent moved to another branch to rebase it. Committing and pushing in that state would
 * commit to the wrong branch, or would move the session's bookmark onto another branch's
 * commits and push it.
 *
 * In Git, the current branch must be the ref. In jj, the ref's bookmark must be an ancestor of
 * the working copy, and the commits after the bookmark must not carry other bookmarks, except
 * commits that are already on trunk.
 */
export async function verifyWorkspaceStillOnRef(context: WorkspaceRoundTripContext): Promise<void> {
  const workspacePath = context.executionWorkspacePath;
  const refName = context.refName;
  const stopMessage =
    'Nothing was committed or pushed. The changes stay in the workspace at ' + workspacePath + '.';

  if (!(await getUsingJj(workspacePath))) {
    const currentBranch = await getCurrentGitBranch(workspacePath);
    if (currentBranch !== refName) {
      throw new Error(
        `The workspace is on ${currentBranch ? `branch "${currentBranch}"` : 'a detached HEAD'}, not on "${refName}". ${stopMessage}`
      );
    }
    return;
  }

  const bookmark = `bookmarks(exact:${jjStringLiteral(refName)})`;
  const ancestorResult =
    await $`jj log -r ${`${bookmark} & ::@`} --no-graph -T ${'commit_id ++ "\n"'}`
      .cwd(workspacePath)
      .quiet()
      .nothrow();
  if (ancestorResult.exitCode !== 0) {
    throw new Error(
      `Could not check that the workspace is still on "${refName}": ${ancestorResult.stderr.toString().trim()}. ${stopMessage}`
    );
  }
  if (!ancestorResult.stdout.toString().trim()) {
    throw new Error(
      `The working copy is no longer on top of bookmark "${refName}". ${stopMessage}`
    );
  }

  const trunkBranch = await getTrunkBranch(workspacePath);
  const trunk = `trunk() | bookmarks(exact:${jjStringLiteral(trunkBranch)}) | remote_bookmarks(exact:${jjStringLiteral(trunkBranch)})`;
  const otherBookmarksResult =
    await $`jj log -r ${`((${bookmark}..@) ~ ::(${trunk})) & bookmarks()`} --no-graph -T ${'local_bookmarks.map(|b| b.name()).join("\n") ++ "\n"'}`
      .cwd(workspacePath)
      .quiet()
      .nothrow();
  if (otherBookmarksResult.exitCode !== 0) {
    throw new Error(
      `Could not check that the workspace is still on "${refName}": ${otherBookmarksResult.stderr.toString().trim()}. ${stopMessage}`
    );
  }
  const otherBookmarks = [
    ...new Set(
      otherBookmarksResult.stdout
        .toString()
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => name && name !== refName)
    ),
  ];
  if (otherBookmarks.length > 0) {
    throw new Error(
      `The working copy is on top of other bookmarks (${otherBookmarks.join(', ')}), not only on "${refName}". ${stopMessage}`
    );
  }
}

export async function runPostExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext,
  commitMessage: string,
  options: { requireRefCheckedOut?: boolean; skipPush?: boolean } = {}
): Promise<void> {
  if (options.requireRefCheckedOut) {
    await verifyWorkspaceStillOnRef(context);
  }

  const commitExitCode = await commitAll(commitMessage, context.executionWorkspacePath);
  if (commitExitCode !== 0) {
    throw new Error(
      `Failed to commit workspace changes before sync push (exit code ${commitExitCode}).`
    );
  }
  const postExecutionState = await captureRepositoryState(context.executionWorkspacePath);
  const hasPendingChanges = await hasUncommittedChanges(context.executionWorkspacePath);
  const repositoryStateChanged = context.preExecutionState
    ? compareRepositoryStates(context.preExecutionState, postExecutionState).hasDifferences
    : true;
  const hasContentChanges =
    repositoryStateChanged && context.preExecutionState?.commitHash && postExecutionState.commitHash
      ? await hasNonEmptyCommitsSince(
          context.executionWorkspacePath,
          context.preExecutionState.commitHash,
          postExecutionState.commitHash
        )
      : repositoryStateChanged;

  try {
    if (!hasContentChanges && !hasPendingChanges) {
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
      if (!options.skipPush) {
        if (await getUsingJj(context.executionWorkspacePath)) {
          await ensureJjPublishedCommitsHaveDescriptions(context.executionWorkspacePath);
          await setWorkspaceBookmarkToCurrent(
            context.executionWorkspacePath,
            context.refName,
            '@-'
          );
        }

        await pushWorkspaceRefToRemote({
          workspacePath: context.executionWorkspacePath,
          refName: context.refName,
          remoteName: 'origin',
          ensureJjBookmarkAtCurrent: false,
        });
      }

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
    const newProc = logSpawn(['jj', 'new', restoreBranch], {
      cwd: context.executionWorkspacePath,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await newProc.exited;
    if (newProc.exitCode !== 0) {
      throw new Error(
        `Failed to restore jj workspace to ${restoreBranch} (exit code ${newProc.exitCode})`
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
