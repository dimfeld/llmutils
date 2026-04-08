import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanAttentionItem } from '$lib/utils/dashboard_attention.js';
import NeedsAttentionCard from './NeedsAttentionCard.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/remote/plan_actions.remote.js', () => ({
  startFinish: vi.fn(),
  finishPlanQuick: vi.fn(),
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({
    selectSession: vi.fn(),
  }),
}));

vi.mock('svelte-sonner', () => ({
  toast: {
    error: vi.fn(),
  },
}));

function makeItem(overrides: Partial<PlanAttentionItem> = {}): PlanAttentionItem {
  return {
    kind: 'plan',
    planUuid: 'plan-1',
    planId: 1,
    planTitle: 'Needs attention',
    projectId: 123,
    epic: false,
    docsUpdatedAt: null,
    lessonsAppliedAt: null,
    needsFinishExecutor: false,
    reasons: [{ type: 'needs_review' }],
    ...overrides,
  };
}

describe('NeedsAttentionCard', () => {
  test('shows Update Docs when finish work still needs an executor', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: true }),
        projectId: '123',
      },
    });

    expect(body).toContain('Update Docs');
    expect(body).not.toContain('Finish');
  });

  test('shows Finish when no finish executor is needed', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: false }),
        projectId: '123',
      },
    });

    expect(body).toContain('Finish');
    expect(body).not.toContain('Update Docs');
  });
});
