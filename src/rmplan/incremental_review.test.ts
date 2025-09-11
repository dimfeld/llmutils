import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { $ } from 'bun';
import {
  storeLastReviewMetadata,
  getLastReviewMetadata,
  calculateDiffRange,
  filterFilesByModificationTime,
  getIncrementalDiff,
  type IncrementalReviewMetadata,
} from './incremental_review.js';

describe.skipIf(!process.env.SLOW_TESTS)('incremental_review', () => {
  let tempDir: string;
  let testRepoDir: string;
  let jjAvailable: boolean;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'incremental-review-test-'));
    testRepoDir = join(tempDir, 'test-repo');

    // Check if jj is available
    try {
      await $`jj --version`.quiet().nothrow();
      jjAvailable = true;
    } catch {
      jjAvailable = false;
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  async function initGitRepo(repoDir: string) {
    await $`mkdir -p ${repoDir}`.quiet();
    await $`git init`.cwd(repoDir).quiet();
    await $`git config user.email "test@example.com"`.cwd(repoDir).quiet();
    await $`git config user.name "Test User"`.cwd(repoDir).quiet();
  }

  async function initJjRepo(repoDir: string) {
    await $`mkdir -p ${repoDir}`.quiet();
    await $`git init`.cwd(repoDir).quiet();
    await $`git config user.email "test@example.com"`.cwd(repoDir).quiet();
    await $`git config user.name "Test User"`.cwd(repoDir).quiet();
    await $`jj git init --colocate`.cwd(repoDir).quiet().nothrow();
    await $`jj config set --repo user.email "test@example.com"`.cwd(repoDir).quiet().nothrow();
    await $`jj config set --repo user.name "Test User"`.cwd(repoDir).quiet().nothrow();
  }

  async function createCommit(
    repoDir: string,
    filename: string,
    content: string,
    message: string,
    useJj = false
  ) {
    await writeFile(join(repoDir, filename), content);
    if (useJj) {
      await $`jj commit -m "${message}"`.cwd(repoDir).quiet().nothrow();
    } else {
      await $`git add ${filename}`.cwd(repoDir).quiet();
      await $`git commit -m "${message}"`.cwd(repoDir).quiet();
    }
  }

  async function getCurrentCommitHash(repoDir: string, useJj = false): Promise<string> {
    if (useJj) {
      const result = await $`jj log -r @ --no-graph -T commit_id`.cwd(repoDir).quiet();
      return result.stdout.toString().trim();
    } else {
      const result = await $`git rev-parse HEAD`.cwd(repoDir).quiet();
      return result.stdout.toString().trim();
    }
  }

  describe('storeLastReviewMetadata and getLastReviewMetadata', () => {
    test('should store and retrieve metadata for Git repository', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'test.txt', 'initial content', 'Initial commit');

      const commitHash = await getCurrentCommitHash(testRepoDir);
      const metadata: IncrementalReviewMetadata = {
        lastReviewCommit: commitHash,
        lastReviewTimestamp: new Date(),
        planId: 'test-plan-1',
        baseBranch: 'main',
      };

      await storeLastReviewMetadata(testRepoDir, 'test-plan-1', metadata);
      const retrieved = await getLastReviewMetadata(testRepoDir, 'test-plan-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.lastReviewCommit).toBe(commitHash);
      expect(retrieved!.planId).toBe('test-plan-1');
      expect(retrieved!.baseBranch).toBe('main');
    });

    test('should store and retrieve metadata for jj repository', async () => {
      if (!jjAvailable) {
        console.log('Skipping jj test: jj not available');
        return;
      }

      await initJjRepo(testRepoDir);
      await createCommit(testRepoDir, 'test.txt', 'initial content', 'Initial commit', true);

      const commitHash = await getCurrentCommitHash(testRepoDir, true);
      const metadata: IncrementalReviewMetadata = {
        lastReviewCommit: commitHash,
        lastReviewTimestamp: new Date(),
        planId: 'test-plan-jj',
        baseBranch: 'main',
      };

      await storeLastReviewMetadata(testRepoDir, 'test-plan-jj', metadata);
      const retrieved = await getLastReviewMetadata(testRepoDir, 'test-plan-jj');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.lastReviewCommit).toBe(commitHash);
      expect(retrieved!.planId).toBe('test-plan-jj');
    });

    test('should return null for non-existent metadata', async () => {
      await initGitRepo(testRepoDir);
      const retrieved = await getLastReviewMetadata(testRepoDir, 'non-existent-plan');
      expect(retrieved).toBeNull();
    });

    test('should handle multiple plans independently', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'test.txt', 'initial content', 'Initial commit');

      const commitHash = await getCurrentCommitHash(testRepoDir);
      const metadata1: IncrementalReviewMetadata = {
        lastReviewCommit: commitHash,
        lastReviewTimestamp: new Date(),
        planId: 'plan-1',
        baseBranch: 'main',
      };

      const metadata2: IncrementalReviewMetadata = {
        lastReviewCommit: commitHash,
        lastReviewTimestamp: new Date(),
        planId: 'plan-2',
        baseBranch: 'develop',
      };

      await storeLastReviewMetadata(testRepoDir, 'plan-1', metadata1);
      await storeLastReviewMetadata(testRepoDir, 'plan-2', metadata2);

      const retrieved1 = await getLastReviewMetadata(testRepoDir, 'plan-1');
      const retrieved2 = await getLastReviewMetadata(testRepoDir, 'plan-2');

      expect(retrieved1!.planId).toBe('plan-1');
      expect(retrieved1!.baseBranch).toBe('main');
      expect(retrieved2!.planId).toBe('plan-2');
      expect(retrieved2!.baseBranch).toBe('develop');
    });
  });

  describe('calculateDiffRange', () => {
    test('should calculate diff range for Git repository', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'content 1', 'First commit');
      const firstCommit = await getCurrentCommitHash(testRepoDir);

      await createCommit(testRepoDir, 'file2.txt', 'content 2', 'Second commit');
      await createCommit(testRepoDir, 'file3.txt', 'content 3', 'Third commit');

      const range = await calculateDiffRange(testRepoDir, firstCommit);
      expect(range.fromCommit).toBe(firstCommit);
      expect(range.toCommit).toBe(await getCurrentCommitHash(testRepoDir));
      expect(range.usingJj).toBe(false);
    });

    test('should calculate diff range for jj repository', async () => {
      if (!jjAvailable) {
        console.log('Skipping jj test: jj not available');
        return;
      }

      await initJjRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'content 1', 'First commit', true);
      const firstCommit = await getCurrentCommitHash(testRepoDir, true);

      await createCommit(testRepoDir, 'file2.txt', 'content 2', 'Second commit', true);

      const range = await calculateDiffRange(testRepoDir, firstCommit);
      expect(range.fromCommit).toBe(firstCommit);
      expect(range.toCommit).toBe(await getCurrentCommitHash(testRepoDir, true));
      expect(range.usingJj).toBe(true);
    });
  });

  describe('filterFilesByModificationTime', () => {
    test('should filter files modified since given timestamp', async () => {
      await initGitRepo(testRepoDir);

      // Create initial files
      await createCommit(testRepoDir, 'old-file.txt', 'old content', 'Old commit');
      const oldTimestamp = new Date();

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 1000));

      await createCommit(testRepoDir, 'new-file.txt', 'new content', 'New commit');
      await createCommit(
        testRepoDir,
        'another-new.txt',
        'another new content',
        'Another new commit'
      );

      const changedFiles = ['old-file.txt', 'new-file.txt', 'another-new.txt'];
      const filteredFiles = await filterFilesByModificationTime(
        testRepoDir,
        changedFiles,
        oldTimestamp
      );

      // Should only include files modified after the timestamp
      expect(filteredFiles).toContain('new-file.txt');
      expect(filteredFiles).toContain('another-new.txt');
      expect(filteredFiles).not.toContain('old-file.txt');
    });

    test('should return all files if timestamp is very old', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'content 1', 'Commit 1');
      await createCommit(testRepoDir, 'file2.txt', 'content 2', 'Commit 2');

      const veryOldTimestamp = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
      const changedFiles = ['file1.txt', 'file2.txt'];
      const filteredFiles = await filterFilesByModificationTime(
        testRepoDir,
        changedFiles,
        veryOldTimestamp
      );

      expect(filteredFiles).toEqual(changedFiles);
    });

    test('should handle non-existent files gracefully', async () => {
      await initGitRepo(testRepoDir);
      const timestamp = new Date();
      const changedFiles = ['non-existent.txt', 'another-missing.txt'];

      const filteredFiles = await filterFilesByModificationTime(
        testRepoDir,
        changedFiles,
        timestamp
      );
      expect(filteredFiles).toEqual([]);
    });
  });

  describe('getIncrementalDiff', () => {
    test('should get incremental diff for Git repository', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'initial content', 'Initial commit');
      const initialCommit = await getCurrentCommitHash(testRepoDir);

      await createCommit(testRepoDir, 'file2.txt', 'new content', 'Add new file');
      await writeFile(join(testRepoDir, 'file1.txt'), 'modified content');
      await $`git add file1.txt`.cwd(testRepoDir).quiet();
      await $`git commit -m "Modify existing file"`.cwd(testRepoDir).quiet();

      const diff = await getIncrementalDiff(testRepoDir, initialCommit, 'main');

      expect(diff.hasChanges).toBe(true);
      expect(diff.changedFiles).toContain('file2.txt');
      expect(diff.changedFiles).toContain('file1.txt');
      expect(diff.baseBranch).toBe('main');
      expect(diff.diffContent).toContain('new content');
      expect(diff.diffContent).toContain('modified content');
    });

    test('should get incremental diff for jj repository', async () => {
      if (!jjAvailable) {
        console.log('Skipping jj test: jj not available');
        return;
      }

      await initJjRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'initial content', 'Initial commit', true);
      const initialCommit = await getCurrentCommitHash(testRepoDir, true);

      await createCommit(testRepoDir, 'file2.txt', 'new content', 'Add new file', true);

      const diff = await getIncrementalDiff(testRepoDir, initialCommit, 'main');

      expect(diff.hasChanges).toBe(true);
      expect(diff.changedFiles).toContain('file2.txt');
      expect(diff.baseBranch).toBe('main');
      expect(diff.diffContent).toContain('new content');
    });

    test('should return no changes when comparing commit to itself', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'content', 'Single commit');
      const commit = await getCurrentCommitHash(testRepoDir);

      const diff = await getIncrementalDiff(testRepoDir, commit, 'main');

      expect(diff.hasChanges).toBe(false);
      expect(diff.changedFiles).toEqual([]);
    });

    test('should handle invalid commit hash gracefully', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'file1.txt', 'content', 'Single commit');

      await expect(
        getIncrementalDiff(testRepoDir, 'invalid-commit-hash', 'main')
      ).rejects.toThrow();
    });
  });

  describe('edge cases and error handling', () => {
    test('should handle corrupted metadata file gracefully', async () => {
      await initGitRepo(testRepoDir);

      // Create corrupt metadata file
      const metadataDir = join(testRepoDir, '.rmfilter', 'reviews');
      await $`mkdir -p ${metadataDir}`.quiet();
      await writeFile(join(metadataDir, 'incremental_metadata.json'), 'invalid json {');

      const retrieved = await getLastReviewMetadata(testRepoDir, 'test-plan');
      expect(retrieved).toBeNull();
    });

    test('should handle missing .rmfilter directory', async () => {
      await initGitRepo(testRepoDir);
      const retrieved = await getLastReviewMetadata(testRepoDir, 'test-plan');
      expect(retrieved).toBeNull();
    });

    test('should create necessary directories when storing metadata', async () => {
      await initGitRepo(testRepoDir);
      await createCommit(testRepoDir, 'test.txt', 'content', 'Initial commit');

      const commitHash = await getCurrentCommitHash(testRepoDir);
      const metadata: IncrementalReviewMetadata = {
        lastReviewCommit: commitHash,
        lastReviewTimestamp: new Date(),
        planId: 'test-plan',
        baseBranch: 'main',
      };

      // Should not throw even when directories don't exist
      try {
        await storeLastReviewMetadata(testRepoDir, 'test-plan', metadata);
      } catch (error) {
        console.error('Error in storeLastReviewMetadata:', error);
        throw error;
      }

      // Should be retrievable
      const retrieved = await getLastReviewMetadata(testRepoDir, 'test-plan');
      expect(retrieved).not.toBeNull();
    });
  });
});
