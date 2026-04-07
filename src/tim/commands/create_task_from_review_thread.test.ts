import { describe, expect, test } from 'vitest';
import type {
  PrReviewThreadDetail,
  PrReviewThreadRow,
  PrReviewThreadCommentRow,
} from '../db/pr_status.js';
import { createTaskFromReviewThread } from './review.js';

function makeThread(overrides: Partial<PrReviewThreadRow> = {}): PrReviewThreadRow {
  return {
    id: 1,
    pr_status_id: 100,
    thread_id: 'PRRT_abc123',
    path: 'src/auth.ts',
    line: null,
    original_line: null,
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

function makeComment(overrides: Partial<PrReviewThreadCommentRow> = {}): PrReviewThreadCommentRow {
  return {
    id: 1,
    review_thread_id: 1,
    comment_id: 'IC_abc',
    database_id: 12345,
    author: 'reviewer',
    body: 'This needs a null check.',
    diff_hunk: '@@ -10,5 +10,5 @@\n context line\n-old code\n+new code',
    state: 'SUBMITTED',
    created_at: '2025-01-15T10:00:00Z',
    ...overrides,
  };
}

const PR_URL = 'https://github.com/owner/repo/pull/42';

describe('createTaskFromReviewThread', () => {
  test('uses thread.line for display line', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts:42');
    expect(task.done).toBe(false);
  });

  test('falls back to original_line when line is null', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: null, original_line: 50 }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts:50');
  });

  test('falls back to start_line when line and original_line are null', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: null, original_line: null, start_line: 30 }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts:30');
  });

  test('falls back to original_start_line as last resort', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({
        line: null,
        original_line: null,
        start_line: null,
        original_start_line: 20,
      }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts:20');
  });

  test('uses path only when no line numbers are available', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({
        line: null,
        original_line: null,
        start_line: null,
        original_start_line: null,
      }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts');
  });

  test('includes comment body in description', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ body: 'Please add error handling here.' })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain('Please add error handling here.');
  });

  test('concatenates multiple comment bodies', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [
        makeComment({ body: 'First comment.' }),
        makeComment({ id: 2, body: 'Second comment with more detail.' }),
      ],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain('First comment.');
    expect(task.description).toContain('Second comment with more detail.');
  });

  test('provides fallback description when comments have no body', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42, path: 'src/utils.ts' }),
      comments: [makeComment({ body: null }), makeComment({ id: 2, body: '' })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain('Address the unresolved review feedback in src/utils.ts:42');
  });

  test('includes diff hunk context in description', () => {
    const hunk = '@@ -10,5 +10,5 @@\n context\n-old\n+new';
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ diff_hunk: hunk })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain('Diff context:');
    expect(task.description).toContain(hunk);
  });

  test('omits diff hunk section when no comments have one', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ diff_hunk: null })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).not.toContain('Diff context:');
  });

  test('includes GitHub discussion link with database_id', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ database_id: 98765 })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain(`GitHub discussion: ${PR_URL}#discussion_r98765`);
  });

  test('falls back to PR link when no database_id available', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ database_id: null })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain(`Pull request: ${PR_URL}`);
    expect(task.description).not.toContain('#discussion_r');
  });

  test('prefers line over all other line fields', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({
        line: 10,
        original_line: 20,
        start_line: 30,
        original_start_line: 40,
      }),
      comments: [makeComment()],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.title).toBe('Address review: src/auth.ts:10');
  });

  test('uses first comment with database_id for the link', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [makeComment({ database_id: null }), makeComment({ id: 2, database_id: 55555 })],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain(`#discussion_r55555`);
  });

  test('skips empty comment bodies when concatenating', () => {
    const detail: PrReviewThreadDetail = {
      thread: makeThread({ line: 42 }),
      comments: [
        makeComment({ body: 'Real feedback.' }),
        makeComment({ id: 2, body: '' }),
        makeComment({ id: 3, body: '  ' }),
        makeComment({ id: 4, body: 'More feedback.' }),
      ],
    };

    const task = createTaskFromReviewThread(detail, PR_URL);
    expect(task.description).toContain('Real feedback.');
    expect(task.description).toContain('More feedback.');
  });
});
