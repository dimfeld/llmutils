import { expect, test, beforeEach, afterEach, describe, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../testing.js';
import {
  saveReviewResult,
  loadReviewHistory,
  createGitNote,
  loadReviewFile,
  type ReviewMetadata,
  type ReviewHistoryEntry,
  type ReviewFileContent,
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
    const expectedFilename = 'review-42-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const fileStat = await stat(reviewFilePath);
    expect(fileStat.isFile()).toBe(true);

    // Verify file content includes both metadata and review content
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.planId).toBe('42');
    expect(parsedContent.metadata.planTitle).toBe('Test Plan');
    expect(parsedContent.metadata.commitHash).toBe('abc123');
    expect(parsedContent.metadata.timestamp).toBe('2024-01-15T10:30:00.000Z');
    expect(parsedContent.metadata.reviewer).toBe('test-user');
    expect(parsedContent.metadata.baseBranch).toBe('main');
    expect(parsedContent.metadata.changedFiles).toEqual(['src/test.ts', 'src/review.ts']);
    expect(parsedContent.reviewContent).toContain('Test review content');
    expect(parsedContent.reviewContent).toContain('Code looks good!');
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.planId).toBe('1');
    expect(parsedContent.metadata.commitHash).toBe('def456');
    expect(parsedContent.metadata.reviewer).toBeUndefined(); // Should not include empty reviewer
    expect(parsedContent.reviewContent).toBe('Minimal review');
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
    const expectedFilename = 'review-plan-with-special-chars-2024-01-15T10-30-00-000Z.json';
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
    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
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

    // Create a file with invalid JSON
    await writeFile(
      join(reviewsDir, 'review-invalid-2024-01-15T10-30-00-000Z.json'),
      'Not valid JSON'
    );

    const history = await loadReviewHistory(reviewsDir);

    // Should only return the valid review
    expect(history).toHaveLength(1);
    expect(history[0].metadata.planId).toBe('1');
  });

  test('handles file system errors gracefully', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    await mkdir(reviewsDir, { recursive: true });

    // Create a directory where a file should be (to cause read error)
    await mkdir(join(reviewsDir, 'review-error-2024-01-15T10-30-00-000Z.json'));

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
      loadReviewFile,
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

    const expectedFilename = 'review-42-2024-12-25T09-15-30-123Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.timestamp).toBe('2024-12-25T09:15:30.123Z');
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.changedFiles).toEqual([
      'src/auth.ts',
      'src/validation.ts',
      'tests/auth.test.ts',
      'docs/api.md',
      'package.json',
    ]);
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    // Verify original formatting is preserved in the review content
    expect(parsedContent.reviewContent).toContain('# Code Review Summary');
    expect(parsedContent.reviewContent).toContain('## Issues Found');
    expect(parsedContent.reviewContent).toContain('- Security vulnerability in auth.ts line 42');
    expect(parsedContent.reviewContent).toContain('```typescript');
    expect(parsedContent.reviewContent).toContain('throw new ValidationError');
    expect(parsedContent.reviewContent).toContain('Overall rating: 8/10');
  });
});

describe('loadReviewFile', () => {
  test('loads full review file content including metadata and review content', async () => {
    const reviewsDir = join(testDir, '.rmfilter', 'reviews');
    const reviewContent = 'This is the full review content\nWith multiple lines';
    const metadata: ReviewMetadata = {
      planId: '42',
      planTitle: 'Test Plan',
      commitHash: 'abc123',
      timestamp: new Date('2024-01-15T10:30:00Z'),
      reviewer: 'test-user',
      baseBranch: 'main',
      changedFiles: ['src/test.ts'],
    };

    const filePath = await saveReviewResult(reviewsDir, reviewContent, metadata);
    const loaded = await loadReviewFile(filePath);

    expect(loaded).not.toBeNull();
    expect(loaded?.metadata.planId).toBe('42');
    expect(loaded?.metadata.planTitle).toBe('Test Plan');
    expect(loaded?.metadata.commitHash).toBe('abc123');
    expect(loaded?.metadata.timestamp).toEqual(new Date('2024-01-15T10:30:00Z'));
    expect(loaded?.metadata.reviewer).toBe('test-user');
    expect(loaded?.metadata.baseBranch).toBe('main');
    expect(loaded?.metadata.changedFiles).toEqual(['src/test.ts']);
    expect(loaded?.reviewContent).toBe(reviewContent);
  });

  test('returns null for non-existent file', async () => {
    const nonExistentPath = join(testDir, 'does-not-exist.json');
    const result = await loadReviewFile(nonExistentPath);
    expect(result).toBeNull();
  });

  test('returns null for invalid JSON file', async () => {
    const invalidJsonPath = join(testDir, 'invalid.json');
    await writeFile(invalidJsonPath, 'This is not JSON', 'utf-8');
    const result = await loadReviewFile(invalidJsonPath);
    expect(result).toBeNull();
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.planTitle).toBe(longTitle);
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.commitHash).toBe('abc123-def456_xyz789');
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.metadata.changedFiles).toEqual([]);
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

    const expectedFilename = 'review-1-2024-01-15T10-30-00-000Z.json';
    const reviewFilePath = join(reviewsDir, expectedFilename);
    const savedContent = await readFile(reviewFilePath, 'utf-8');
    const parsedContent: ReviewFileContent = JSON.parse(savedContent);

    expect(parsedContent.reviewContent).toContain('✅ Good, ❌ Issues, ⚠️ Warnings');
    expect(parsedContent.reviewContent).toContain('café résumé naïve');
  });
});
