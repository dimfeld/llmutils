import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  getFileContentAtRef,
  getDiff,
  getCurrentGitBranch,
  getCurrentBranchName,
  getCurrentJujutsuBranch,
} from './git_utils';
import * as gitUtils from './git_utils';
import { $ } from 'bun';

describe('Git Utilities', () => {
  let tmpRepoPath: string;
  let commit1Sha: string;
  let commit2Sha: string;
  let commit3Sha: string;
  let commit4Sha: string;

  beforeAll(async () => {
    tmpRepoPath = await fs.mkdtemp(path.join(tmpdir(), 'rmpr-git-utils-test-'));

    // Initialize Git repo
    await $`git init -b main`.cwd(tmpRepoPath).quiet();
    await $`git config user.email test@example.com`.cwd(tmpRepoPath).quiet();
    await $`git config user.name "Test User"`.cwd(tmpRepoPath).quiet();
    await $`git config commit.gpgsign false`.cwd(tmpRepoPath).quiet();

    // Commit 1: Add file1.txt
    await fs.writeFile(path.join(tmpRepoPath, 'file1.txt'), 'Initial content for file1\n');
    await $`git add file1.txt`.cwd(tmpRepoPath).quiet();
    await $`git commit -m "Add file1.txt"`.cwd(tmpRepoPath).quiet();
    commit1Sha = (await $`git rev-parse HEAD`.cwd(tmpRepoPath).text()).trim();

    // Commit 2: Modify file1.txt
    await fs.writeFile(path.join(tmpRepoPath, 'file1.txt'), 'Modified content for file1\n');
    await $`git add file1.txt`.cwd(tmpRepoPath).quiet();
    await $`git commit -m "Modify file1.txt"`.cwd(tmpRepoPath).quiet();
    commit2Sha = (await $`git rev-parse HEAD`.cwd(tmpRepoPath).text()).trim();

    // Commit 3: Add file2.txt (file1.txt remains as in commit2Sha)
    await fs.writeFile(path.join(tmpRepoPath, 'file2.txt'), 'Content for file2\n');
    await $`git add file2.txt`.cwd(tmpRepoPath).quiet();
    await $`git commit -m "Add file2.txt"`.cwd(tmpRepoPath).quiet();
    commit3Sha = (await $`git rev-parse HEAD`.cwd(tmpRepoPath).text()).trim();

    // Commit 4: Delete file1.txt (file2.txt remains as in commit3Sha)
    await $`git rm file1.txt`.cwd(tmpRepoPath).quiet();
    await $`git commit -m "Delete file1.txt"`.cwd(tmpRepoPath).quiet();
    commit4Sha = (await $`git rev-parse HEAD`.cwd(tmpRepoPath).text()).trim();
  });

  afterAll(async () => {
    if (tmpRepoPath) {
      await fs.rm(tmpRepoPath, { recursive: true, force: true });
    }
  });

  describe('getCurrentGitBranch', () => {
    test('should return the current branch name', async () => {
      // Create a new branch and check it out
      const branchName = 'test-branch';
      await $`git checkout -b ${branchName}`.cwd(tmpRepoPath).quiet();

      const currentBranch = await getCurrentGitBranch(tmpRepoPath);
      expect(currentBranch).toBe(branchName);
    });

    test('should return null in detached HEAD state', async () => {
      // Checkout a commit directly to simulate detached HEAD
      await $`git checkout ${commit1Sha}`.cwd(tmpRepoPath).quiet();

      const currentBranch = await getCurrentGitBranch(tmpRepoPath);
      expect(currentBranch).toBeNull();
    });

    test('should return null when not in a Git repository', async () => {
      // Test with a directory outside the Git repository
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'non-git-dir-'));
      try {
        const currentBranch = await getCurrentGitBranch(tempDir);
        expect(currentBranch).toBeNull();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('getFileContentAtRef', () => {
    test('should fetch content of an existing file at a specific commit', async () => {
      const content = await getFileContentAtRef('file1.txt', commit1Sha, tmpRepoPath);
      expect(content).toBe('Initial content for file1\n');
    });

    test('should fetch content of a modified file at a later commit', async () => {
      const content = await getFileContentAtRef('file1.txt', commit2Sha, tmpRepoPath);
      expect(content).toBe('Modified content for file1\n');
    });

    test('should fetch content of a newly added file', async () => {
      const content = await getFileContentAtRef('file2.txt', commit3Sha, tmpRepoPath);
      expect(content).toBe('Content for file2\n');
    });

    test('should throw an error when fetching a non-existent file', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(getFileContentAtRef('nonexistent.txt', commit1Sha, tmpRepoPath)).rejects.toThrow(
        new RegExp(
          `Failed to get file content for 'nonexistent\\.txt' at ref '${commit1Sha}'\\. ` +
            `Git command: 'git show ${commit1Sha}:nonexistent\\.txt' \\(cwd: .+\\)\\. Exit code: 128\\. ` +
            `Stderr: fatal: path 'nonexistent\\.txt' does not exist in '${commit1Sha}'`
        )
      );
    });

    test('should throw an error when fetching a deleted file at a commit after its deletion', async () => {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(getFileContentAtRef('file1.txt', commit4Sha, tmpRepoPath)).rejects.toThrow(
        new RegExp(
          `Failed to get file content for 'file1\\.txt' at ref '${commit4Sha}'\\. ` +
            `Git command: 'git show ${commit4Sha}:file1\\.txt' \\(cwd: .+\\)\\. Exit code: 128\\. ` +
            `Stderr: fatal: path 'file1\\.txt' (exists on disk, but not in|does not exist in) '${commit4Sha}'`
        )
      );
    });

    test('should fetch content of a file using "HEAD" as ref', async () => {
      // Checkout back to main branch where file2.txt exists
      await $`git checkout main`.cwd(tmpRepoPath).quiet();
      const content = await getFileContentAtRef('file2.txt', 'HEAD', tmpRepoPath);
      expect(content).toBe('Content for file2\n');
    });

    test('should fetch content of a file using a branch name as ref (main)', async () => {
      const content = await getFileContentAtRef('file2.txt', 'main', tmpRepoPath);
      expect(content).toBe('Content for file2\n');
    });
  });

  describe('getCurrentCommitSha', () => {
    test('should return the current commit SHA when in a Git repository', async () => {
      // Get the current commit SHA using git command for comparison
      const expectedSha = (await $`git rev-parse HEAD`.cwd(tmpRepoPath).text()).trim();

      const sha = await gitUtils.getCurrentCommitSha(tmpRepoPath);
      expect(sha).toBe(expectedSha);
    });

    test('should return null when not in a Git repository', async () => {
      // Test with a temporary directory that's not a Git repository
      const tempDir = await fs.mkdtemp(path.join(tmpdir(), 'non-git-dir-'));
      try {
        const sha = await gitUtils.getCurrentCommitSha(tempDir);
        expect(sha).toBeNull();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('getDiff', () => {
    test('should get a diff for a modified file', async () => {
      const diff = await getDiff('file1.txt', commit1Sha, commit2Sha, tmpRepoPath);
      expect(diff).toMatch(
        new RegExp(
          `^diff --git a\\/file1\\.txt b\\/file1\\.txt\\nindex [0-9a-f]+\\.\\.[0-9a-f]+ \\d+\\n--- a\\/file1\\.txt\\n\\+\\+\\+ b\\/file1\\.txt\\n@@ -1 \\+1 @@\\n-Initial content for file1\\n\\+Modified content for file1$`,
          'm'
        )
      );
    });

    test('should get a diff for an added file', async () => {
      const diff = await getDiff('file2.txt', commit2Sha, commit3Sha, tmpRepoPath);
      expect(diff).toMatch(
        new RegExp(
          `^diff --git a\\/file2\\.txt b\\/file2\\.txt\\nnew file mode \\d+\\nindex 0000000\\.\\.[0-9a-f]+\\n--- \\/dev\\/null\\n\\+\\+\\+ b\\/file2\\.txt\\n@@ -0,0 \\+1 @@\\n\\+Content for file2$`,
          'm'
        )
      );
    });

    test('should get a diff for a deleted file', async () => {
      const diff = await getDiff('file1.txt', commit3Sha, commit4Sha, tmpRepoPath);
      expect(diff).toMatch(
        new RegExp(
          `^diff --git a\\/file1\\.txt b\\/file1\\.txt\\ndeleted file mode \\d+\\nindex [0-9a-f]+\\.\\.0000000\\n--- a\\/file1\\.txt\\n\\+\\+\\+ \\/dev\\/null\\n@@ -1 \\+0,0 @@\\n-Modified content for file1$`,
          'm'
        )
      );
    });

    test('should return an empty string for an unchanged file between two refs', async () => {
      const diff = await getDiff('file2.txt', commit3Sha, commit4Sha, tmpRepoPath);
      expect(diff).toBe('');
    });

    test('should return an empty string for a file diffed against the same ref', async () => {
      const diff = await getDiff('file1.txt', commit1Sha, commit1Sha, tmpRepoPath);
      expect(diff).toBe('');
    });

    test('should throw an error if one of the refs is invalid for diff', async () => {
      const invalidRef = 'nonexistentref';
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(getDiff('file1.txt', invalidRef, commit2Sha, tmpRepoPath)).rejects.toThrow(
        new RegExp(
          `Failed to get diff for 'file1\\.txt' between '${invalidRef}' and '${commit2Sha}'\\. ` +
            `Git command: 'git diff --patch ${invalidRef}\\.\\.${commit2Sha} -- file1\\.txt' \\(cwd: .+\\)\\. Exit code: 128\\. ` +
            `Stderr: fatal: bad revision '${invalidRef}\\.\\.${commit2Sha}'`
        )
      );
    });

    test('should get a diff for a file that does not exist in baseRef but exists in headRef (overall addition)', async () => {
      const diff = await getDiff('file2.txt', commit1Sha, commit3Sha, tmpRepoPath);
      expect(diff).toMatch(
        new RegExp(
          `^diff --git a\\/file2\\.txt b\\/file2\\.txt\\nnew file mode \\d+\\nindex 0000000\\.\\.[0-9a-f]+\\n--- \\/dev\\/null\\n\\+\\+\\+ b\\/file2\\.txt\\n@@ -0,0 \\+1 @@\\n\\+Content for file2$`,
          'm'
        )
      );
    });

    test('should get a diff for a file that exists in baseRef but not in headRef (overall deletion)', async () => {
      const diff = await getDiff('file1.txt', commit1Sha, commit4Sha, tmpRepoPath);
      expect(diff).toMatch(
        new RegExp(
          `^diff --git a\\/file1\\.txt b\\/file1\\.txt\\ndeleted file mode \\d+\\nindex [0-9a-f]+\\.\\.0000000\\n--- a\\/file1\\.txt\\n\\+\\+\\+ \\/dev\\/null\\n@@ -1 \\+0,0 @@\\n-Initial content for file1$`,
          'm'
        )
      );
    });
  });
});
