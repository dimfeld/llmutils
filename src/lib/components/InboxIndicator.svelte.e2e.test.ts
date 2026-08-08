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
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => mocks.sessionManager,
}));

vi.mock('svelte-sonner', () => ({
  toast: mocks.toast,
}));

import InboxIndicator from './InboxIndicator.svelte';

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
  return { items: [], unreadCount: 0, ...overrides };
}

function renderIndicator(response: InboxItemsResponse | null): void {
  mocks.inboxQuery.current = response;
  mocks.getInboxItems.mockReturnValue(mocks.inboxQuery);
  unmountRendered = render(InboxIndicator).unmount;
}

async function openPopover(): Promise<void> {
  await page.getByRole('button', { name: /inbox/i }).first().click();
  await expect.element(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
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
  mocks.toast.error.mockReset();
  mocks.sessionCallbacks.length = 0;
  mocks.pageState.params.projectId = '7';
});

afterEach(() => {
  unmountRendered?.();
  unmountRendered = null;
});

describe('InboxIndicator browser behavior', () => {
  test('renders the unread badge and popup rows without marking items read on open', async () => {
    const internalItem = makeItem({ event_count: 3 });
    const externalItem = makeItem({
      id: 2,
      project_id: 8,
      kind: 'merge_queue_removed',
      pr_url: 'https://github.com/other/repo/pull/8',
      pr_number: 8,
      repo: 'other/repo',
      pr_title: 'External PR',
      actor: 'bob',
      viewHref: { href: 'https://github.com/other/repo/pull/8', external: true },
      action: { type: 'github', projectId: 8, prNumber: 8 },
    });

    renderIndicator(makeResponse({ items: [internalItem, externalItem], unreadCount: 2 }));

    await expect.element(page.getByRole('button', { name: '2 unread inbox items' })).toBeVisible();
    await openPopover();

    await expect.element(page.getByText('Fix the widget', { exact: true })).toBeVisible();
    await expect.element(page.getByText('PR comment', { exact: true })).toBeVisible();
    await expect.element(page.getByText('3 comments', { exact: true })).toBeVisible();
    await expect.element(page.getByText('owner/repo · alice', { exact: true })).toBeVisible();
    await expect.element(page.getByText('External PR', { exact: true })).toBeVisible();
    await expect.element(page.getByText('Removed from merge queue', { exact: true })).toBeVisible();
    await expect.element(page.getByText(/minutes? ago|just now/).first()).toBeVisible();
    await expect
      .element(
        page.getByRole('button', { name: /Fix the widget/ }).getByRole('img', { name: 'Unread' })
      )
      .toBeInTheDocument();

    expect(mocks.markInboxItemsRead).not.toHaveBeenCalled();
  });

  test('marks all visible inbox items read from the popup', async () => {
    renderIndicator(makeResponse({ items: [makeItem()], unreadCount: 1 }));
    await openPopover();

    await page.getByRole('button', { name: 'Mark all inbox items as read' }).click();

    expect(mocks.markAllInboxItemsRead).toHaveBeenCalledWith({ projectId: 'all' });
  });

  test('reports a rejected command through the shared toast path', async () => {
    mocks.markAllInboxItemsRead.mockRejectedValueOnce(new Error('server unavailable'));
    renderIndicator(makeResponse({ items: [makeItem()], unreadCount: 1 }));
    await openPopover();

    await page.getByRole('button', { name: 'Mark all inbox items as read' }).click();
    await expect.poll(() => mocks.toast.error.mock.calls.length).toBe(1);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Failed to mark all inbox items as read: server unavailable'
    );
  });

  test('extracts the message from a structured HttpError body', async () => {
    const structuredError = { body: { message: 'project not found' } };
    mocks.markAllInboxItemsRead.mockRejectedValueOnce(structuredError);
    renderIndicator(makeResponse({ items: [makeItem()], unreadCount: 1 }));
    await openPopover();

    await page.getByRole('button', { name: 'Mark all inbox items as read' }).click();
    await expect.poll(() => mocks.toast.error.mock.calls.length).toBe(1);
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Failed to mark all inbox items as read: project not found'
    );
  });

  test('marks an internal row read, closes the popover, and navigates to its internal href', async () => {
    renderIndicator(makeResponse({ items: [makeItem()], unreadCount: 1 }));
    await openPopover();

    await page.getByRole('button', { name: /Fix the widget/ }).click();

    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [1] });
    expect(mocks.goto).toHaveBeenCalledWith('/projects/7/prs/42');
    await expect.element(page.getByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  test('renders an external row as a new-tab link and marks it read on click', async () => {
    const item = makeItem({
      kind: 'merge_queue_removed',
      viewHref: { href: 'https://github.com/owner/repo/pull/42', external: true },
      action: { type: 'github', projectId: 7, prNumber: 42 },
    });
    renderIndicator(makeResponse({ items: [item], unreadCount: 1 }));
    await openPopover();

    const link = page.getByRole('link', { name: /Fix the widget/ });
    await expect.element(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    await expect.element(link).toHaveAttribute('target', '_blank');
    await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer');

    await link.click();

    expect(mocks.markInboxItemsRead).toHaveBeenCalledWith({ ids: [1] });
  });

  test('shows the caught-up state and no badge when there are no items', async () => {
    renderIndicator(makeResponse());

    await expect.element(page.getByRole('button', { name: 'No unread inbox items' })).toBeVisible();
    await openPopover();

    await expect.element(page.getByText('All caught up', { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Mark all inbox items as read' }))
      .not.toBeInTheDocument();
  });

  test('shows a distinct loading state while the inbox query is pending', async () => {
    mocks.inboxQuery.loading = true;
    renderIndicator(null);

    await expect.element(page.getByRole('button', { name: 'Loading inbox' })).toBeVisible();
    await openPopover();
    await expect.element(page.getByText('Loading inbox…', { exact: true })).toBeVisible();
    await expect.element(page.getByText('All caught up', { exact: true })).not.toBeInTheDocument();
  });

  test('shows a rejected query state and provides a retry action', async () => {
    mocks.inboxQuery.error = new Error('query failed');
    renderIndicator(null);

    await expect.element(page.getByRole('button', { name: 'Inbox unavailable' })).toBeVisible();
    await openPopover();
    await expect.element(page.getByRole('alert')).toBeVisible();
    await expect
      .element(page.getByText('Unable to load the inbox.', { exact: true }))
      .toBeVisible();

    await page.getByRole('button', { name: 'Retry loading inbox' }).click();
    expect(mocks.inboxQuery.refresh).toHaveBeenCalledTimes(1);
  });

  test('uses the current project for the footer link, then falls back to the first row project', async () => {
    renderIndicator(makeResponse({ items: [makeItem({ project_id: 8 })], unreadCount: 1 }));
    await openPopover();
    await expect
      .element(page.getByRole('link', { name: 'View all notifications' }))
      .toHaveAttribute('href', '/projects/7/inbox');

    unmountRendered?.();
    unmountRendered = null;
    mocks.pageState.params.projectId = undefined;
    renderIndicator(makeResponse({ items: [makeItem({ project_id: 8 })], unreadCount: 1 }));
    await openPopover();
    await expect
      .element(page.getByRole('link', { name: 'View all notifications' }))
      .toHaveAttribute('href', '/projects/8/inbox');
  });

  test('preserves the all-project footer target with rows and in the empty state', async () => {
    mocks.pageState.params.projectId = 'all';
    renderIndicator(makeResponse({ items: [makeItem({ project_id: 8 })], unreadCount: 1 }));
    await openPopover();
    await expect
      .element(page.getByRole('link', { name: 'View all notifications' }))
      .toHaveAttribute('href', '/projects/all/inbox');

    unmountRendered?.();
    unmountRendered = null;
    renderIndicator(makeResponse());
    await openPopover();
    await expect
      .element(page.getByRole('link', { name: 'View all notifications' }))
      .toHaveAttribute('href', '/projects/all/inbox');
  });

  test('closes the popover when the footer link is clicked', async () => {
    renderIndicator(makeResponse({ items: [makeItem()], unreadCount: 1 }));
    await openPopover();

    await page.getByRole('link', { name: 'View all notifications' }).click();

    await expect.element(page.getByRole('heading', { name: 'Inbox' })).not.toBeInTheDocument();
  });

  test('refreshes on inbox SSE events and cleans up the subscription and polling timer', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    renderIndicator(makeResponse());

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
});
