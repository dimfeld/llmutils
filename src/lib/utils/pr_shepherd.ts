// Relative imports: the CLI reaches this module through the webhook ingest orchestrator,
// and the CLI build does not resolve the SvelteKit path aliases.
import { getEffectiveReviewDecision, isPrApproved } from '../../common/github/review_requests.js';
import type { PrStatusDetail } from '../../tim/db/pr_status.js';

/**
 * The overall state of a shepherded PR. The order of the checks in `evaluatePrShepherd`
 * decides which state wins when more than one applies.
 */
export type PrShepherdStatus =
  | 'done'
  | 'paused'
  | 'needs_attention'
  | 'waiting_checks'
  | 'waiting_review'
  | 'ready'
  | 'in_merge_queue';

export type PrShepherdAttentionKind =
  | 'conflicts'
  | 'ci_failed'
  | 'changes_requested'
  | 'unresolved_threads'
  | 'behind_base';

export interface PrShepherdAttentionItem {
  kind: PrShepherdAttentionKind;
  label: string;
  /** A blocking item puts the PR in `needs_attention`. A non-blocking item is only a hint. */
  blocking: boolean;
}

export interface PrShepherdEvaluation {
  status: PrShepherdStatus;
  attention: PrShepherdAttentionItem[];
}

export type PrShepherdInput = Pick<PrStatusDetail, 'status' | 'reviews' | 'reviewThreads'>;

/**
 * Flags that produce a notification when they become true. Other states are reported
 * through the existing inbox signals (CI failures, review comments).
 */
export type PrShepherdNotificationFlag = 'conflicts' | 'ready';

export function countUnresolvedReviewThreads(pr: Pick<PrStatusDetail, 'reviewThreads'>): number {
  return pr.reviewThreads?.filter((thread) => !thread.thread.is_resolved).length ?? 0;
}

