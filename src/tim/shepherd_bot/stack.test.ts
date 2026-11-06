import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import type { PrStackEntry, StackablePr } from '../../lib/utils/pr_shepherd.js';
import { upsertBranchMergeRequirements } from '../db/branch_merge_requirements.js';
import { openDatabase } from '../db/database.js';
import { getStackedBranchesAbovePr, loadOpenStacksForRepo } from './stack.js';
import { addFixturePr, FIXTURE_OWNER, FIXTURE_REPO } from './test_fixtures.js';

function entry(
  prNumber: number,
  head: string,
  base: string,
  depth: number
): PrStackEntry<StackablePr> {
  return {
    pr: {
      status: { pr_number: prNumber, head_branch: head, base_branch: base, owner: 'o', repo: 'r' },
    } as StackablePr,
    depth,
  };
}

describe('getStackedBranchesAbovePr', () => {
  // main <- a (1) <- b (2) <- c (3), and a <- d (4)
  const stack = [
    entry(1, 'a', 'main', 0),
    entry(2, 'b', 'a', 1),
    entry(3, 'c', 'b', 2),
    entry(4, 'd', 'a', 1),
  ];

  test('returns all branches above the PR, each after its base branch', () => {
    expect(getStackedBranchesAbovePr(stack, 1)).toEqual([
      { headBranch: 'b', baseBranch: 'a' },
      { headBranch: 'd', baseBranch: 'a' },
      { headBranch: 'c', baseBranch: 'b' },
    ]);
  });

  test('does not include branches below the PR or siblings', () => {
    expect(getStackedBranchesAbovePr(stack, 2)).toEqual([{ headBranch: 'c', baseBranch: 'b' }]);
  });

  test('returns nothing for the tip or for a PR that is not in the stack', () => {
    expect(getStackedBranchesAbovePr(stack, 3)).toEqual([]);
    expect(getStackedBranchesAbovePr(stack, 99)).toEqual([]);
    expect(getStackedBranchesAbovePr([], 1)).toEqual([]);
  });
});

describe('loadOpenStacksForRepo required checks', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  function requireChecks(branchName: string, checks: string[]): void {
    upsertBranchMergeRequirements(db, {
      owner: FIXTURE_OWNER,
      repo: FIXTURE_REPO,
      branchName,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          sourceName: null,
          strict: true,
          checks: checks.map((context) => ({ context })),
        },
      ],
    });
  }

  const optionalFailure = {
    checkRollupState: 'failure',
    checks: [
      { name: 'test', source: 'check_run' as const, status: 'completed', conclusion: 'success' },
      { name: 'lint', source: 'check_run' as const, status: 'completed', conclusion: 'failure' },
    ],
  };

  function loadByNumber() {
    const stacks = loadOpenStacksForRepo(db, FIXTURE_OWNER, FIXTURE_REPO);
    return new Map(stacks.flat().map((entry) => [entry.pr.status.pr_number, entry.pr]));
  }

  test('a stacked PR uses the required checks of the trunk branch', () => {
    requireChecks('main', ['test']);
    addFixturePr(db, 1, { head: 'a', ...optionalFailure });
    addFixturePr(db, 2, { base: 'a', head: 'b', ...optionalFailure });
    addFixturePr(db, 3, { base: 'b', head: 'c', ...optionalFailure });

    const prs = loadByNumber();
    for (const prNumber of [1, 2, 3]) {
      const pr = prs.get(prNumber)!;
      expect(pr.requiredCheckNames).toEqual(['test']);
      expect(pr.requiredChecksBranch).toBe('main');
      expect(pr.status.check_rollup_state).toBe('success');
    }
  });

  test('a stacked PR keeps the rules of its own base branch when that branch has rules', () => {
    requireChecks('main', ['test']);
    requireChecks('a', ['lint']);
    addFixturePr(db, 1, { head: 'a', ...optionalFailure });
    addFixturePr(db, 2, { base: 'a', head: 'b', ...optionalFailure });

    const stacked = loadByNumber().get(2)!;
    expect(stacked.requiredCheckNames).toEqual(['lint']);
    expect(stacked.requiredChecksBranch).toBe('a');
    expect(stacked.status.check_rollup_state).toBe('failure');
  });

  test('no branch rules keep the GitHub rollup state and no required checks', () => {
    addFixturePr(db, 1, { head: 'a', ...optionalFailure });
    addFixturePr(db, 2, { base: 'a', head: 'b', ...optionalFailure });

    for (const pr of loadByNumber().values()) {
      expect(pr.requiredCheckNames).toEqual([]);
      expect(pr.requiredChecksBranch).toBeNull();
      expect(pr.status.check_rollup_state).toBe('failure');
    }
  });
});
