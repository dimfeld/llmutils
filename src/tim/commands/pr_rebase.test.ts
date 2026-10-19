import { describe, expect, test } from 'vitest';

import { resolveSinglePullRequestTarget } from './ci_fix.js';
import type { PlanPrFixTarget, PullRequestFixTarget } from './pr.js';
import { buildPrRebasePrompt } from './pr_rebase.js';

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
    expect(prompt).toContain('Do not edit plan files');
    expect(prompt).toContain('stop and ask the user');
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
    expect(prompt).not.toContain('git rebase origin/main');
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
