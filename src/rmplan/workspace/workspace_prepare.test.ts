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
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('test-branch-999-2');
  });

  test('handles branch creation failure with invalid branch name', async () => {
    // Git rejects branch names starting with '-' (looks like an option)
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: '-invalid-branch',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to create branch');
    expect(result.error).toContain('-invalid-branch');
  });

  test('successfully works with default trunk branch detection', async () => {
    // Just use the default - should detect 'main'
    const result = await prepareExistingWorkspace(tempDir, {
      branchName: 'auto-trunk-branch',
    });

    expect(result.success).toBe(true);
    expect(result.actualBranchName).toBe('auto-trunk-branch');

    const currentBranch = await getCurrentBranch(tempDir);
    expect(currentBranch).toBe('auto-trunk-branch');
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
      expect(logOutput).toContain('main');
    } finally {
      if (originalAllowOffline === undefined) {
        delete process.env.ALLOW_OFFLINE;
      } else {
        process.env.ALLOW_OFFLINE = originalAllowOffline;
      }
    }
  });
});
