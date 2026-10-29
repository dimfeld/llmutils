import type { Database } from 'bun:sqlite';

import { upsertPrStatus, type UpsertPrStatusInput } from '../db/pr_status.js';

export const FIXTURE_OWNER = 'example';
export const FIXTURE_REPO = 'repo';

export function fixturePrUrl(prNumber: number): string {
  return `https://github.com/${FIXTURE_OWNER}/${FIXTURE_REPO}/pull/${prNumber}`;
}

/**
 * Add an open, approved, passing PR. `base` and `head` make stacks: a PR whose base is the
 * head of another PR is stacked on it. Returns the PR status ID.
 */
export function addFixturePr(
  db: Database,
  prNumber: number,
  options: { base?: string; head?: string } & Partial<UpsertPrStatusInput> = {}
): number {
  const { base, head, ...overrides } = options;
  return upsertPrStatus(db, {
    prUrl: fixturePrUrl(prNumber),
    owner: FIXTURE_OWNER,
    repo: FIXTURE_REPO,
    prNumber,
    author: 'me',
    title: `PR ${prNumber}`,
    state: 'open',
    draft: false,
    mergeable: 'MERGEABLE',
    headSha: `sha-${prNumber}`,
    baseSha: 'base',
    baseBranch: base ?? 'main',
    headBranch: head ?? `feature-${prNumber}`,
    reviewDecision: 'APPROVED',
    checkRollupState: 'success',
    mergedAt: null,
    lastFetchedAt: '2026-01-01T00:00:00.000Z',
    checks: [{ name: 'test', source: 'check_run', status: 'completed', conclusion: 'success' }],
    reviews: [{ author: 'reviewer', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00.000Z' }],
    labels: [],
    reviewThreads: [],
    ...overrides,
  }).status.id;
}

export const FAILING_CHECKS: Pick<UpsertPrStatusInput, 'checkRollupState' | 'checks'> = {
  checkRollupState: 'failure',
  checks: [{ name: 'test', source: 'check_run', status: 'completed', conclusion: 'failure' }],
};

export function unresolvedThread(
  threadId: string
): NonNullable<UpsertPrStatusInput['reviewThreads']>[number] {
  return {
    threadId,
    path: 'src/index.ts',
    line: 10,
    isResolved: false,
    isOutdated: false,
    comments: [{ commentId: `${threadId}-c1`, author: 'reviewer', body: 'Please rename this.' }],
  };
}
