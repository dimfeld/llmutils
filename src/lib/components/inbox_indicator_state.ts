import type { InboxItemsResponse, EnrichedInboxItem } from '$lib/remote/inbox.remote.js';
import type { InboxItemKind } from '$tim/db/inbox_item.js';

export interface InboxIndicatorState {
  unreadCount: number;
  label: string;
  hasUnread: boolean;
}

export interface InboxRowDisplay {
  kindLabel: string;
  kindIconKey: InboxKindIconKey;
  countLabel: string | null;
  title: string;
  subtitle: string;
}

export type InboxKindIconKey =
  | 'eye'
  | 'message-circle'
  | 'git-merge'
  | 'check'
  | 'circle-x'
  | 'list-x';

const KIND_CONFIG: Record<
  InboxItemKind,
  { label: string; iconKey: InboxKindIconKey; countNoun: string }
> = {
  review_requested: { label: 'Review requested', iconKey: 'eye', countNoun: 'request' },
  pr_comment: { label: 'PR comment', iconKey: 'message-circle', countNoun: 'comment' },
  reviewed_pr_comment: {
    label: 'Comment on reviewed PR',
    iconKey: 'message-circle',
    countNoun: 'comment',
  },
  pr_merged: { label: 'PR merged', iconKey: 'git-merge', countNoun: 'merge' },
  pr_approved: { label: 'PR approved', iconKey: 'check', countNoun: 'approval' },
  ci_failure: { label: 'CI failure', iconKey: 'circle-x', countNoun: 'failure' },
  merge_queue_removed: {
    label: 'Removed from merge queue',
    iconKey: 'list-x',
    countNoun: 'removal',
  },
};

export function getInboxIndicatorState(
  data: InboxItemsResponse | null | undefined
): InboxIndicatorState {
  if (!data) {
    return { unreadCount: 0, label: 'Inbox', hasUnread: false };
  }

  const { unreadCount } = data;
  if (unreadCount === 0) {
    return { unreadCount: 0, label: 'No unread inbox items', hasUnread: false };
  }

  const label = unreadCount === 1 ? '1 unread inbox item' : `${unreadCount} unread inbox items`;
  return { unreadCount, label, hasUnread: true };
}

export function getInboxRowDisplay(item: EnrichedInboxItem): InboxRowDisplay {
  const config = KIND_CONFIG[item.kind] ?? KIND_CONFIG.pr_comment;

  let countLabel: string | null = null;
  if (item.event_count > 1) {
    const noun = config.countNoun;
    const plural = noun.endsWith('s') ? noun + 'es' : noun + 's';
    countLabel = `${item.event_count} ${plural}`;
  }

  const title = item.pr_title ?? item.pr_url;
  const parts: string[] = [];
  if (item.repo) parts.push(item.repo);
  if (item.actor) parts.push(item.actor);
  const subtitle = parts.join(' · ');

  return {
    kindLabel: config.label,
    kindIconKey: config.iconKey,
    countLabel,
    title,
    subtitle,
  };
}
