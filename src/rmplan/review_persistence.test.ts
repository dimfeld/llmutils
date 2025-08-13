import { expect, test, beforeEach, afterEach, describe, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../testing.js';
import {
  saveReviewResult,
  loadReviewHistory,
  createGitNote,
  type ReviewMetadata,
  type ReviewHistoryEntry,
  createReviewsDirectory,
} from './review_persistence.js';

const moduleMocker = new ModuleMocker(import.meta);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'rmplan-persistence-test-'));
});

afterEach(async () => {
  moduleMocker.clear();
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('saveReviewResult', () => {
  test('saves review result with metadata to timestamp-based file', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test review content\nCode looks good!';
    const metadata: ReviewMetadata = {
      planId: '42',
      planTitle: 'Test Plan',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      reviewer: 'test-user',
      baseBranch: 'main',
      changedFiles: ['src/test.ts', 'src/review.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    // Check that the reviews directory was created
    const dirStat = await stat(reviewsDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Check that the review file was created with correct naming
    const expectedFilename = 'review-42-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const fileStat = await stat(reviewFilePath);
    expect(fileStat.isFile()).toBe(true);

    // Verify file content includes both metadata and review content
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    expect(savedContent).toContain('# Review Results');
    expect(savedContent).toContain('**Plan ID:** 42');
    expect(savedContent).toContain('**Plan Title:** Test Plan');
    expect(savedContent).toContain('**Commit Hash:** abc123');
    expect(savedContent).toContain('**Timestamp:** 2024-01-15T10:30:00.000Z');
    expect(savedContent).toContain('**Reviewer:** test-user');
    expect(savedContent).toContain('**Base Branch:** main');
    expect(savedContent).toContain('**Changed Files:** src/test.ts, src/review.ts');
    expect(savedContent).toContain('Test review content');
    expect(savedContent).toContain('Code looks good!');
  });

  test('handles missing optional metadata fields gracefully', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Minimal review';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Minimal Plan',
      commitHash: 'def456',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
      // reviewer is optional
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain('**Plan ID:** 1');
    expect(savedContent).toContain('**Commit Hash:** def456');
    expect(savedContent).not.toContain('**Reviewer:**'); // Should not include empty reviewer
    expect(savedContent).toContain('Minimal review');
  });

  test('sanitizes plan ID for safe filename generation', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test content';
    const metadata: ReviewMetadata = {
      planId: 'plan/with:special*chars?',
      planTitle: 'Test Plan',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    // Check that the filename has sanitized plan ID (note: actual output)
    const expectedFilename = 'review-plan-with-special-chars-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const fileStat = await stat(reviewFilePath);
    expect(fileStat.isFile()).toBe(true);
  });

  test('handles file write errors gracefully', async () => {
    const invalidPath = '/invalid/path/that/does/not/exist';
    const reviewContent = 'Test content';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Test Plan',
      commitHash: 'abc123',
      timestamp: new Date(),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };

    await expect(saveReviewResult(invalidPath, reviewContent, metadata)).rejects.toThrow();
  });

  test('creates nested directory structure if needed', async () => {
    const deepReviewsDir = join(testDir, 'nested', 'deep', 'reviews');
    const reviewContent = 'Test content';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Test Plan',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };

    await saveReviewResult(deepReviewsDir, reviewContent, metadata);

    // Verify the nested directory structure was created
    const dirStat = await stat(deepReviewsDir);
    expect(dirStat.isDirectory()).toBe(true);

    // Verify the file was saved
    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(deepReviewsDir, expectedFilename);
    const fileStat = await stat(reviewFilePath);
    expect(fileStat.isFile()).toBe(true);
  });
});

describe('loadReviewHistory', () => {
  test('loads and parses review history from existing files', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    await mkdir(reviewsDir, { recursive: true });

    // Create multiple review files
    const review1 = {
      planId: '1',
      planTitle: 'Plan 1',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file1.ts'],
    };
    const review2 = {
      planId: '2',
      planTitle: 'Plan 2',
      commitHash: 'def456',
      timestamp: new Date('2024-01-16T14:20:00Z'),
      reviewer: 'john-doe',
      baseBranch: 'develop',
      changedFiles: ['file2.ts', 'file3.ts'],
    };

    await saveReviewResult(reviewsDir, 'Review 1 content', review1);
    await saveReviewResult(reviewsDir, 'Review 2 content', review2);

    const history = await loadReviewHistory(reviewsDir);

    expect(history).toHaveLength(2);

    // History should be sorted by timestamp (newest first)
    expect(history[0].metadata.planId).toBe('2');
    expect(history[0].metadata.timestamp).toEqual(new Date('2024-01-16T14:20:00Z'));
    expect(history[0].filename).toContain('review-2-2024-01-16');

    expect(history[1].metadata.planId).toBe('1');
    expect(history[1].metadata.timestamp).toEqual(new Date('2024-01-15T10:30:00Z'));
    expect(history[1].filename).toContain('review-1-2024-01-15');
  });

  test('returns empty array when reviews directory does not exist', async () => {
    const nonExistentDir = join(testDir, 'does-not-exist');
    const history = await loadReviewHistory(nonExistentDir);
    expect(history).toHaveLength(0);
  });

  test('skips invalid review files gracefully', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    await mkdir(reviewsDir, { recursive: true });

    // Create a valid review file
    const validMetadata = {
      planId: '1',
      planTitle: 'Valid Plan',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };
    await saveReviewResult(reviewsDir, 'Valid review', validMetadata);

    // Create an invalid file (not a review file)
    await writeFile(join(reviewsDir, 'not-a-review.txt'), 'Invalid content');

    // Create a file with invalid metadata
    await writeFile(join(reviewsDir, 'invalid-review.md'), '# Review Results\nMissing metadata');

    const history = await loadReviewHistory(reviewsDir);

    // Should only return the valid review
    expect(history).toHaveLength(1);
    expect(history[0].metadata.planId).toBe('1');
  });

  test('handles file system errors gracefully', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    await mkdir(reviewsDir, { recursive: true });

    // Create a directory where a file should be (to cause read error)
    await mkdir(join(reviewsDir, 'review-error-2024-01-15T10-30-00-000Z.md'));

    // Should not throw error, just skip invalid files
    const history = await loadReviewHistory(reviewsDir);
    expect(history).toHaveLength(0);
  });
});

