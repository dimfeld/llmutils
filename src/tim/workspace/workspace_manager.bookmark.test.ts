import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';

describe('ensurePrimaryWorkspaceBranch', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  const spawnAndLogOutput = mock(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-manager-bookmark-test-'));
    await fs.mkdir(path.join(tempDir, '.jj'));

    spawnAndLogOutput.mockClear();

    await moduleMocker.mock('../../logging.js', () => ({
      debugLog: mock(() => {}),
      log: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      spawnAndLogOutput,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
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

  test('returns error when working copy is dirty and no fromBranch', async () => {
    spawnAndLogOutput.mockImplementation(async (args: string[]) => {
      if (args[0] === 'jj' && args[1] === 'status') {
        return { exitCode: 0, stdout: 'Working copy changes:\nM file.txt', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');
    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Working copy is dirty');
  });

  test('uses @ revision when working copy is clean and no fromBranch', async () => {
    spawnAndLogOutput.mockImplementation(async (args: string[]) => {
      if (args[0] === 'jj' && args[1] === 'status') {
        return { exitCode: 0, stdout: 'The working copy has no changes.', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');
    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123');

    expect(result).toEqual({ success: true });

    const calls = spawnAndLogOutput.mock.calls;
    // Find the bookmark set call
    const bookmarkCall = calls.find(
      (c) => c[0][0] === 'jj' && c[0][1] === 'bookmark' && c[0][2] === 'set'
    );
    expect(bookmarkCall).toBeTruthy();
    expect(bookmarkCall![0]).toEqual(['jj', 'bookmark', 'set', 'task-123', '--revision', '@']);
  });

  test('runs jj new @- after successful push without fromBranch', async () => {
    spawnAndLogOutput.mockImplementation(async (args: string[]) => {
      if (args[0] === 'jj' && args[1] === 'status') {
        return { exitCode: 0, stdout: 'The working copy has no changes.', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');
    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123');

    expect(result).toEqual({ success: true });

    const calls = spawnAndLogOutput.mock.calls;
    const newCall = calls.find((c) => c[0][0] === 'jj' && c[0][1] === 'new');
    expect(newCall).toBeTruthy();
    expect(newCall![0]).toEqual(['jj', 'new', '@-']);
  });

  test('does not run jj new @- when fromBranch is specified', async () => {
    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');
    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123', {
      fromBranch: 'some-branch',
    });

    expect(result).toEqual({ success: true });

    const calls = spawnAndLogOutput.mock.calls;
    const newCall = calls.find((c) => c[0][0] === 'jj' && c[0][1] === 'new');
    expect(newCall).toBeUndefined();
  });

  test('does not check working copy status when fromBranch is specified', async () => {
    const { ensurePrimaryWorkspaceBranch } = await import('./workspace_manager.js');
    const result = await ensurePrimaryWorkspaceBranch(tempDir, 'task-123', {
      fromBranch: 'some-branch',
    });

    expect(result).toEqual({ success: true });

    const calls = spawnAndLogOutput.mock.calls;
    const statusCall = calls.find((c) => c[0][0] === 'jj' && c[0][1] === 'status');
    expect(statusCall).toBeUndefined();
  });
});
