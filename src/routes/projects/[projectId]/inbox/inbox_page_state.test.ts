import { describe, expect, test } from 'vitest';

import type { EnrichedInboxItem } from '$lib/remote/inbox.remote.js';
import type { InboxItemKind } from '$tim/db/inbox_item.js';

import {
  formatAbsoluteTime,
  getActionButtonConfig,
  getEventCountLabel,
  getKindBadge,
} from './inbox_page_state.js';

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
    last_event_at: '2026-08-07T11:00:00.000Z',
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

describe('getKindBadge', () => {
  const ALL_KINDS: InboxItemKind[] = [
    'review_requested',
    'pr_comment',
    'reviewed_pr_comment',
    'pr_approved',
    'pr_merged',
    'ci_failure',
    'merge_queue_removed',
  ];

  test.each(ALL_KINDS)('returns a label and dark-mode color classes for %s', (kind) => {
    const badge = getKindBadge(kind);
    expect(badge.label.length).toBeGreaterThan(0);
    expect(badge.colorClasses).toContain('dark:');
    expect(badge.colorClasses).toMatch(/^bg-\S+ text-\S+ dark:bg-\S+ dark:text-\S+$/);
  });

  test('gives every kind a distinct label', () => {
    const labels = new Set(ALL_KINDS.map((kind) => getKindBadge(kind).label));
    expect(labels.size).toBe(ALL_KINDS.length);
  });

  test('falls back to the pr_comment badge for an unrecognized kind', () => {
    const badge = getKindBadge('not_a_real_kind' as InboxItemKind);
    expect(badge).toEqual(getKindBadge('pr_comment'));
  });
});

describe('getActionButtonConfig', () => {
  test('maps review_requested action to a launch button labeled Run Review Guide', () => {
    const item = makeItem({
      kind: 'review_requested',
      action: { type: 'review-guide', projectId: 7, prNumber: 42 },
    });
    expect(getActionButtonConfig(item)).toEqual({ label: 'Run Review Guide', type: 'launch' });
  });

  test('maps pr_comment action to a launch button labeled Fix PR', () => {
    const item = makeItem({
      kind: 'pr_comment',
      action: { type: 'pr-fix', projectId: 7, prNumber: 42 },
    });
    expect(getActionButtonConfig(item)).toEqual({ label: 'Fix PR', type: 'launch' });
  });

  test('maps ci_failure action to a launch button labeled Fix CI', () => {
    const item = makeItem({
      kind: 'ci_failure',
      action: { type: 'ci-fix', projectId: 7, prNumber: 42 },
    });
    expect(getActionButtonConfig(item)).toEqual({ label: 'Fix CI', type: 'launch' });
  });

  test('maps merge_queue_removed action to an external-link config', () => {
    const item = makeItem({
      kind: 'merge_queue_removed',
      action: { type: 'github', projectId: 7, prNumber: 42 },
    });
    expect(getActionButtonConfig(item)).toEqual({ label: 'View on GitHub', type: 'external-link' });
  });

  test.each<InboxItemKind>(['pr_approved', 'pr_merged', 'reviewed_pr_comment' as InboxItemKind])(
    'returns null when action.type is null (%s has no launch action)',
    (kind) => {
      const item = makeItem({ kind, action: { type: null, projectId: 7, prNumber: 42 } });
      expect(getActionButtonConfig(item)).toBeNull();
    }
  );
});

describe('getEventCountLabel', () => {
  test('returns null for a single event', () => {
    expect(getEventCountLabel(makeItem({ event_count: 1 }))).toBeNull();
  });

  test('returns null for a zero (or unexpectedly low) event count', () => {
    expect(getEventCountLabel(makeItem({ event_count: 0 }))).toBeNull();
  });

  test('pluralizes the per-kind noun for aggregated counts', () => {
    expect(getEventCountLabel(makeItem({ kind: 'pr_comment', event_count: 3 }))).toBe('3 comments');
    expect(getEventCountLabel(makeItem({ kind: 'review_requested', event_count: 2 }))).toBe(
      '2 requests'
    );
    expect(getEventCountLabel(makeItem({ kind: 'pr_approved', event_count: 4 }))).toBe(
      '4 approvals'
    );
    expect(getEventCountLabel(makeItem({ kind: 'pr_merged', event_count: 2 }))).toBe('2 merges');
    expect(getEventCountLabel(makeItem({ kind: 'ci_failure', event_count: 5 }))).toBe('5 failures');
    expect(getEventCountLabel(makeItem({ kind: 'merge_queue_removed', event_count: 2 }))).toBe(
      '2 removals'
    );
  });
});

describe('formatAbsoluteTime', () => {
  test('formats a valid ISO timestamp using toLocaleString', () => {
    const iso = '2026-08-07T11:00:00.000Z';
    expect(formatAbsoluteTime(iso)).toBe(new Date(iso).toLocaleString());
  });

  test('returns the original string for an invalid timestamp', () => {
    expect(formatAbsoluteTime('not-a-date')).toBe('not-a-date');
  });
});
