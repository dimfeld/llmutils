import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  captureRepositoryState,
  clearAllGitCaches,
  compareRepositoryStates,
  hasUncommittedChanges,
} from '../../common/git.js';
import { prepareExistingWorkspace } from './workspace_manager.js';

vi.mock('../commands/workspace.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../commands/workspace.js')>();
  return {
    ...actual,
    pullWorkspaceRefIfExists: vi.fn(async () => true),
    pushWorkspaceRefToRemote: vi.fn(async () => {}),
    setWorkspaceBookmarkToCurrent: vi.fn(async () => {}),
  };
});

vi.mock('./workspace_info.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workspace_info.js')>();
  return {
    ...actual,
    patchWorkspaceInfo: vi.fn(() => ({})),
  };
});

import { pushWorkspaceRefToRemote } from '../commands/workspace.js';
import { setWorkspaceBookmarkToCurrent } from '../commands/workspace.js';
import { runPostExecutionWorkspaceSync } from './workspace_roundtrip.js';

async function runGit(
  dir: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runJj(
  dir: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['jj', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function seedBareRemoteWithMain(remoteDir: string): Promise<void> {
  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-seed-'));
  try {
    expect((await runGit(remoteDir, ['init', '--bare', '--initial-branch=main'])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['init', '-b', 'main'])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['config', 'user.email', 'test@example.com'])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['config', 'user.name', 'Test User'])).exitCode).toBe(0);
    await fs.writeFile(path.join(seedDir, 'README.md'), '# seed\n');
    expect((await runGit(seedDir, ['add', '.'])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['commit', '-m', 'seed main'])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['remote', 'add', 'origin', remoteDir])).exitCode).toBe(0);
    expect((await runGit(seedDir, ['push', '-u', 'origin', 'main'])).exitCode).toBe(0);
  } finally {
    await fs.rm(seedDir, { recursive: true, force: true });
  }
}

const HAS_JJ = Boolean(Bun.which('jj'));

