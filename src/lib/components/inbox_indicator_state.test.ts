import { describe, expect, test } from 'vitest';

import type { EnrichedInboxItem, InboxItemsResponse } from '$lib/remote/inbox.remote.js';
import type { InboxItemKind } from '$tim/db/inbox_item.js';
import { getInboxIndicatorState, getInboxRowDisplay } from './inbox_indicator_state.js';

function makeResponse(overrides: Partial<InboxItemsResponse> = {}): InboxItemsResponse {
  return {
    items: [],
    unreadCount: 0,
    ...overrides,
  };
}

function makeItem(overrides: Partial<EnrichedInboxItem> = {}): EnrichedInboxItem {
  return {
    id: 1,
    project_id: 1,
    kind: 'pr_comment',
    pr_url: 'https://github.com/owner/repo/pull/42',
    pr_number: 42,
    repo: 'owner/repo',
    pr_title: 'Fix the widget',
    actor: 'somedev',
    event_count: 1,
    summary: 'A comment',
    dedupe_key: 'pr_comment:https://github.com/owner/repo/pull/42',
    first_event_at: '2026-08-07T10:00:00.000Z',
    last_event_at: '2026-08-07T12:00:00.000Z',
    created_at: '2026-08-07T10:00:00.000Z',
    updated_at: '2026-08-07T12:00:00.000Z',
    read_at: null,
    dismissed_at: null,
    viewHref: { href: '/projects/1/prs/42', external: false },
    planHref: null,
    action: { type: 'pr-fix', projectId: 1, prNumber: 42 },
    ...overrides,
  };
}

describe('getInboxIndicatorState', () => {
  test('returns defaults for null input', () => {
    const result = getInboxIndicatorState(null);
    expect(result).toEqual({ unreadCount: 0, label: 'Inbox', hasUnread: false });
  });

  test('returns defaults for undefined input', () => {
    const result = getInboxIndicatorState(undefined);
    expect(result).toEqual({ unreadCount: 0, label: 'Inbox', hasUnread: false });
  });

  test('zero unread shows no-unread label', () => {
    const result = getInboxIndicatorState(makeResponse({ unreadCount: 0 }));
    expect(result.hasUnread).toBe(false);
    expect(result.label).toBe('No unread inbox items');
    expect(result.unreadCount).toBe(0);
  });

  test('singular unread count', () => {
    const result = getInboxIndicatorState(makeResponse({ unreadCount: 1 }));
    expect(result.hasUnread).toBe(true);
    expect(result.label).toBe('1 unread inbox item');
    expect(result.unreadCount).toBe(1);
  });

  test('plural unread count', () => {
    const result = getInboxIndicatorState(makeResponse({ unreadCount: 5 }));
    expect(result.hasUnread).toBe(true);
    expect(result.label).toBe('5 unread inbox items');
    expect(result.unreadCount).toBe(5);
  });
});

describe('getInboxRowDisplay', () => {
  test('pr_comment kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'pr_comment' }));
    expect(result.kindLabel).toBe('PR comment');
    expect(result.kindIconKey).toBe('message-circle');
  });

  test('review_requested kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'review_requested' }));
    expect(result.kindLabel).toBe('Review requested');
    expect(result.kindIconKey).toBe('eye');
  });

  test('reviewed_pr_comment kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'reviewed_pr_comment' }));
    expect(result.kindLabel).toBe('Comment on reviewed PR');
    expect(result.kindIconKey).toBe('message-circle');
  });

  test('pr_merged kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'pr_merged' }));
    expect(result.kindLabel).toBe('PR merged');
    expect(result.kindIconKey).toBe('git-merge');
  });

  test('pr_approved kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'pr_approved' }));
    expect(result.kindLabel).toBe('PR approved');
    expect(result.kindIconKey).toBe('check');
  });

  test('ci_failure kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'ci_failure' }));
    expect(result.kindLabel).toBe('CI failure');
    expect(result.kindIconKey).toBe('circle-x');
  });

  test('merge_queue_removed kind', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'merge_queue_removed' }));
    expect(result.kindLabel).toBe('Removed from merge queue');
    expect(result.kindIconKey).toBe('list-x');
  });

  test('countLabel is null when event_count is 1', () => {
    const result = getInboxRowDisplay(makeItem({ event_count: 1 }));
    expect(result.countLabel).toBeNull();
  });

  test('countLabel shows plural for event_count > 1', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'pr_comment', event_count: 3 }));
    expect(result.countLabel).toBe('3 comments');
  });

  test('countLabel pluralizes requests correctly', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'review_requested', event_count: 2 }));
    expect(result.countLabel).toBe('2 requests');
  });

  test('countLabel pluralizes failures correctly', () => {
    const result = getInboxRowDisplay(makeItem({ kind: 'ci_failure', event_count: 4 }));
    expect(result.countLabel).toBe('4 failures');
  });

  test('title uses pr_title when available', () => {
    const result = getInboxRowDisplay(makeItem({ pr_title: 'My PR' }));
    expect(result.title).toBe('My PR');
  });

  test('title falls back to pr_url when pr_title is null', () => {
    const result = getInboxRowDisplay(
      makeItem({ pr_title: null, pr_url: 'https://github.com/o/r/pull/1' })
    );
    expect(result.title).toBe('https://github.com/o/r/pull/1');
  });

  test('subtitle combines repo and actor', () => {
    const result = getInboxRowDisplay(makeItem({ repo: 'owner/repo', actor: 'dev' }));
    expect(result.subtitle).toBe('owner/repo · dev');
  });

  test('subtitle with repo only', () => {
    const result = getInboxRowDisplay(makeItem({ repo: 'owner/repo', actor: null }));
    expect(result.subtitle).toBe('owner/repo');
  });

  test('subtitle with actor only', () => {
    const result = getInboxRowDisplay(makeItem({ repo: null, actor: 'dev' }));
    expect(result.subtitle).toBe('dev');
  });

  test('subtitle is empty when both are null', () => {
    const result = getInboxRowDisplay(makeItem({ repo: null, actor: null }));
    expect(result.subtitle).toBe('');
  });
});
