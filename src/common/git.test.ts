import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import {
  getGitRoot,
  hasUncommittedChanges,
  getCurrentGitBranch,
  getCurrentBranchName,
  getCurrentJujutsuBranch,
} from './git';

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
