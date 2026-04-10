import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
import PrRow from './PrRow.svelte';

function createPr(): EnrichedProjectPr {
  return {
    projectId: 123,
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
      requested_reviewers: null,
      review_decision: null,
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
    currentUserReviewRequestLabel: null,
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
  };
}

describe('PrRow', () => {
  test('renders a button to open the PR in a new window', () => {
    const { body } = render(PrRow, {
      props: {
        pr: createPr(),
        href: '/projects/123/prs/42',
        itemId: '123:42',
      },
    });

    expect(body).toContain('href="https://github.com/example/repo/pull/42"');
    expect(body).toContain('target="_blank"');
    expect(body).toContain('rel="noopener noreferrer"');
    expect(body).toContain('aria-label="Open pull request #42 on GitHub in new window"');
    expect(body).toContain('title="Open on GitHub in new window"');
  });

  test('renders a review requested badge when the current user was requested again', () => {
    const pr = createPr();
    pr.currentUserReviewRequestLabel = 'Review Requested';

    const { body } = render(PrRow, {
      props: {
        pr,
        href: '/projects/123/prs/42',
        itemId: '123:42',
      },
    });

    expect(body).toContain('Review Requested');
  });

  test('renders compact diff stats when additions and deletions are available', () => {
    const pr = createPr();
    pr.status.additions = 42;
    pr.status.deletions = 17;

    const { body } = render(PrRow, {
      props: {
        pr,
        href: '/projects/123/prs/42',
        itemId: '123:42',
      },
    });

    expect(body).toContain('+42');
    expect(body).toContain('-17');
  });

  test('does not render diff stats when additions and deletions are null', () => {
    const pr = createPr();
    // additions and deletions are already null in createPr()

    const { body } = render(PrRow, {
      props: {
        pr,
        href: '/projects/123/prs/42',
        itemId: '123:42',
      },
    });

    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });
});
