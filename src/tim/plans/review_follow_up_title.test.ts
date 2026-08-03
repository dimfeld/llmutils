import { describe, expect, test } from 'vitest';
import {
  PR_REVIEW_THREAD_TITLE_PREFIX,
  REVIEW_FEEDBACK_TITLE_PREFIX,
  REVIEW_FOLLOW_UP_TITLE_PREFIXES,
  isReviewFollowUpTaskTitle,
} from './review_follow_up_title.js';
import { buildTaskTitleFromIssue, createTaskFromReviewThread } from '../commands/review.js';
import type {
  PrReviewThreadDetail,
  PrReviewThreadRow,
  PrReviewThreadCommentRow,
} from '../db/pr_status.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';

describe('isReviewFollowUpTaskTitle', () => {
  test('matches the "Address Review Feedback:" prefix', () => {
    expect(isReviewFollowUpTaskTitle('Address Review Feedback: fix the null check')).toBe(true);
  });

  test('matches the "Address review:" prefix', () => {
    expect(isReviewFollowUpTaskTitle('Address review: src/foo.ts:12')).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(isReviewFollowUpTaskTitle('address review feedback: lowercase prefix')).toBe(true);
    expect(isReviewFollowUpTaskTitle('ADDRESS REVIEW: uppercase prefix')).toBe(true);
    expect(isReviewFollowUpTaskTitle('AdDrEsS rEvIeW fEeDbAcK: mixed case')).toBe(true);
  });

  test('tolerates leading and trailing whitespace', () => {
    expect(isReviewFollowUpTaskTitle('   Address review: src/foo.ts:12   ')).toBe(true);
    expect(isReviewFollowUpTaskTitle('\tAddress Review Feedback: tabbed\n')).toBe(true);
  });

  test('does not match a title that merely contains the phrase mid-string', () => {
    expect(
      isReviewFollowUpTaskTitle('Please Address Review Feedback: this is not a prefix match')
    ).toBe(false);
    expect(isReviewFollowUpTaskTitle('See: Address review: for context')).toBe(false);
  });

  test('does not match an empty string', () => {
    expect(isReviewFollowUpTaskTitle('')).toBe(false);
    expect(isReviewFollowUpTaskTitle('   ')).toBe(false);
  });

  test('does not match an ordinary substantive title', () => {
    expect(isReviewFollowUpTaskTitle('Add new feature Y')).toBe(false);
    expect(isReviewFollowUpTaskTitle('Refactor the plan sync module')).toBe(false);
  });
});

describe('REVIEW_FOLLOW_UP_TITLE_PREFIXES drift guard', () => {
  function makeIssue(overrides: Partial<ReviewIssue> = {}): ReviewIssue {
    return {
      severity: 'major',
      category: 'bug',
      content: 'The null check is missing on the request handler.',
      ...overrides,
    };
  }

  function makeThread(overrides: Partial<PrReviewThreadRow> = {}): PrReviewThreadDetail {
    const thread: PrReviewThreadRow = {
      id: 1,
      pr_status_id: 100,
      thread_id: 'PRRT_abc123',
      path: 'src/auth.ts',
      line: 42,
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
    const comment: PrReviewThreadCommentRow = {
      id: 1,
      review_thread_id: 1,
      comment_id: 'IC_abc',
      database_id: 12345,
      author: 'reviewer',
      body: 'This needs a null check.',
      diff_hunk: null,
      state: 'SUBMITTED',
      created_at: '2025-01-15T10:00:00Z',
    };
    return { thread, comments: [comment] };
  }

  test('titles built from a review issue are recognized as follow-up titles', () => {
    const task = { title: buildTaskTitleFromIssue(makeIssue()) };
    expect(task.title.startsWith(REVIEW_FEEDBACK_TITLE_PREFIX)).toBe(true);
    expect(isReviewFollowUpTaskTitle(task.title)).toBe(true);
  });

  test('titles built from an issue with empty content are recognized as follow-up titles', () => {
    const task = { title: buildTaskTitleFromIssue(makeIssue({ content: '' })) };
    expect(isReviewFollowUpTaskTitle(task.title)).toBe(true);
  });

  test('titles built from a PR review thread are recognized as follow-up titles', () => {
    const detail = makeThread();
    const task = createTaskFromReviewThread(detail, 'https://github.com/owner/repo/pull/42');
    expect(task.title.startsWith(PR_REVIEW_THREAD_TITLE_PREFIX)).toBe(true);
    expect(isReviewFollowUpTaskTitle(task.title)).toBe(true);
  });
});
