import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type { ActionablePr, PrAttentionItem } from '$lib/utils/dashboard_attention.js';
import PrAttentionCard from './PrAttentionCard.svelte';

function createActionablePr(overrides: Partial<ActionablePr> = {}): ActionablePr {
  return {
    prUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    title: 'Add feature X',
    owner: 'example',
    repo: 'repo',
    author: 'alice',
    actionReason: 'open',
    checkStatus: 'passing',
    linkedPlanId: null,
    linkedPlanUuid: null,
    linkedPlanTitle: null,
    projectId: 123,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewRequestedAt: null,
    reviewRequestedStacked: false,
    hasApprovingReview: false,
    ...overrides,
  };
}

function createItem(prOverrides: Partial<ActionablePr> = {}): PrAttentionItem {
  return {
    kind: 'pr',
    actionablePr: createActionablePr(prOverrides),
  };
}

describe('PrAttentionCard', () => {
  test('renders PR title and number', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem(),
      },
    });

    expect(body).toContain('Add feature X');
    expect(body).toContain('#42');
  });

  test('renders the external PR link as a Linear deep link', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem(),
      },
    });

    expect(body).toContain('href="linear://review/example/repo/pull/42"');
  });

  test('renders compact diff stats when additions and deletions are available', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({ additions: 42, deletions: 17 }),
      },
    });

    expect(body).toContain('+42');
    expect(body).toContain('-17');
  });

  test('does not render diff stats when additions and deletions are null', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem(),
        // additions and deletions are null by default
      },
    });

    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('does not render diff stats when only additions is non-null', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({ additions: 5, deletions: null }),
      },
    });

    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('does not render diff stats when only deletions is non-null', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({ additions: null, deletions: 8 }),
      },
    });

    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('renders review request age with yellow badge styling', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({
          actionReason: 'review_requested',
          reviewRequestedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
        }),
      },
    });

    expect(body).toContain('Review requested');
    expect(body).toContain('5h');
    expect(body).toContain('bg-yellow-200');
    expect(body).toContain('dark:bg-yellow-950/60');
    expect(body).not.toContain('bg-purple-100');
  });

  test('renders the stacked marker alongside the review request age', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({
          actionReason: 'review_requested',
          reviewRequestedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
          reviewRequestedStacked: true,
        }),
      },
    });

    expect(body).toContain('Review requested');
    expect(body).toContain('5h');
    expect(body).toContain('Stacked');
  });

  test('renders an approval check mark when a review-requested PR has an approving review', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({
          actionReason: 'review_requested',
          hasApprovingReview: true,
        }),
      },
    });

    expect(body).toContain('Approved by a reviewer');
    expect(body).toContain('text-green-600');
  });

  test('does not render an approval check mark when there is no approving review', () => {
    const { body } = render(PrAttentionCard, {
      props: {
        item: createItem({
          actionReason: 'review_requested',
          hasApprovingReview: false,
        }),
      },
    });

    expect(body).not.toContain('Approved by a reviewer');
  });
});