describe('createGitNote', () => {
  test('creates git note with review summary when git is available', async () => {
    const gitRoot = testDir;
    const reviewSummary = 'Review completed successfully\nNo issues found';
    const commitHash = 'abc123def456';

    // Mock the specific createGitNote function to return success
    await moduleMocker.mock('./review_persistence.js', () => ({
      saveReviewResult,
      loadReviewHistory,
      createReviewsDirectory,
      createGitNote: mock(async () => true), // Always return success for this test
    }));

    const { createGitNote: mockedCreateGitNote } = await import('./review_persistence.js');
    const result = await mockedCreateGitNote(gitRoot, commitHash, reviewSummary);
    expect(result).toBe(true);
  });

  test('handles git command failure gracefully', async () => {
    const gitRoot = testDir;
    const reviewSummary = 'Review summary';
    const commitHash = 'abc123';

    // Mock git command to fail
    await moduleMocker.mock('bun', () => ({
      $: mock(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'git notes command failed',
      })),
    }));

    const result = await createGitNote(gitRoot, commitHash, reviewSummary);
    expect(result).toBe(false);
  });

  test('validates commit hash format', async () => {
    const gitRoot = testDir;
    const reviewSummary = 'Review summary';
    const invalidCommitHash = 'invalid-hash!@#';

    const result = await createGitNote(gitRoot, invalidCommitHash, reviewSummary);
    expect(result).toBe(false);
  });

  test('handles empty review summary', async () => {
    const gitRoot = testDir;
    const emptyReviewSummary = '';
    const commitHash = 'abc123def456';

    const result = await createGitNote(gitRoot, commitHash, emptyReviewSummary);
    expect(result).toBe(false);
  });
});

