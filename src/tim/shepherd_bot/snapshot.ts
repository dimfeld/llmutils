// Relative imports: this module runs in the CLI, which does not resolve SvelteKit aliases.
import { classifyCheckRun } from '../../common/github/required_check_rollup.js';
import { getEffectiveReviewDecision } from '../../common/github/review_requests.js';
import {
  evaluatePrShepherd,
  summarizeCheckRollup,
  type PrShepherdStatus,
} from '../../lib/utils/pr_shepherd.js';
import type { PrStatusDetail } from '../db/pr_status.js';

/**
 * The parts of a PR's state that the shepherd bot reacts to. The trigger logic compares the
 * stored snapshot with a new one, and wakes the bot only when they differ. Because only the
 * latest state is kept, many pushes or check updates in a row become one change.
 *
 * `behind_by` is left out on purpose: it changes each time the base branch moves and the
 * bot does not act on it.
 */
export interface ShepherdBotPrSnapshot {
  state: string;
  draft: boolean;
  headSha: string | null;
  mergeable: string | null;
  checks: 'passing' | 'failing' | 'pending' | 'none';
  failingChecks: string[];
  reviewDecision: string | null;
  unresolvedThreadIds: string[];
  inMergeQueue: boolean;
  status: PrShepherdStatus;
}

/** `detail` must already have the required-check rollup state applied. */
export function buildShepherdBotSnapshot(
  detail: Pick<PrStatusDetail, 'status' | 'checks' | 'reviews' | 'reviewThreads'>
): ShepherdBotPrSnapshot {
  const { status } = detail;
  return {
    state: status.state,
    draft: Boolean(status.draft),
    headSha: status.head_sha,
    mergeable: status.mergeable,
    checks: summarizeCheckRollup(status.check_rollup_state),
    failingChecks: [
      ...new Set(
        detail.checks
          .filter((check) => classifyCheckRun(check) === 'failing')
          .map((check) => check.name)
      ),
    ].sort(),
    reviewDecision: getEffectiveReviewDecision(detail),
    unresolvedThreadIds: (detail.reviewThreads ?? [])
      .filter((thread) => !thread.thread.is_resolved)
      .map((thread) => thread.thread.thread_id)
      .sort(),
    inMergeQueue: Boolean(status.merge_queue_enqueued_at),
    status: evaluatePrShepherd(detail).status,
  };
}

export function serializeShepherdBotSnapshot(snapshot: ShepherdBotPrSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseShepherdBotSnapshot(value: string | null): ShepherdBotPrSnapshot | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as Partial<ShepherdBotPrSnapshot> | null;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.state !== 'string' ||
      !Array.isArray(parsed.failingChecks) ||
      !Array.isArray(parsed.unresolvedThreadIds)
    ) {
      return null;
    }
    return parsed as ShepherdBotPrSnapshot;
  } catch {
    return null;
  }
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 8) : 'none';
}

/**
 * Describe the differences between two snapshots, one line for each change. An empty list
 * means that nothing changed that the bot cares about.
 */
export function describeShepherdBotSnapshotChanges(
  previous: ShepherdBotPrSnapshot,
  next: ShepherdBotPrSnapshot
): string[] {
  const changes: string[] = [];

  if (previous.state !== next.state) {
    changes.push(`PR state changed from ${previous.state} to ${next.state}`);
  }
  if (previous.draft !== next.draft) {
    changes.push(next.draft ? 'PR was converted to a draft' : 'PR was marked ready for review');
  }
  if (previous.headSha !== next.headSha) {
    changes.push(
      `New commits were pushed (head ${shortSha(previous.headSha)} -> ${shortSha(next.headSha)})`
    );
  }

  const wasConflicting = previous.mergeable === 'CONFLICTING';
  const isConflicting = next.mergeable === 'CONFLICTING';
  if (!wasConflicting && isConflicting) {
    changes.push('Merge conflicts with the base branch appeared');
  } else if (wasConflicting && !isConflicting) {
    changes.push('Merge conflicts with the base branch are gone');
  }

  if (previous.checks !== next.checks) {
    changes.push(`Checks changed from ${previous.checks} to ${next.checks}`);
  }
  const previousFailing = new Set(previous.failingChecks);
  const newlyFailing = next.failingChecks.filter((name) => !previousFailing.has(name));
  if (newlyFailing.length > 0) {
    changes.push(`Checks that started failing: ${newlyFailing.join(', ')}`);
  }

  if (previous.reviewDecision !== next.reviewDecision) {
    changes.push(
      `Review decision changed from ${previous.reviewDecision ?? 'none'} to ${next.reviewDecision ?? 'none'}`
    );
  }

  const previousThreads = new Set(previous.unresolvedThreadIds);
  const nextThreads = new Set(next.unresolvedThreadIds);
  const newThreads = next.unresolvedThreadIds.filter((id) => !previousThreads.has(id));
  const resolvedThreads = previous.unresolvedThreadIds.filter((id) => !nextThreads.has(id));
  if (newThreads.length > 0) {
    changes.push(
      `${newThreads.length} new unresolved review thread${newThreads.length === 1 ? '' : 's'}`
    );
  }
  if (resolvedThreads.length > 0) {
    changes.push(
      `${resolvedThreads.length} review thread${resolvedThreads.length === 1 ? ' was' : 's were'} resolved`
    );
  }

  if (previous.inMergeQueue !== next.inMergeQueue) {
    changes.push(next.inMergeQueue ? 'PR entered the merge queue' : 'PR left the merge queue');
  }

  return changes;
}
