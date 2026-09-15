import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PlanListItem } from '$lib/server/db_queries.js';
import PlansList from './PlansList.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({ page: { params: { projectId: '7' } } }));
vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({ sessions: new Map() }),
}));

function plan(uuid: string, status: PlanListItem['status']): PlanListItem {
  return {
    uuid,
    projectId: 7,
    planId: uuid === 'later' ? 1 : 2,
    title: uuid === 'later' ? 'Review this later' : 'Review this now',
    goal: null,
    status,
    displayStatus: status,
    priority: null,
    epic: false,
    updatedAt: '2026-09-15T00:00:00.000Z',
    hasPullRequests: false,
    prSummaryStatus: 'none',
    depsFullyResolved: true,
    taskCounts: { done: 1, total: 1 },
    reviewIssueCount: 0,
  };
}

test('the deferred review filter opens the group and shows only deferred reviews', async (): Promise<void> => {
  render(PlansList, {
    props: { plans: [plan('later', 'review_deferred'), plan('now', 'needs_review')] },
  });
  await expect
    .element(page.getByRole('link', { name: /Review this later/ }))
    .not.toBeInTheDocument();
  await page.getByRole('button', { name: 'Review deferred 1', exact: true }).click();
  await expect.element(page.getByRole('link', { name: /Review this later/ })).toBeVisible();
  await expect.element(page.getByRole('link', { name: /Review this now/ })).not.toBeInTheDocument();
});
