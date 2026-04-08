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
});
