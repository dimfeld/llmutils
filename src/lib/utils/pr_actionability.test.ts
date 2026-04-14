import { describe, expect, test } from 'vitest';

import type {
  LinkedPlanSummary,
  PrStatusDetail,
  PrStatusRow,
  PrReviewRow,
  PrReviewRequestRow,
} from '$tim/db/pr_status.js';
import {
  buildActionablePrsForRepo,
  classifyCheckStatus,
  classifyOwnPr,
  hasReviewRequestForUser,
} from '$lib/utils/pr_actionability.js';

function makePrStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 1,
    pr_url: 'https://github.com/owner/repo/pull/1',
    owner: 'owner',
    repo: 'repo',
    pr_number: 1,
    author: 'testuser',
    title: 'Test PR',
    state: 'open',
    draft: 0,
    mergeable: null,
    head_sha: null,
    base_branch: null,
    head_branch: null,
    requested_reviewers: null,
    review_decision: null,
    check_rollup_state: null,
    merged_at: null,
    additions: null,
    deletions: null,
    changed_files: null,
    pr_updated_at: null,
    latest_commit_pushed_at: null,
    last_fetched_at: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makePrDetail(
  statusOverrides: Partial<PrStatusRow> = {},
  extras: {
    reviews?: PrReviewRow[];
    reviewRequests?: PrReviewRequestRow[];
  } = {}
): PrStatusDetail {
  return {
    status: makePrStatus(statusOverrides),
    checks: [],
    reviews: extras.reviews ?? [],
    reviewRequests: extras.reviewRequests ?? [],
    labels: [],
  };
}

describe('classifyCheckStatus', () => {
  test('returns none for null', () => {
    expect(classifyCheckStatus(null)).toBe('none');
  });

  test('returns passing for SUCCESS', () => {
    expect(classifyCheckStatus('SUCCESS')).toBe('passing');
  });

  test('returns failing for FAILURE', () => {
    expect(classifyCheckStatus('FAILURE')).toBe('failing');
  });

  test('returns failing for ERROR', () => {
    expect(classifyCheckStatus('ERROR')).toBe('failing');
  });

  test('returns pending for PENDING', () => {
    expect(classifyCheckStatus('PENDING')).toBe('pending');
  });

  test('returns failing for lowercase failure', () => {
    expect(classifyCheckStatus('failure')).toBe('failing');
  });

  test('returns none for unknown values', () => {
    expect(classifyCheckStatus('IN_PROGRESS')).toBe('none');
  });
});

