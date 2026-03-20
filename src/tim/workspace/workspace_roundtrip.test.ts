import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ModuleMocker } from '../../testing.js';

describe('runPostExecutionWorkspaceSync', () => {
  let moduleMocker: ModuleMocker;
  const commitAll = mock(async () => 1);
  const getUsingJj = mock(async () => true);
  const setWorkspaceBookmarkToCurrent = mock(async () => {});
  const pushWorkspaceRefToRemote = mock(async () => {});
  const pushWorkspaceRefBetweenWorkspaces = mock(async () => {});
  const pullWorkspaceRefIfExists = mock(async () => true);
  const getRepositoryIdentity = mock(async () => ({ repositoryId: 'repo' }));
  const findPrimaryWorkspaceForRepository = mock(() => null);
  const getWorkspaceInfoByPath = mock(() => null);

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);

    commitAll.mockClear();
    getUsingJj.mockClear();
    setWorkspaceBookmarkToCurrent.mockClear();
    pushWorkspaceRefToRemote.mockClear();
    pushWorkspaceRefBetweenWorkspaces.mockClear();
    pullWorkspaceRefIfExists.mockClear();
    getRepositoryIdentity.mockClear();
    findPrimaryWorkspaceForRepository.mockClear();
    getWorkspaceInfoByPath.mockClear();

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getUsingJj,
      getCurrentBranchName: mock(async () => 'task-123'),
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      ensureWorkspaceRefExists: mock(async () => {}),
      pullWorkspaceRefIfExists,
      pushWorkspaceRefBetweenWorkspaces,
      pushWorkspaceRefToRemote,
      setWorkspaceBookmarkToCurrent,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity,
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath,
      findPrimaryWorkspaceForRepository,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('pushes to origin and refreshes the primary workspace when available', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
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
    expect(pullWorkspaceRefIfExists).toHaveBeenCalledWith(
      '/tmp/primary',
      'task-123',
      'origin',
      undefined,
      {
        checkoutJjBookmark: false,
      }
    );
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
    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('does not try to refresh origin when there is no primary workspace', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'task-123',
        syncTarget: 'origin',
      },
      'sync workspace'
    );

    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });
});

describe('prepareWorkspaceRoundTrip', () => {
  let moduleMocker: ModuleMocker;
  const getCurrentBranchName = mock(async () => 'task-123');
  const getRepositoryIdentity = mock(async () => ({ repositoryId: 'repo' }));
  const findPrimaryWorkspaceForRepository = mock(() => null);
  const getWorkspaceInfoByPath = mock(() => null);

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    getCurrentBranchName.mockClear();
    getRepositoryIdentity.mockClear();
    findPrimaryWorkspaceForRepository.mockClear();
    getWorkspaceInfoByPath.mockClear();

    await moduleMocker.mock('../../common/git.js', () => ({
      getCurrentBranchName,
      getUsingJj: mock(async () => true),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: mock(async () => 1),
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      ensureWorkspaceRefExists: mock(async () => {}),
      pullWorkspaceRefIfExists: mock(async () => true),
      pushWorkspaceRefBetweenWorkspaces: mock(async () => {}),
      pushWorkspaceRefToRemote: mock(async () => {}),
      setWorkspaceBookmarkToCurrent: mock(async () => {}),
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity,
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath,
      findPrimaryWorkspaceForRepository,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('includes the primary workspace in origin sync context when available', async () => {
    getWorkspaceInfoByPath.mockReturnValue({
      isPrimary: false,
      repositoryId: 'repo',
      branch: 'task-123',
    });
    findPrimaryWorkspaceForRepository.mockReturnValue({
      workspacePath: '/tmp/primary',
    });

    const { prepareWorkspaceRoundTrip } = await import('./workspace_roundtrip.js');

    await expect(
      prepareWorkspaceRoundTrip({
        workspacePath: '/tmp/workspace',
        workspaceSyncEnabled: true,
        syncTarget: 'origin',
      })
    ).resolves.toEqual({
      executionWorkspacePath: '/tmp/workspace',
      primaryWorkspacePath: '/tmp/primary',
      refName: 'task-123',
      syncTarget: 'origin',
    });
  });
});
