import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  captureRepositoryState,
  clearAllGitCaches,
  compareRepositoryStates,
  getGitRoot,
  hasUncommittedChanges,
  getCurrentGitBranch,
  getCurrentBranchName,
  getCurrentCommitHash,
  getCurrentJujutsuBranch,
  getGitRepository,
  getMergeBase,
  fetchRemoteBranch,
  remoteBranchExists,
  remoteBranchExistsGit,
  remoteBranchExistsJj,
  getJjChangeId,
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

async function runGitOutput(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function initGitRepository(dir: string): Promise<void> {
  await runGit(dir, ['init', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
}

async function isJjAvailable(): Promise<boolean> {
  const proc = Bun.spawn(['jj', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  return (await proc.exited) === 0;
}

async function runJj(dir: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['jj', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`jj ${args.join(' ')} failed: ${stderr.trim()}`);
  }
}

async function runJjOutput(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(['jj', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`jj ${args.join(' ')} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
}

async function initJjColocatedRepository(dir: string): Promise<void> {
  await runJj(dir, ['git', 'init', '--colocate']);
  await runJj(dir, ['config', 'set', '--repo', 'user.email', 'test@example.com']);
  await runJj(dir, ['config', 'set', '--repo', 'user.name', 'Test User']);
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
      expect(before.hasChanges).toBeFalsy();
      expect(before.statusOutput).toBeUndefined();

      await fs.writeFile(filePath, 'modified');

      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTruthy();
      expect(after.statusOutput).toContain('example.txt');
      expect(after.diffHash).toEqual(expect.any(String));

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.commitChanged).toBeFalsy();
      expect(comparison.workingTreeChanged).toBeTruthy();
      expect(comparison.hasDifferences).toBeTruthy();
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
      expect(after.hasChanges).toBeFalsy();
      expect(after.statusOutput).toBeUndefined();
      expect(after.diffHash).toBeUndefined();
      expect(comparison.commitChanged).toBeTruthy();
      expect(comparison.workingTreeChanged).toBeFalsy();
      expect(comparison.hasDifferences).toBeTruthy();
    });

    it('marks status as unavailable when repository status cannot be read', async () => {
      const state = await captureRepositoryState(tempDir);
      expect(state.statusCheckFailed).toBeTruthy();
      expect(state.hasChanges).toBeFalsy();
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
      expect(before.hasChanges).toBeTruthy();
      expect(before.statusOutput).toContain('example.txt');
      expect(before.diffHash).toEqual(expect.any(String));

      await fs.writeFile(filePath, 'second dirty state with actual edits');
      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTruthy();
      expect(after.statusOutput).toBe(before.statusOutput);
      expect(after.diffHash).not.toBe(before.diffHash);

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.commitChanged).toBeFalsy();
      expect(comparison.workingTreeChanged).toBeTruthy();
      expect(comparison.hasDifferences).toBeTruthy();
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
      expect(before.hasChanges).toBeFalsy();

      const subdir = path.join(tempDir, 'src');
      await fs.mkdir(subdir);
      await runGit(tempDir, ['mv', 'example.txt', path.join('src', 'moved.txt')]);
      await fs.rm(deletedFile);

      const after = await captureRepositoryState(tempDir);
      expect(after.hasChanges).toBeTruthy();
      expect(after.statusOutput).toEqual(expect.any(String));
      expect(after.statusOutput).toContain('->');
      expect(after.statusOutput).toContain('extra.txt');

      const comparison = compareRepositoryStates(before, after);
      expect(comparison.workingTreeChanged).toBeTruthy();
      expect(comparison.hasDifferences).toBeTruthy();

      const detection = detectPlanningWithoutImplementation(
        'Plan: reorganize files soon',
        before,
        after
      );
      expect(detection.detected).toBeFalsy();
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

  describe('merge-base and remote branch helpers', () => {
    it('computes merge-base for git repositories against origin/<baseBranch>', async () => {
      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-remote-'));
      const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-source-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initGitRepository(sourceDir);

        await fs.writeFile(path.join(sourceDir, 'file.txt'), 'base');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'base']);

        await runGit(sourceDir, ['remote', 'add', 'origin', remoteDir]);
        await runGit(sourceDir, ['push', '-u', 'origin', 'main']);
        const mainCommit = await runGitOutput(sourceDir, ['rev-parse', 'main']);

        await runGit(sourceDir, ['checkout', '-b', 'feature/base']);
        await fs.writeFile(path.join(sourceDir, 'file.txt'), 'feature');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'feature commit']);
        await runGit(sourceDir, ['push', '-u', 'origin', 'feature/base']);

        await runGit(tempDir, ['clone', remoteDir, '.']);
        await runGit(tempDir, ['checkout', 'feature/base']);

        const mergeBase = await getMergeBase(tempDir, 'main');
        expect(mergeBase).toBe(mainCommit);
      } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('returns null merge-base when base branch does not exist', async () => {
      await initGitRepository(tempDir);
      await fs.writeFile(path.join(tempDir, 'file.txt'), 'content');
      await runGit(tempDir, ['add', '.']);
      await runGit(tempDir, ['commit', '-m', 'initial']);

      const mergeBase = await getMergeBase(tempDir, 'missing-branch');
      expect(mergeBase).toBeNull();
    });

    it('fetches a specific remote branch and detects remote branch existence', async () => {
      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-remote-'));
      const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-source-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initGitRepository(sourceDir);

        await fs.writeFile(path.join(sourceDir, 'base.txt'), 'base');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'base']);
        await runGit(sourceDir, ['remote', 'add', 'origin', remoteDir]);
        await runGit(sourceDir, ['push', '-u', 'origin', 'main']);

        await runGit(tempDir, ['clone', remoteDir, '.']);
        expect(await remoteBranchExists(tempDir, 'late-branch')).toBe(false);
        expect(await remoteBranchExistsGit(tempDir, 'late-branch')).toBe(false);
        expect(await fetchRemoteBranch(tempDir, 'late-branch')).toBe(false);

        await runGit(sourceDir, ['checkout', '-b', 'late-branch']);
        await fs.writeFile(path.join(sourceDir, 'late.txt'), 'late');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'late']);
        await runGit(sourceDir, ['push', '-u', 'origin', 'late-branch']);

        expect(await remoteBranchExists(tempDir, 'late-branch')).toBe(true);
        expect(await fetchRemoteBranch(tempDir, 'late-branch')).toBe(true);
        expect(await remoteBranchExists(tempDir, 'late-branch')).toBe(true);
      } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('detects remote branch deletion even when local tracking ref still exists', async () => {
      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-remote-'));
      const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-source-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initGitRepository(sourceDir);

        await fs.writeFile(path.join(sourceDir, 'base.txt'), 'base');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'base']);
        await runGit(sourceDir, ['remote', 'add', 'origin', remoteDir]);
        await runGit(sourceDir, ['push', '-u', 'origin', 'main']);

        await runGit(sourceDir, ['checkout', '-b', 'late-branch']);
        await fs.writeFile(path.join(sourceDir, 'late.txt'), 'late');
        await runGit(sourceDir, ['add', '.']);
        await runGit(sourceDir, ['commit', '-m', 'late']);
        await runGit(sourceDir, ['push', '-u', 'origin', 'late-branch']);

        await runGit(tempDir, ['clone', remoteDir, '.']);
        expect(await fetchRemoteBranch(tempDir, 'late-branch')).toBe(true);
        expect(await remoteBranchExistsGit(tempDir, 'late-branch')).toBe(true);

        await runGit(sourceDir, ['push', 'origin', '--delete', 'late-branch']);
        await runGit(tempDir, ['rev-parse', '--verify', 'refs/remotes/origin/late-branch']);
        expect(await remoteBranchExistsGit(tempDir, 'late-branch')).toBe(false);
      } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('remoteBranchExistsGit throws on transport/auth errors', async () => {
      await initGitRepository(tempDir);
      // Point origin at a non-existent path to simulate transport failure
      await runGit(tempDir, ['remote', 'add', 'origin', '/nonexistent/remote/path']);
      await expect(remoteBranchExistsGit(tempDir, 'some-branch')).rejects.toThrow(
        /Failed to check remote branch existence/
      );
    });

    it('returns null JJ change id for git repositories', async () => {
      await initGitRepository(tempDir);
      const changeId = await getJjChangeId(tempDir);
      expect(changeId).toBeNull();
      const revisionChangeId = await getJjChangeId(tempDir, 'HEAD');
      expect(revisionChangeId).toBeNull();
    });
  });

  describe('JJ integration tests for base tracking', () => {
    beforeEach(() => {
      clearAllGitCaches();
    });

    afterEach(() => {
      clearAllGitCaches();
    });

    it('computes merge-base in JJ repositories for default and explicit source refs', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initJjColocatedRepository(tempDir);
        await runJj(tempDir, ['git', 'remote', 'add', 'origin', remoteDir]);

        await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
        await runJj(tempDir, ['commit', '-m', 'base']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'main']);
        const mainCommit = await runJjOutput(tempDir, [
          'log',
          '-r',
          'main',
          '--no-graph',
          '-T',
          'commit_id',
        ]);

        await fs.writeFile(path.join(tempDir, 'feature.txt'), 'feature');
        await runJj(tempDir, ['commit', '-m', 'feature']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'feature/base']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'feature/base']);

        const mergeBaseFromHead = await getMergeBase(tempDir, 'main');
        expect(mergeBaseFromHead).toBe(mainCommit);

        const mergeBaseFromExplicitSource = await getMergeBase(tempDir, 'main', 'feature/base');
        expect(mergeBaseFromExplicitSource).toBe(mainCommit);
      } finally {
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('returns null merge-base for a non-existent JJ base branch', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      await initJjColocatedRepository(tempDir);
      await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
      await runJj(tempDir, ['commit', '-m', 'base']);

      const mergeBase = await getMergeBase(tempDir, 'missingbase');
      expect(mergeBase).toBeNull();
    });

    it('reports existing remote JJ bookmarks', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initJjColocatedRepository(tempDir);
        await runJj(tempDir, ['git', 'remote', 'add', 'origin', remoteDir]);

        await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
        await runJj(tempDir, ['commit', '-m', 'base']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'main']);

        expect(await remoteBranchExistsJj(tempDir, 'main')).toBe(true);
      } finally {
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('reports missing remote JJ bookmarks', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initJjColocatedRepository(tempDir);
        await runJj(tempDir, ['git', 'remote', 'add', 'origin', remoteDir]);

        await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
        await runJj(tempDir, ['commit', '-m', 'base']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'main']);

        expect(await remoteBranchExistsJj(tempDir, 'nonexistent')).toBe(false);
      } finally {
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('reports deleted remote JJ bookmarks as missing', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initJjColocatedRepository(tempDir);
        await runJj(tempDir, ['git', 'remote', 'add', 'origin', remoteDir]);

        await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
        await runJj(tempDir, ['commit', '-m', 'base']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'main']);

        await fs.writeFile(path.join(tempDir, 'stacked.txt'), 'stacked');
        await runJj(tempDir, ['commit', '-m', 'stacked']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'stacked']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'stacked']);

        expect(await remoteBranchExistsJj(tempDir, 'stacked')).toBe(true);

        await runGit(tempDir, ['push', 'origin', '--delete', 'stacked']);
        expect(await remoteBranchExistsJj(tempDir, 'stacked')).toBe(false);
      } finally {
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('fetchRemoteBranch succeeds for existing JJ bookmark', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-remote-'));

      try {
        await runGit(remoteDir, ['init', '--bare']);
        await initJjColocatedRepository(tempDir);
        await runJj(tempDir, ['git', 'remote', 'add', 'origin', remoteDir]);

        await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
        await runJj(tempDir, ['commit', '-m', 'base']);
        await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);
        await runJj(tempDir, ['git', 'push', '--bookmark', 'main']);

        // fetchRemoteBranch returns true for existing bookmarks
        expect(await fetchRemoteBranch(tempDir, 'main')).toBe(true);
        // Note: jj git fetch --branch returns exit 0 even for missing bookmarks
        // (it fetches nothing), so remoteBranchExistsJj is needed for existence checks
      } finally {
        await fs.rm(remoteDir, { recursive: true, force: true });
      }
    });

    it('returns JJ change id for current revision', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      await initJjColocatedRepository(tempDir);
      await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
      await runJj(tempDir, ['commit', '-m', 'base']);

      const changeId = await getJjChangeId(tempDir);
      expect(changeId).toEqual(expect.any(String));
      expect(changeId).toMatch(/^[a-z0-9]+$/i);
    });

    it('returns JJ change id for a specific revision', async () => {
      if (!(await isJjAvailable())) {
        return;
      }

      await initJjColocatedRepository(tempDir);
      await fs.writeFile(path.join(tempDir, 'base.txt'), 'base');
      await runJj(tempDir, ['commit', '-m', 'base']);
      await runJj(tempDir, ['bookmark', 'set', '-r', '@-', 'main']);

      await fs.writeFile(path.join(tempDir, 'feature.txt'), 'feature');
      await runJj(tempDir, ['commit', '-m', 'feature']);

      const headChangeId = await getJjChangeId(tempDir);
      const baseChangeId = await getJjChangeId(tempDir, 'main');

      expect(headChangeId).toEqual(expect.any(String));
      expect(baseChangeId).toEqual(expect.any(String));
      expect(baseChangeId).not.toBe(headChangeId);
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

    it('should parse a single jj bookmark name from multi-bookmark output', async () => {
      const versionProc = Bun.spawn(['jj', '--version'], { stdout: 'pipe', stderr: 'pipe' });
      if ((await versionProc.exited) !== 0) {
        return;
      }

      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jj-current-branch-'));
      try {
        const initProc = Bun.spawn(['jj', 'git', 'init'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await initProc.exited;

        await Bun.spawn(['jj', 'config', 'set', '--repo', 'user.email', 'test@example.com'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited;
        await Bun.spawn(['jj', 'config', 'set', '--repo', 'user.name', 'Test User'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited;

        await fs.writeFile(path.join(repoDir, 'test.txt'), 'initial content');
        await Bun.spawn(['jj', 'commit', '-m', 'Initial commit'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited;
        await Bun.spawn(['jj', 'bookmark', 'set', 'main'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited;
        await Bun.spawn(['jj', 'bookmark', 'set', 'feature/test-branch'], {
          cwd: repoDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }).exited;

        const currentBranch = await getCurrentJujutsuBranch(repoDir);
        expect(currentBranch).toBe('feature/test-branch');
      } finally {
        await fs.rm(repoDir, { recursive: true, force: true });
      }
    });
  });
});
