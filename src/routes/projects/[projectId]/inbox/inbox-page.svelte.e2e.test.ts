import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { EnrichedInboxItem, InboxItemsResponse } from '$lib/remote/inbox.remote.js';

const mocks = vi.hoisted(() => {
  const sessionCallbacks: Array<(eventName: string) => void> = [];
  const unsubscribe = vi.fn();

  return {
    inboxQuery: {
      current: null as unknown,
      error: null as unknown,
      loading: false,
      refresh: vi.fn(async (): Promise<void> => undefined),
    },
    getInboxItems: vi.fn(),
    markInboxItemsRead: vi.fn(async (): Promise<void> => undefined),
    markAllInboxItemsRead: vi.fn(async (): Promise<void> => undefined),
    dismissInboxItem: vi.fn(async (): Promise<void> => undefined),
    startPrReviewGuide: vi.fn(),
    startFixPrThreads: vi.fn(),
    startFixThreads: vi.fn(),
    startPrCiFix: vi.fn(),
    startCiFix: vi.fn(),
    goto: vi.fn(async (): Promise<void> => undefined),
    toast: {
      error: vi.fn(),
    },
    pageState: { params: { projectId: '7' } },
    sessionCallbacks,
    unsubscribe,
    sessionManager: {
      onEvent: vi.fn((callback: (eventName: string) => void): (() => void) => {
        sessionCallbacks.push(callback);
        return unsubscribe;
      }),
    },
  };
});

vi.mock('$app/navigation', () => ({
  goto: mocks.goto,
}));

vi.mock('$app/state', () => ({
  page: mocks.pageState,
}));

vi.mock('$lib/remote/inbox.remote.js', () => ({
  getInboxItems: mocks.getInboxItems,
  markInboxItemsRead: mocks.markInboxItemsRead,
  markAllInboxItemsRead: mocks.markAllInboxItemsRead,
  dismissInboxItem: mocks.dismissInboxItem,
}));

vi.mock('$lib/remote/review_thread_actions.remote.js', () => ({
  startPrReviewGuide: mocks.startPrReviewGuide,
  startFixPrThreads: mocks.startFixPrThreads,
  startFixThreads: mocks.startFixThreads,
  startPrCiFix: mocks.startPrCiFix,
  startCiFix: mocks.startCiFix,
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => mocks.sessionManager,
}));

vi.mock('svelte-sonner', () => ({
  toast: mocks.toast,
}));

import InboxPage from './+page.svelte';

let unmountRendered: (() => void) | null = null;

function makeItem(overrides: Partial<EnrichedInboxItem> = {}): EnrichedInboxItem {
  return {
    id: 1,
    project_id: 7,
    kind: 'pr_comment',
    pr_url: 'https://github.com/owner/repo/pull/42',
    pr_number: 42,
    repo: 'owner/repo',
    pr_title: 'Fix the widget',
    actor: 'alice',
    event_count: 1,
    summary: 'A comment',
    dedupe_key: 'pr_comment:https://github.com/owner/repo/pull/42',
    first_event_at: '2026-08-07T10:00:00.000Z',
    last_event_at: new Date(Date.now() - 120_000).toISOString(),
    created_at: '2026-08-07T10:00:00.000Z',
    updated_at: '2026-08-07T10:00:00.000Z',
    read_at: null,
    dismissed_at: null,
    viewHref: { href: '/projects/7/prs/42', external: false },
    planHref: null,
    action: { type: 'pr-fix', projectId: 7, prNumber: 42 },
    ...overrides,
  };
}

function makeResponse(overrides: Partial<InboxItemsResponse> = {}): InboxItemsResponse {
  return { items: [], unreadCount: 0, totalCount: 0, ...overrides };
}

