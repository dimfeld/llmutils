import { describe, expect, test } from 'vitest';

import type { PrReviewThreadRow } from '$tim/db/pr_status.js';
import { getReviewThreadHunkWindow } from './review_hunk.js';

function makeThread(overrides: Partial<PrReviewThreadRow> = {}): PrReviewThreadRow {
  return {
    id: 1,
    pr_status_id: 100,
    thread_id: 'thread-1',
    path: 'src/example.ts',
    line: 15,
    original_line: 15,
    original_start_line: null,
    start_line: null,
    diff_side: 'RIGHT',
    start_diff_side: null,
    is_resolved: 0,
    is_outdated: 0,
    subject_type: 'LINE',
    ...overrides,
  };
}

function makeLongHunk(focusLine = 15, totalLines = 30): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;

  for (let line = 1; line <= totalLines; line += 1) {
    if (line === focusLine) {
      body.push(`-line${line}-old`);
      body.push(`+line${line}-new`);
      oldCount += 1;
      newCount += 1;
      continue;
    }

    body.push(` line${line}`);
    oldCount += 1;
    newCount += 1;
  }

  return `@@ -1,${oldCount} +1,${newCount} @@\n${body.join('\n')}`;
}

describe('getReviewThreadHunkWindow', () => {
  test('trims a large right-side hunk to five lines of context around the comment line', () => {
    const thread = makeThread({ line: 15, original_line: 15, diff_side: 'RIGHT' });
    const hunk = makeLongHunk();

    const result = getReviewThreadHunkWindow(thread, hunk, 5);

    expect(result.isTruncated).toBe(true);
    expect(result.hunk).toContain('line10');
    expect(result.hunk).toContain('line15-old');
    expect(result.hunk).toContain('line15-new');
    expect(result.hunk).toContain('line20');
    expect(result.hunk).not.toContain('line4');
    expect(result.hunk).not.toContain('line25');
  });

  test('uses the left-side line numbers for left-side comments', () => {
    const thread = makeThread({
      line: null,
      original_line: 15,
      diff_side: 'LEFT',
    });
    const hunk = makeLongHunk();

    const result = getReviewThreadHunkWindow(thread, hunk, 5);

    expect(result.isTruncated).toBe(true);
    expect(result.hunk).toContain('line15-old');
    expect(result.hunk).toContain('line15-new');
  });

  test('leaves small hunks unchanged', () => {
    const thread = makeThread({ line: 2, original_line: 2 });
    const hunk = '@@ -1,3 +1,3 @@\n line1\n-old2\n+new2\n line3';

    const result = getReviewThreadHunkWindow(thread, hunk, 5);

    expect(result.isTruncated).toBe(false);
    expect(result.hunk).toBe(hunk);
  });
});
