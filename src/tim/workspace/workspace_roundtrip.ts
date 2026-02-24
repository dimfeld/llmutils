import { getCurrentBranchName, getUsingJj } from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { findPrimaryWorkspaceForRepository, getWorkspaceInfoByPath } from './workspace_info.js';
import {
  ensureWorkspaceRefExists,
  pushWorkspaceRefBetweenWorkspaces,
  setWorkspaceBookmarkToCurrent,
} from '../commands/workspace.js';

export interface WorkspaceRoundTripContext {
  executionWorkspacePath: string;
  primaryWorkspacePath: string;
  refName: string;
}

export async function prepareWorkspaceRoundTrip(options: {
  workspacePath: string;
  workspaceSyncEnabled: boolean;
}): Promise<WorkspaceRoundTripContext | null> {
  if (!options.workspaceSyncEnabled) {
    return null;
  }

  const workspaceInfo = getWorkspaceInfoByPath(options.workspacePath);
  if (!workspaceInfo || workspaceInfo.isPrimary) {
    return null;
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

  const refName = (await getCurrentBranchName(options.workspacePath)) ?? workspaceInfo.branch;
  if (!refName) {
    throw new Error(
      `No current branch/bookmark detected for workspace ${options.workspacePath}. Check out or create a branch before syncing.`
    );
  }

  return {
    executionWorkspacePath: options.workspacePath,
    primaryWorkspacePath: primaryWorkspace.workspacePath,
    refName,
  };
}

export async function runPreExecutionWorkspaceSync(
  context: WorkspaceRoundTripContext
): Promise<void> {
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

  await pushWorkspaceRefBetweenWorkspaces({
    sourceWorkspacePath: context.executionWorkspacePath,
    destinationWorkspacePath: context.primaryWorkspacePath,
    refName: context.refName,
    ensureJjBookmarkAtCurrent: true,
  });
}
