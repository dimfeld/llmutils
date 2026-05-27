import { renderWithTooltipProvider } from '$lib/test-utils/render_with_tooltip_provider.js';
import { describe, expect, test, vi } from 'vitest';

import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
import { getLinearPrReviewUrl } from '$lib/remote/project_prs.remote.js';
import { getPrReviews } from '$lib/remote/pr_reviews.remote.js';
import PrDetail from './PrDetail.svelte';

vi.mock('$lib/remote/project_prs.remote.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/remote/project_prs.remote.js')>(
    '$lib/remote/project_prs.remote.js'
  );
  return {
    ...actual,
    getLinearPrReviewUrl: vi.fn(async () => null),
  };
});

vi.mock('$lib/remote/pr_reviews.remote.js', async () => {
  const actual = await vi.importActual<typeof import('$lib/remote/pr_reviews.remote.js')>(
    '$lib/remote/pr_reviews.remote.js'
  );
  return {
    ...actual,
    getPrReviews: vi.fn(async () => []),
  };
});

function createPr(): EnrichedProjectPr {
  return {
    projectId: 123,
    currentUserReviewRequestLabel: 'Review Requested',
    requiredCheckNames: [],
    status: {
      id: 1,
      pr_url: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      pr_number: 42,
      author: 'alice',
      title: 'Add feature X',
      state: 'open',
      draft: 0,
      mergeable: 'MERGEABLE',
      head_sha: 'abc123',
      base_branch: 'main',
      head_branch: 'feature-x',
      requested_reviewers: '["dimfeld"]',
      review_decision: 'REVIEW_REQUIRED',
      check_rollup_state: 'success',
      merged_at: null,
      additions: null,
      deletions: null,
      changed_files: null,
      pr_updated_at: null,
      last_fetched_at: '2026-03-18T10:00:00.000Z',
      created_at: '2026-03-18T10:00:00.000Z',
      updated_at: '2026-03-18T10:00:00.000Z',
    },
    linkedPlans: [],
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
  };
}

