import type { EnrichedInboxItem, InboxActionType } from '$lib/remote/inbox.remote.js';
import type { InboxItemKind } from '$tim/db/inbox_item.js';

export interface KindBadgeConfig {
  label: string;
  colorClasses: string;
}

const KIND_BADGE_CONFIG: Record<InboxItemKind, KindBadgeConfig> = {
  review_requested: {
    label: 'Review Requested',
    colorClasses: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  },
  pr_comment: {
    label: 'PR Comment',
    colorClasses: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  reviewed_pr_comment: {
    label: 'Reviewed PR Comment',
    colorClasses: 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300',
  },
  pr_approved: {
    label: 'PR Approved',
    colorClasses: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
  pr_merged: {
    label: 'PR Merged',
    colorClasses: 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300',
  },
  ci_failure: {
    label: 'CI Failure',
    colorClasses: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  },
  merge_queue_removed: {
    label: 'Merge Queue Removed',
    colorClasses: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  },
};

export function getKindBadge(kind: InboxItemKind): KindBadgeConfig {
  return KIND_BADGE_CONFIG[kind] ?? KIND_BADGE_CONFIG.pr_comment;
}

export interface ActionButtonConfig {
  label: string;
  type: 'launch' | 'external-link';
}

const ACTION_BUTTON_LABELS: Record<InboxActionType, ActionButtonConfig> = {
  'review-guide': { label: 'Run Review Guide', type: 'launch' },
  'pr-fix': { label: 'Fix PR', type: 'launch' },
  'ci-fix': { label: 'Fix CI', type: 'launch' },
  github: { label: 'View on GitHub', type: 'external-link' },
};

export function getActionButtonConfig(item: EnrichedInboxItem): ActionButtonConfig | null {
  if (!item.action.type) return null;
  return ACTION_BUTTON_LABELS[item.action.type] ?? null;
}

export function getEventCountLabel(item: EnrichedInboxItem): string | null {
  if (item.event_count <= 1) return null;
  const kind = item.kind;
  const NOUNS: Record<InboxItemKind, string> = {
    review_requested: 'request',
    pr_comment: 'comment',
    reviewed_pr_comment: 'comment',
    pr_approved: 'approval',
    pr_merged: 'merge',
    ci_failure: 'failure',
    merge_queue_removed: 'removal',
  };
  const noun = NOUNS[kind] ?? 'event';
  const plural = noun.endsWith('s') ? noun + 'es' : noun + 's';
  return `${item.event_count} ${plural}`;
}

export function formatAbsoluteTime(isoString: string): string {
  const date = new Date(isoString);
  return Number.isNaN(date.getTime()) ? isoString : date.toLocaleString();
}
