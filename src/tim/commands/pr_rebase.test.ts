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
    expect(prompt).toContain(
      `jj log -r 'conflicts() & descendants(roots(main@origin.."feature-x"))'`
    );
    expect(prompt).toContain('out of scope');
    expect(prompt).toContain('branches stacked on top of it');
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

    expect(prompt).toContain('git rebase --onto <base branch> origin/<base branch> <branch>');
    expect(prompt).toContain('git push --force-with-lease origin feature-x feature-y feature-z');
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
