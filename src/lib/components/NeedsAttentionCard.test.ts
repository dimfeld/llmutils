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
  startCreatePr: vi.fn(),
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
    hasPr: false,
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

  test('shows Finish when no finish executor is needed and plan has PR', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: false, hasPr: true }),
        projectId: '123',
      },
    });

    expect(body).toContain('Finish');
    expect(body).not.toContain('Update Docs');
    expect(body).not.toContain('Create PR');
  });

  test('shows Create PR as primary when no PR and pr-based workflow', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: false, hasPr: false }),
        projectId: '123',
        developmentWorkflow: 'pr-based',
      },
    });

    expect(body).toContain('Create PR');
    // "Finish" is in a dropdown menu which is not rendered during SSR
    expect(body).not.toContain('Update Docs');
  });

  test('shows Finish without Create PR when trunk-based workflow', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: false, hasPr: false }),
        projectId: '123',
        developmentWorkflow: 'trunk-based',
      },
    });

    expect(body).not.toContain('Create PR');
    expect(body).toContain('Finish');
  });

  test('does not show Create PR for epic plans', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ epic: true, needsFinishExecutor: false, hasPr: false }),
        projectId: '123',
        developmentWorkflow: 'pr-based',
      },
    });

    expect(body).not.toContain('Create PR');
    expect(body).toContain('Finish');
  });

  test('shows Update Docs when finish executor is needed regardless of PR status', () => {
    const { body } = render(NeedsAttentionCard, {
      props: {
        item: makeItem({ needsFinishExecutor: true, hasPr: false }),
        projectId: '123',
        developmentWorkflow: 'pr-based',
      },
    });

    expect(body).toContain('Update Docs');
    expect(body).not.toContain('Create PR');
  });
});
