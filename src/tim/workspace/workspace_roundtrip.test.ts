import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../common/process.js', () => ({
  commitAll: vi.fn(async () => 1),
  logSpawn: vi.fn(() => ({ exited: Promise.resolve(0), exitCode: 0 })),
}));

vi.mock('../../common/git.js', () => ({
  captureRepositoryState: vi.fn(async () => ({
    commitHash: 'after',
    hasChanges: false,
    statusOutput: '',
    diffHash: 'after-hash',
  })),
  compareRepositoryStates: vi.fn(() => ({
    commitChanged: true,
    workingTreeChanged: false,
    hasDifferences: true,
  })),
  getUsingJj: vi.fn(async () => true),
  getCurrentBranchName: vi.fn(async () => 'task-123'),
  getTrunkBranch: vi.fn(async () => 'main'),
  hasUncommittedChanges: vi.fn(async () => false),
}));

vi.mock('../commands/workspace.js', () => ({
  pullWorkspaceRefIfExists: vi.fn(async () => true),
  pushWorkspaceRefToRemote: vi.fn(async () => {}),
  setWorkspaceBookmarkToCurrent: vi.fn(async () => {}),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({ repositoryId: 'repo' })),
}));

vi.mock('./workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  findPrimaryWorkspaceForRepository: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(() => ({})),
}));

vi.mock('../plan_materialize.js', () => ({
  MATERIALIZED_DIR: '.tim/plans',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(async () => []),
    rm: vi.fn(async () => {}),
  };
});

vi.mock('../../logging.js', () => ({
  warn: vi.fn(() => {}),
  log: vi.fn(() => {}),
  error: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
}));

import { commitAll, logSpawn } from '../../common/process.js';
import {
  captureRepositoryState,
  compareRepositoryStates,
  getUsingJj,
  getCurrentBranchName,
  getTrunkBranch,
  hasUncommittedChanges,
} from '../../common/git.js';
import {
  pullWorkspaceRefIfExists,
  pushWorkspaceRefToRemote,
  setWorkspaceBookmarkToCurrent,
} from '../commands/workspace.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import {
  getWorkspaceInfoByPath,
  findPrimaryWorkspaceForRepository,
  patchWorkspaceInfo,
} from './workspace_info.js';
import { readdir as readdirMock, rm as rmMock } from 'node:fs/promises';

