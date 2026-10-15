import { describe, expect, test } from 'vitest';

import type {
  PrReviewRequestRow,
  PrReviewRow,
  PrStatusDetail,
  PrStatusRow,
} from '../../tim/db/pr_status.js';
import {
  getEffectiveReviewDecision,
  hasHumanApproval,
  hasHumanReview,
  hasHumanReviewRequest,
  isBotReviewer,
  isPrApproved,
  needsHumanReviewRequest,
} from './review_requests.js';

function makeDetail(
  statusOverrides: Partial<PrStatusRow> = {},
  extras: { reviews?: Partial<PrReviewRow>[]; reviewRequests?: Partial<PrReviewRequestRow>[] } = {}
): PrStatusDetail {
  return {
    status: {
      id: 1,
      pr_url: 'https://github.com/owner/repo/pull/1',
      owner: 'owner',
      repo: 'repo',
      pr_number: 1,
      author: 'Alice',
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
      ...statusOverrides,
    },
    checks: [],
    reviews: (extras.reviews ?? []).map((review, index) => ({
      id: index + 1,
      pr_status_id: 1,
      author: 'bob',
      state: 'COMMENTED',
      body: null,
      submitted_at: '2026-01-02T00:00:00Z',
      ...review,
    })),
    reviewRequests: (extras.reviewRequests ?? []).map((request, index) => ({
      id: index + 1,
      pr_status_id: 1,
      reviewer: 'bob',
      requested_at: '2026-01-02T00:00:00Z',
      removed_at: null,
      notified_at: null,
      last_event_at: '2026-01-02T00:00:00Z',
      request_version: 1,
      ...request,
    })),
    labels: [],
  };
}

describe('isBotReviewer', () => {
  test('matches bot suffix logins and Copilot', () => {
    expect(isBotReviewer('coderabbitai[bot]')).toBe(true);
    expect(isBotReviewer('Copilot')).toBe(true);
    expect(isBotReviewer('bob')).toBe(false);
  });
});

describe('hasHumanReviewRequest', () => {
  test('ignores bot requests and removed requests', () => {
    expect(
      hasHumanReviewRequest(
        makeDetail(
          { requested_reviewers: JSON.stringify(['Copilot']) },
          {
            reviewRequests: [
              { reviewer: 'greptile-apps[bot]' },
              { reviewer: 'bob', removed_at: '2026-01-03T00:00:00Z' },
            ],
          }
        )
      )
    ).toBe(false);
  });

  test('finds human requests in rows or in the requested reviewers snapshot', () => {
    expect(hasHumanReviewRequest(makeDetail({}, { reviewRequests: [{ reviewer: 'bob' }] }))).toBe(
      true
    );
    expect(hasHumanReviewRequest(makeDetail({ requested_reviewers: '["bob"]' }))).toBe(true);
  });

  test('treats an invalid snapshot as no request', () => {
    expect(hasHumanReviewRequest(makeDetail({ requested_reviewers: 'not json' }))).toBe(false);
  });
});

describe('hasHumanReview', () => {
  test('ignores pending reviews, bot reviews, and reviews by the author', () => {
    expect(
      hasHumanReview(
        makeDetail(
          {},
          {
            reviews: [
              { author: 'bob', state: 'PENDING' },
              { author: 'coderabbitai[bot]', state: 'CHANGES_REQUESTED' },
              { author: 'Copilot' },
              { author: 'alice' },
            ],
          }
        )
      )
    ).toBe(false);
  });

  test('counts a submitted review by another human', () => {
    expect(
      hasHumanReview(makeDetail({}, { reviews: [{ author: 'bob', state: 'APPROVED' }] }))
    ).toBe(true);
  });
});

