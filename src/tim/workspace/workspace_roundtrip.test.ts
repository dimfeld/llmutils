import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';

describe('runPostExecutionWorkspaceSync', () => {
  let moduleMocker: ModuleMocker;
  const commitAll = mock(async () => 1);
  const logSpawn = mock(() => ({ exited: Promise.resolve(0), exitCode: 0 }));
  const getUsingJj = mock(async () => true);
  const getTrunkBranch = mock(async () => 'main');
  const captureRepositoryState = mock(async () => ({
    commitHash: 'after',
    hasChanges: false,
    statusOutput: '',
    diffHash: 'after-hash',
  }));
  const compareRepositoryStates = mock(() => ({
    commitChanged: true,
    workingTreeChanged: false,
    hasDifferences: true,
  }));
  const hasUncommittedChanges = mock(async () => false);
  const setWorkspaceBookmarkToCurrent = mock(async () => {});
  const pushWorkspaceRefToRemote = mock(async () => {});
  const pullWorkspaceRefIfExists = mock(async () => true);
  const getRepositoryIdentity = mock(async () => ({ repositoryId: 'repo' }));
  const findPrimaryWorkspaceForRepository = mock(() => null);
  const getWorkspaceInfoByPath = mock(() => null);
  const patchWorkspaceInfo = mock(() => ({}));
  const readdirMock = mock(async () => []);
  const rmMock = mock(async () => {});

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);

    commitAll.mockClear();
    logSpawn.mockClear();
    getUsingJj.mockClear();
    getTrunkBranch.mockClear();
    captureRepositoryState.mockClear();
    compareRepositoryStates.mockClear();
    hasUncommittedChanges.mockClear();
    setWorkspaceBookmarkToCurrent.mockClear();
    pushWorkspaceRefToRemote.mockClear();
    pullWorkspaceRefIfExists.mockClear();
    getRepositoryIdentity.mockClear();
    findPrimaryWorkspaceForRepository.mockClear();
    getWorkspaceInfoByPath.mockClear();
    patchWorkspaceInfo.mockClear();
    readdirMock.mockClear();
    rmMock.mockClear();

    commitAll.mockImplementation(async () => 1);
    logSpawn.mockImplementation(() => ({ exited: Promise.resolve(0), exitCode: 0 }));
    getUsingJj.mockImplementation(async () => true);
    getTrunkBranch.mockImplementation(async () => 'main');
    captureRepositoryState.mockImplementation(async () => ({
      commitHash: 'after',
      hasChanges: false,
      statusOutput: '',
      diffHash: 'after-hash',
    }));
    compareRepositoryStates.mockImplementation(() => ({
      commitChanged: true,
      workingTreeChanged: false,
      hasDifferences: true,
    }));
    hasUncommittedChanges.mockImplementation(async () => false);
    setWorkspaceBookmarkToCurrent.mockImplementation(async () => {});
    pushWorkspaceRefToRemote.mockImplementation(async () => {});
    pullWorkspaceRefIfExists.mockImplementation(async () => true);
    getRepositoryIdentity.mockImplementation(async () => ({ repositoryId: 'repo' }));
    findPrimaryWorkspaceForRepository.mockImplementation(() => null);
    getWorkspaceInfoByPath.mockImplementation(() => null);
    patchWorkspaceInfo.mockImplementation(() => ({}));
    readdirMock.mockImplementation(async () => []);
    rmMock.mockImplementation(async () => {});

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll,
      logSpawn,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      captureRepositoryState,
      compareRepositoryStates,
      getUsingJj,
      getCurrentBranchName: mock(async () => 'task-123'),
      getTrunkBranch,
      hasUncommittedChanges,
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      pullWorkspaceRefIfExists,
      pushWorkspaceRefToRemote,
      setWorkspaceBookmarkToCurrent,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity,
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath,
      findPrimaryWorkspaceForRepository,
      patchWorkspaceInfo,
    }));

    await moduleMocker.mock('../plan_materialize.js', () => ({
      MATERIALIZED_DIR: '.tim/plans',
    }));

    await moduleMocker.mock('node:fs/promises', () => ({
      readdir: readdirMock,
      rm: rmMock,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      warn: mock(() => {}),
      log: mock(() => {}),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('pushes to origin and refreshes the primary workspace when changes exist', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
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
    expect(readdirMock).toHaveBeenCalledWith('/tmp/workspace/.tim/plans');
  });

  test('skips push and deletes a newly created empty jj branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'task-123',
        branchCreatedDuringSetup: true,
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(pushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(setWorkspaceBookmarkToCurrent).not.toHaveBeenCalled();
    expect(logSpawn).toHaveBeenCalledWith(['jj', 'edit', 'main'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(logSpawn).toHaveBeenCalledWith(['jj', 'bookmark', 'delete', 'task-123'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(patchWorkspaceInfo).toHaveBeenCalledWith('/tmp/workspace', { branch: '' });
    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('skips push and deletes a newly created empty git branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    getUsingJj.mockReturnValue(Promise.resolve(false));
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'task-123',
        branchCreatedDuringSetup: true,
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(pushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(setWorkspaceBookmarkToCurrent).not.toHaveBeenCalled();
    expect(logSpawn).toHaveBeenCalledWith(['git', 'checkout', 'main'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(logSpawn).toHaveBeenCalledWith(['git', 'branch', '-D', 'task-123'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(patchWorkspaceInfo).toHaveBeenCalledWith('/tmp/workspace', { branch: '' });
    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('skips push without deleting when reusing an unchanged branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
        branchCreatedDuringSetup: false,
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(pushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(logSpawn).not.toHaveBeenCalled();
    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
    // Still refreshes the primary workspace from origin
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

  test('pushes and refreshes the primary workspace when a newly created branch has changes', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
        branchCreatedDuringSetup: true,
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
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
    expect(logSpawn).not.toHaveBeenCalled();
    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('still pushes when only uncommitted changes are present after execution', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    compareRepositoryStates.mockReturnValueOnce({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    hasUncommittedChanges.mockResolvedValueOnce(true);

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(pushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
    // Verify no cleanup occurs when there are uncommitted changes
    expect(logSpawn).not.toHaveBeenCalled();
    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('does not try to refresh origin when there is no primary workspace', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'task-123',
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('throws and does not clear branch metadata when cleanup commands fail', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    getUsingJj.mockReturnValue(Promise.resolve(false));
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    // Make git checkout fail
    logSpawn.mockReturnValue({ exited: Promise.resolve(1), exitCode: 1 } as any);

    await expect(
      runPostExecutionWorkspaceSync(
        {
          executionWorkspacePath: '/tmp/workspace',
          refName: 'task-123',
          branchCreatedDuringSetup: true,
          preExecutionState: {
            commitHash: 'before',
            hasChanges: false,
          },
        },
        'sync workspace'
      )
    ).rejects.toThrow('Failed to checkout main for branch cleanup');

    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('throws when git branch delete fails after successful checkout', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    getUsingJj.mockReturnValue(Promise.resolve(false));
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    // First call (checkout) succeeds, second call (branch -D) fails
    logSpawn
      .mockReturnValueOnce({ exited: Promise.resolve(0), exitCode: 0 } as any)
      .mockReturnValueOnce({ exited: Promise.resolve(1), exitCode: 1 } as any);

    await expect(
      runPostExecutionWorkspaceSync(
        {
          executionWorkspacePath: '/tmp/workspace',
          refName: 'task-123',
          branchCreatedDuringSetup: true,
          preExecutionState: {
            commitHash: 'before',
            hasChanges: false,
          },
        },
        'sync workspace'
      )
    ).rejects.toThrow('Failed to delete git branch task-123');

    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('skips cleanup when the branch to delete matches the restore branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    getUsingJj.mockReturnValue(Promise.resolve(false));
    compareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        refName: 'main',
        branchCreatedDuringSetup: true,
        preExecutionState: {
          commitHash: 'before',
          hasChanges: false,
        },
      },
      'sync workspace'
    );

    expect(logSpawn).not.toHaveBeenCalled();
    expect(patchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('pushes to origin when preExecutionState is not set', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');

    await runPostExecutionWorkspaceSync(
      {
        executionWorkspacePath: '/tmp/workspace',
        primaryWorkspacePath: '/tmp/primary',
        refName: 'task-123',
      },
      'sync workspace'
    );

    expect(pushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
  });
});

describe('runPreExecutionWorkspaceSync', () => {
  let moduleMocker: ModuleMocker;
  const captureRepositoryState = mock(async () => ({
    commitHash: 'after-pull',
    hasChanges: false,
    statusOutput: '',
    diffHash: 'hash',
  }));
  const pullWorkspaceRefIfExists = mock(async () => true);
  const readdirMock = mock(async () => []);
  const rmMock = mock(async () => {});

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    captureRepositoryState.mockClear();
    pullWorkspaceRefIfExists.mockClear();
    readdirMock.mockClear();
    rmMock.mockClear();

    await moduleMocker.mock('../../common/git.js', () => ({
      captureRepositoryState,
      compareRepositoryStates: mock(() => ({
        commitChanged: true,
        workingTreeChanged: false,
        hasDifferences: true,
      })),
      getCurrentBranchName: mock(async () => 'task-123'),
      getTrunkBranch: mock(async () => 'main'),
      getUsingJj: mock(async () => true),
      hasUncommittedChanges: mock(async () => false),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: mock(async () => 1),
      logSpawn: mock(() => ({ exited: Promise.resolve(0), exitCode: 0 })),
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      pullWorkspaceRefIfExists,
      pushWorkspaceRefToRemote: mock(async () => {}),
      setWorkspaceBookmarkToCurrent: mock(async () => {}),
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(async () => ({ repositoryId: 'repo' })),
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath: mock(() => null),
      findPrimaryWorkspaceForRepository: mock(() => null),
      patchWorkspaceInfo: mock(() => ({})),
    }));

    await moduleMocker.mock('../plan_materialize.js', () => ({
      MATERIALIZED_DIR: '.tim/plans',
    }));

    await moduleMocker.mock('node:fs/promises', () => ({
      readdir: readdirMock,
      rm: rmMock,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      warn: mock(() => {}),
      log: mock(() => {}),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('pulls from origin and captures state after pull', async () => {
    const { runPreExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    const context = {
      executionWorkspacePath: '/tmp/workspace',
      refName: 'task-123',
    };

    await runPreExecutionWorkspaceSync(context);

    expect(readdirMock).toHaveBeenCalledWith('/tmp/workspace/.tim/plans');
    expect(pullWorkspaceRefIfExists).toHaveBeenCalledWith('/tmp/workspace', 'task-123', 'origin');
    expect(captureRepositoryState).toHaveBeenCalledWith('/tmp/workspace');
    expect(context.preExecutionState).toEqual({
      commitHash: 'after-pull',
      hasChanges: false,
      statusOutput: '',
      diffHash: 'hash',
    });
  });

  test('skips pull and captures state for newly created branches', async () => {
    const { runPreExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    const context = {
      executionWorkspacePath: '/tmp/workspace',
      refName: 'task-123',
      branchCreatedDuringSetup: true,
    };

    await runPreExecutionWorkspaceSync(context);

    expect(pullWorkspaceRefIfExists).not.toHaveBeenCalled();
    expect(captureRepositoryState).toHaveBeenCalledWith('/tmp/workspace');
    expect(context.preExecutionState).toEqual({
      commitHash: 'after-pull',
      hasChanges: false,
      statusOutput: '',
      diffHash: 'hash',
    });
  });
});

describe('wipeMaterializedPlans', () => {
  test('deletes materialized plan contents while preserving keep files and directory', async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-'));
    const plansDir = path.join(workspaceDir, '.tim', 'plans');
    await mkdir(plansDir, { recursive: true });
    await writeFile(path.join(plansDir, '1.plan.md'), 'primary');
    await writeFile(path.join(plansDir, '.1.plan.md.shadow'), 'shadow');
    await writeFile(path.join(plansDir, '2.plan.md'), 'reference');
    await writeFile(path.join(plansDir, '1-tasks.json'), '{}');
    await writeFile(path.join(plansDir, '.gitignore'), '*.plan.md');
    await writeFile(path.join(plansDir, '.gitkeep'), '');

    try {
      const { wipeMaterializedPlans } = await import('./workspace_roundtrip.js');
      await wipeMaterializedPlans(workspaceDir);

      const remainingEntries = await readdir(plansDir);
      expect(remainingEntries).toHaveLength(2);
      expect(remainingEntries.sort()).toEqual(['.gitignore', '.gitkeep']);
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });

  test('ignores missing materialized plans directory', async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-'));

    try {
      const { wipeMaterializedPlans } = await import('./workspace_roundtrip.js');
      await expect(wipeMaterializedPlans(workspaceDir)).resolves.toBeUndefined();
    } finally {
      await rm(workspaceDir, { force: true, recursive: true });
    }
  });
});

describe('prepareWorkspaceRoundTrip', () => {
  let moduleMocker: ModuleMocker;
  const getCurrentBranchName = mock(async () => 'task-123');
  const getTrunkBranch = mock(async () => 'main');
  const getRepositoryIdentity = mock(async () => ({ repositoryId: 'repo' }));
  const findPrimaryWorkspaceForRepository = mock(() => null);
  const getWorkspaceInfoByPath = mock(() => null);

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    getCurrentBranchName.mockClear();
    getTrunkBranch.mockClear();
    getRepositoryIdentity.mockClear();
    findPrimaryWorkspaceForRepository.mockClear();
    getWorkspaceInfoByPath.mockClear();

    await moduleMocker.mock('../../common/git.js', () => ({
      captureRepositoryState: mock(async () => ({
        commitHash: 'before',
        hasChanges: false,
        statusOutput: '',
        diffHash: 'hash',
      })),
      compareRepositoryStates: mock(() => ({
        commitChanged: true,
        workingTreeChanged: false,
        hasDifferences: true,
      })),
      getCurrentBranchName,
      getTrunkBranch,
      getUsingJj: mock(async () => true),
      hasUncommittedChanges: mock(async () => false),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: mock(async () => 1),
      logSpawn: mock(() => ({ exited: Promise.resolve(0), exitCode: 0 })),
    }));

    await moduleMocker.mock('../commands/workspace.js', () => ({
      pullWorkspaceRefIfExists: mock(async () => true),
      pushWorkspaceRefToRemote: mock(async () => {}),
      setWorkspaceBookmarkToCurrent: mock(async () => {}),
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity,
    }));

    await moduleMocker.mock('./workspace_info.js', () => ({
      getWorkspaceInfoByPath,
      findPrimaryWorkspaceForRepository,
      patchWorkspaceInfo: mock(() => ({})),
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      warn: mock(() => {}),
      log: mock(() => {}),
      error: mock(() => {}),
      sendStructured: mock(() => {}),
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('includes the primary workspace in sync context when available', async () => {
    getWorkspaceInfoByPath.mockReturnValue({
      workspaceType: 'standard',
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
        branchCreatedDuringSetup: true,
      })
    ).resolves.toEqual({
      executionWorkspacePath: '/tmp/workspace',
      primaryWorkspacePath: '/tmp/primary',
      refName: 'task-123',
      branchCreatedDuringSetup: true,
    });
  });

  test('returns null when the current branch is the trunk branch', async () => {
    getCurrentBranchName.mockReturnValue(Promise.resolve('main'));
    getWorkspaceInfoByPath.mockReturnValue({
      workspaceType: 'standard',
      repositoryId: 'repo',
      branch: 'main',
    });
    findPrimaryWorkspaceForRepository.mockReturnValue({
      workspacePath: '/tmp/primary',
    });

    const { prepareWorkspaceRoundTrip } = await import('./workspace_roundtrip.js');

    await expect(
      prepareWorkspaceRoundTrip({
        workspacePath: '/tmp/workspace',
        workspaceSyncEnabled: true,
      })
    ).resolves.toBeNull();
  });
});
