import { describe, expect, test } from 'vitest';

import type { PrStackEntry, StackablePr } from '../../lib/utils/pr_shepherd.js';
import { getStackedBranchesAbovePr } from './stack.js';

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