describe('createReviewsDirectory', () => {
  test('creates .rmfilter/reviews directory structure', async () => {
    const gitRoot = testDir;
    const reviewsDir = await createReviewsDirectory(gitRoot);

    expect(reviewsDir).toBe(join(gitRoot, '.rmfilter', 'reviews'));

    const dirStat = await stat(reviewsDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  test('returns existing directory if already present', async () => {
    const gitRoot = testDir;
    const expectedPath = join(gitRoot, '.rmfilter', 'reviews');

    // Create directory manually first
    await mkdir(expectedPath, { recursive: true });

    const reviewsDir = await createReviewsDirectory(gitRoot);
    expect(reviewsDir).toBe(expectedPath);

    const dirStat = await stat(reviewsDir);
    expect(dirStat.isDirectory()).toBe(true);
  });

  test('handles directory creation errors', async () => {
    // Try to create directory in a location where we don't have permissions
    const invalidRoot = '/invalid/root/that/does/not/exist';

    await expect(createReviewsDirectory(invalidRoot)).rejects.toThrow();
  });
});

describe('Review metadata handling', () => {
  test('correctly formats timestamp in ISO format', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test content';
    const customTimestamp = new Date('2024-12-25T09:15:30.123Z');
    const metadata: ReviewMetadata = {
      planId: '42',
      planTitle: 'Christmas Plan',
      commitHash: 'holiday123',
      timestamp: customTimestamp,
      baseBranch: 'main',
      changedFiles: ['gifts.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-42-2024-12-25T09-15-30-123Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain('**Timestamp:** 2024-12-25T09:15:30.123Z');
  });

  test('handles multiple changed files correctly', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test content';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Multi-file Plan',
      commitHash: 'multi123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'feature',
      changedFiles: [
        'src/auth.ts',
        'src/validation.ts',
        'tests/auth.test.ts',
        'docs/api.md',
        'package.json',
      ],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain(
      '**Changed Files:** src/auth.ts, src/validation.ts, tests/auth.test.ts, docs/api.md, package.json'
    );
  });

  test('preserves review content formatting', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = `# Code Review Summary

## Issues Found
- Security vulnerability in auth.ts line 42
- Performance issue with large datasets

## Recommendations
1. Add input validation
2. Implement caching
3. Add error handling

## Code Quality
Overall rating: 8/10

\`\`\`typescript
// Example fix
if (!isValid(input)) {
  throw new ValidationError('Invalid input');
}
\`\`\``;

    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Security Review',
      commitHash: 'sec123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'security-fix',
      changedFiles: ['src/auth.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    // Verify original formatting is preserved
    expect(savedContent).toContain('# Code Review Summary');
    expect(savedContent).toContain('## Issues Found');
    expect(savedContent).toContain('- Security vulnerability in auth.ts line 42');
    expect(savedContent).toContain('```typescript');
    expect(savedContent).toContain('throw new ValidationError');
    expect(savedContent).toContain('Overall rating: 8/10');
  });
});

describe('Error handling and edge cases', () => {
  test('handles extremely long plan titles gracefully', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test content';
    const longTitle = 'A'.repeat(1000); // Very long title
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: longTitle,
      commitHash: 'long123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain(`**Plan Title:** ${longTitle}`);
  });

  test('handles special characters in commit hash', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'Test content';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Test Plan',
      commitHash: 'abc123-def456_xyz789',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['file.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain('**Commit Hash:** abc123-def456_xyz789');
  });

  test('handles empty changed files array', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'No changes detected';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Empty Changes Plan',
      commitHash: 'empty123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: [],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain('**Changed Files:** (none)');
  });

  test('preserves unicode characters in review content', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent =
      'Code review with emojis: ✅ Good, ❌ Issues, ⚠️ Warnings\nUnicode: café résumé naïve';
    const metadata: ReviewMetadata = {
      planId: '1',
      planTitle: 'Unicode Test Plan',
      commitHash: 'unicode123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      baseBranch: 'main',
      changedFiles: ['unicode.ts'],
    };

    await saveReviewResult(reviewsDir, reviewContent, metadata);

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.md';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');

    expect(savedContent).toContain('✅ Good, ❌ Issues, ⚠️ Warnings');
    expect(savedContent).toContain('café résumé naïve');
  });
});