describe('runPostExecutionWorkspaceSync integration', () => {
  const pushWorkspaceRefToRemoteMock = vi.mocked(pushWorkspaceRefToRemote);
  const setWorkspaceBookmarkToCurrentMock = vi.mocked(setWorkspaceBookmarkToCurrent);

  beforeEach(() => {
    vi.clearAllMocks();
    clearAllGitCaches();
  });

  afterEach(() => {
    clearAllGitCaches();
  });

  test('git: deletes an unused newly-created branch and does not push', async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-remote-'));
    const workspaceParentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-git-'));
    const workspaceDir = path.join(workspaceParentDir, 'workspace');
    try {
      await seedBareRemoteWithMain(remoteDir);
      expect((await runGit(workspaceParentDir, ['clone', remoteDir, workspaceDir])).exitCode).toBe(
        0
      );
      expect(
        (await runGit(workspaceDir, ['config', 'user.email', 'test@example.com'])).exitCode
      ).toBe(0);
      expect((await runGit(workspaceDir, ['config', 'user.name', 'Test User'])).exitCode).toBe(0);

      const prepareResult = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'plan-noop',
        createBranch: true,
      });
      expect(prepareResult.success).toBe(true);

      const preExecutionState = await captureRepositoryState(workspaceDir);
      expect(preExecutionState.hasChanges).toBe(false);

      await runPostExecutionWorkspaceSync(
        {
          executionWorkspacePath: workspaceDir,
          refName: 'plan-noop',
          branchCreatedDuringSetup: true,
          preExecutionState,
        },
        'sync workspace'
      );

      const postExecutionState = await captureRepositoryState(workspaceDir);
      expect(compareRepositoryStates(preExecutionState, postExecutionState).hasDifferences).toBe(
        false
      );

      const currentBranch = await runGit(workspaceDir, ['branch', '--show-current']);
      expect(currentBranch.stdout.trim()).toBe('main');

      const localBranch = await runGit(workspaceDir, [
        'show-ref',
        '--verify',
        'refs/heads/plan-noop',
      ]);
      expect(localBranch.exitCode).not.toBe(0);

      const remoteBranch = await runGit(remoteDir, [
        'show-ref',
        '--verify',
        'refs/heads/plan-noop',
      ]);
      expect(remoteBranch.exitCode).not.toBe(0);

      expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(workspaceParentDir, { recursive: true, force: true });
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test('git: commits untracked files before pushing', async () => {
    const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-remote-'));
    const workspaceParentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-git-'));
    const workspaceDir = path.join(workspaceParentDir, 'workspace');
    try {
      await seedBareRemoteWithMain(remoteDir);
      expect((await runGit(workspaceParentDir, ['clone', remoteDir, workspaceDir])).exitCode).toBe(
        0
      );
      expect(
        (await runGit(workspaceDir, ['config', 'user.email', 'test@example.com'])).exitCode
      ).toBe(0);
      expect((await runGit(workspaceDir, ['config', 'user.name', 'Test User'])).exitCode).toBe(0);

      const prepareResult = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'plan-untracked',
        createBranch: true,
      });
      expect(prepareResult.success).toBe(true);

      const preExecutionState = await captureRepositoryState(workspaceDir);
      expect(preExecutionState.hasChanges).toBe(false);

      await fs.writeFile(path.join(workspaceDir, 'new-file.txt'), 'untracked content\n');
      expect(await hasUncommittedChanges(workspaceDir)).toBe(true);

      await runPostExecutionWorkspaceSync(
        {
          executionWorkspacePath: workspaceDir,
          refName: 'plan-untracked',
          branchCreatedDuringSetup: true,
          preExecutionState,
        },
        'sync workspace'
      );

      expect(await hasUncommittedChanges(workspaceDir)).toBe(false);
      expect(pushWorkspaceRefToRemoteMock).toHaveBeenCalledWith({
        workspacePath: workspaceDir,
        refName: 'plan-untracked',
        remoteName: 'origin',
        ensureJjBookmarkAtCurrent: false,
      });

      const committedFile = await runGit(workspaceDir, ['show', 'HEAD:new-file.txt']);
      expect(committedFile.exitCode).toBe(0);
      expect(committedFile.stdout).toBe('untracked content\n');
    } finally {
      await fs.rm(workspaceParentDir, { recursive: true, force: true });
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test.skipIf(!HAS_JJ)(
    'jj: deletes an unused newly-created bookmark and does not push',
    async () => {
      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-jj-remote-'));
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-jj-'));
      try {
        await seedBareRemoteWithMain(remoteDir);
        expect((await runJj(workspaceDir, ['git', 'init'])).exitCode).toBe(0);
        expect(
          (await runJj(workspaceDir, ['git', 'remote', 'add', 'origin', remoteDir])).exitCode
        ).toBe(0);
        expect((await runJj(workspaceDir, ['git', 'fetch'])).exitCode).toBe(0);
        // Materialize the local bookmark from the fetched remote branch.
        expect(
          (await runJj(workspaceDir, ['bookmark', 'track', 'main', '--remote', 'origin'])).exitCode
        ).toBe(0);
        expect((await runJj(workspaceDir, ['new', 'main'])).exitCode).toBe(0);

        const prepareResult = await prepareExistingWorkspace(workspaceDir, {
          baseBranch: 'main',
          branchName: 'jj-plan-noop',
          createBranch: true,
        });
        expect(prepareResult.success).toBe(true);

        const preExecutionState = await captureRepositoryState(workspaceDir);
        expect(preExecutionState.hasChanges).toBe(false);

        await runPostExecutionWorkspaceSync(
          {
            executionWorkspacePath: workspaceDir,
            refName: 'jj-plan-noop',
            branchCreatedDuringSetup: true,
            preExecutionState,
          },
          'sync workspace'
        );

        // In jj, `jj new main` after bookmark deletion creates a fresh working copy revision,
        // so the commit hash changes. The key assertions are that nothing was pushed and the
        // bookmark was cleaned up.
        const bookmarkList = await runJj(workspaceDir, ['bookmark', 'list', 'jj-plan-noop']);
        expect(bookmarkList.exitCode).toBe(0);
        expect(bookmarkList.stdout).not.toContain('jj-plan-noop');

        const remoteBranch = await runGit(remoteDir, [
          'show-ref',
          '--verify',
          'refs/heads/jj-plan-noop',
        ]);
        expect(remoteBranch.exitCode).not.toBe(0);

        expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    }
  );

  test.skipIf(!HAS_JJ)(
    'jj: commits uncommitted changes on descriptionless revisions and pushes the bookmark',
    async () => {
      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-jj-remote-'));
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-roundtrip-jj-work-'));
      try {
        await seedBareRemoteWithMain(remoteDir);
        expect((await runJj(workspaceDir, ['git', 'init'])).exitCode).toBe(0);
        expect(
          (await runJj(workspaceDir, ['git', 'remote', 'add', 'origin', remoteDir])).exitCode
        ).toBe(0);
        expect((await runJj(workspaceDir, ['git', 'fetch'])).exitCode).toBe(0);
        expect(
          (await runJj(workspaceDir, ['bookmark', 'track', 'main', '--remote', 'origin'])).exitCode
        ).toBe(0);
        expect((await runJj(workspaceDir, ['new', 'main'])).exitCode).toBe(0);

        const prepareResult = await prepareExistingWorkspace(workspaceDir, {
          baseBranch: 'main',
          branchName: 'jj-plan-work',
          createBranch: true,
        });
        expect(prepareResult.success).toBe(true);

        const preExecutionState = await captureRepositoryState(workspaceDir);
        expect(preExecutionState.hasChanges).toBe(false);

        await fs.appendFile(path.join(workspaceDir, 'README.md'), '\nchange made by test\n');
        expect(await hasUncommittedChanges(workspaceDir)).toBe(true);

        await runPostExecutionWorkspaceSync(
          {
            executionWorkspacePath: workspaceDir,
            refName: 'jj-plan-work',
            branchCreatedDuringSetup: true,
            preExecutionState,
          },
          'sync workspace'
        );

        const postExecutionState = await captureRepositoryState(workspaceDir);
        expect(compareRepositoryStates(preExecutionState, postExecutionState).hasDifferences).toBe(
          true
        );
        expect(await hasUncommittedChanges(workspaceDir)).toBe(false);

        expect(setWorkspaceBookmarkToCurrentMock).toHaveBeenCalledWith(
          workspaceDir,
          'jj-plan-work',
          '@-'
        );
        expect(pushWorkspaceRefToRemoteMock).toHaveBeenCalledWith({
          workspacePath: workspaceDir,
          refName: 'jj-plan-work',
          remoteName: 'origin',
          ensureJjBookmarkAtCurrent: false,
        });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    }
  );
});

describe('runPostExecutionWorkspaceSync ref guard', () => {
  const pushWorkspaceRefToRemoteMock = vi.mocked(pushWorkspaceRefToRemote);
  const setWorkspaceBookmarkToCurrentMock = vi.mocked(setWorkspaceBookmarkToCurrent);
  let remoteDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearAllGitCaches();
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-remote-'));
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-guard-work-'));
    await seedBareRemoteWithMain(remoteDir);
  });

  afterEach(async () => {
    clearAllGitCaches();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(remoteDir, { recursive: true, force: true });
  });

  async function setUpGitWorkspace(): Promise<void> {
    await fs.rm(workspaceDir, { recursive: true, force: true });
    expect(
      (await runGit(path.dirname(workspaceDir), ['clone', remoteDir, workspaceDir])).exitCode
    ).toBe(0);
    await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
    await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
    expect((await runGit(workspaceDir, ['checkout', '-b', 'chat/one'])).exitCode).toBe(0);
  }

  async function setUpJjWorkspace(): Promise<void> {
    expect((await runJj(workspaceDir, ['git', 'init'])).exitCode).toBe(0);
    await runJj(workspaceDir, ['config', 'set', '--repo', 'user.email', 'test@example.com']);
    await runJj(workspaceDir, ['config', 'set', '--repo', 'user.name', 'Test User']);
    expect(
      (await runJj(workspaceDir, ['git', 'remote', 'add', 'origin', remoteDir])).exitCode
    ).toBe(0);
    expect((await runJj(workspaceDir, ['git', 'fetch'])).exitCode).toBe(0);
    expect(
      (await runJj(workspaceDir, ['bookmark', 'track', 'main', '--remote', 'origin'])).exitCode
    ).toBe(0);
    expect((await runJj(workspaceDir, ['new', 'main'])).exitCode).toBe(0);
    expect(
      (await runJj(workspaceDir, ['bookmark', 'create', 'chat/one', '-r', 'main'])).exitCode
    ).toBe(0);
  }

  async function jjCommitFile(name: string, message: string): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, name), `${name}\n`);
    expect((await runJj(workspaceDir, ['commit', '-m', message])).exitCode).toBe(0);
  }

  async function sync(): Promise<void> {
    await runPostExecutionWorkspaceSync(
      { executionWorkspacePath: workspaceDir, refName: 'chat/one' },
      'sync workspace',
      { requireRefCheckedOut: true }
    );
  }

  test('git: pushes when the chat branch is still checked out', async () => {
    await setUpGitWorkspace();
    await fs.writeFile(path.join(workspaceDir, 'work.txt'), 'work\n');

    await sync();

    expect(pushWorkspaceRefToRemoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ refName: 'chat/one' })
    );
  });

  test('git: does not commit or push after the agent moved to another branch', async () => {
    await setUpGitWorkspace();
    expect((await runGit(workspaceDir, ['checkout', '-b', 'plan-x'])).exitCode).toBe(0);
    await fs.writeFile(path.join(workspaceDir, 'work.txt'), 'work\n');
    const headBefore = (await runGit(workspaceDir, ['rev-parse', 'HEAD'])).stdout;

    await expect(sync()).rejects.toThrow('The workspace is on branch "plan-x", not on "chat/one"');

    expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
    expect((await runGit(workspaceDir, ['rev-parse', 'HEAD'])).stdout).toBe(headBefore);
    expect(await hasUncommittedChanges(workspaceDir)).toBe(true);
  });

  test('git: does not push from a detached HEAD', async () => {
    await setUpGitWorkspace();
    expect((await runGit(workspaceDir, ['checkout', '--detach'])).exitCode).toBe(0);

    await expect(sync()).rejects.toThrow('a detached HEAD');
    expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
  });

  test.skipIf(!HAS_JJ)('jj: pushes chat work on top of the chat bookmark', async () => {
    await setUpJjWorkspace();
    await jjCommitFile('work.txt', 'chat work');
    await fs.writeFile(path.join(workspaceDir, 'more.txt'), 'more\n');

    await sync();

    expect(setWorkspaceBookmarkToCurrentMock).toHaveBeenCalledWith(workspaceDir, 'chat/one', '@-');
    expect(pushWorkspaceRefToRemoteMock).toHaveBeenCalled();
  });

  test.skipIf(!HAS_JJ)(
    'jj: does not move the chat bookmark onto a rebased plan branch',
    async () => {
      await setUpJjWorkspace();
      // The plan branch descends from the chat's start commit, as it does after a rebase
      // onto the latest trunk.
      await jjCommitFile('plan.txt', 'plan work');
      expect(
        (await runJj(workspaceDir, ['bookmark', 'create', 'plan-x', '-r', '@-'])).exitCode
      ).toBe(0);
      await fs.writeFile(path.join(workspaceDir, 'leftover.txt'), 'leftover\n');

      await expect(sync()).rejects.toThrow('on top of other bookmarks (plan-x)');

      expect(setWorkspaceBookmarkToCurrentMock).not.toHaveBeenCalled();
      expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
      expect(await hasUncommittedChanges(workspaceDir)).toBe(true);
    }
  );

  test.skipIf(!HAS_JJ)(
    'jj: does not push when the working copy left the chat bookmark',
    async () => {
      await setUpJjWorkspace();
      await jjCommitFile('chat.txt', 'chat work');
      expect(
        (await runJj(workspaceDir, ['bookmark', 'set', 'chat/one', '-r', '@-'])).exitCode
      ).toBe(0);
      expect((await runJj(workspaceDir, ['new', 'main'])).exitCode).toBe(0);

      await expect(sync()).rejects.toThrow('no longer on top of bookmark "chat/one"');
      expect(pushWorkspaceRefToRemoteMock).not.toHaveBeenCalled();
    }
  );

  test.skipIf(!HAS_JJ)('jj: allows chat work rebased onto a newer trunk', async () => {
    await setUpJjWorkspace();
    // Move trunk forward with a new commit that carries the main bookmark.
    expect((await runJj(workspaceDir, ['new', 'main'])).exitCode).toBe(0);
    await jjCommitFile('trunk.txt', 'new trunk work');
    expect((await runJj(workspaceDir, ['bookmark', 'set', 'main', '-r', '@-'])).exitCode).toBe(0);
    await jjCommitFile('work.txt', 'chat work on new trunk');

    await sync();

    expect(pushWorkspaceRefToRemoteMock).toHaveBeenCalled();
  });
});