describe('PrDetail', () => {
  test('renders the current user review-request label in the badge bar', async () => {
    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
      },
    });

    expect(body).toContain('Review Requested');
    expect(body).not.toContain('Review Required');
  });

  test('renders a Graphite link for the current PR', async () => {
    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
      },
    });

    expect(body).toContain('View in Graphite');
    expect(body).toContain('href="https://app.graphite.com/github/pr/example/repo/42"');
  });

  test('does not block server render on the Linear review URL lookup', async () => {
    vi.mocked(getLinearPrReviewUrl).mockImplementationOnce(
      () => new Promise<string | null>(() => {})
    );

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
      },
    });

    expect(body).toContain('View in GitHub');
    expect(body).toContain('View in Graphite');
    expect(body).not.toContain('View in Linear');
    expect(getLinearPrReviewUrl).toHaveBeenCalledWith({
      projectId: '123',
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
    });
  });

  test('shows the draft toggle only for the authenticated author', async () => {
    const ownPr = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
        username: 'alice',
        tokenConfigured: true,
      },
    });

    expect(ownPr.body).toContain('Convert to draft');

    const otherPr = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
        username: 'bob',
        tokenConfigured: true,
      },
    });

    expect(otherPr.body).not.toContain('Convert to draft');
    expect(otherPr.body).not.toContain('Mark ready for review');
  });

  test('renders full diff stats when additions, deletions, and changed_files are available', async () => {
    const pr = createPr();
    pr.status.additions = 42;
    pr.status.deletions = 17;
    pr.status.changed_files = 3;

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(body).toContain('3 files changed');
    expect(body).toContain('+42');
    expect(body).toContain('-17');
  });

  test('does not render diff stats when changed_files is null', async () => {
    const pr = createPr();
    pr.status.additions = 42;
    pr.status.deletions = 17;
    pr.status.changed_files = null;

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(body).not.toContain('files changed');
    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('does not render diff stats when additions and deletions are null', async () => {
    const pr = createPr();
    // additions, deletions, changed_files are already null in createPr()

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(body).not.toContain('files changed');
    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('renders requested reviewers who have not reviewed yet', async () => {
    const pr = createPr();
    pr.status.requested_reviewers = '["dimfeld","bob"]';
    pr.reviews = [
      {
        id: 11,
        pr_status_id: 1,
        author: 'bob',
        state: 'APPROVED',
        body: null,
        submitted_at: '2026-03-18T11:00:00.000Z',
      },
    ];

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(body).toContain('1 review');
    expect(body).toContain('1 requested');
    expect(body).toContain('Requested');
    expect(body).toContain('dimfeld');
    expect(body).not.toContain('@dimfeld');
    expect(body).not.toContain('@bob');
  });

  test('renders active requested reviewers from review request history', async () => {
    const pr = createPr();
    pr.status.requested_reviewers = null;
    pr.reviewRequests = [
      {
        id: 21,
        pr_status_id: 1,
        reviewer: 'carol',
        requested_at: '2026-03-18T10:00:00.000Z',
        removed_at: null,
        notified_at: null,
        last_event_at: '2026-03-18T10:00:00.000Z',
        request_version: 1,
      },
      {
        id: 22,
        pr_status_id: 1,
        reviewer: 'dave',
        requested_at: '2026-03-18T10:00:00.000Z',
        removed_at: '2026-03-18T11:00:00.000Z',
        notified_at: null,
        last_event_at: '2026-03-18T11:00:00.000Z',
        request_version: 1,
      },
    ];

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(body).toContain('0 reviews');
    expect(body).toContain('1 requested');
    expect(body).toContain('carol');
    expect(body).not.toContain('@dave');
  });

  test('sorts linked plans by plan number', async () => {
    const pr = createPr();
    pr.linkedPlans = [
      { planUuid: 'plan-30', planId: 30, title: 'Plan thirty' },
      { planUuid: 'plan-10', planId: 10, title: 'Plan ten' },
      { planUuid: 'plan-20', planId: 20, title: 'Plan twenty' },
    ];

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    const plan10 = body.indexOf('href="/projects/123/plans/plan-10"');
    const plan20 = body.indexOf('href="/projects/123/plans/plan-20"');
    const plan30 = body.indexOf('href="/projects/123/plans/plan-30"');

    expect(plan10).toBeGreaterThanOrEqual(0);
    expect(plan20).toBeGreaterThanOrEqual(0);
    expect(plan30).toBeGreaterThanOrEqual(0);
    expect(plan10).toBeLessThan(plan20);
    expect(plan20).toBeLessThan(plan30);
  });

  test('loads and links plan-only review guides for linked plans', async () => {
    vi.mocked(getPrReviews).mockResolvedValueOnce([
      {
        id: 501,
        project_id: 123,
        pr_status_id: null,
        pr_url: null,
        branch: null,
        base_branch: 'main',
        reviewed_sha: 'abc123',
        review_guide: '# Plan guide',
        status: 'complete',
        error_message: null,
        created_at: '2026-03-18T10:00:00.000Z',
        updated_at: '2026-03-18T10:00:00.000Z',
        plan_uuid: 'plan-10',
        issue_count: 2,
        unresolved_count: 1,
      },
    ]);
    const pr = createPr();
    pr.linkedPlans = [{ planUuid: 'plan-10', planId: 10, title: 'Plan ten' }];

    const { body } = await renderWithTooltipProvider(PrDetail, {
      props: {
        pr,
        projectId: '123',
      },
    });

    expect(getPrReviews).toHaveBeenLastCalledWith({
      prUrl: 'https://github.com/example/repo/pull/42',
      linkedPlanUuids: ['plan-10'],
    });
    expect(body).toContain('href="/projects/123/plans/plan-10/reviews/501"');
  });
});