function renderPage(response: InboxItemsResponse | null): void {
  mocks.inboxQuery.current = response;
  mocks.getInboxItems.mockReturnValue(mocks.inboxQuery);
  unmountRendered = render(InboxPage).unmount;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inboxQuery.current = null;
  mocks.inboxQuery.error = null;
  mocks.inboxQuery.loading = false;
  mocks.inboxQuery.refresh.mockReset();
  mocks.inboxQuery.refresh.mockResolvedValue(undefined);
  mocks.markInboxItemsRead.mockReset();
  mocks.markInboxItemsRead.mockResolvedValue(undefined);
  mocks.markAllInboxItemsRead.mockReset();
  mocks.markAllInboxItemsRead.mockResolvedValue(undefined);
  mocks.dismissInboxItem.mockReset();
  mocks.dismissInboxItem.mockResolvedValue(undefined);
  mocks.startPrReviewGuide.mockReset();
  mocks.startFixPrThreads.mockReset();
  mocks.startFixThreads.mockReset();
  mocks.startPrCiFix.mockReset();
  mocks.startCiFix.mockReset();
  mocks.toast.error.mockReset();
  mocks.sessionCallbacks.length = 0;
  mocks.pageState.params.projectId = '7';
});

afterEach(() => {
  unmountRendered?.();
  unmountRendered = null;
});

