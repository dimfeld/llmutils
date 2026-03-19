import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ModuleMocker } from '../../testing.js';

describe('setWorkspaceBookmarkToCurrent', () => {
  let moduleMocker: ModuleMocker;
  let processCalls: string[][];
  const getJjBookmarkRevisionForWorkingCopy = mock(async () => '@');

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    processCalls = [];
    getJjBookmarkRevisionForWorkingCopy.mockClear();
    getJjBookmarkRevisionForWorkingCopy.mockResolvedValue('@');

    await moduleMocker.mock('../../common/git.js', () => ({
      getCurrentBranchName: mock(async () => null),
      getCurrentCommitHash: mock(async () => null),
      getCurrentJujutsuBranch: mock(async () => null),
      getGitRoot: mock(async () => '/tmp/workspace'),
      getJjBookmarkRevisionForWorkingCopy,
      getUsingJj: mock(async () => true),
      hasUncommittedChanges: mock(async () => false),
      isInGitRepository: mock(async () => true),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput: mock(async (args: string[]) => {
        processCalls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('sets bookmarks to the provided revision', async () => {
    const { setWorkspaceBookmarkToCurrent } = await import('./workspace.js');

    await setWorkspaceBookmarkToCurrent('/tmp/workspace', 'task-123', '@-');

    expect(processCalls).toContainEqual(['jj', 'bookmark', 'set', 'task-123', '--revision', '@-']);
  });

  test('uses @- when jj status reports no working-copy changes', async () => {
    const { setWorkspaceBookmarkToCurrent } = await import('./workspace.js');
    getJjBookmarkRevisionForWorkingCopy.mockResolvedValue('@-');

    await setWorkspaceBookmarkToCurrent('/tmp/workspace', 'task-123');

    expect(getJjBookmarkRevisionForWorkingCopy).toHaveBeenCalledWith('/tmp/workspace');
    expect(processCalls).toContainEqual(['jj', 'bookmark', 'set', 'task-123', '--revision', '@-']);
  });
});