/** Same mapping as `checkRollupToSummaryStatus` in `pr_display.ts`, without its alias imports. */
export function summarizeCheckRollup(
  rollupState: string | null
): 'passing' | 'failing' | 'pending' | 'none' {
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Decide the shepherd state of a PR from cached data. The function is pure so that the
 * server (notifications) and the browser (the shepherd page) always agree.
 */
export function evaluatePrShepherd(pr: PrShepherdInput): PrShepherdEvaluation {
  const { status } = pr;
  if (status.state !== 'open') {
    return { status: 'done', attention: [] };
  }

  const attention: PrShepherdAttentionItem[] = [];
  if (status.mergeable === 'CONFLICTING') {
    attention.push({ kind: 'conflicts', label: 'Merge conflicts', blocking: true });
  }

  const checks = summarizeCheckRollup(status.check_rollup_state);
  if (checks === 'failing') {
    attention.push({ kind: 'ci_failed', label: 'CI failing', blocking: true });
  }

  if (getEffectiveReviewDecision(pr) === 'CHANGES_REQUESTED') {
    attention.push({ kind: 'changes_requested', label: 'Changes requested', blocking: true });
  }

  const unresolvedThreads = countUnresolvedReviewThreads(pr);
  if (unresolvedThreads > 0) {
    attention.push({
      kind: 'unresolved_threads',
      label: plural(unresolvedThreads, 'unresolved thread'),
      blocking: true,
    });
  }

  // Being behind is not a blocker: many repositories merge PRs that are behind, and an
  // update starts new CI runs. The UI offers a button but the shepherd never asks for it.
  if ((status.behind_by ?? 0) > 0 && status.mergeable !== 'CONFLICTING') {
    attention.push({
      kind: 'behind_base',
      label: `${plural(status.behind_by ?? 0, 'commit')} behind ${status.base_branch ?? 'base'}`,
      blocking: false,
    });
  }

  if (status.draft) {
    return { status: 'paused', attention };
  }

  // A queued PR needs no action. GitHub removes it from the queue when something fails,
  // and the next evaluation then shows the problem.
  if (status.merge_queue_enqueued_at) {
    return { status: 'in_merge_queue', attention };
  }

  if (attention.some((item) => item.blocking)) {
    return { status: 'needs_attention', attention };
  }

  if (checks === 'pending') {
    return { status: 'waiting_checks', attention };
  }

  if (!isPrApproved(pr)) {
    return { status: 'waiting_review', attention };
  }

  // A stacked PR is ready even while its base PR is open, because the whole stack can go
  // into the merge queue together.
  return { status: 'ready', attention };
}

export function getPrShepherdNotificationFlags(
  evaluation: PrShepherdEvaluation
): PrShepherdNotificationFlag[] {
  const flags: PrShepherdNotificationFlag[] = [];
  if (evaluation.status === 'done' || evaluation.status === 'paused') {
    return flags;
  }
  if (evaluation.attention.some((item) => item.kind === 'conflicts')) {
    flags.push('conflicts');
  }
  if (evaluation.status === 'ready') {
    flags.push('ready');
  }
  return flags;
}

export const PR_SHEPHERD_STATUS_LABELS: Record<PrShepherdStatus, string> = {
  done: 'Done',
  paused: 'Draft',
  needs_attention: 'Needs attention',
  waiting_checks: 'Waiting for checks',
  waiting_review: 'Waiting for review',
  ready: 'Ready to merge',
  in_merge_queue: 'In merge queue',
};

export interface StackablePr {
  status: Pick<
    PrStatusDetail['status'],
    'owner' | 'repo' | 'pr_number' | 'base_branch' | 'head_branch'
  >;
}

export interface PrStackEntry<T extends StackablePr> {
  pr: T;
  /** 0 for a PR whose base is not another PR in the list, +1 for each PR below it. */
  depth: number;
}

function repoKey(pr: StackablePr): string {
  return `${pr.status.owner}/${pr.status.repo}`.toLowerCase();
}

/**
 * Group PRs into stacks. Two PRs are in the same stack when the base branch of one is the
 * head branch of the other (in the same repository). Each group is ordered from the PR
 * nearest to the trunk to the tip, and siblings are ordered by PR number.
 */
export function groupPrsIntoStacks<T extends StackablePr>(prs: readonly T[]): PrStackEntry<T>[][] {
  const byHead = new Map<string, T>();
  for (const pr of prs) {
    if (pr.status.head_branch) {
      byHead.set(`${repoKey(pr)}#${pr.status.head_branch}`, pr);
    }
  }

  const parentOf = (pr: T): T | null => {
    if (!pr.status.base_branch) {
      return null;
    }
    const parent = byHead.get(`${repoKey(pr)}#${pr.status.base_branch}`);
    return parent && parent !== pr ? parent : null;
  };

  const children = new Map<T, T[]>();
  const roots: T[] = [];
  for (const pr of prs) {
    const parent = parentOf(pr);
    if (parent) {
      const list = children.get(parent) ?? [];
      list.push(pr);
      children.set(parent, list);
    } else {
      roots.push(pr);
    }
  }

  const byNumber = (a: T, b: T): number => a.status.pr_number - b.status.pr_number;
  const visited = new Set<T>();
  const groups: PrStackEntry<T>[][] = [];

  const walk = (pr: T, depth: number, group: PrStackEntry<T>[]): void => {
    if (visited.has(pr)) {
      return;
    }
    visited.add(pr);
    group.push({ pr, depth });
    for (const child of (children.get(pr) ?? []).toSorted(byNumber)) {
      walk(child, depth + 1, group);
    }
  };

  for (const root of roots.toSorted(byNumber)) {
    const group: PrStackEntry<T>[] = [];
    walk(root, 0, group);
    groups.push(group);
  }

  // A branch cycle has no root. Start such a group from its lowest PR number.
  for (const pr of prs.toSorted(byNumber)) {
    if (!visited.has(pr)) {
      const group: PrStackEntry<T>[] = [];
      walk(pr, 0, group);
      groups.push(group);
    }
  }

  return groups;
}

export type ShepherdListPr = StackablePr &
  PrShepherdInput & {
    shepherd: unknown;
  };

export interface ShepherdList<T extends ShepherdListPr> {
  /** Stacks that contain at least one shepherded PR, ordered by root PR number. */
  groups: PrStackEntry<T>[][];
  /** Open PRs that are not in the list and not in a stack with a shepherded PR. */
  unwatched: T[];
}

/**
 * Build the shepherd page model from the user's own PRs. Stacks are kept together, so a
 * PR that is not in the list still shows when it is part of a stack with a shepherded PR.
 */
export function buildShepherdList<T extends ShepherdListPr>(prs: readonly T[]): ShepherdList<T> {
  const openPrs = prs.filter((pr) => pr.status.state === 'open');
  const groups: PrStackEntry<T>[][] = [];
  const unwatched: T[] = [];

  for (const group of groupPrsIntoStacks(openPrs)) {
    if (group.some((entry) => entry.pr.shepherd)) {
      groups.push(group);
    } else {
      unwatched.push(...group.map((entry) => entry.pr));
    }
  }

  // Sort by root PR number so stacks keep their place when PR status changes.
  const byRootPr = (a: PrStackEntry<T>[], b: PrStackEntry<T>[]): number =>
    a[0].pr.status.pr_number - b[0].pr.status.pr_number ||
    repoKey(a[0].pr).localeCompare(repoKey(b[0].pr));

  return {
    groups: groups.toSorted(byRootPr),
    unwatched: unwatched.toSorted((a, b) => b.status.pr_number - a.status.pr_number),
  };
}

export interface MergedPrDayGroup<T> {
  /** Local calendar date of the merge, as `YYYY-MM-DD`. */
  key: string;
  label: string;
  prs: T[];
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Group merged PRs by the local calendar day they merged, most recent day first.
 * PRs without a valid `merged_at` are left out.
 */
export function groupPrsByMergedDay<T extends { status: { merged_at: string | null } }>(
  prs: readonly T[],
  now: Date = new Date()
): MergedPrDayGroup<T>[] {
  const todayKey = localDateKey(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yesterdayKey = localDateKey(yesterday);

  const dated = prs
    .flatMap((pr) => {
      const mergedAt = pr.status.merged_at ? new Date(pr.status.merged_at) : null;
      return mergedAt && !Number.isNaN(mergedAt.getTime()) ? [{ pr, mergedAt }] : [];
    })
    .toSorted((a, b) => b.mergedAt.getTime() - a.mergedAt.getTime());

  const groups: MergedPrDayGroup<T>[] = [];
  for (const { pr, mergedAt } of dated) {
    const key = localDateKey(mergedAt);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.prs.push(pr);
      continue;
    }

    const label =
      key === todayKey
        ? 'Today'
        : key === yesterdayKey
          ? 'Yesterday'
          : mergedAt.toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
            });
    groups.push({ key, label, prs: [pr] });
  }
  return groups;
}
