import type { PrSummaryStatus } from '$lib/server/db_queries.js';

export function stateBadgeColor(state: string, draft: number): string {
  if (draft) return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  switch (state) {
    case 'merged':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
    case 'closed':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'open':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

export function stateLabel(state: string, draft: number): string {
  if (draft) return 'Draft';
  switch (state) {
    case 'merged':
      return 'Merged';
    case 'closed':
      return 'Closed';
    case 'open':
      return 'Open';
    default:
      return state;
  }
}

export function checksBadgeColor(rollupState: string | null): string {
  switch (rollupState) {
    case 'success':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'failure':
    case 'error':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'pending':
    case 'expected':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

export function checksLabel(rollupState: string | null): string {
  switch (rollupState) {
    case 'success':
      return 'Checks passing';
    case 'failure':
      return 'Checks failing';
    case 'error':
      return 'Checks error';
    case 'pending':
    case 'expected':
      return 'Checks pending';
    default:
      return 'No checks';
  }
}

export function labelStyle(color: string | null): string {
  if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) return '';
  const r = parseInt(color.slice(0, 2), 16);
  const g = parseInt(color.slice(2, 4), 16);
  const b = parseInt(color.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const textColor = luminance > 0.5 ? '#000' : '#fff';
  return `background-color: #${color}; color: ${textColor};`;
}

export function reviewDecisionBadgeColor(decision: string | null): string {
  switch (decision) {
    case 'APPROVED':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'CHANGES_REQUESTED':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'REVIEW_REQUIRED':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

export function reviewDecisionLabel(decision: string | null): string {
  switch (decision) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Changes Requested';
    case 'REVIEW_REQUIRED':
      return 'Review Required';
    default:
      return decision ?? '';
  }
}

export function checkRollupToSummaryStatus(rollupState: string | null): PrSummaryStatus {
  switch (rollupState) {
    case 'success':
      return 'passing';
    case 'failure':
    case 'error':
      return 'failing';
    case 'pending':
    case 'expected':
      return 'pending';
    default:
      return 'none';
  }
}
