import { describe, expect, test } from 'vitest';

import type { PrStackEntry } from '../../lib/utils/pr_shepherd.js';
import type { StackPr } from '../shepherd_bot/stack.js';
import { resolveSinglePullRequestTarget } from './ci_fix.js';
import type { PlanPrFixTarget, PullRequestFixTarget } from './pr.js';
import { buildPrRebasePrompt, getStackRootRebaseTarget } from './pr_rebase.js';

function makeTarget(): PullRequestFixTarget {
  return {
    kind: 'pr',
    repoRoot: '/tmp/repo',
    canonicalPrUrl: 'https://github.com/example/repo/pull/42',
    prNumber: 42,
    owner: 'example',
    repo: 'repo',
    title: 'Add feature X',
    author: 'alice',
    baseBranch: 'main',
    headBranch: 'feature-x',
    headSha: 'abc123def456789',
    prStatus: { status: {} } as PullRequestFixTarget['prStatus'],
  };
}

function makePlanTarget(prStatuses: PlanPrFixTarget['prStatuses']): PlanPrFixTarget {
  return {
    kind: 'plan',
    planId: 401,
    plan: { id: 401, uuid: 'plan-401', title: 'Plan 401' } as PlanPrFixTarget['plan'],
    planPath: null,
    repoRoot: '/tmp/repo',
    prStatuses,
  };
}

describe('buildPrRebasePrompt', () => {
  test('includes the PR context', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), false);

    expect(prompt).toContain('https://github.com/example/repo/pull/42');
    expect(prompt).toContain('**Base Branch:** main');
    expect(prompt).toContain('**Head Branch:** feature-x');
    expect(prompt).toContain('**Author:** alice');
  });

  test('gives git rebase and force-with-lease push instructions for git repositories', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), false);

    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git push --force-with-lease origin feature-x');
    expect(prompt).not.toContain('jj rebase');
  });

  test('gives jj rebase and bookmark push instructions for jj repositories', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), true);

    expect(prompt).toContain('jj rebase -b @ -d main@origin');
    expect(prompt).toContain('jj git push --bookmark feature-x');
    expect(prompt).toContain(
      `jj log -r 'conflicts() & descendants(roots(main@origin.."feature-x"))'`
    );
    expect(prompt).not.toContain('git rebase origin/main');
  });
});

describe('buildPrRebasePrompt with stacked branches', () => {
  const stacked = [
    { headBranch: 'feature-y', baseBranch: 'feature-x' },
    { headBranch: 'feature-z', baseBranch: 'feature-y' },
  ];

  test('pushes all stacked bookmarks in jj repositories', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), true, stacked);

    expect(prompt).toContain(
      '`feature-y` (based on `feature-x`), `feature-z` (based on `feature-y`)'
    );
    expect(prompt).toContain(
      'jj git push --bookmark feature-x --bookmark feature-y --bookmark feature-z'
    );
    expect(prompt).toContain("jj log -r 'main@origin::'");
    expect(prompt).not.toContain('push with `jj git push --bookmark feature-x`.');
  });

  test('rebases and pushes all stacked branches in git repositories', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), false, stacked);

    expect(prompt).toContain('git push --force-with-lease origin feature-x feature-y feature-z');
  });

  test('adds the end session section only when the tool is enabled', () => {
    expect(buildPrRebasePrompt(makeTarget(), true)).not.toContain('## Ending the Session');
    const prompt = buildPrRebasePrompt(makeTarget(), true, [], { endSessionTool: true });
    expect(prompt).toContain('## Ending the Session');
    expect(prompt).toContain('EndTimSession');
  });

  test('does not mention a stack when no PRs are stacked on top', () => {
    const prompt = buildPrRebasePrompt(makeTarget(), true, []);

    expect(prompt).not.toContain('stacked on top of this PR');
    expect(prompt).toContain('jj git push --bookmark feature-x`');
  });
});

