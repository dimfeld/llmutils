import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  captureRepositoryState,
  compareRepositoryStates,
  getGitRoot,
  hasUncommittedChanges,
  getCurrentGitBranch,
  getCurrentBranchName,
  getCurrentCommitHash,
  getCurrentJujutsuBranch,
  getGitRepository,
  resetGitRepositoryCache,
  isInGitRepository,
  clearGitRootCache,
} from './git';
import { detectPlanningWithoutImplementation } from '../tim/executors/failure_detection.ts';

async function runGit(dir: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function initGitRepository(dir: string): Promise<void> {
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
}

describe('Git Utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-git-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getGitRoot', () => {
    it('should return the git root directory', async () => {
      // Initialize a git repo
      const proc = Bun.spawn(['git', 'init'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      const gitRoot = await getGitRoot(tempDir);
      expect(await fs.realpath(gitRoot!)).toBe(await fs.realpath(tempDir));
    });

    it('should handle jj workspaces', async () => {
      // Create a .jj directory
      const jjDir = path.join(tempDir, '.jj');
      await fs.mkdir(jjDir);

      const gitRoot = await getGitRoot(tempDir);
      expect(gitRoot).toBe(tempDir);
    });

    it('should return current working directory as fallback', async () => {
      const gitRoot = await getGitRoot(tempDir);
      expect(gitRoot).toBe(tempDir);
    });
  });

  describe('isInGitRepository', () => {
    beforeEach(() => {
      clearGitRootCache();
    });

    afterEach(() => {
      clearGitRootCache();
    });

    it('should return true when .git directory exists', async () => {
      // Initialize a git repo
      const proc = Bun.spawn(['git', 'init'], {
        cwd: tempDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await proc.exited;

      const result = await isInGitRepository(tempDir);
      expect(result).toBe(true);
    });

    it('should return true when .jj directory exists', async () => {
      // Create a .jj directory (simulating a Jujutsu repository)
      const jjDir = path.join(tempDir, '.jj');
      await fs.mkdir(jjDir);

      const result = await isInGitRepository(tempDir);
      expect(result).toBe(true);
    });

    it('should return false when neither .git nor .jj exists', async () => {
      // tempDir is an empty directory with no repository
      const result = await isInGitRepository(tempDir);
      expect(result).toBe(false);
    });

    it('should work with different cwd values', async () => {
      // Create a subdirectory in a git repo
      await initGitRepository(tempDir);
      const subDir = path.join(tempDir, 'subdir', 'nested');
      await fs.mkdir(subDir, { recursive: true });

      // Check from the subdirectory - should still detect the repo
      const result = await isInGitRepository(subDir);
      expect(result).toBe(true);

      // Create an entirely separate non-repo directory
      const nonRepoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-repo-'));
      try {
        const nonRepoResult = await isInGitRepository(nonRepoDir);
        expect(nonRepoResult).toBe(false);
      } finally {
        await fs.rm(nonRepoDir, { recursive: true, force: true });
      }
    });

    it('should handle .git as a file (git worktree)', async () => {
      // In git worktrees, .git is a file pointing to the main repo
      const gitFile = path.join(tempDir, '.git');
      await fs.writeFile(gitFile, 'gitdir: /path/to/main/repo/.git/worktrees/myworktree');

      const result = await isInGitRepository(tempDir);
      expect(result).toBe(true);
    });
  });

  describe('hasUncommittedChanges', () => {
    it('should return false for a clean git repository', async () => {
      // Initialize a git repo
      const initProc = Bun.spawn(['git', 'init'], { cwd: tempDir });
      await initProc.exited;

      const configEmailProc = Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await configEmailProc.exited;

      const configNameProc = Bun.spawn(['git', 'config', 'user.name', 'Test User'], {
        cwd: tempDir,
      });
      await configNameProc.exited;

      // Create a file and commit it
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'initial content');

      const addProc = Bun.spawn(['git', 'add', '.'], { cwd: tempDir });
      await addProc.exited;

      const commitProc = Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir });
      await commitProc.exited;

      const hasChanges = await hasUncommittedChanges(tempDir);
      expect(hasChanges).toBe(false);
    });

    it('should return true for uncommitted changes in working directory', async () => {
      // Initialize a git repo
      const initProc = Bun.spawn(['git', 'init'], { cwd: tempDir });
      await initProc.exited;

      const configEmailProc = Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await configEmailProc.exited;

      const configNameProc = Bun.spawn(['git', 'config', 'user.name', 'Test User'], {
        cwd: tempDir,
      });
      await configNameProc.exited;

      // Create and commit initial file
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'initial content');

      const addProc = Bun.spawn(['git', 'add', '.'], { cwd: tempDir });
      await addProc.exited;

      const commitProc = Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir });
      await commitProc.exited;

      // Make changes without committing
      await fs.writeFile(testFile, 'modified content');

      const hasChanges = await hasUncommittedChanges(tempDir);
      expect(hasChanges).toBe(true);
    });

    it('should return true for staged changes', async () => {
      // Initialize a git repo
      const initProc = Bun.spawn(['git', 'init'], { cwd: tempDir });
      await initProc.exited;

      const configEmailProc = Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await configEmailProc.exited;

      const configNameProc = Bun.spawn(['git', 'config', 'user.name', 'Test User'], {
        cwd: tempDir,
      });
      await configNameProc.exited;

      // Create and commit initial file
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'initial content');

      const addProc = Bun.spawn(['git', 'add', '.'], { cwd: tempDir });
      await addProc.exited;

      const commitProc = Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir });
      await commitProc.exited;

      // Stage a new file
      const newFile = path.join(tempDir, 'new.txt');
      await fs.writeFile(newFile, 'new content');

      const addNewProc = Bun.spawn(['git', 'add', newFile], { cwd: tempDir });
      await addNewProc.exited;

      const hasChanges = await hasUncommittedChanges(tempDir);
      expect(hasChanges).toBe(true);
    });
  });

  describe('repository state tracking', () => {
    it('captures uncommitted changes and reports working tree differences', async () => {
      await initGitRepository(tempDir);

      const filePath = path.join(tempDir, 'example.txt');
      await fs.writeFile(filePath, 'initial');

      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Initial commit']);

      const before = await captureRepositoryState(tempDir);
      expect(before.hasChanges).toBeFalse();
      expect(before.statusOutput).toBeUndefined();

      await fs.writeFile(filePath, 'modified');

      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTrue();
      expect(after.statusOutput).toContain('example.txt');
      expect(after.diffHash).toBeString();

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.commitChanged).toBeFalse();
      expect(comparison.workingTreeChanged).toBeTrue();
      expect(comparison.hasDifferences).toBeTrue();
    });

    it('detects commit hash changes without working tree diffs', async () => {
      await initGitRepository(tempDir);

      const filePath = path.join(tempDir, 'example.txt');
      await fs.writeFile(filePath, 'initial');

      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Initial commit']);

      const before = await captureRepositoryState(tempDir);
      const beforeCommit = await getCurrentCommitHash(tempDir);
      expect(beforeCommit).not.toBeNull();

      await fs.writeFile(filePath, 'updated');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Update file']);

      const after = await captureRepositoryState(tempDir);
      const afterCommit = await getCurrentCommitHash(tempDir);
      expect(afterCommit).not.toBeNull();
      expect(afterCommit).not.toBe(beforeCommit);
      const comparison = compareRepositoryStates(before, after);
      expect(after.hasChanges).toBeFalse();
      expect(after.statusOutput).toBeUndefined();
      expect(after.diffHash).toBeUndefined();
      expect(comparison.commitChanged).toBeTrue();
      expect(comparison.workingTreeChanged).toBeFalse();
      expect(comparison.hasDifferences).toBeTrue();
    });

    it('marks status as unavailable when repository status cannot be read', async () => {
      const state = await captureRepositoryState(tempDir);
      expect(state.statusCheckFailed).toBeTrue();
      expect(state.hasChanges).toBeFalse();
      expect(state.diffHash).toBeUndefined();
    });

    it('detects working tree changes when file list remains the same', async () => {
      await initGitRepository(tempDir);

      const filePath = path.join(tempDir, 'example.txt');
      await fs.writeFile(filePath, 'initial');

      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Initial commit']);

      await fs.writeFile(filePath, 'first dirty state');
      const before = await captureRepositoryState(tempDir);
      expect(before.hasChanges).toBeTrue();
      expect(before.statusOutput).toContain('example.txt');
      expect(before.diffHash).toBeString();

      await fs.writeFile(filePath, 'second dirty state with actual edits');
      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTrue();
      expect(after.statusOutput).toBe(before.statusOutput);
      expect(after.diffHash).not.toBe(before.diffHash);

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.commitChanged).toBeFalse();
      expect(comparison.workingTreeChanged).toBeTrue();
      expect(comparison.hasDifferences).toBeTrue();
    });

    it('detects renames and deletions as working tree changes', async () => {
      await initGitRepository(tempDir);

      const renamedSource = path.join(tempDir, 'example.txt');
      const deletedFile = path.join(tempDir, 'extra.txt');
      await fs.writeFile(renamedSource, 'initial');
      await fs.writeFile(deletedFile, 'remove me');

      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'Initial commit']);

      const before = await captureRepositoryState(tempDir);
      expect(before.hasChanges).toBeFalse();

      const subdir = path.join(tempDir, 'src');
      await fs.mkdir(subdir);
      await runGit(tempDir, ['mv', 'example.txt', path.join('src', 'moved.txt')]);
      await fs.rm(deletedFile);

      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTrue();
      expect(after.statusOutput).toBeString();
      expect(after.statusOutput).toContain('->');
      expect(after.statusOutput).toContain('extra.txt');

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.workingTreeChanged).toBeTrue();
      expect(comparison.hasDifferences).toBeTrue();

      const detection = detectPlanningWithoutImplementation(
        'Plan: reorganize files soon',
        before,
        after
      );
      expect(detection.detected).toBeFalse();
      expect(detection.recommendedAction).toBe('proceed');
    });
  });

  describe('getGitRepository', () => {
    beforeEach(() => {
      resetGitRepositoryCache();
    });

    afterEach(() => {
      resetGitRepositoryCache();
    });

    it('parses GitHub style remotes', async () => {
      await initGitRepository(tempDir);
      await runGit(tempDir, ['remote', 'add', 'origin', 'git@github.com:owner/repo.git']);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe('owner/repo');
    });

    it('parses SCP-style remotes without usernames', async () => {
      await initGitRepository(tempDir);
      await runGit(tempDir, ['remote', 'add', 'origin', 'example.com:owner/repo.git']);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe('owner/repo');
    });

    it('returns the repository directory name when no remote is configured', async () => {
      await initGitRepository(tempDir);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe(path.basename(tempDir));
    });

    it('falls back to repository name for filesystem remotes', async () => {
      await initGitRepository(tempDir);
      await runGit(tempDir, ['remote', 'add', 'origin', '../external/project.git']);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe('project');
    });

    it('parses HTTPS remotes with custom ports', async () => {
      await initGitRepository(tempDir);
      await runGit(tempDir, [
        'remote',
        'add',
        'origin',
        'https://github.enterprise.example.com:8443/workspace/project.git',
      ]);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe('workspace/project');
    });

    it('falls back to sanitized remote name when path information is missing', async () => {
      await initGitRepository(tempDir);
      await runGit(tempDir, ['remote', 'add', 'origin', 'ssh://example.com']);

      const repo = await getGitRepository(tempDir);
      expect(repo).toBe('example.com');
    });
  });

  describe('getCurrentGitBranch', () => {
    it('should return the current branch name', async () => {
      // Initialize a git repo and create a branch
      const initProc = Bun.spawn(['git', 'init', '-b', 'main'], { cwd: tempDir });
      await initProc.exited;

      const configEmailProc = Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await configEmailProc.exited;

      const configNameProc = Bun.spawn(['git', 'config', 'user.name', 'Test User'], {
        cwd: tempDir,
      });
      await configNameProc.exited;

      // Create initial commit
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'initial content');

      const addProc = Bun.spawn(['git', 'add', '.'], { cwd: tempDir });
      await addProc.exited;

      const commitProc = Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir });
      await commitProc.exited;

      // Create a new branch and check it out
      const branchName = 'test-branch';
      const checkoutProc = Bun.spawn(['git', 'checkout', '-b', branchName], { cwd: tempDir });
      await checkoutProc.exited;

      const currentBranch = await getCurrentGitBranch(tempDir);
      expect(currentBranch).toBe(branchName);
    });

    it('should return null when not in a Git repository', async () => {
      // Test with a directory outside the Git repository
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-git-dir-'));
      try {
        const currentBranch = await getCurrentGitBranch(tempDir);
        expect(currentBranch).toBeNull();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('getCurrentBranchName', () => {
    it('should return Git branch when available', async () => {
      // Initialize a git repo
      const initProc = Bun.spawn(['git', 'init', '-b', 'main'], { cwd: tempDir });
      await initProc.exited;

      const configEmailProc = Bun.spawn(['git', 'config', 'user.email', 'test@example.com'], {
        cwd: tempDir,
      });
      await configEmailProc.exited;

      const configNameProc = Bun.spawn(['git', 'config', 'user.name', 'Test User'], {
        cwd: tempDir,
      });
      await configNameProc.exited;

      // Create initial commit
      const testFile = path.join(tempDir, 'test.txt');
      await fs.writeFile(testFile, 'initial content');

      const addProc = Bun.spawn(['git', 'add', '.'], { cwd: tempDir });
      await addProc.exited;

      const commitProc = Bun.spawn(['git', 'commit', '-m', 'Initial commit'], { cwd: tempDir });
      await commitProc.exited;

      const currentBranch = await getCurrentBranchName(tempDir);
      expect(currentBranch).toBe('main');
    });

    it('should return null when neither Git nor Jujutsu is available', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'non-scm-dir-'));
      try {
        const currentBranch = await getCurrentBranchName(tempDir);
        expect(currentBranch).toBeNull();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
