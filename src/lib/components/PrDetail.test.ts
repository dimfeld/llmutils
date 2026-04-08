import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
import PrDetail from './PrDetail.svelte';

function createPr(): EnrichedProjectPr {
  return {
    projectId: 123,
    currentUserReviewRequestLabel: 'Review Requested',
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
  test('renders the current user review-request label in the badge bar', () => {
    const { body } = render(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
      },
    });

    expect(body).toContain('Review Requested');
    expect(body).not.toContain('Review Required');
  });

  test('shows the draft toggle only for the authenticated author', () => {
    const ownPr = render(PrDetail, {
      props: {
        pr: createPr(),
        projectId: '123',
        username: 'alice',
        tokenConfigured: true,
      },
    });

    expect(ownPr.body).toContain('Convert to draft');

    const otherPr = render(PrDetail, {
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
});