describe('needsHumanReviewRequest', () => {
  test('flags an open ready PR that only has bot activity', () => {
    expect(
      needsHumanReviewRequest(
        makeDetail(
          { requested_reviewers: '["Copilot"]' },
          { reviews: [{ author: 'Copilot' }, { author: 'alice' }] }
        )
      )
    ).toBe(true);
  });

  test('does not flag drafts or closed PRs', () => {
    expect(needsHumanReviewRequest(makeDetail({ draft: 1 }))).toBe(false);
    expect(needsHumanReviewRequest(makeDetail({ state: 'merged' }))).toBe(false);
    expect(needsHumanReviewRequest(makeDetail({ state: 'closed' }))).toBe(false);
  });

  test('does not flag PRs that GitHub reports as approved or with changes requested', () => {
    expect(
      needsHumanReviewRequest(
        makeDetail(
          { review_decision: 'APPROVED' },
          { reviewRequests: [], reviews: [{ author: 'bob', state: 'APPROVED' }] }
        )
      )
    ).toBe(false);
    expect(needsHumanReviewRequest(makeDetail({ review_decision: 'CHANGES_REQUESTED' }))).toBe(
      false
    );
    expect(needsHumanReviewRequest(makeDetail({ review_decision: 'REVIEW_REQUIRED' }))).toBe(true);
  });

  test('does not flag PRs with a human request or a human review', () => {
    expect(needsHumanReviewRequest(makeDetail({}, { reviewRequests: [{ reviewer: 'bob' }] }))).toBe(
      false
    );
    // A reviewer drops off the requested list after reviewing, so a review also counts.
    expect(needsHumanReviewRequest(makeDetail({}, { reviews: [{ author: 'bob' }] }))).toBe(false);
  });
});

describe('isPrApproved', () => {
  test('requires both an APPROVED decision and a non-bot approval', () => {
    expect(
      isPrApproved(
        makeDetail(
          { review_decision: 'APPROVED' },
          { reviews: [{ author: 'bob', state: 'APPROVED' }] }
        )
      )
    ).toBe(true);
    expect(isPrApproved(makeDetail({ review_decision: 'APPROVED' }))).toBe(false);
    expect(
      isPrApproved(
        makeDetail(
          { review_decision: 'APPROVED' },
          {
            reviews: [
              { author: 'df-reviewflow[bot]', state: 'APPROVED' },
              { author: 'Copilot', state: 'APPROVED' },
              { author: 'bob', state: 'COMMENTED' },
            ],
          }
        )
      )
    ).toBe(false);
    expect(
      isPrApproved(
        makeDetail({ review_decision: null }, { reviews: [{ author: 'bob', state: 'APPROVED' }] })
      )
    ).toBe(false);
  });

  test('hasHumanApproval ignores bot approvals', () => {
    expect(hasHumanApproval([{ author: 'some-app[bot]', state: 'APPROVED' }])).toBe(false);
    expect(hasHumanApproval([{ author: 'bob', state: 'APPROVED' }])).toBe(true);
  });

  test('flags a bot-only approved PR that has no human review or request', () => {
    expect(
      needsHumanReviewRequest(
        makeDetail(
          { review_decision: 'APPROVED' },
          { reviews: [{ author: 'df-reviewflow[bot]', state: 'APPROVED' }] }
        )
      )
    ).toBe(true);
  });

  test('getEffectiveReviewDecision hides a bot-only APPROVED decision', () => {
    expect(
      getEffectiveReviewDecision(
        makeDetail(
          { review_decision: 'APPROVED' },
          { reviews: [{ author: 'df-reviewflow[bot]', state: 'APPROVED' }] }
        )
      )
    ).toBeNull();
    expect(
      getEffectiveReviewDecision(
        makeDetail(
          { review_decision: 'APPROVED' },
          { reviews: [{ author: 'bob', state: 'APPROVED' }] }
        )
      )
    ).toBe('APPROVED');
    expect(getEffectiveReviewDecision(makeDetail({ review_decision: 'CHANGES_REQUESTED' }))).toBe(
      'CHANGES_REQUESTED'
    );
  });
});
