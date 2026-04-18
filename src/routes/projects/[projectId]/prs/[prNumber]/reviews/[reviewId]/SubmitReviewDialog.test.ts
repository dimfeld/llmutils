import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';
import type { ReviewIssueRow } from '$tim/db/review.js';
import SubmitReviewDialog from './SubmitReviewDialog.svelte';

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 1,
    review_id: 10,
    severity: 'minor',
    category: 'other',
    content: 'Issue content',
    file: 'src/app.ts',
    line: '12',
    start_line: null,
    suggestion: null,
    source: null,
    side: 'RIGHT',
    submittedInPrReviewId: null,
    resolved: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function defaultProps(issues: ReviewIssueRow[], overrides: Partial<Record<string, unknown>> = {}) {
  return {
    open: true,
    reviewId: 10,
    reviewedSha: 'abcdef1234567890',
    currentHeadSha: 'abcdef1234567890',
    issues,
    onClose: vi.fn(),
    onSubmitted: vi.fn(),
    ...overrides,
  };
}

describe('SubmitReviewDialog', () => {
  test('renders status radio options and body field', () => {
    const issues = [makeIssue()];
    const { body } = render(SubmitReviewDialog, { props: defaultProps(issues) });
    expect(body).toContain('Submit review to GitHub');
    expect(body).toContain('COMMENT');
    expect(body).toContain('APPROVE');
    expect(body).toContain('REQUEST CHANGES');
    expect(body).toContain('submit-review-body');
  });

  test('lists submittable issues and hides resolved + already-submitted ones', () => {
    const issues = [
      makeIssue({ id: 1, content: 'Visible unresolved' }),
      makeIssue({ id: 2, content: 'Already resolved', resolved: 1 }),
      makeIssue({ id: 3, content: 'Already submitted', submittedInPrReviewId: 99 }),
    ];
    const { body } = render(SubmitReviewDialog, { props: defaultProps(issues) });
    expect(body).toContain('Visible unresolved');
    expect(body).not.toContain('Already resolved');
    expect(body).not.toContain('Already submitted');
    // Default selection covers the one submittable issue
    expect(body).toContain('1 of 1 selected');
  });

  test('shows stale-SHA warning when current head differs from reviewed sha', () => {
    const issues = [makeIssue()];
    const props = defaultProps(issues, {
      reviewedSha: 'aaaaaaaa00000000',
      currentHeadSha: 'bbbbbbbb11111111',
    });
    const { body } = render(SubmitReviewDialog, { props });
    expect(body).toContain('HEAD has moved');
    // Reviewed SHA is shown as short form in the warning
    expect(body).toContain('aaaaaaa');
  });

  test('does not show stale-SHA warning when shas match', () => {
    const issues = [makeIssue()];
    const props = defaultProps(issues, {
      reviewedSha: 'samesha0',
      currentHeadSha: 'samesha0',
    });
    const { body } = render(SubmitReviewDialog, { props });
    expect(body).not.toContain('HEAD has moved');
  });

  test('shows empty message when there are no submittable issues', () => {
    const issues = [makeIssue({ id: 1, resolved: 1 })];
    const { body } = render(SubmitReviewDialog, { props: defaultProps(issues) });
    expect(body).toContain('No submittable issues');
  });
});
