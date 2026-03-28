import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { findUniqueBranchName, prepareExistingWorkspace } from './workspace_manager.js';
import { clearAllGitCaches } from '../../common/git.js';

/**
 * Helper function to run git commands
 */
async function runGit(
  dir: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);

  return { exitCode, stdout, stderr };
}

/**
 * Helper function to initialize a git repository with initial commit
 */
async function initGitRepository(dir: string): Promise<void> {
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);

  // Create initial commit
  const testFile = path.join(dir, 'README.md');
  await fs.writeFile(testFile, '# Test Repository\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'Initial commit']);
}

async function cloneGitRepository(source: string, destination: string): Promise<void> {
  const result = await runGit(path.dirname(destination), ['clone', source, destination]);
  expect(result.exitCode).toBe(0);
}

/**
 * Helper to get current branch name
 */
async function getCurrentBranch(dir: string): Promise<string> {
  const result = await runGit(dir, ['branch', '--show-current']);
  return result.stdout.trim();
}

/**
 * Helper to check if a branch exists
 */
async function branchExistsInRepo(dir: string, branchName: string): Promise<boolean> {
  const result = await runGit(dir, ['rev-parse', '--verify', branchName]);
  return result.exitCode === 0;
}

describe('findUniqueBranchName', () => {
  let tempDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-prepare-test-'));
    await initGitRepository(tempDir);
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns original name when branch does not exist (Git)', async () => {
    const branchName = await findUniqueBranchName(tempDir, 'new-feature', false);
    expect(branchName).toBe('new-feature');
  });

  test('returns suffixed name when branch exists (Git)', async () => {
    // Create a branch with the base name
    await runGit(tempDir, ['checkout', '-b', 'feature-branch']);
    await runGit(tempDir, ['checkout', 'main']);

    const branchName = await findUniqueBranchName(tempDir, 'feature-branch', false);
    expect(branchName).toBe('feature-branch-2');
  });

  test('handles multiple existing suffixes correctly (Git)', async () => {
    // Create branches with base name and multiple suffixes
    await runGit(tempDir, ['checkout', '-b', 'task-123']);
    await runGit(tempDir, ['checkout', 'main']);
    await runGit(tempDir, ['checkout', '-b', 'task-123-2']);
    await runGit(tempDir, ['checkout', 'main']);
    await runGit(tempDir, ['checkout', '-b', 'task-123-3']);
    await runGit(tempDir, ['checkout', 'main']);

    const branchName = await findUniqueBranchName(tempDir, 'task-123', false);
    expect(branchName).toBe('task-123-4');
  });

  test('returns original name for non-conflicting branch (Git)', async () => {
    // Create a branch that should not conflict
    await runGit(tempDir, ['checkout', '-b', 'other-feature']);
    await runGit(tempDir, ['checkout', 'main']);

    const branchName = await findUniqueBranchName(tempDir, 'my-feature', false);
    expect(branchName).toBe('my-feature');
  });
});

