import type { Database } from 'bun:sqlite';

import {
  groupPrsIntoStacks,
  type PrStackEntry,
  type StackablePr,
} from '../../lib/utils/pr_shepherd.js';
import { withRequiredCheckRollupStates } from '../../common/github/required_check_rollup.js';
import { getPrStatusesForRepo, type PrStatusDetail, type PrStatusRow } from '../db/pr_status.js';

export type StackPr = PrStatusDetail & { requiredCheckNames: string[] };

/**
 * All open stacks in a repository, each ordered from the PR nearest to the trunk to the tip.
 * The details include review threads and the required-check rollup state.
 */
export function loadOpenStacksForRepo(
  db: Database,
  owner: string,
  repo: string
): PrStackEntry<StackPr>[][] {
  const prs = withRequiredCheckRollupStates(
    db,
    getPrStatusesForRepo(db, owner, repo, { includeReviewThreads: true })
  );
  return groupPrsIntoStacks(prs);
}

/** The open stack that contains the PR, or an empty list when the PR is not open. */
export function findOpenStackForPr(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo' | 'pr_number'>
): PrStackEntry<StackPr>[] {
  return (
    loadOpenStacksForRepo(db, status.owner, status.repo).find((group) =>
      group.some((entry) => entry.pr.status.pr_number === status.pr_number)
    ) ?? []
  );
}

/**
 * The PRs from the root of the stack up to and including `prNumber`, following base
 * branches. Siblings of the path are not included.
 */
export function getStackPathToPr<T extends StackablePr>(
  stack: readonly PrStackEntry<T>[],
  prNumber: number
): T[] {
  const byHead = new Map<string, T>();
  for (const entry of stack) {
    if (entry.pr.status.head_branch) {
      byHead.set(entry.pr.status.head_branch, entry.pr);
    }
  }

  const path: T[] = [];
  const seen = new Set<T>();
  let current = stack.find((entry) => entry.pr.status.pr_number === prNumber)?.pr;
  while (current && !seen.has(current)) {
    seen.add(current);
    path.unshift(current);
    const baseBranch = current.status.base_branch;
    current = baseBranch ? byHead.get(baseBranch) : undefined;
  }
  return path;
}

export interface StackedBranch {
  headBranch: string;
  baseBranch: string;
}

/**
 * The branches of the PRs stacked on top of `prNumber`, directly or through other PRs. Each
 * branch comes after the branch it is based on.
 */
export function getStackedBranchesAbovePr<T extends StackablePr>(
  stack: readonly PrStackEntry<T>[],
  prNumber: number
): StackedBranch[] {
  const start = stack.find((entry) => entry.pr.status.pr_number === prNumber)?.pr.status
    .head_branch;
  if (!start) {
    return [];
  }

  const result: StackedBranch[] = [];
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const entry of stack) {
      const { head_branch: headBranch, base_branch: baseBranch } = entry.pr.status;
      if (baseBranch === parent && headBranch && !seen.has(headBranch)) {
        seen.add(headBranch);
        queue.push(headBranch);
        result.push({ headBranch, baseBranch });
      }
    }
  }
  return result;
}
