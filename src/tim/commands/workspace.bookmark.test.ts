import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';

vi.mock('../../common/git.js', () => ({
  getCurrentBranchName: vi.fn(async () => null),
  getCurrentCommitHash: vi.fn(async () => null),
  getCurrentJujutsuBranch: vi.fn(async () => null),
  getGitRoot: vi.fn(async () => '/tmp/workspace'),
  getJjBookmarkRevisionForWorkingCopy: vi.fn(async () => '@'),
  getUsingJj: vi.fn(async () => true),
  hasUncommittedChanges: vi.fn(async () => false),
  isInGitRepository: vi.fn(async () => true),
}));

vi.mock('../../common/process.js', () => ({
  spawnAndLogOutput: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

import { getJjBookmarkRevisionForWorkingCopy } from '../../common/git.js';
import { spawnAndLogOutput } from '../../common/process.js';

describe('setWorkspaceBookmarkToCurrent', () => {
  let processCalls: string[][];
  const mockGetJjBookmarkRevisionForWorkingCopy = vi.mocked(getJjBookmarkRevisionForWorkingCopy);
  const mockSpawnAndLogOutput = vi.mocked(spawnAndLogOutput);

  beforeEach(async () => {
    processCalls = [];
    vi.clearAllMocks();
    mockGetJjBookmarkRevisionForWorkingCopy.mockResolvedValue('@');
    mockSpawnAndLogOutput.mockImplementation(async (args: string[]) => {
      processCalls.push(args);
      return { exitCode: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('sets bookmarks to the provided revision', async () => {
    const { setWorkspaceBookmarkToCurrent } = await import('./workspace.js');

    await setWorkspaceBookmarkToCurrent('/tmp/workspace', 'task-123', '@-');

    expect(processCalls).toContainEqual([
      'jj',
      'log',
      '-r',
      '@-',
      '--no-graph',
      '-T',
      'description',
    ]);
    expect(processCalls).toContainEqual(['jj', 'describe', '-r', '@-', '-m', 'start task-123']);
    expect(processCalls).toContainEqual(['jj', 'bookmark', 'set', 'task-123', '--revision', '@-']);
  });

  test('uses @- when jj status reports no working-copy changes', async () => {
    const { setWorkspaceBookmarkToCurrent } = await import('./workspace.js');
    mockGetJjBookmarkRevisionForWorkingCopy.mockResolvedValue('@-');

    await setWorkspaceBookmarkToCurrent('/tmp/workspace', 'task-123');

    expect(mockGetJjBookmarkRevisionForWorkingCopy).toHaveBeenCalledWith('/tmp/workspace');
    expect(processCalls).toContainEqual([
      'jj',
      'log',
      '-r',
      '@-',
      '--no-graph',
      '-T',
      'description',
    ]);
    expect(processCalls).toContainEqual(['jj', 'describe', '-r', '@-', '-m', 'start task-123']);
    expect(processCalls).toContainEqual(['jj', 'bookmark', 'set', 'task-123', '--revision', '@-']);
  });
});