describe('findUniqueBranchName with Jujutsu', () => {
  let tempDir: string;
  let hasJj = false;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-jj-test-'));

    // Check if jj is available
    const jjCheck = Bun.spawn(['jj', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await jjCheck.exited;
    hasJj = exitCode === 0;

    if (hasJj) {
      // Initialize a jj repository
      const jjInit = Bun.spawn(['jj', 'git', 'init'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjInit.exited;

      // Configure user.email and user.name for jj (required for commits)
      const jjConfigEmail = Bun.spawn(
        ['jj', 'config', 'set', '--repo', 'user.email', 'test@example.com'],
        {
          cwd: tempDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      await jjConfigEmail.exited;

      const jjConfigName = Bun.spawn(['jj', 'config', 'set', '--repo', 'user.name', 'Test User'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjConfigName.exited;

      // Create initial content
      await fs.writeFile(path.join(tempDir, 'README.md'), '# Test Jujutsu Repo\n');
      const jjCommit = Bun.spawn(['jj', 'commit', '-m', 'Initial commit'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjCommit.exited;
    }
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('returns original name when bookmark does not exist (Jujutsu)', async () => {
    if (!hasJj) {
      console.log('Skipping Jujutsu test - jj not installed');
      return;
    }

    const branchName = await findUniqueBranchName(tempDir, 'new-feature', true);
    expect(branchName).toBe('new-feature');
  });

  test('returns suffixed name when bookmark exists (Jujutsu)', async () => {
    if (!hasJj) {
      console.log('Skipping Jujutsu test - jj not installed');
      return;
    }

    // Create a bookmark
    const setBookmark = Bun.spawn(['jj', 'bookmark', 'set', 'feature-branch'], {
      cwd: tempDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await setBookmark.exited;

    const branchName = await findUniqueBranchName(tempDir, 'feature-branch', true);
    expect(branchName).toBe('feature-branch-2');
  });
});

describe('prepareExistingWorkspace', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-prepare-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-remote-'));

    // Create a bare remote repository
    await runGit(remoteDir, ['init', '--bare']);

    // Initialize the workspace as a clone of the "remote"
    await initGitRepository(tempDir);
    await runGit(tempDir, ['remote', 'add', 'origin', remoteDir]);
    await runGit(tempDir, ['push', '-u', 'origin', 'main']);
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    if (remoteDir) {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test('successfully fetches, checks out base, creates branch (Git)', async () => {
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'new-task-branch',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.actualBranchName).toBe('new-task-branch');

    // Verify the branch was created and checked out
    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('new-task-branch');
  });

  test('uses specified --from-branch instead of auto-detected trunk', async () => {
    // Create a develop branch
    await runGit(tempDir, ['checkout', '-b', 'develop']);
    await fs.writeFile(path.join(tempDir, 'develop-file.txt'), 'develop content');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'Develop commit']);
    await runGit(tempDir, ['push', '-u', 'origin', 'develop']);
    await runGit(tempDir, ['checkout', 'main']);

    const result = await prepareExistingWorkspace(tempDir, {
      baseBranch: 'develop',
      branchName: 'feature-from-develop',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('feature-from-develop');

    // Verify the branch was created and includes develop content
    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('feature-from-develop');

    // Check that develop-file.txt exists (inherited from develop branch)
    const fileExists = await fs
      .access(path.join(tempDir, 'develop-file.txt'))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });

  test('auto-suffixes branch name when it already exists', async () => {
    // Create a branch with the intended name
    await runGit(tempDir, ['checkout', '-b', 'task-456']);
    await runGit(tempDir, ['checkout', 'main']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'task-456',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('task-456-2');

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('task-456-2');
  });

  test('missing remote skips fetch and continues', async () => {
    await runGit(tempDir, ['remote', 'remove', 'origin']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'new-branch',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('new-branch');
  });

  test('fetch failure aborts by default', async () => {
    await runGit(tempDir, ['remote', 'set-url', 'origin', path.join(tempDir, 'missing-remote')]);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'new-branch',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to fetch from remote');
  });

  test('fetch failure continues with warning when ALLOW_OFFLINE is set', async () => {
    // Save original env value
    const originalAllowOffline = process.env.ALLOW_OFFLINE;

    try {
      // Set ALLOW_OFFLINE
      process.env.ALLOW_OFFLINE = 'true';

      await runGit(tempDir, ['remote', 'set-url', 'origin', path.join(tempDir, 'missing-remote')]);

      const result = await prepareExistingWorkspace(tempDir, {
        branchName: 'offline-branch',
        createBranch: true,
      });

      expect(result.success).toBe(true);
      expect(result.actualBranchName).toBe('offline-branch');
    } finally {
      // Restore original env value
      if (originalAllowOffline === undefined) {
        delete process.env.ALLOW_OFFLINE;
      } else {
        process.env.ALLOW_OFFLINE = originalAllowOffline;
      }
    }
  });

  test('handles checkout failure for invalid base branch', async () => {
    const result = await prepareExistingWorkspace(tempDir, {
      baseBranch: 'nonexistent-branch',
      branchName: 'new-branch',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to checkout base branch');
    expect(result.error).toContain('nonexistent-branch');
  });

  test('handles existing branch by auto-suffixing', async () => {
    // When a branch already exists, the function should auto-suffix the name

    // Create the base branch
    await runGit(tempDir, ['checkout', '-b', 'test-branch-999']);
    await runGit(tempDir, ['checkout', 'main']);

    // The function should succeed with a suffixed name
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'test-branch-999',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('test-branch-999-2');
  });

  test('handles branch creation failure with invalid branch name', async () => {
    // Git rejects branch names starting with '-' (looks like an option)
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: '-invalid-branch',
      createBranch: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create branch');
    expect(result.error).toContain('-invalid-branch');
  });

  test('successfully works with default trunk branch detection', async () => {
    // Just use the default - should detect 'main'
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'auto-trunk-branch',
      createBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('auto-trunk-branch');

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('auto-trunk-branch');
  });

  test('fast-forwards the base branch from origin before creating a new branch', async () => {
    const remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-prepare-remote-'));
    const remoteDir = path.join(remoteRoot, 'origin.git');
    const peerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-prepare-peer-'));
    const peerDir = path.join(peerRoot, 'peer');

    try {
      expect(
        (await runGit(remoteRoot, ['init', '--bare', '--initial-branch=main', remoteDir])).exitCode
      ).toBe(0);
      const addRemoteResult = await runGit(tempDir, ['remote', 'add', 'origin', remoteDir]);
      if (addRemoteResult.exitCode !== 0) {
        expect((await runGit(tempDir, ['remote', 'set-url', 'origin', remoteDir])).exitCode).toBe(
          0
        );
      }
      expect((await runGit(tempDir, ['push', '-u', 'origin', 'main'])).exitCode).toBe(0);

      await cloneGitRepository(remoteDir, peerDir);
      expect((await runGit(peerDir, ['config', 'user.email', 'test@example.com'])).exitCode).toBe(
        0
      );
      expect((await runGit(peerDir, ['config', 'user.name', 'Test User'])).exitCode).toBe(0);

      await fs.writeFile(path.join(peerDir, 'REMOTE_CHANGE.md'), 'new base content\n');
      expect((await runGit(peerDir, ['add', 'REMOTE_CHANGE.md'])).exitCode).toBe(0);
      expect((await runGit(peerDir, ['commit', '-m', 'Remote update'])).exitCode).toBe(0);
      expect((await runGit(peerDir, ['push', 'origin', 'main'])).exitCode).toBe(0);

      const result = await prepareExistingWorkspace(tempDir, {
        branchName: 'branch-from-updated-main',
        createBranch: true,
      });

      expect(result.success).toBe(true);
      expect(await fs.readFile(path.join(tempDir, 'REMOTE_CHANGE.md'), 'utf8')).toContain(
        'new base content'
      );
      expect(await getCurrentBranch(tempDir)).toBe('branch-from-updated-main');
    } finally {
      await fs.rm(remoteRoot, { recursive: true, force: true });
      await fs.rm(peerRoot, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, creates a new branch locally in the execution workspace', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-prepare-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-prepare-'));

    try {
      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'separate-primary-local-branch',
        createBranch: true,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'separate-primary-local-branch',
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('separate-primary-local-branch');
      expect(await branchExistsInRepo(primaryDir, 'separate-primary-local-branch')).toBe(false);

      const remoteBranch = await runGit(remoteDir, [
        'rev-parse',
        '--verify',
        'refs/heads/separate-primary-local-branch',
      ]);
      expect(remoteBranch.exitCode).not.toBe(0);
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, checks out an existing remote branch in the execution workspace', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-existing-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-existing-'));

    try {
      await runGit(tempDir, ['checkout', '-b', 'already-remote']);
      await fs.writeFile(path.join(tempDir, 'already-remote.txt'), 'remote branch content');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Add remote branch content']);
      await runGit(tempDir, ['push', '-u', 'origin', 'already-remote']);
      await runGit(tempDir, ['checkout', 'main']);

      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'already-remote',
        createBranch: true,
        reuseExistingBranch: true,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'already-remote',
        reusedExistingBranch: true,
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('already-remote');
      await expect(
        fs.readFile(path.join(workspaceDir, 'already-remote.txt'), 'utf-8')
      ).resolves.toBe('remote branch content');
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, creates a suffixed local branch when reuseExistingBranch is false and the remote branch exists', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-no-reuse-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-no-reuse-'));

    try {
      await runGit(tempDir, ['checkout', '-b', 'already-remote']);
      await fs.writeFile(path.join(tempDir, 'already-remote.txt'), 'remote branch content');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Add remote branch content']);
      await runGit(tempDir, ['push', '-u', 'origin', 'already-remote']);
      await runGit(tempDir, ['checkout', 'main']);

      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'already-remote',
        createBranch: true,
        reuseExistingBranch: false,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'already-remote-2',
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('already-remote-2');

      const reusedRemoteFileExists = await fs
        .access(path.join(workspaceDir, 'already-remote.txt'))
        .then(() => true)
        .catch(() => false);
      expect(reusedRemoteFileExists).toBe(false);
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, reuses an existing local execution branch when reuseExistingBranch is true', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-local-reuse-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-local-reuse-'));

    try {
      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
      await runGit(workspaceDir, ['checkout', '-b', 'local-only-branch']);
      await fs.writeFile(path.join(workspaceDir, 'local-only.txt'), 'execution workspace branch');
      await runGit(workspaceDir, ['add', '.']);
      await runGit(workspaceDir, ['commit', '-m', 'Create local-only execution branch']);
      await runGit(workspaceDir, ['checkout', 'main']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'local-only-branch',
        createBranch: true,
        reuseExistingBranch: true,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'local-only-branch',
        reusedExistingBranch: true,
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('local-only-branch');
      await expect(fs.readFile(path.join(workspaceDir, 'local-only.txt'), 'utf-8')).resolves.toBe(
        'execution workspace branch'
      );
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, fast-forwards an existing local execution branch from origin when reuseExistingBranch is true', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-local-ff-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-local-ff-'));

    try {
      await runGit(tempDir, ['checkout', '-b', 'shared-branch']);
      await fs.writeFile(path.join(tempDir, 'shared.txt'), 'initial');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Create shared branch']);
      await runGit(tempDir, ['push', '-u', 'origin', 'shared-branch']);
      await runGit(tempDir, ['checkout', 'main']);

      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
      await runGit(workspaceDir, ['checkout', 'shared-branch']);
      await runGit(workspaceDir, ['checkout', 'main']);

      const otherCloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-other-clone-'));
      try {
        await cloneGitRepository(remoteDir, otherCloneDir);
        await runGit(otherCloneDir, ['config', 'user.email', 'test@example.com']);
        await runGit(otherCloneDir, ['config', 'user.name', 'Test User']);
        await runGit(otherCloneDir, ['checkout', 'shared-branch']);
        await fs.writeFile(path.join(otherCloneDir, 'shared.txt'), 'updated remotely');
        await runGit(otherCloneDir, ['add', '.']);
        await runGit(otherCloneDir, ['commit', '-m', 'Update shared branch']);
        await runGit(otherCloneDir, ['push', 'origin', 'shared-branch']);
      } finally {
        await fs.rm(otherCloneDir, { recursive: true, force: true });
      }

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'shared-branch',
        createBranch: true,
        reuseExistingBranch: true,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'shared-branch',
        reusedExistingBranch: true,
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('shared-branch');
      await expect(fs.readFile(path.join(workspaceDir, 'shared.txt'), 'utf-8')).resolves.toBe(
        'updated remotely'
      );
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, force-resets a divergent local execution branch from origin when reuseExistingBranch is true', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-diverged-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-diverged-'));

    try {
      await runGit(tempDir, ['checkout', '-b', 'shared-branch']);
      await fs.writeFile(path.join(tempDir, 'shared.txt'), 'initial');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Create shared branch']);
      await runGit(tempDir, ['push', '-u', 'origin', 'shared-branch']);
      await runGit(tempDir, ['checkout', 'main']);

      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
      await runGit(workspaceDir, ['checkout', 'shared-branch']);
      await fs.writeFile(path.join(workspaceDir, 'shared.txt'), 'local divergent change');
      await runGit(workspaceDir, ['add', '.']);
      await runGit(workspaceDir, ['commit', '-m', 'Diverge locally']);
      await runGit(workspaceDir, ['checkout', 'main']);

      const otherCloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-other-diverged-'));
      try {
        await cloneGitRepository(remoteDir, otherCloneDir);
        await runGit(otherCloneDir, ['config', 'user.email', 'test@example.com']);
        await runGit(otherCloneDir, ['config', 'user.name', 'Test User']);
        await runGit(otherCloneDir, ['checkout', 'shared-branch']);
        await fs.writeFile(path.join(otherCloneDir, 'shared.txt'), 'remote canonical change');
        await runGit(otherCloneDir, ['add', '.']);
        await runGit(otherCloneDir, ['commit', '-m', 'Advance remote branch']);
        await runGit(otherCloneDir, ['push', 'origin', 'shared-branch']);
      } finally {
        await fs.rm(otherCloneDir, { recursive: true, force: true });
      }

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'shared-branch',
        createBranch: true,
        reuseExistingBranch: true,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'shared-branch',
        reusedExistingBranch: true,
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('shared-branch');
      await expect(fs.readFile(path.join(workspaceDir, 'shared.txt'), 'utf-8')).resolves.toBe(
        'remote canonical change'
      );
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, suffixes when the execution workspace already has a local-only branch and reuseExistingBranch is false', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-local-suffix-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-local-suffix-'));

    try {
      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
      await runGit(workspaceDir, ['checkout', '-b', 'local-only-branch']);
      await fs.writeFile(path.join(workspaceDir, 'local-only.txt'), 'execution workspace branch');
      await runGit(workspaceDir, ['add', '.']);
      await runGit(workspaceDir, ['commit', '-m', 'Create local-only execution branch']);
      await runGit(workspaceDir, ['checkout', 'main']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'local-only-branch',
        createBranch: true,
        reuseExistingBranch: false,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'local-only-branch-2',
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('local-only-branch-2');
      const inheritedFileExists = await fs
        .access(path.join(workspaceDir, 'local-only.txt'))
        .then(() => true)
        .catch(() => false);
      expect(inheritedFileExists).toBe(false);
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  test('with a separate primary workspace, local collision suffixing also avoids remote branch names', async () => {
    const primaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-primary-remote-suffix-'));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-exec-remote-suffix-'));

    try {
      await runGit(tempDir, ['checkout', '-b', 'local-only-branch-2']);
      await fs.writeFile(path.join(tempDir, 'remote-suffix.txt'), 'remote branch');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Create remote suffix branch']);
      await runGit(tempDir, ['push', '-u', 'origin', 'local-only-branch-2']);
      await runGit(tempDir, ['checkout', 'main']);

      await cloneGitRepository(remoteDir, primaryDir);
      await runGit(primaryDir, ['config', 'user.email', 'test@example.com']);
      await runGit(primaryDir, ['config', 'user.name', 'Test User']);

      await cloneGitRepository(remoteDir, workspaceDir);
      await runGit(workspaceDir, ['config', 'user.email', 'test@example.com']);
      await runGit(workspaceDir, ['config', 'user.name', 'Test User']);
      await runGit(workspaceDir, ['checkout', '-b', 'local-only-branch']);
      await fs.writeFile(path.join(workspaceDir, 'local-only.txt'), 'execution workspace branch');
      await runGit(workspaceDir, ['add', '.']);
      await runGit(workspaceDir, ['commit', '-m', 'Create local-only execution branch']);
      await runGit(workspaceDir, ['checkout', 'main']);

      const result = await prepareExistingWorkspace(workspaceDir, {
        branchName: 'local-only-branch',
        createBranch: true,
        reuseExistingBranch: false,
        primaryWorkspacePath: primaryDir,
      });

      expect(result).toEqual({
        success: true,
        actualBranchName: 'local-only-branch-3',
      });
      expect(await getCurrentBranch(workspaceDir)).toBe('local-only-branch-3');
    } finally {
      await fs.rm(primaryDir, { recursive: true, force: true });
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

describe('prepareExistingWorkspace with Jujutsu', () => {
  let tempDir: string;
  let hasJj = false;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-jj-prepare-'));

    // Check if jj is available
    const jjCheck = Bun.spawn(['jj', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await jjCheck.exited;
    hasJj = exitCode === 0;

    if (hasJj) {
      // Initialize a jj repository
      const jjInit = Bun.spawn(['jj', 'git', 'init'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjInit.exited;

      // Configure user.email and user.name for jj (required for commits)
      const jjConfigEmail = Bun.spawn(
        ['jj', 'config', 'set', '--repo', 'user.email', 'test@example.com'],
        {
          cwd: tempDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      );
      await jjConfigEmail.exited;

      const jjConfigName = Bun.spawn(['jj', 'config', 'set', '--repo', 'user.name', 'Test User'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjConfigName.exited;

      // Create initial content
      await fs.writeFile(path.join(tempDir, 'README.md'), '# Test Jujutsu Repo\n');
      const jjCommit = Bun.spawn(['jj', 'commit', '-m', 'Initial commit'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await jjCommit.exited;

      // Set up main bookmark
      const setMain = Bun.spawn(['jj', 'bookmark', 'set', 'main'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await setMain.exited;
    }
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('successfully fetches, creates new change with bookmark (Jujutsu)', async () => {
    if (!hasJj) {
      console.log('Skipping Jujutsu test - jj not installed');
      return;
    }

    // Set ALLOW_OFFLINE since we don't have a real remote in this test
    const originalAllowOffline = process.env.ALLOW_OFFLINE;

    try {
      process.env.ALLOW_OFFLINE = 'true';

      const result = await prepareExistingWorkspace(tempDir, {
        baseBranch: 'main',
        branchName: 'jj-feature',
        createBranch: true,
      });

      expect(result.success).toBe(true);
      expect(result.actualBranchName).toBe('jj-feature');

      // Verify the bookmark was created
      const bookmarkList = Bun.spawn(['jj', 'bookmark', 'list'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout] = await Promise.all([
        bookmarkList.exited,
        new Response(bookmarkList.stdout as ReadableStream).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('jj-feature');
    } finally {
      if (originalAllowOffline === undefined) {
        delete process.env.ALLOW_OFFLINE;
      } else {
        process.env.ALLOW_OFFLINE = originalAllowOffline;
      }
    }
  });

  test('auto-suffixes bookmark when it exists (Jujutsu)', async () => {
    if (!hasJj) {
      console.log('Skipping Jujutsu test - jj not installed');
      return;
    }

    // Set ALLOW_OFFLINE since we don't have a real remote
    const originalAllowOffline = process.env.ALLOW_OFFLINE;

    try {
      process.env.ALLOW_OFFLINE = 'true';

      // Create the bookmark first
      const setBookmark = Bun.spawn(['jj', 'bookmark', 'set', 'task-789'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await setBookmark.exited;

      const result = await prepareExistingWorkspace(tempDir, {
        baseBranch: 'main',
        branchName: 'task-789',
        createBranch: true,
      });

      expect(result.success).toBe(true);
      expect(result.actualBranchName).toBe('task-789-2');
    } finally {
      if (originalAllowOffline === undefined) {
        delete process.env.ALLOW_OFFLINE;
      } else {
        process.env.ALLOW_OFFLINE = originalAllowOffline;
      }
    }
  });

  test('skips new change creation when createBranch is false (Jujutsu)', async () => {
    if (!hasJj) {
      console.log('Skipping Jujutsu test - jj not installed');
      return;
    }

    const originalAllowOffline = process.env.ALLOW_OFFLINE;

    try {
      process.env.ALLOW_OFFLINE = 'true';

      const result = await prepareExistingWorkspace(tempDir, {
        baseBranch: 'main',
        branchName: 'jj-no-branch',
        createBranch: false,
      });

      expect(result.success).toBe(true);
      expect(result.actualBranchName).toBe('main');

      const bookmarkList = Bun.spawn(['jj', 'bookmark', 'list'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [listExit, listOutput] = await Promise.all([
        bookmarkList.exited,
        new Response(bookmarkList.stdout as ReadableStream).text(),
      ]);

      expect(listExit).toBe(0);
      expect(listOutput).toContain('main');
      expect(listOutput).not.toContain('jj-no-branch');

      const currentBookmarks = Bun.spawn(['jj', 'log', '-r', '@', '-T', 'bookmarks'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [logExit, logOutput] = await Promise.all([
        currentBookmarks.exited,
        new Response(currentBookmarks.stdout as ReadableStream).text(),
      ]);

      expect(logExit).toBe(0);
      expect(logOutput).not.toContain('jj-no-branch');
    } finally {
      if (originalAllowOffline === undefined) {
        delete process.env.ALLOW_OFFLINE;
      } else {
        process.env.ALLOW_OFFLINE = originalAllowOffline;
      }
    }
  });
});

describe('reuseExistingBranch', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reuse-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-reuse-remote-'));

    // Create a bare remote repository
    await runGit(remoteDir, ['init', '--bare']);

    // Initialize the workspace as a clone of the "remote"
    await initGitRepository(tempDir);
    await runGit(tempDir, ['remote', 'add', 'origin', remoteDir]);
    await runGit(tempDir, ['push', '-u', 'origin', 'main']);
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    if (remoteDir) {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test('checks out existing local branch instead of creating new one', async () => {
    // Create a branch with some work on it
    await runGit(tempDir, ['checkout', '-b', 'my-plan-branch']);
    await fs.writeFile(path.join(tempDir, 'plan-work.txt'), 'work in progress');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'Plan work']);
    await runGit(tempDir, ['checkout', 'main']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'my-plan-branch',
      createBranch: true,
      reuseExistingBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('my-plan-branch');
    expect(result.reusedExistingBranch).toBe(true);

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('my-plan-branch');

    // Verify the branch content is preserved
    const fileExists = await fs
      .access(path.join(tempDir, 'plan-work.txt'))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });

  test('creates new branch with exact name when not local and not remote', async () => {
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'brand-new-branch',
      createBranch: true,
      reuseExistingBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('brand-new-branch');
    expect(result.reusedExistingBranch).toBeFalsy();

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('brand-new-branch');
  });

  test('reuses branch when it exists only on remote', async () => {
    // Create a branch, push it to remote, then delete it locally
    await runGit(tempDir, ['checkout', '-b', 'remote-only-branch']);
    await fs.writeFile(path.join(tempDir, 'remote-work.txt'), 'remote content');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'Remote work']);
    await runGit(tempDir, ['push', '-u', 'origin', 'remote-only-branch']);
    await runGit(tempDir, ['checkout', 'main']);
    await runGit(tempDir, ['branch', '-D', 'remote-only-branch']);

    // Fetch so remote refs are available
    await runGit(tempDir, ['fetch', 'origin']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'remote-only-branch',
      createBranch: true,
      reuseExistingBranch: true,
    });

    expect(result.success).toBe(true);
    // Should reuse the remote branch since reuseExistingBranch is true
    expect(result.actualBranchName).toBe('remote-only-branch');
    expect(result.reusedExistingBranch).toBe(true);

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('remote-only-branch');
  });

  test('does not reuse branch when reuseExistingBranch is false', async () => {
    // Create a branch
    await runGit(tempDir, ['checkout', '-b', 'existing-branch']);
    await runGit(tempDir, ['checkout', 'main']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'existing-branch',
      createBranch: true,
      reuseExistingBranch: false,
    });

    expect(result.success).toBe(true);
    // Should be suffixed (old behavior) since reuseExistingBranch is false
    expect(result.actualBranchName).toBe('existing-branch-2');
  });

  test('pulls latest from remote when reusing existing branch', async () => {
    // Create a branch and push it
    await runGit(tempDir, ['checkout', '-b', 'shared-branch']);
    await fs.writeFile(path.join(tempDir, 'initial.txt'), 'initial');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'Initial on branch']);
    await runGit(tempDir, ['push', '-u', 'origin', 'shared-branch']);

    // Simulate a remote update: clone, commit, push from another clone
    const otherCloneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-other-clone-'));
    try {
      await cloneGitRepository(remoteDir, otherCloneDir);
      await runGit(otherCloneDir, ['checkout', 'shared-branch']);
      await fs.writeFile(path.join(otherCloneDir, 'remote-update.txt'), 'from remote');
      await runGit(otherCloneDir, ['add', '.']);
      await runGit(otherCloneDir, ['commit', '-m', 'Remote update']);
      await runGit(otherCloneDir, ['push', 'origin', 'shared-branch']);
    } finally {
      await fs.rm(otherCloneDir, { recursive: true, force: true });
    }

    // Go back to main so prepareExistingWorkspace can check out the branch
    await runGit(tempDir, ['checkout', 'main']);

    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'shared-branch',
      createBranch: true,
      reuseExistingBranch: true,
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('shared-branch');

    // The remote update should have been pulled
    const fileExists = await fs
      .access(path.join(tempDir, 'remote-update.txt'))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });
});

describe('findUniqueBranchName with checkRemote', () => {
  let tempDir: string;
  let remoteDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-unique-remote-test-'));
    remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-unique-remote-'));

    await runGit(remoteDir, ['init', '--bare']);
    await initGitRepository(tempDir);
    await runGit(tempDir, ['remote', 'add', 'origin', remoteDir]);
    await runGit(tempDir, ['push', '-u', 'origin', 'main']);
  });

  afterEach(async () => {
    clearAllGitCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    if (remoteDir) {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
  });

  test('returns original name when branch not on local or remote', async () => {
    const name = await findUniqueBranchName(tempDir, 'fresh-branch', false, {
      checkRemote: true,
    });
    expect(name).toBe('fresh-branch');
  });

  test('suffixes when branch exists only on remote', async () => {
    // Create and push a branch, then delete locally
    await runGit(tempDir, ['checkout', '-b', 'remote-branch']);
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'commit']);
    await runGit(tempDir, ['push', '-u', 'origin', 'remote-branch']);
    await runGit(tempDir, ['checkout', 'main']);
    await runGit(tempDir, ['branch', '-D', 'remote-branch']);
    await runGit(tempDir, ['fetch', 'origin']);

    const name = await findUniqueBranchName(tempDir, 'remote-branch', false, {
      checkRemote: true,
    });
    expect(name).toBe('remote-branch-2');
  });

  test('does not check remote when checkRemote is false', async () => {
    // Create and push a branch, then delete locally
    await runGit(tempDir, ['checkout', '-b', 'remote-branch']);
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');
    await runGit(tempDir, ['add', '.']);
    await runGit(tempDir, ['commit', '-m', 'commit']);
    await runGit(tempDir, ['push', '-u', 'origin', 'remote-branch']);
    await runGit(tempDir, ['checkout', 'main']);
    await runGit(tempDir, ['branch', '-D', 'remote-branch']);
    await runGit(tempDir, ['fetch', 'origin']);

    // Without checkRemote, it should not detect the remote branch
    const name = await findUniqueBranchName(tempDir, 'remote-branch', false);
    expect(name).toBe('remote-branch');
  });
});
