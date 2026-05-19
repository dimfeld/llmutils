import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';
import type { PrReviewSubmissionRow, ReviewIssueRow, ReviewRow } from '$tim/db/review.js';
import ReviewGuideView from './ReviewGuideView.svelte';

function makeReview(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 10,
    project_id: 1,
    pr_status_id: null,
    pr_url: null,
    branch: null,
    base_branch: 'main',
    reviewed_sha: 'abcdef1234567890',
    review_guide: '# Summary\n\nReview body',
    status: 'complete',
    error_message: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    plan_uuid: 'plan-uuid-1',
    ...overrides,
  };
}

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 1,
    review_id: 10,
    severity: 'minor',
    category: 'bug',
    content: 'Issue content',
    file: 'src/app.ts',
    line: '12',
    start_line: null,
    suggestion: 'Fix it',
    source: 'combined',
    side: 'RIGHT',
    submittedInPrReviewId: 7,
    resolved: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSubmission(overrides: Partial<PrReviewSubmissionRow> = {}): PrReviewSubmissionRow {
  return {
    id: 7,
    reviewId: 10,
    githubReviewId: 12345,
    githubReviewUrl: 'https://github.com/example/repo/pull/1#pullrequestreview-12345',
    event: 'COMMENT',
    body: null,
    commitSha: 'abcdef1234567890',
    submittedBy: 'reviewer',
    submittedAt: '2026-01-01T00:00:00.000Z',
    errorMessage: null,
    ...overrides,
  };
}

describe('ReviewGuideView', () => {
  test('hides PR-only controls and linked plans for plan-only review guides', () => {
    const { body } = render(ReviewGuideView, {
      props: {
        review: makeReview(),
        issues: [makeIssue()],
        projectId: '1',
        backHref: '/projects/1/plans/plan-uuid-1',
        backLabel: 'Back to plan #7001',
        allowGithubSubmission: false,
        linkedPlans: [{ planUuid: 'plan-uuid-1', planId: 7001, title: 'Plan review' }],
        linkedPlanUuid: 'plan-uuid-1',
        submissions: [makeSubmission()],
      },
    });

    expect(body).toContain('Back to plan #7001');
    expect(body).toContain('Review body');
    expect(body).toContain('Issue content');
    expect(body).not.toContain('Linked plans:');
    expect(body).not.toContain('Submit Review');
    expect(body).not.toContain('Submitted in review');
    expect(body).toContain('Add to plan as a task');
    expect(body).toContain('Edit');
    expect(body).toContain('Mark resolved');
    expect(body).toContain('Delete issue');
  });

  test('renders note-severity issues in a Notes group with no actionable buttons', () => {
    const { body } = render(ReviewGuideView, {
      props: {
        review: makeReview({ pr_url: 'https://github.com/example/repo/pull/1', plan_uuid: null }),
        issues: [
          makeIssue({ id: 1, severity: 'critical', content: 'Critical issue', resolved: 1 }),
          makeIssue({ id: 2, severity: 'major', content: 'Major issue', resolved: 1 }),
          makeIssue({ id: 3, severity: 'minor', content: 'Minor issue', resolved: 1 }),
          makeIssue({ id: 4, severity: 'info', content: 'Info issue', resolved: 1 }),
          makeIssue({
            id: 5,
            severity: 'note',
            category: 'other',
            content: 'Heads up:\nMulti-line note body',
            suggestion: null,
            submittedInPrReviewId: null,
          }),
        ],
        projectId: '1',
        backHref: '/projects/1/prs/1',
        backLabel: 'Back to PR #1',
        allowGithubSubmission: true,
        linkedPlans: [{ planUuid: 'plan-uuid-1', planId: 7001, title: 'Plan review' }],
        linkedPlanUuid: 'plan-uuid-1',
        submissions: [],
      },
    });

    expect(body).toContain('Notes');
    expect(body).toContain('Heads up:');
    expect(body).toContain('Multi-line note body');
    expect(body).toContain('(0 of 4 unresolved)');

    const notesGroupIdx = body.indexOf('Notes');
    for (const severityLabel of ['Critical', 'Major', 'Minor', 'Info']) {
      expect(notesGroupIdx).toBeGreaterThan(body.indexOf(severityLabel));
    }

    expect(body).toContain('whitespace-pre-wrap');

    const noteCardIdx = body.indexOf('Multi-line note body');
    const tailAfterNote = body.slice(noteCardIdx);
    const nextLiBoundary = tailAfterNote.indexOf('</li>');
    const noteCard = tailAfterNote.slice(0, nextLiBoundary);
    expect(noteCard).not.toContain('Add to plan as a task');
    expect(noteCard).not.toContain('Mark resolved');
    expect(noteCard).not.toContain('Mark unresolved');
    expect(noteCard).not.toContain('Delete issue');
    expect(noteCard).not.toMatch(/>Edit</);
  });

  test('shows PR review controls when GitHub submission is allowed', () => {
    const { body } = render(ReviewGuideView, {
      props: {
        review: makeReview({
          pr_url: 'https://github.com/example/repo/pull/1',
          branch: null,
          plan_uuid: null,
        }),
        issues: [makeIssue()],
        projectId: '1',
        backHref: '/projects/1/prs/1',
        backLabel: 'Back to PR #1',
        allowGithubSubmission: true,
        linkedPlans: [{ planUuid: 'plan-uuid-1', planId: 7001, title: 'Plan review' }],
        linkedPlanUuid: 'plan-uuid-1',
        submissions: [makeSubmission()],
      },
    });

    expect(body).toContain('Linked plan:');
    expect(body).toContain('Submit Review');
    expect(body).toContain('Submitted in review #12345');
    expect(body).toContain('Add to plan as a task');
    expect(body).toContain('Mark resolved');
    expect(body).toContain('Edit');
    expect(body).toContain('Delete issue');
  });
});