describe('runPostExecutionWorkspaceSync', () => {
  const mockCommitAll = vi.mocked(commitAll);
  const mockLogSpawn = vi.mocked(logSpawn);
  const mockGetUsingJj = vi.mocked(getUsingJj);
  const mockGetTrunkBranch = vi.mocked(getTrunkBranch);
  const mockCaptureRepositoryState = vi.mocked(captureRepositoryState);
  const mockCompareRepositoryStates = vi.mocked(compareRepositoryStates);
  const mockHasUncommittedChanges = vi.mocked(hasUncommittedChanges);
  const mockSetWorkspaceBookmarkToCurrent = vi.mocked(setWorkspaceBookmarkToCurrent);
  const mockPushWorkspaceRefToRemote = vi.mocked(pushWorkspaceRefToRemote);
  const mockPullWorkspaceRefIfExists = vi.mocked(pullWorkspaceRefIfExists);
  const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
  const mockFindPrimaryWorkspaceForRepository = vi.mocked(findPrimaryWorkspaceForRepository);
  const mockGetWorkspaceInfoByPath = vi.mocked(getWorkspaceInfoByPath);
  const mockPatchWorkspaceInfo = vi.mocked(patchWorkspaceInfo);
  const mockReaddir = vi.mocked(readdirMock);
  const mockRm = vi.mocked(rmMock);

  beforeEach(() => {
    vi.clearAllMocks();

    mockCommitAll.mockResolvedValue(1);
    mockLogSpawn.mockReturnValue({ exited: Promise.resolve(0), exitCode: 0 } as any);
    mockGetUsingJj.mockResolvedValue(true);
    mockGetTrunkBranch.mockResolvedValue('main');
    mockCaptureRepositoryState.mockResolvedValue({
      commitHash: 'after',
      hasChanges: false,
      statusOutput: '',
      diffHash: 'after-hash',
    });
    mockCompareRepositoryStates.mockReturnValue({
      commitChanged: true,
      workingTreeChanged: false,
      hasDifferences: true,
    });
    mockHasUncommittedChanges.mockResolvedValue(false);
    mockSetWorkspaceBookmarkToCurrent.mockResolvedValue(undefined);
    mockPushWorkspaceRefToRemote.mockResolvedValue(undefined);
    mockPullWorkspaceRefIfExists.mockResolvedValue(true);
    mockGetRepositoryIdentity.mockResolvedValue({ repositoryId: 'repo' } as any);
    mockFindPrimaryWorkspaceForRepository.mockReturnValue(null);
    mockGetWorkspaceInfoByPath.mockReturnValue(null);
    mockPatchWorkspaceInfo.mockReturnValue({} as any);
    mockReaddir.mockResolvedValue([] as any);
    mockRm.mockResolvedValue(undefined);
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

    expect(mockSetWorkspaceBookmarkToCurrent).toHaveBeenCalledWith(
      '/tmp/workspace',
      'task-123',
      '@-'
    );
    expect(mockPushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
    expect(mockPullWorkspaceRefIfExists).toHaveBeenCalledWith(
      '/tmp/primary',
      'task-123',
      'origin',
      undefined,
      {
        checkoutJjBookmark: false,
      }
    );
    expect(mockReaddir).toHaveBeenCalledWith('/tmp/workspace/.tim/plans');
  });

  test('skips push and deletes a newly created empty jj branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockCompareRepositoryStates.mockReturnValue({
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

    expect(mockPushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(mockSetWorkspaceBookmarkToCurrent).not.toHaveBeenCalled();
    expect(mockLogSpawn).toHaveBeenCalledWith(['jj', 'edit', 'main'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(mockLogSpawn).toHaveBeenCalledWith(['jj', 'bookmark', 'delete', 'task-123'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(mockPatchWorkspaceInfo).toHaveBeenCalledWith('/tmp/workspace', { branch: '' });
    expect(mockPullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('skips push and deletes a newly created empty git branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockGetUsingJj.mockResolvedValue(false);
    mockCompareRepositoryStates.mockReturnValue({
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

    expect(mockPushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(mockSetWorkspaceBookmarkToCurrent).not.toHaveBeenCalled();
    expect(mockLogSpawn).toHaveBeenCalledWith(['git', 'checkout', 'main'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(mockLogSpawn).toHaveBeenCalledWith(['git', 'branch', '-D', 'task-123'], {
      cwd: '/tmp/workspace',
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    expect(mockPatchWorkspaceInfo).toHaveBeenCalledWith('/tmp/workspace', { branch: '' });
    expect(mockPullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('skips push without deleting when reusing an unchanged branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockCompareRepositoryStates.mockReturnValue({
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

    expect(mockPushWorkspaceRefToRemote).not.toHaveBeenCalled();
    expect(mockLogSpawn).not.toHaveBeenCalled();
    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
    // Still refreshes the primary workspace from origin
    expect(mockPullWorkspaceRefIfExists).toHaveBeenCalledWith(
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

    expect(mockSetWorkspaceBookmarkToCurrent).toHaveBeenCalledWith(
      '/tmp/workspace',
      'task-123',
      '@-'
    );
    expect(mockPushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
    expect(mockPullWorkspaceRefIfExists).toHaveBeenCalledWith(
      '/tmp/primary',
      'task-123',
      'origin',
      undefined,
      {
        checkoutJjBookmark: false,
      }
    );
    expect(mockLogSpawn).not.toHaveBeenCalled();
    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('still pushes when only uncommitted changes are present after execution', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockCompareRepositoryStates.mockReturnValueOnce({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    mockHasUncommittedChanges.mockResolvedValueOnce(true);

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

    expect(mockPushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
    // Verify no cleanup occurs when there are uncommitted changes
    expect(mockLogSpawn).not.toHaveBeenCalled();
    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
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

    expect(mockPullWorkspaceRefIfExists).not.toHaveBeenCalled();
  });

  test('throws and does not clear branch metadata when cleanup commands fail', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockGetUsingJj.mockResolvedValue(false);
    mockCompareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    // Make git checkout fail
    mockLogSpawn.mockReturnValue({ exited: Promise.resolve(1), exitCode: 1 } as any);

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

    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('throws when git branch delete fails after successful checkout', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockGetUsingJj.mockResolvedValue(false);
    mockCompareRepositoryStates.mockReturnValue({
      commitChanged: false,
      workingTreeChanged: false,
      hasDifferences: false,
    });
    // First call (checkout) succeeds, second call (branch -D) fails
    mockLogSpawn
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

    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
  });

  test('skips cleanup when the branch to delete matches the restore branch', async () => {
    const { runPostExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    mockGetUsingJj.mockResolvedValue(false);
    mockCompareRepositoryStates.mockReturnValue({
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

    expect(mockLogSpawn).not.toHaveBeenCalled();
    expect(mockPatchWorkspaceInfo).not.toHaveBeenCalled();
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

    expect(mockPushWorkspaceRefToRemote).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      refName: 'task-123',
      remoteName: 'origin',
      ensureJjBookmarkAtCurrent: false,
    });
  });
});

describe('runPreExecutionWorkspaceSync', () => {
  const mockCaptureRepositoryState = vi.mocked(captureRepositoryState);
  const mockPullWorkspaceRefIfExists = vi.mocked(pullWorkspaceRefIfExists);
  const mockReaddir = vi.mocked(readdirMock);
  const mockRm = vi.mocked(rmMock);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCaptureRepositoryState.mockResolvedValue({
      commitHash: 'after-pull',
      hasChanges: false,
      statusOutput: '',
      diffHash: 'hash',
    });
    mockPullWorkspaceRefIfExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValue([] as any);
    mockRm.mockResolvedValue(undefined);
  });

  test('pulls from origin and captures state after pull', async () => {
    const { runPreExecutionWorkspaceSync } = await import('./workspace_roundtrip.js');
    const context = {
      executionWorkspacePath: '/tmp/workspace',
      refName: 'task-123',
    };

    await runPreExecutionWorkspaceSync(context);

    expect(mockReaddir).not.toHaveBeenCalled();
    expect(mockPullWorkspaceRefIfExists).toHaveBeenCalledWith(
      '/tmp/workspace',
      'task-123',
      'origin'
    );
    expect(mockCaptureRepositoryState).toHaveBeenCalledWith('/tmp/workspace');
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

    expect(mockPullWorkspaceRefIfExists).not.toHaveBeenCalled();
    expect(mockCaptureRepositoryState).toHaveBeenCalledWith('/tmp/workspace');
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

    // Restore real fs for this test
    const { readdir: realReaddir, rm: realRm } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdirMock).mockImplementation(realReaddir as any);
    vi.mocked(rmMock).mockImplementation(realRm as any);

    try {
      const { wipeMaterializedPlans } = await import('./workspace_roundtrip.js');
      await wipeMaterializedPlans(workspaceDir);

      const remainingEntries = await realReaddir(plansDir);
      expect(remainingEntries).toHaveLength(2);
      expect(remainingEntries.sort()).toEqual(['.gitignore', '.gitkeep']);
    } finally {
      await realRm(workspaceDir, { force: true, recursive: true });
    }
  });

  test('ignores missing materialized plans directory', async () => {
    const { mkdtemp: realMkdtemp, rm: realRm } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const workspaceDir = await (realMkdtemp as typeof mkdtemp)(
      path.join(os.tmpdir(), 'workspace-roundtrip-')
    );

    // Restore real fs for this test
    const { readdir: realReaddir } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(readdirMock).mockImplementation(realReaddir as any);
    vi.mocked(rmMock).mockImplementation(realRm as any);

    try {
      const { wipeMaterializedPlans } = await import('./workspace_roundtrip.js');
      await expect(wipeMaterializedPlans(workspaceDir)).resolves.toBeUndefined();
    } finally {
      await (realRm as typeof rm)(workspaceDir, { force: true, recursive: true });
    }
  });
});

describe('prepareWorkspaceRoundTrip', () => {
  const mockGetCurrentBranchName = vi.mocked(getCurrentBranchName);
  const mockGetTrunkBranch = vi.mocked(getTrunkBranch);
  const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
  const mockFindPrimaryWorkspaceForRepository = vi.mocked(findPrimaryWorkspaceForRepository);
  const mockGetWorkspaceInfoByPath = vi.mocked(getWorkspaceInfoByPath);

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentBranchName.mockResolvedValue('task-123');
    mockGetTrunkBranch.mockResolvedValue('main');
    mockGetRepositoryIdentity.mockResolvedValue({ repositoryId: 'repo' } as any);
    mockFindPrimaryWorkspaceForRepository.mockReturnValue(null);
    mockGetWorkspaceInfoByPath.mockReturnValue(null);
  });

  test('includes the primary workspace in sync context when available', async () => {
    mockGetWorkspaceInfoByPath.mockReturnValue({
      workspaceType: 'standard',
      repositoryId: 'repo',
      branch: 'task-123',
    } as any);
    mockFindPrimaryWorkspaceForRepository.mockReturnValue({
      workspacePath: '/tmp/primary',
    } as any);

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
    mockGetCurrentBranchName.mockResolvedValue('main');
    mockGetWorkspaceInfoByPath.mockReturnValue({
      workspaceType: 'standard',
      repositoryId: 'repo',
      branch: 'main',
    } as any);
    mockFindPrimaryWorkspaceForRepository.mockReturnValue({
      workspacePath: '/tmp/primary',
    } as any);

    const { prepareWorkspaceRoundTrip } = await import('./workspace_roundtrip.js');

    await expect(
      prepareWorkspaceRoundTrip({
        workspacePath: '/tmp/workspace',
        workspaceSyncEnabled: true,
      })
    ).resolves.toBeNull();
  });
});
