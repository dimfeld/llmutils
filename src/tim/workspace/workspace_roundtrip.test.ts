import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ModuleMocker } from '../../testing.js';

describe('runPostExecutionWorkspaceSync', () => {
  let moduleMocker: ModuleMocker;
  const commitAll = mock(async () => 1);
  const getUsingJj = mock(async () => true);
  const setWorkspaceBookmarkToCurrent = mock(async () => {});
  const pushWorkspaceRefToRemote = mock(async () => {});
  const pushWorkspaceRefBetweenWorkspaces = mock(async () => {});

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);

    commitAll.mockClear();
    getUsingJj.mockClear();
    setWorkspaceBookmarkToCurrent.mockClear();
    pushWorkspaceRefToRemote.mockClear();
    pushWorkspaceRefBetweenWorkspaces.mockClear();

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getUsingJj,
      getCurrentBranchName: mock(async () => 'task-123'),
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      ensureWorkspaceRefExists: mock(async () => {}),
      pullWorkspaceRefIfExists: mock(async () => true),
      pushWorkspaceRefBetweenWorkspaces,
      pushWorkspaceRefToRemote,
      setWorkspaceBookmarkToCurrent,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'repo' })),
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath: mock(() => null),
      findPrimaryWorkspaceForRepository: mock(() => null),
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('pushes to origin without overriding the bookmark after setting it to @-', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'task-123',
        syncTarget: 'origin',
      },
      'sync workspace'
    );

    expect(setWorkspaceBookmarkToCurrent).toHaveBeenCalledWith('/tmp/workspace', 'task-123', '@-');
    expect(pushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
  });

  test('pushes to the primary workspace without overriding the bookmark after setting it to @-', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
        syncTarget: 'primary-workspace',
      },
      'sync workspace'
    );

    expect(setWorkspaceBookmarkToCurrent).toHaveBeenCalledWith('/tmp/workspace', 'task-123', '@-');
    expect(pushWorkspaceRefBetweenWorkspaces).toHaveBeenCalledWith({
      sourceWorkspacePath: '/tmp/workspace',
      destinationWorkspacePath: '/tmp/primary',
      refName: 'task-123',
      ensureJjBookmarkAtCurrent: false,
    });
  });
});