describe('resolveSinglePullRequestTarget', () => {
  test('returns a PR target unchanged', () => {
    const target = makeTarget();
    expect(resolveSinglePullRequestTarget(target, 'tim pr rebase')).toBe(target);
  });

  test('names the command when a plan has no linked pull requests', () => {
    expect(() => resolveSinglePullRequestTarget(makePlanTarget([]), 'tim pr rebase')).toThrow(
      'tim pr rebase requires one linked pull request for plan 401'
    );
  });
});

function stackEntry(
  prNumber: number,
  head: string | null,
  base: string | null,
  depth: number
): PrStackEntry<StackPr> {
  return {
    pr: {
      status: {
        pr_number: prNumber,
        pr_url: `https://github.com/example/repo/pull/${prNumber}`,
        owner: 'example',
        repo: 'repo',
        title: `PR ${prNumber}`,
        author: 'bob',
        head_sha: `sha${prNumber}`,
        head_branch: head,
        base_branch: base,
      },
    } as StackPr,
    depth,
  };
}

function makeStackedTarget(): PullRequestFixTarget {
  return { ...makeTarget(), prNumber: 43, baseBranch: 'feature-x', headBranch: 'feature-y' };
}

describe('getStackRootRebaseTarget', () => {
  // main <- feature-x (42) <- feature-y (43) <- feature-z (44)
  const stack = [
    stackEntry(42, 'feature-x', 'main', 0),
    stackEntry(43, 'feature-y', 'feature-x', 1),
    stackEntry(44, 'feature-z', 'feature-y', 2),
  ];

  test('returns the root PR of the stack with the trunk branch as its base', () => {
    const target = makeStackedTarget();
    const rootTarget = getStackRootRebaseTarget(target, stack);

    expect(rootTarget).toMatchObject({
      kind: 'pr',
      repoRoot: '/tmp/repo',
      canonicalPrUrl: 'https://github.com/example/repo/pull/42',
      prNumber: 42,
      title: 'PR 42',
      author: 'bob',
      baseBranch: 'main',
      headBranch: 'feature-x',
      headSha: 'sha42',
    });
    expect(rootTarget?.prStatus).toBe(stack[0].pr);
  });

  test('returns the root for a PR higher in the stack', () => {
    const target = {
      ...makeTarget(),
      prNumber: 44,
      baseBranch: 'feature-y',
      headBranch: 'feature-z',
    };
    expect(getStackRootRebaseTarget(target, stack)?.prNumber).toBe(42);
  });

  test('returns null when the PR is the root of the stack', () => {
    expect(getStackRootRebaseTarget(makeTarget(), stack)).toBeNull();
  });

  test('returns null when the PR is not in an open stack', () => {
    expect(getStackRootRebaseTarget(makeStackedTarget(), [])).toBeNull();
  });

  test('returns null when the root PR has no base or head branch', () => {
    const noBase = [stackEntry(42, 'feature-x', null, 0), stack[1]];
    expect(getStackRootRebaseTarget(makeStackedTarget(), noBase)).toBeNull();
  });
});

describe('buildPrRebasePrompt for a whole stack', () => {
  const rootTarget = makeTarget();
  const requestedPr = makeStackedTarget();
  const stacked = [{ headBranch: 'feature-y', baseBranch: 'feature-x' }];

  test('names the requested PR and the trunk branch', () => {
    const prompt = buildPrRebasePrompt(rootTarget, true, stacked, { requestedPr });

    expect(prompt).toContain('root of a stack');
    expect(prompt).toContain('PR #43');
    expect(prompt).toContain('`feature-y`');
    expect(prompt).toContain('jj rebase -b @ -d main@origin');
    expect(prompt).toContain('jj git push --bookmark feature-x --bookmark feature-y');
  });

  test('checks out the root branch before the git rebase', () => {
    const prompt = buildPrRebasePrompt(rootTarget, false, stacked, { requestedPr });

    expect(prompt).toContain('git checkout feature-x');
    expect(prompt).toContain('git rebase origin/main');
    expect(prompt).toContain('git push --force-with-lease origin feature-x feature-y');
  });

  test('does not mention a stack root without a requested PR', () => {
    const prompt = buildPrRebasePrompt(rootTarget, false, stacked);

    expect(prompt).not.toContain('root of a stack');
    expect(prompt).not.toContain('git checkout feature-x');
  });
});
