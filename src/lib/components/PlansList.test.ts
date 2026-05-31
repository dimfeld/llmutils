import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import PlansList from './PlansList.svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
}));

vi.mock('$app/state', () => ({
  page: {
    params: { projectId: '7' },
  },
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({
    sessions: new Map(),
  }),
}));

describe('PlansList create affordance', () => {
  test('renders New Plan beside Import Issue when both hrefs are present', () => {
    const { body } = render(PlansList, {
      props: {
        plans: [],
        newPlanHref: '/projects/7/plans/new',
        importIssueHref: '/projects/7/import',
      },
    });

    expect(body).toContain('href="/projects/7/plans/new"');
    expect(body).toContain('New Plan');
    expect(body).toContain('href="/projects/7/import"');
    expect(body).toContain('Import Issue');
  });

  test('hides New Plan when no concrete project href is provided', () => {
    const { body } = render(PlansList, {
      props: {
        plans: [],
        newPlanHref: null,
        importIssueHref: null,
      },
    });

    expect(body).not.toContain('New Plan');
    expect(body).not.toContain('/plans/new');
  });
});