describe('classifyOwnPr', () => {
  test('returns null for closed PR', () => {
    const pr = makePrDetail({ state: 'closed' });
    expect(classifyOwnPr(pr)).toBeNull();
  });

  test('returns null for draft PR', () => {
    const pr = makePrDetail({ draft: 1 });
    expect(classifyOwnPr(pr)).toBeNull();
  });

  test('returns ready_to_merge when checks pass, approved, and mergeable', () => {
    const pr = makePrDetail({
      check_rollup_state: 'SUCCESS',
      review_decision: 'APPROVED',
      mergeable: 'MERGEABLE',
    });
    expect(classifyOwnPr(pr)).toEqual({
      actionReason: 'ready_to_merge',
      checkStatus: 'passing',
    });
  });

  test('returns changes_requested when review requests changes', () => {
    const pr = makePrDetail({
      review_decision: 'CHANGES_REQUESTED',
      check_rollup_state: 'FAILURE',
    });
    // changes_requested takes priority over checks_failing
    expect(classifyOwnPr(pr)).toEqual({
      actionReason: 'changes_requested',
      checkStatus: 'failing',
    });
  });

  test('returns checks_failing when checks fail', () => {
    const pr = makePrDetail({
      check_rollup_state: 'FAILURE',
      review_decision: 'APPROVED',
    });
    expect(classifyOwnPr(pr)).toEqual({
      actionReason: 'checks_failing',
      checkStatus: 'failing',
    });
  });

  test('returns checks_failing for ERROR check state', () => {
    const pr = makePrDetail({
      check_rollup_state: 'ERROR',
    });
    expect(classifyOwnPr(pr)).toEqual({
      actionReason: 'checks_failing',
      checkStatus: 'failing',
    });
  });

  test('returns open when checks pass but not approved', () => {
    const pr = makePrDetail({
      check_rollup_state: 'SUCCESS',
      review_decision: 'REVIEW_REQUIRED',
      mergeable: 'MERGEABLE',
    });
    expect(classifyOwnPr(pr)).toEqual({ actionReason: 'open', checkStatus: 'passing' });
  });

  test('returns open when approved but checks not passing', () => {
    const pr = makePrDetail({
      check_rollup_state: 'PENDING',
      review_decision: 'APPROVED',
      mergeable: 'MERGEABLE',
    });
    expect(classifyOwnPr(pr)).toEqual({ actionReason: 'open', checkStatus: 'pending' });
  });

  test('returns open when approved and checks pass but not mergeable', () => {
    const pr = makePrDetail({
      check_rollup_state: 'SUCCESS',
      review_decision: 'APPROVED',
      mergeable: 'CONFLICTING',
    });
    expect(classifyOwnPr(pr)).toEqual({ actionReason: 'open', checkStatus: 'passing' });
  });

  test('returns open when no actionable status', () => {
    const pr = makePrDetail({
      check_rollup_state: 'PENDING',
      review_decision: null,
    });
    expect(classifyOwnPr(pr)).toEqual({ actionReason: 'open', checkStatus: 'pending' });
  });
});

describe('hasReviewRequestForUser', () => {
  test('returns true when user has active review request', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns false when review request was removed', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: '2026-01-02T00:00:00Z',
            last_event_at: '2026-01-02T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(false);
  });

  test('returns true when re-requested after previous removal', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-03T00:00:00Z',
            removed_at: '2026-01-02T00:00:00Z',
            last_event_at: '2026-01-03T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns false when user already reviewed after the request', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
        reviews: [
          {
            id: 1,
            pr_status_id: 1,
            author: 'reviewer',
            state: 'APPROVED',
            submitted_at: '2026-01-02T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(false);
  });

  test('returns true when re-requested after user reviewed', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-03T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-03T00:00:00Z',
          },
        ],
        reviews: [
          {
            id: 1,
            pr_status_id: 1,
            author: 'reviewer',
            state: 'APPROVED',
            submitted_at: '2026-01-02T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns true when user is in snapshot requested_reviewers and has no reviews', () => {
    const pr = makePrDetail({
      requested_reviewers: JSON.stringify(['reviewer']),
    });
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns false when user is in snapshot but has already reviewed', () => {
    const pr = makePrDetail(
      { requested_reviewers: JSON.stringify(['reviewer']) },
      {
        reviews: [
          {
            id: 1,
            pr_status_id: 1,
            author: 'reviewer',
            state: 'COMMENTED',
            submitted_at: '2026-01-02T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(false);
  });

  test('is case-insensitive for usernames', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'Reviewer',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
      }
    );
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns false when no review requests exist', () => {
    const pr = makePrDetail();
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(false);
  });

  test('ignores PENDING reviews when checking if user already reviewed', () => {
    const pr = makePrDetail(
      {},
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'reviewer',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
        reviews: [
          {
            id: 1,
            pr_status_id: 1,
            author: 'reviewer',
            state: 'PENDING',
            submitted_at: '2026-01-02T00:00:00Z',
          },
        ],
      }
    );
    // PENDING reviews don't count as having reviewed
    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(true);
  });

  test('returns false for malformed requested_reviewers json', () => {
    const pr = makePrDetail({
      requested_reviewers: '{not valid json',
    });

    expect(hasReviewRequestForUser(pr, 'reviewer')).toBe(false);
  });
});