describe('inbox full page', () => {
  test('requests items with includeRead for the current project and shows unread/total counts', async () => {
    renderPage(
      makeResponse({
        items: [makeItem({ id: 1 }), makeItem({ id: 2, read_at: '2026-08-07T12:00:00.000Z' })],
        unreadCount: 1,
        totalCount: 2,
      })
    );

    expect(mocks.getInboxItems).toHaveBeenCalledWith({ projectId: '7', includeRead: true });
    await expect.element(page.getByText('1 unread · 2 total')).toBeVisible();
  });

  test('renders kind badges and sorted rows without marking anything read on load', async () => {
    const reviewRequested = makeItem({
      id: 1,
      kind: 'review_requested',
      pr_title: 'Needs review',
      action: { type: 'review-guide', projectId: 7, prNumber: 42 },
    });
    const ciFailure = makeItem({
      id: 2,
      kind: 'ci_failure',
      pr_title: 'Broken build',
      action: { type: 'ci-fix', projectId: 7, prNumber: 43 },
    });

    renderPage(makeResponse({ items: [reviewRequested, ciFailure], unreadCount: 2 }));

    await expect.element(page.getByText('Review Requested', { exact: true })).toBeVisible();
    await expect.element(page.getByText('CI Failure', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Needs review', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Broken build', { exact: true })).toBeVisible();
    expect(mocks.markInboxItemsRead).not.toHaveBeenCalled();
  });

  test('shows unread visual indicator only for unread rows', async () => {
    const unreadItem = makeItem({ id: 1, pr_title: 'Unread row' });
    const readItem = makeItem({
      id: 2,
      pr_title: 'Read row',
      read_at: '2026-08-07T12:00:00.000Z',
    });
    renderPage(makeResponse({ items: [unreadItem, readItem], unreadCount: 1 }));

    await expect
      .element(page.getByRole('row', { name: /Unread row/ }).getByRole('img', { name: 'Unread' }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('row', { name: /Read row/ }).getByRole('img', { name: 'Unread' }))
      .not.toBeInTheDocument();
  });

  test('shows the aggregated event count label when event_count is greater than 1', async () => {
    renderPage(
      makeResponse({
        items: [makeItem({ kind: 'pr_comment', event_count: 3 })],
        unreadCount: 1,
      })
    );

    await expect.element(page.getByText(/3 comments/)).toBeVisible();
  });

  test('does not show an event count label for a single event', async () => {
    renderPage(makeResponse({ items: [makeItem({ event_count: 1 })], unreadCount: 1 }));

    await expect.element(page.getByText('Fix the widget', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/\d+ comments/)).not.toBeInTheDocument();
  });

  test('renders an internal view link that marks the item read and navigates client-side', async () => {
    renderPage(makeResponse({ items: [makeItem({ id: 9 })], unreadCount: 1 }));

    await page.getByRole('button', { name: 'View' }).click();

    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [9] });
    expect(mocks.goto).toHaveBeenCalledWith('/projects/7/prs/42');
  });

  test('renders an external view link with target=_blank and marks it read on click', async () => {
    const item = makeItem({
      id: 10,
      kind: 'merge_queue_removed',
      viewHref: { href: 'https://github.com/owner/repo/pull/42', external: true },
      action: { type: 'github', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    const link = page.getByRole('link', { name: 'View ↗' });
    await expect.element(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');

    await link.click();
    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [10] });
  });

  test('merge_queue_removed with a locally-known PR shows both internal View and external GitHub link', async () => {
    const item = makeItem({
      id: 30,
      kind: 'merge_queue_removed',
      viewHref: { href: '/projects/7/prs/42', external: false },
      action: { type: 'github', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await expect.element(page.getByRole('button', { name: 'View' })).toBeVisible();

    const githubLink = page.getByRole('link', { name: /View on GitHub/ });
    await expect
      .element(githubLink)
      .toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    await expect.element(githubLink).toHaveAttribute('target', '_blank');
    await expect.element(githubLink).toHaveAttribute('rel', 'noopener noreferrer');

    await githubLink.click();
    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [30] });
  });

  test('review_requested rows show a Run Review Guide button that launches and marks read', async () => {
    mocks.startPrReviewGuide.mockResolvedValue({ status: 'started' });
    const item = makeItem({
      id: 11,
      kind: 'review_requested',
      action: { type: 'review-guide', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Run Review Guide' }).click();

    await expect.poll(() => mocks.startPrReviewGuide.mock.calls.length).toBe(1);
    expect(mocks.startPrReviewGuide).toHaveBeenCalledWith({ projectId: 7, prNumber: 42 });
    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [11] });
    await expect.element(page.getByText('Started', { exact: true })).toBeVisible();
  });

  test('pr_comment rows show a Fix PR button using startFixPrThreads by default', async () => {
    mocks.startFixPrThreads.mockResolvedValue({ status: 'started' });
    const item = makeItem({
      id: 12,
      kind: 'pr_comment',
      action: { type: 'pr-fix', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Fix PR' }).click();

    await expect.poll(() => mocks.startFixPrThreads.mock.calls.length).toBe(1);
    expect(mocks.startFixPrThreads).toHaveBeenCalledWith({ projectId: 7, prNumber: 42 });
    expect(mocks.startFixThreads).not.toHaveBeenCalled();
  });

  test('prefers startFixThreads with planUuid when the enriched item carries one', async () => {
    mocks.startFixThreads.mockResolvedValue({ status: 'started' });
    const item = makeItem({
      id: 13,
      kind: 'pr_comment',
      action: { type: 'pr-fix', projectId: 7, prNumber: 42, planUuid: 'plan-abc' },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Fix PR' }).click();

    await expect.poll(() => mocks.startFixThreads.mock.calls.length).toBe(1);
    expect(mocks.startFixThreads).toHaveBeenCalledWith({ planUuid: 'plan-abc' });
    expect(mocks.startFixPrThreads).not.toHaveBeenCalled();
  });

  test('ci_failure rows show a Fix CI button using startPrCiFix by default and startCiFix with a planUuid', async () => {
    mocks.startPrCiFix.mockResolvedValue({ status: 'started' });
    const item = makeItem({
      id: 14,
      kind: 'ci_failure',
      action: { type: 'ci-fix', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Fix CI' }).click();
    await expect.poll(() => mocks.startPrCiFix.mock.calls.length).toBe(1);
    expect(mocks.startPrCiFix).toHaveBeenCalledWith({ projectId: 7, prNumber: 42 });

    unmountRendered?.();
    unmountRendered = null;
    mocks.startPrCiFix.mockClear();
    mocks.startCiFix.mockResolvedValue({ status: 'started' });
    const planItem = makeItem({
      id: 15,
      kind: 'ci_failure',
      action: { type: 'ci-fix', projectId: 7, prNumber: 42, planUuid: 'plan-xyz' },
    });
    renderPage(makeResponse({ items: [planItem], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Fix CI' }).click();
    await expect.poll(() => mocks.startCiFix.mock.calls.length).toBe(1);
    expect(mocks.startCiFix).toHaveBeenCalledWith({ planUuid: 'plan-xyz' });
    expect(mocks.startPrCiFix).not.toHaveBeenCalled();
  });

  test.each(['pr_approved', 'pr_merged', 'reviewed_pr_comment'] as const)(
    '%s rows show a view link but no launch/action button',
    async (kind) => {
      const item = makeItem({ id: 20, kind, action: { type: null, projectId: 7, prNumber: 42 } });
      renderPage(makeResponse({ items: [item], unreadCount: 1 }));

      await expect.element(page.getByRole('button', { name: 'View' })).toBeVisible();
      await expect
        .element(page.getByRole('button', { name: /Run Review Guide|Fix PR|Fix CI/ }))
        .not.toBeInTheDocument();
    }
  );

  test('navigates to the session page on already_running and does not double-launch', async () => {
    mocks.startPrReviewGuide.mockResolvedValue({
      status: 'already_running',
      connectionId: 'conn-1',
    });
    const item = makeItem({
      id: 16,
      kind: 'review_requested',
      action: { type: 'review-guide', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Run Review Guide' }).click();

    await expect.poll(() => mocks.goto.mock.calls.length).toBe(1);
    expect(mocks.goto).toHaveBeenCalledWith('/projects/7/sessions/conn-1');
    await expect.element(page.getByText('Already running', { exact: true })).toBeVisible();

    await page.getByText('Already running', { exact: true }).click();
    expect(mocks.startPrReviewGuide).toHaveBeenCalledTimes(1);
  });

  test('shows Retry with error message when goto rejects on already_running, and Retry works', async () => {
    mocks.startPrReviewGuide.mockResolvedValue({
      status: 'already_running',
      connectionId: 'conn-1',
    });
    mocks.goto.mockRejectedValueOnce(new Error('navigation failed'));
    const item = makeItem({
      id: 17,
      kind: 'review_requested',
      action: { type: 'review-guide', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Run Review Guide' }).click();

    // The failed navigation must surface a Retry button right away, not leave the row
    // stuck showing "Already running" until the 30s auto-clear timeout.
    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect
      .element(page.getByText('Already running', { exact: true }))
      .not.toBeInTheDocument();
    // The navigation error message must be visible in an accessible alert element.
    await expect.element(page.getByRole('alert')).toBeVisible();
    await expect.element(page.getByText('navigation failed')).toBeVisible();

    mocks.goto.mockResolvedValueOnce(undefined);
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => mocks.startPrReviewGuide.mock.calls.length).toBe(2);
    await expect.poll(() => mocks.goto.mock.calls.length).toBe(2);
    await expect.element(page.getByText('Already running', { exact: true })).toBeVisible();
    // Error should be cleared after successful retry
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });

  test('clicking Mark all read scopes the command to the current route project', async () => {
    renderPage(makeResponse({ items: [makeItem()], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Mark all read' }).click();

    expect(mocks.markAllInboxItemsRead).toHaveBeenCalledWith({ projectId: '7' });
  });

  test('scopes Mark all read to all projects on the /projects/all/inbox route', async () => {
    mocks.pageState.params.projectId = 'all';
    renderPage(makeResponse({ items: [makeItem()], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Mark all read' }).click();

    expect(mocks.markAllInboxItemsRead).toHaveBeenCalledWith({ projectId: 'all' });
  });

  test('does not show Mark all read when there are no unread items', async () => {
    renderPage(
      makeResponse({ items: [makeItem({ read_at: '2026-08-07T12:00:00.000Z' })], unreadCount: 0 })
    );

    await expect
      .element(page.getByRole('button', { name: 'Mark all read' }))
      .not.toBeInTheDocument();
  });

  test('dismissing a row calls dismissInboxItem with its id', async () => {
    renderPage(makeResponse({ items: [makeItem({ id: 21 })], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Dismiss notification' }).click();

    expect(mocks.dismissInboxItem).toHaveBeenCalledWith({ id: 21 });
  });

  test('shows an empty state box when there are no items', async () => {
    renderPage(makeResponse());

    await expect.element(page.getByText('No inbox notifications.')).toBeVisible();
  });

  test('shows a loading indicator during initial load and not the empty state', async () => {
    mocks.inboxQuery.current = null;
    mocks.inboxQuery.loading = true;
    mocks.inboxQuery.error = null;
    mocks.getInboxItems.mockReturnValue(mocks.inboxQuery);
    unmountRendered = render(InboxPage).unmount;

    await expect.element(page.getByText('Loading inbox...')).toBeVisible();
    await expect.element(page.getByText('No inbox notifications.')).not.toBeInTheDocument();
  });

  test('shows a refresh error banner with retry while preserving cached items', async () => {
    const items = [makeItem({ id: 1, pr_title: 'Cached item' })];
    mocks.inboxQuery.current = makeResponse({ items, unreadCount: 1, totalCount: 1 });
    mocks.inboxQuery.error = new Error('Connection lost');
    mocks.inboxQuery.loading = false;
    mocks.getInboxItems.mockReturnValue(mocks.inboxQuery);
    unmountRendered = render(InboxPage).unmount;

    await expect.element(page.getByRole('alert')).toBeVisible();
    await expect.element(page.getByText(/Failed to refresh inbox/)).toBeVisible();
    await expect.element(page.getByText('Connection lost')).toBeVisible();

    await expect.element(page.getByText('Cached item', { exact: true })).toBeVisible();
    await expect.element(page.getByText('1 unread · 1 total')).toBeVisible();

    await expect.element(page.getByText('No inbox notifications.')).not.toBeInTheDocument();

    await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(1);
  });

  test('shows an error message with retry button when the query fails', async () => {
    mocks.inboxQuery.current = null;
    mocks.inboxQuery.loading = false;
    mocks.inboxQuery.error = new Error('Network timeout');
    mocks.getInboxItems.mockReturnValue(mocks.inboxQuery);
    unmountRendered = render(InboxPage).unmount;

    await expect.element(page.getByText(/Failed to load inbox/)).toBeVisible();
    await expect.element(page.getByText('No inbox notifications.')).not.toBeInTheDocument();

    await page.getByRole('button', { name: 'Retry' }).click();
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(1);
  });

  test('refreshes the query on inbox:updated SSE events and on the polling fallback', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    renderPage(makeResponse());

    expect(mocks.sessionManager.onEvent).toHaveBeenCalledTimes(1);
    const intervalCall = setIntervalSpy.mock.calls.at(-1);
    const intervalId = setIntervalSpy.mock.results.at(-1)?.value;
    expect(intervalCall?.[1]).toBe(60_000);

    mocks.sessionCallbacks[0]?.('inbox:updated');
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(1);

    mocks.sessionCallbacks[0]?.('session:update');
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(1);

    const pollCallback = intervalCall?.[0] as (() => void) | undefined;
    pollCallback?.();
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(2);

    unmountRendered?.();
    unmountRendered = null;

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  test('shows the error message and Retry when a launch command rejects', async () => {
    mocks.startPrCiFix.mockRejectedValueOnce(new Error('spawn failed'));
    const item = makeItem({
      id: 22,
      kind: 'ci_failure',
      action: { type: 'ci-fix', projectId: 7, prNumber: 42 },
    });
    renderPage(makeResponse({ items: [item], unreadCount: 1 }));

    await page.getByRole('button', { name: 'Fix CI' }).click();

    await expect.element(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect.element(page.getByRole('alert')).toBeVisible();
    await expect.element(page.getByText('spawn failed')).toBeVisible();

    // Retry succeeds
    mocks.startPrCiFix.mockResolvedValueOnce({ status: 'started' });
    await page.getByRole('button', { name: 'Retry' }).click();

    await expect.poll(() => mocks.startPrCiFix.mock.calls.length).toBe(2);
    await expect.element(page.getByText('Started', { exact: true })).toBeVisible();
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
  });
});
