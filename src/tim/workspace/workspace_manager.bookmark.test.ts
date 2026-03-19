import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';

describe('ensurePrimaryWorkspaceBranch', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  const spawnAndLogOutput = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
  const getJjBookmarkRevisionForWorkingCopy = mock(async () => '@');

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-manager-bookmark-test-'));
    await fs.mkdir(path.join(tempDir, '.jj'));

    spawnAndLogOutput.mockClear();
    getJjBookmarkRevisionForWorkingCopy.mockClear();
    getJjBookmarkRevisionForWorkingCopy.mockResolvedValue('@-');

    await moduleMocker.mock('../../logging.js', () => ({
      debugLog: mock(() => {}),
      log: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getJjBookmarkRevisionForWorkingCopy,
      getTrunkBranch: mock(async () => 'main'),
    }));

    await moduleMocker.mock('../actions.js', () => ({
      executePostApplyCommand: mock(async () => true),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses @- for jj bookmark creation when the working copy has no changes', async () => {
    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');

    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123');

    expect(result).toEqual({ success: true });
    expect(getJjBookmarkRevisionForWorkingCopy).toHaveBeenCalledWith(tempDir);
    expect(spawnAndLogOutput).toHaveBeenCalledWith(
      ['jj', 'bookmark', 'set', 'task-123', '--revision', '@-'],
      { cwd: tempDir }
    );
  });
});