describe('buildActionablePrsForRepo', () => {
  const linkedPlanSummary: LinkedPlanSummary = {
    planUuid: 'plan-uuid-1',
    planId: 42,
    title: 'Linked plan',
  };

  test('builds actionable own PRs with linked plan context', () => {
    const pr = makePrDetail({
      pr_url: 'https://github.com/owner/repo/pull/10',
      pr_number: 10,
      author: 'testuser',
      title: 'Ready PR',
      check_rollup_state: 'SUCCESS',
      review_decision: 'APPROVED',
      mergeable: 'MERGEABLE',
    });
    const linkedPlansByPrUrl = new Map([[pr.status.pr_url, [linkedPlanSummary]]]);

    expect(buildActionablePrsForRepo(7, [pr], linkedPlansByPrUrl, 'testuser')).toEqual([
      {
        prUrl: 'https://github.com/owner/repo/pull/10',
        prNumber: 10,
        title: 'Ready PR',
        owner: 'owner',
        repo: 'repo',
        author: 'testuser',
        actionReason: 'ready_to_merge',
        checkStatus: 'passing',
        linkedPlanId: 42,
        linkedPlanUuid: 'plan-uuid-1',
        linkedPlanTitle: 'Linked plan',
        projectId: 7,
        additions: null,
        deletions: null,
        changedFiles: null,
      },
    ]);
  });

  test('builds review-requested PRs for other authors', () => {
    const pr = makePrDetail(
      {
        pr_url: 'https://github.com/owner/repo/pull/11',
        pr_number: 11,
        author: 'someone-else',
        title: 'Needs review',
        check_rollup_state: 'PENDING',
      },
      {
        reviewRequests: [
          {
            id: 1,
            pr_status_id: 1,
            reviewer: 'testuser',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
      }
    );

    expect(buildActionablePrsForRepo(7, [pr], new Map(), 'testuser')).toEqual([
      {
        prUrl: 'https://github.com/owner/repo/pull/11',
        prNumber: 11,
        title: 'Needs review',
        owner: 'owner',
        repo: 'repo',
        author: 'someone-else',
        actionReason: 'review_requested',
        checkStatus: 'pending',
        linkedPlanId: null,
        linkedPlanUuid: null,
        linkedPlanTitle: null,
        projectId: 7,
        additions: null,
        deletions: null,
        changedFiles: null,
      },
    ]);
  });

  test('skips closed PRs but includes open PRs regardless of actionable state', () => {
    const closed = makePrDetail({
      pr_url: 'https://github.com/owner/repo/pull/12',
      pr_number: 12,
      state: 'closed',
      author: 'testuser',
      check_rollup_state: 'SUCCESS',
      review_decision: 'APPROVED',
      mergeable: 'MERGEABLE',
    });
    const openPending = makePrDetail({
      pr_url: 'https://github.com/owner/repo/pull/13',
      pr_number: 13,
      author: 'testuser',
      check_rollup_state: 'PENDING',
      review_decision: null,
    });

    const result = buildActionablePrsForRepo(7, [closed, openPending], new Map(), 'testuser');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      prUrl: 'https://github.com/owner/repo/pull/13',
      prNumber: 13,
      actionReason: 'open',
      checkStatus: 'pending',
    });
  });

  test('returns no actionable PRs when there is no authenticated username', () => {
    const ownPr = makePrDetail({
      pr_url: 'https://github.com/owner/repo/pull/14',
      pr_number: 14,
      author: 'testuser',
      check_rollup_state: 'FAILURE',
    });
    const requestedReview = makePrDetail(
      {
        pr_url: 'https://github.com/owner/repo/pull/15',
        pr_number: 15,
        author: 'someone-else',
      },
      {
        reviewRequests: [
          {
            id: 2,
            pr_status_id: 1,
            reviewer: 'testuser',
            requested_at: '2026-01-01T00:00:00Z',
            removed_at: null,
            last_event_at: '2026-01-01T00:00:00Z',
          },
        ],
      }
    );

    expect(buildActionablePrsForRepo(7, [ownPr, requestedReview], new Map(), null)).toEqual([]);
  });
});
