import { getCurrentBranchName, getUsingJj } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { findPrimaryWorkspaceForRepository, getWorkspaceInfoByPath } from './workspace_info.js';
import {
  ensureWorkspaceRefExists,
  pullWorkspaceRefIfExists,
  pushWorkspaceRefBetweenWorkspaces,
  pushWorkspaceRefToRemote,
  setWorkspaceBookmarkToCurrent,
} from '../commands/workspace.js';

export type WorkspaceSyncTarget = 'origin' | 'primary-workspace';

export interface WorkspaceRoundTripContext {
  executionWorkspacePath: string;
  primaryWorkspacePath?: string;
  refName: string;
  syncTarget: WorkspaceSyncTarget;
}

export async function prepareWorkspaceRoundTrip(options: {
  workspacePath: string;
  workspaceSyncEnabled: boolean;
  syncTarget?: WorkspaceSyncTarget;
}): Promise<WorkspaceRoundTripContext | null> {
  if (!options.workspaceSyncEnabled) {
    return null;
  }

  const syncTarget = options.syncTarget ?? 'origin';
  const workspaceInfo = getWorkspaceInfoByPath(options.workspacePath);
  if (!workspaceInfo || workspaceInfo.isPrimary) {
    return null;
  }

  const refName = (await getCurrentBranchName(options.workspacePath)) ?? workspaceInfo.branch;
  if (!refName) {
    throw new Error(
      `No current branch/bookmark detected for workspace ${options.workspacePath}. Check out or create a branch before syncing.`
    );
  }

  if (syncTarget === 'origin') {
    return {
      executionWorkspacePath: options.workspacePath,
      refName,
      syncTarget,
    };
  }

  const repositoryId =
    workspaceInfo.repositoryId ??
    (await getRepositoryIdentity({ cwd: options.workspacePath })).repositoryId;
  const primaryWorkspace = findPrimaryWorkspaceForRepository(repositoryId);
  if (!primaryWorkspace) {
    return null;
  }

  if (primaryWorkspace.workspacePath === options.workspacePath) {
    return null;
  }

  return {
    executionWorkspacePath: options.workspacePath,
    primaryWorkspacePath: primaryWorkspace.workspacePath,
    refName,
    syncTarget,
  };
}

export async function runPreExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext
): Promise<void> {
  if (context.syncTarget === 'origin') {
    await pullWorkspaceRefIfExists(context.executionWorkspacePath, context.refName, 'origin');
    return;
  }

  if (!context.primaryWorkspacePath) {
    throw new Error('Primary workspace path is required for primary-workspace sync.');
  }

  await ensureWorkspaceRefExists(context.primaryWorkspacePath, context.refName);
  await pushWorkspaceRefBetweenWorkspaces({
    sourceWorkspacePath: context.primaryWorkspacePath,
    destinationWorkspacePath: context.executionWorkspacePath,
    refName: context.refName,
  });
}

export async function runPostExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext,
  commitMessage: string
): Promise<void> {
  await commitAll(commitMessage, context.executionWorkspacePath);

  if (await getUsingJj(context.executionWorkspacePath)) {
    await setWorkspaceBookmarkToCurrent(context.executionWorkspacePath, context.refName);
  }

  if (context.syncTarget === 'origin') {
    await pushWorkspaceRefToRemote({
      workspacePath: context.executionWorkspacePath,
      refName: context.refName,
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: true,
    });
    return;
  }

  if (!context.primaryWorkspacePath) {
    throw new Error('Primary workspace path is required for primary-workspace sync.');
  }

  await pushWorkspaceRefBetweenWorkspaces({
    sourceWorkspacePath: context.executionWorkspacePath,
    destinationWorkspacePath: context.primaryWorkspacePath,
    refName: context.refName,
    ensureJjBookmarkAtCurrent: true,
  });
}
