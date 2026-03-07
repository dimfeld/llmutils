import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { ModuleMocker } from '../../testing.js';

describe('setWorkspaceBookmarkToCurrent', () => {
  let moduleMocker: ModuleMocker;
  let processCalls: string[][];

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    processCalls = [];

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
});
