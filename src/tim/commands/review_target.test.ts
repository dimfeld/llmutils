import { describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import { PlanNotFoundError } from '../plans.js';
import { resolveReviewTarget, type ReviewTargetDependencies } from './review_target.js';
import type { PrStatusRow } from '../db/pr_status.js';
import type { PrReviewContext } from '../utils/pr_context_gathering.js';

function createDeps(overrides: Partial<ReviewTargetDependencies> = {}): ReviewTargetDependencies {
  const deps: ReviewTargetDependencies = {
    getDatabase: vi.fn(() => ({}) as Database),
    resolveRepoRoot: vi.fn(async () => '/repo'),
    resolvePlanByNumericId: vi.fn(async (planId: number) => ({
      plan: {
        id: planId,
        uuid: `plan-${planId}-uuid`,
        title: `Plan ${planId}`,
        goal: 'Test plan',
        branch: `${planId}-feature`,
        tasks: [],
      },
      planPath: `/repo/.tim/plans/${planId}.plan.md`,
    })),
    getCurrentBranchName: vi.fn(async () => 'feature/no-plan'),
    getTrunkBranch: vi.fn(async () => 'main'),
    remoteBranchExists: vi.fn(async () => false),
    getRepositoryIdentity: vi.fn(async () => ({
      repositoryId: 'github.com__acme__widgets',
      remoteUrl: 'https://github.com/acme/widgets.git',
      gitRoot: '/repo',
    })),
    gatherPrContext: vi.fn(async () => createPrContext()),
    branchExistsLocally: vi.fn(async () => false),
  };

  return {
    ...deps,
    ...overrides,
  };
}

function createPrStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 42,
    pr_url: 'https://github.com/acme/widgets/pull/123',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 123,
    author: 'octocat',
    title: 'Improve widgets',
    state: 'OPEN',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'abc123',
    base_branch: 'main',
    head_branch: 'feature/widgets',
    requested_reviewers: null,
    review_decision: null,
    check_rollup_state: null,
    merged_at: null,
    additions: 1,
    deletions: 1,
    changed_files: 1,
    pr_updated_at: null,
    latest_commit_pushed_at: null,
    ready_at: null,
    last_fetched_at: '2026-06-05T00:00:00.000Z',
    created_at: '2026-06-05T00:00:00.000Z',
    updated_at: '2026-06-05T00:00:00.000Z',
    ...overrides,
  };
}

function createPrContext(overrides: Partial<PrReviewContext> = {}): PrReviewContext {
  const prStatus = createPrStatus();
  return {
    prStatus,
    baseBranch: 'main',
    headBranch: 'feature/widgets',
    headSha: 'abc123',
    owner: 'acme',
    repo: 'widgets',
    prNumber: 123,
    prUrl: 'https://github.com/acme/widgets/pull/123',
    ...overrides,
  };
}

describe('resolveReviewTarget', () => {
  test('rejects a plan ID combined with a planless selector before resolving the repo', async () => {
    const deps = createDeps();

    await expect(
      resolveReviewTarget(
        {
          planId: 377,
          options: { current: true },
        },
        deps
      )
    ).rejects.toThrow('Cannot combine a plan ID with --current');
    expect(deps.resolveRepoRoot).not.toHaveBeenCalled();
  });

  test('rejects multiple planless selectors before resolving the repo', async () => {
    const deps = createDeps();

    await expect(
      resolveReviewTarget(
        {
          options: { current: true, branch: 'feature/branch' },
        },
        deps
      )
    ).rejects.toThrow('Conflicting review target selectors: --current, --branch');
    expect(deps.resolveRepoRoot).not.toHaveBeenCalled();
  });

  test('uses branch-name plan auto-selection before falling back to current worktree', async () => {
    const deps = createDeps({
      getCurrentBranchName: vi.fn(async () => '377-planless-review-targets'),
    });

    const target = await resolveReviewTarget({ options: {} }, deps);

    expect(target.kind).toBe('plan');
    if (target.kind === 'plan') {
      expect(target.planId).toBe(377);
      expect(target.autoSelected?.selectionReason).toBe('branch-name');
    }
    expect(deps.resolvePlanByNumericId).toHaveBeenCalledWith(377, '/repo');
  });

  test('resolves explicit --current before branch-name plan auto-selection', async () => {
    const deps = createDeps({
      getCurrentBranchName: vi.fn(async () => '377-planless-review-targets'),
    });

    const target = await resolveReviewTarget({ options: { current: true } }, deps);

    expect(target).toMatchObject({
      kind: 'current',
      repoRoot: '/repo',
      currentBranch: '377-planless-review-targets',
      baseBranch: 'main',
      worktreePath: '/repo',
    });
    expect(deps.resolvePlanByNumericId).not.toHaveBeenCalled();
  });

  test('falls back to current worktree when branch-name auto-selection finds no plan', async () => {
    const deps = createDeps({
      getCurrentBranchName: vi.fn(async () => '999-missing-plan'),
      resolvePlanByNumericId: vi.fn(async () => {
        throw new PlanNotFoundError('Plan 999 was not found');
      }),
    });

    const target = await resolveReviewTarget({ options: {} }, deps);

    expect(target).toMatchObject({
      kind: 'current',
      repoRoot: '/repo',
      currentBranch: '999-missing-plan',
      baseBranch: 'main',
      worktreePath: '/repo',
    });
  });

  test('resolves explicit branch metadata and honors --base', async () => {
    const deps = createDeps({
      branchExistsLocally: vi.fn(async () => true),
    });

    const target = await resolveReviewTarget(
      {
        options: { branch: 'feature/review-me', base: 'release/base' },
      },
      deps
    );

    expect(target).toMatchObject({
      kind: 'branch',
      repoRoot: '/repo',
      requestedBranch: 'feature/review-me',
      baseBranch: 'release/base',
    });
    expect(deps.remoteBranchExists).not.toHaveBeenCalled();
  });

  test('resolves explicit PR metadata and validates the current repository', async () => {
    const deps = createDeps();

    const target = await resolveReviewTarget(
      {
        options: { pr: '123' },
      },
      deps
    );

    expect(target).toMatchObject({
      kind: 'pr',
      repoRoot: '/repo',
      canonicalPrUrl: 'https://github.com/acme/widgets/pull/123',
      prNumber: 123,
      title: 'Improve widgets',
      owner: 'acme',
      repo: 'widgets',
      baseBranch: 'main',
      headBranch: 'feature/widgets',
      headSha: 'abc123',
      prStatusId: 42,
    });
    expect(deps.gatherPrContext).toHaveBeenCalledWith({
      db: expect.anything(),
      prUrlOrNumber: '123',
      cwd: '/repo',
    });
  });

  test('rejects PR targets from another repository', async () => {
    const deps = createDeps({
      gatherPrContext: vi.fn(async () =>
        createPrContext({
          owner: 'other',
          repo: 'repo',
          prUrl: 'https://github.com/other/repo/pull/123',
        })
      ),
    });

    await expect(resolveReviewTarget({ options: { pr: '123' } }, deps)).rejects.toThrow(
      'belongs to other/repo, but the current repository is acme/widgets'
    );
  });
});
