import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { ReviewIssue } from './formatters/review_formatter.js';
import {
  clearTmpDir,
  deleteBatchReviewCache,
  ensureTmpDir,
  getCacheFilename,
  readBatchReviewCache,
  writeBatchReviewCache,
} from './batch_review_cache.js';
import { TMP_DIR } from './plan_materialize.js';

describe('batch_review_cache', () => {
  let tempDir = '';

  const issues: ReviewIssue[] = [
    {
      severity: 'major',
      category: 'bug',
      content: 'Example persisted issue',
      file: 'src/example.ts',
      line: 12,
      suggestion: 'Fix the example bug',
    },
  ];

  async function runGit(args: string[]): Promise<void> {
    const proc = Bun.spawn(['git', ...args], { cwd: tempDir, stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr as ReadableStream).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
    }
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-batch-review-cache-test-'));
    await runGit(['init', '-b', 'main']);
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  test('builds cache filenames for full-plan and scoped reviews', () => {
    expect(getCacheFilename(42)).toBe('review-42-all.json');
    expect(getCacheFilename('312')).toBe('review-312-all.json');
    expect(getCacheFilename(42, [5, 1, 3, 3])).toBe('review-42-1_3_5.json');
    // Empty array treated as 'all'
    expect(getCacheFilename(42, [])).toBe('review-42-all.json');
    // Single task index
    expect(getCacheFilename(10, [7])).toBe('review-10-7.json');
    // Duplicates in different orders produce the same filename
    expect(getCacheFilename(1, [3, 1, 2, 3, 1])).toBe(getCacheFilename(1, [2, 3, 1]));
  });

  test('writes and reads batch review cache data', async () => {
    const input = {
      gitSha: 'abc123',
      issues,
      timestamp: '2026-04-04T12:00:00.000Z',
      planId: 42,
    };

    await writeBatchReviewCache(tempDir, 42, [3, 1, 5, 3], input);

    const expected = { ...input, taskScope: '1_3_5' };
    const result = await readBatchReviewCache(tempDir, 42, [1, 3, 5]);
    expect(result).toEqual(expected);

    const savedContent = await fs.readFile(
      path.join(tempDir, TMP_DIR, 'review-42-1_3_5.json'),
      'utf8'
    );
    expect(JSON.parse(savedContent)).toEqual(expected);
  });

  test('returns null when the cache file does not exist', async () => {
    await ensureTmpDir(tempDir);
    await expect(readBatchReviewCache(tempDir, 77, [2])).resolves.toBeNull();
  });

  test('deletes an existing cache file and ignores missing files', async () => {
    await writeBatchReviewCache(tempDir, 42, [2], {
      gitSha: 'abc123',
      issues,
      timestamp: '2026-04-04T12:00:00.000Z',
      planId: 42,
    });

    await deleteBatchReviewCache(tempDir, 42, [2]);
    await expect(readBatchReviewCache(tempDir, 42, [2])).resolves.toBeNull();

    await expect(deleteBatchReviewCache(tempDir, 42, [2])).resolves.toBeUndefined();
  });

  test('clearTmpDir empties the tmp directory without removing it', async () => {
    const tmpDir = await ensureTmpDir(tempDir);
    await fs.writeFile(path.join(tmpDir, 'leftover.json'), '{"old":true}\n', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'nested', 'child.json'), '{}\n', 'utf8');

    await clearTmpDir(tempDir);

    await expect(fs.readdir(tmpDir)).resolves.toEqual([]);
    const stat = await fs.stat(tmpDir);
    expect(stat.isDirectory()).toBe(true);
  });

  test('task-title resolved indexes use the same cache filename as task-index input', async () => {
    const input = {
      gitSha: 'def456',
      issues,
      timestamp: '2026-04-04T13:00:00.000Z',
      planId: 312,
    };

    await writeBatchReviewCache(tempDir, 312, [4, 2], input);

    const expected = { ...input, taskScope: '2_4' };
    await expect(readBatchReviewCache(tempDir, 312, [2, 4])).resolves.toEqual(expected);
    expect(getCacheFilename(312, [4, 2])).toBe(getCacheFilename(312, [2, 4]));
  });

  test('round-trips cache data with all optional ReviewIssue fields', async () => {
    const fullIssues: ReviewIssue[] = [
      {
        id: 'issue-1',
        severity: 'critical',
        category: 'security',
        content: 'SQL injection vulnerability',
        file: 'src/db.ts',
        line: 42,
        suggestion: 'Use parameterized queries',
      },
      {
        severity: 'info',
        category: 'style',
        content: 'Minimal issue with no optional fields',
      },
      {
        id: 'issue-3',
        severity: 'minor',
        category: 'performance',
        content: 'Unnecessary allocation',
        line: '10-15',
      },
    ];

    const input = {
      gitSha: 'ff00ff',
      issues: fullIssues,
      timestamp: '2026-04-04T14:00:00.000Z',
      planId: '99' as string | number,
    };

    await writeBatchReviewCache(tempDir, '99', undefined, input);
    const result = await readBatchReviewCache(tempDir, '99');
    expect(result).toEqual({ ...input, taskScope: 'all' });
  });

  test('overwrites existing cache on subsequent writes', async () => {
    const first = {
      gitSha: 'aaa111',
      issues,
      timestamp: '2026-04-04T10:00:00.000Z',
      planId: 5 as string | number,
    };
    const second = {
      gitSha: 'bbb222',
      issues: [{ severity: 'minor' as const, category: 'style', content: 'Updated issue' }],
      timestamp: '2026-04-04T11:00:00.000Z',
      planId: 5 as string | number,
    };

    await writeBatchReviewCache(tempDir, 5, undefined, first);
    await writeBatchReviewCache(tempDir, 5, undefined, second);

    const result = await readBatchReviewCache(tempDir, 5);
    expect(result).toEqual({ ...second, taskScope: 'all' });
  });

  test('returns null for malformed JSON cache file', async () => {
    const tmpDir = await ensureTmpDir(tempDir);
    await fs.writeFile(path.join(tmpDir, 'review-99-all.json'), 'not valid json{{{', 'utf8');
    await expect(readBatchReviewCache(tempDir, 99)).resolves.toBeNull();
  });

  test('returns null for cache file with missing required fields', async () => {
    const tmpDir = await ensureTmpDir(tempDir);
    await fs.writeFile(
      path.join(tmpDir, 'review-99-all.json'),
      JSON.stringify({ gitSha: 'abc', planId: 99 }),
      'utf8'
    );
    await expect(readBatchReviewCache(tempDir, 99)).resolves.toBeNull();
  });

  test('returns null for cache file with invalid issue entries', async () => {
    const tmpDir = await ensureTmpDir(tempDir);
    await fs.writeFile(
      path.join(tmpDir, 'review-99-all.json'),
      JSON.stringify({ gitSha: 'abc', issues: [{}], planId: 99, taskScope: 'all', timestamp: 'x' }),
      'utf8'
    );
    await expect(readBatchReviewCache(tempDir, 99)).resolves.toBeNull();
  });

  test('ensureTmpDir creates the tmp directory and adds it to git info exclude', async () => {
    const tmpDir = await ensureTmpDir(tempDir);

    const stat = await fs.stat(tmpDir);
    expect(stat.isDirectory()).toBe(true);

    const excludeContents = await fs.readFile(
      path.join(tempDir, '.git', 'info', 'exclude'),
      'utf8'
    );
    expect(excludeContents).toContain(TMP_DIR);
  });
});
