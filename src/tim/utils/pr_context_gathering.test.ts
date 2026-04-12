import { describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import type { PrStatusDetail } from '../db/pr_status.js';
import {
  checkoutPrBranch,
  gatherPrContext,
  type BranchCheckoutDependencies,
  type PrContextGatheringDependencies,
} from './pr_context_gathering.js';

function makeDetail(overrides?: Partial<PrStatusDetail['status']>): PrStatusDetail {
  return {
    status: {
      id: 10,
      pr_url: 'https://github.com/acme/repo/pull/123',
      owner: 'acme',
      repo: 'repo',
      pr_number: 123,
      author: 'alice',
      title: 'Test PR',
      state: 'open',
      draft: 0,
      mergeable: 'MERGEABLE',
      head_sha: 'abc123',
      base_branch: 'main',
      head_branch: 'feature/pr-123',
      requested_reviewers: null,
      review_decision: null,
      check_rollup_state: null,
      merged_at: null,
      additions: null,
      deletions: null,
      changed_files: null,
      pr_updated_at: null,
      latest_commit_pushed_at: null,
      last_fetched_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    },
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
    reviewThreads: [],
  };
}

function makeDeps(
  overrides?: Partial<PrContextGatheringDependencies>
): PrContextGatheringDependencies {
  const detail = makeDetail();

  return {
    canonicalizePrUrl: vi.fn((url: string) => url),
    parsePrOrIssueNumber: vi.fn(async () => ({ owner: 'acme', repo: 'repo', number: 123 })),
    validatePrIdentifier: vi.fn(),
    getGitRepository: vi.fn(async () => 'acme/repo'),
    getGitRoot: vi.fn(async () => '/tmp/repo'),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 22, uuid: '22-uuid' },
      planPath: null,
    })) as any,
    getPrStatusByUrl: vi.fn(() => detail),
    getPrStatusForPlan: vi.fn(() => [detail]),
    refreshPrStatus: vi.fn(async () => detail),
    ...overrides,
  };
}

describe('gatherPrContext', () => {
  test('resolves from full PR URL using cached status', async () => {
    const deps = makeDeps();
    const result = await gatherPrContext(
      {
        db: {} as Database,
        prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
        maxStatusAgeMs: 60 * 60 * 1000,
      },
      deps
    );

    expect(result.prUrl).toBe('https://github.com/acme/repo/pull/123');
    expect(result.owner).toBe('acme');
    expect(result.repo).toBe('repo');
    expect(result.prNumber).toBe(123);
    expect(result.baseBranch).toBe('main');
    expect(result.headBranch).toBe('feature/pr-123');
    expect(result.headSha).toBe('abc123');
    expect(deps.refreshPrStatus).not.toHaveBeenCalled();
  });

  test('resolves from bare PR number using git remote', async () => {
    const deps = makeDeps();
    await gatherPrContext({ db: {} as Database, prUrlOrNumber: '123' }, deps);

    expect(deps.getGitRepository).toHaveBeenCalled();
    expect(deps.canonicalizePrUrl).toHaveBeenCalledWith('https://github.com/acme/repo/pull/123');
  });

  test('resolves from --plan with one linked PR', async () => {
    const deps = makeDeps();
    const result = await gatherPrContext({ db: {} as Database, plan: 22 }, deps);

    expect(deps.resolvePlanFromDb).toHaveBeenCalled();
    expect(deps.getPrStatusForPlan).toHaveBeenCalledWith({} as Database, '22-uuid');
    expect(result.prUrl).toBe('https://github.com/acme/repo/pull/123');
  });

  test('throws for --plan when multiple PRs are linked', async () => {
    const deps = makeDeps({
      getPrStatusForPlan: vi.fn(() => [makeDetail(), makeDetail({ id: 11, pr_number: 124 })]),
    });

    await expect(gatherPrContext({ db: {} as Database, plan: 22 }, deps)).rejects.toThrow(
      'multiple linked pull requests'
    );
  });

  test('throws for --plan when no PRs are linked', async () => {
    const deps = makeDeps({
      getPrStatusForPlan: vi.fn(() => []),
    });

    await expect(gatherPrContext({ db: {} as Database, plan: 22 }, deps)).rejects.toThrow(
      'has no linked pull requests'
    );
  });

  test('throws on invalid PR URL', async () => {
    const deps = makeDeps({
      validatePrIdentifier: vi.fn(() => {
        throw new Error('Not a pull request URL');
      }),
    });

    await expect(
      gatherPrContext(
        {
          db: {} as Database,
          prUrlOrNumber: 'https://github.com/acme/repo/issues/123',
        },
        deps
      )
    ).rejects.toThrow('Not a pull request URL');
  });

  test('refreshes stale cached PR status', async () => {
    const stale = makeDetail({ last_fetched_at: '2001-01-01T00:00:00.000Z' });
    const fresh = makeDetail({ last_fetched_at: new Date().toISOString(), head_sha: 'new-sha' });
    const deps = makeDeps({
      getPrStatusByUrl: vi.fn(() => stale),
      refreshPrStatus: vi.fn(async () => fresh),
    });

    const result = await gatherPrContext(
      {
        db: {} as Database,
        prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
        maxStatusAgeMs: 1000,
      },
      deps
    );

    expect(deps.refreshPrStatus).toHaveBeenCalled();
    expect(result.headSha).toBe('new-sha');
  });

  test('auto-refreshes when PR status is not in the database', async () => {
    const fresh = makeDetail({
      last_fetched_at: new Date().toISOString(),
      head_sha: 'fetched-sha',
    });
    const deps = makeDeps({
      getPrStatusByUrl: vi.fn(() => null),
      refreshPrStatus: vi.fn(async () => fresh),
    });

    const result = await gatherPrContext(
      {
        db: {} as Database,
        prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
      },
      deps
    );

    expect(deps.refreshPrStatus).toHaveBeenCalled();
    expect(result.headSha).toBe('fetched-sha');
  });

  test('throws when no prUrlOrNumber and no plan provided', async () => {
    const deps = makeDeps();

    await expect(gatherPrContext({ db: {} as Database }, deps)).rejects.toThrow(
      'PR URL/number is required when --plan is not provided'
    );
  });

  test('throws when parsePrOrIssueNumber returns null for an invalid identifier', async () => {
    const deps = makeDeps({
      parsePrOrIssueNumber: vi.fn(async () => null),
    });

    await expect(
      gatherPrContext(
        {
          db: {} as Database,
          prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
        },
        deps
      )
    ).rejects.toThrow('Invalid GitHub pull request identifier');
  });

  test('throws when PR metadata is missing required fields', async () => {
    const incompleteDetail = makeDetail({
      base_branch: null,
      head_branch: null,
      head_sha: null,
    });
    const deps = makeDeps({
      getPrStatusByUrl: vi.fn(() => incompleteDetail),
    });

    await expect(
      gatherPrContext(
        {
          db: {} as Database,
          prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
          maxStatusAgeMs: 60 * 60 * 1000,
        },
        deps
      )
    ).rejects.toThrow('PR metadata is incomplete');
  });

  test('throws when PR metadata has missing base branch', async () => {
    const incompleteDetail = makeDetail({ base_branch: null });
    const deps = makeDeps({
      getPrStatusByUrl: vi.fn(() => incompleteDetail),
    });

    await expect(
      gatherPrContext(
        {
          db: {} as Database,
          prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
          maxStatusAgeMs: 60 * 60 * 1000,
        },
        deps
      )
    ).rejects.toThrow('base branch');
  });

  test('throws when git repository format is invalid for bare number resolution', async () => {
    const deps = makeDeps({
      getGitRepository: vi.fn(async () => 'invalid-no-slash'),
    });

    await expect(
      gatherPrContext({ db: {} as Database, prUrlOrNumber: '42' }, deps)
    ).rejects.toThrow('Could not determine repository owner/name from git remote');
  });

  test('status with null last_fetched_at triggers refresh', async () => {
    const noTimestamp = makeDetail({ last_fetched_at: null });
    const fresh = makeDetail({ last_fetched_at: new Date().toISOString() });
    const deps = makeDeps({
      getPrStatusByUrl: vi.fn(() => noTimestamp),
      refreshPrStatus: vi.fn(async () => fresh),
    });

    await gatherPrContext(
      {
        db: {} as Database,
        prUrlOrNumber: 'https://github.com/acme/repo/pull/123',
        maxStatusAgeMs: 60 * 60 * 1000,
      },
      deps
    );

    expect(deps.refreshPrStatus).toHaveBeenCalled();
  });
});

describe('checkoutPrBranch', () => {
  function makeBranchDeps(
    overrides?: Partial<BranchCheckoutDependencies>
  ): BranchCheckoutDependencies {
    return {
      getWorkingCopyStatus: vi.fn(async () => ({
        hasChanges: false,
        checkFailed: false,
      })),
      getUsingJj: vi.fn(async () => false),
      runCommand: vi.fn(async () => ({ exitCode: 0, stderr: '' })),
      ...overrides,
    };
  }

  test('throws when working tree is dirty and skipDirtyCheck is false', async () => {
    const deps = makeBranchDeps({
      getWorkingCopyStatus: vi.fn(async () => ({
        hasChanges: true,
        checkFailed: false,
      })),
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/pr-123', cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Working tree has uncommitted changes');
  });

  test('throws when working copy status check fails', async () => {
    const deps = makeBranchDeps({
      getWorkingCopyStatus: vi.fn(async () => ({
        hasChanges: false,
        checkFailed: true,
      })),
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/pr-123', cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to determine working tree status');
  });

  test('uses git fetch + detached checkout for git repositories', async () => {
    const commands: string[][] = [];
    const runCommand = vi.fn(async (args: string[]) => {
      commands.push(args);
      return { exitCode: 0, stderr: '' };
    });
    const deps = makeBranchDeps({ runCommand });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(commands).toContainEqual(['git', 'fetch', 'origin', 'feature/pr-123']);
    expect(commands).toContainEqual(['git', 'checkout', '--detach', 'origin/feature/pr-123']);
  });

  test('fetches base branch after git checkout when baseBranch is provided', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({ runCommand });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['git', 'fetch', 'origin', 'feature/pr-123'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['git', 'checkout', '--detach', 'origin/feature/pr-123'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(3, ['git', 'fetch', 'origin', 'main'], '/tmp/repo');
  });

  test('uses jj bookmark track + jj new for jj repositories', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand).toHaveBeenCalledWith(
      ['jj', 'bookmark', 'track', 'feature/pr-123@origin'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenCalledWith(['jj', 'new', 'feature/pr-123'], '/tmp/repo');
  });

  test('fetches base branch after jj checkout when baseBranch is provided', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['jj', 'bookmark', 'track', 'feature/pr-123@origin'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(2, ['jj', 'new', 'feature/pr-123'], '/tmp/repo');
    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      ['jj', 'git', 'fetch', '--branch', 'main'],
      '/tmp/repo'
    );
  });

  test('proceeds with checkout when dirty tree and skipDirtyCheck is true', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({ runCommand });

    // Even though we set hasChanges, skipDirtyCheck should bypass the check
    await checkoutPrBranch(
      { branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(deps.getWorkingCopyStatus).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalled();
  });

  test('throws when git base branch fetch fails', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      // Checkout succeeds, but base branch fetch fails
      if (args[0] === 'git' && args[1] === 'fetch' && args[3] === 'main') {
        return { exitCode: 1, stderr: "fatal: couldn't find remote ref main" };
      }
      return { exitCode: 0, stderr: '' };
    });
    const deps = makeBranchDeps({ runCommand });

    await expect(
      checkoutPrBranch(
        { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
        deps
      )
    ).rejects.toThrow('Failed to fetch base branch "main"');
  });

  test('throws when jj base branch fetch fails', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      // Checkout succeeds, but base branch fetch fails
      if (args[0] === 'jj' && args[1] === 'git' && args[2] === 'fetch' && args[4] === 'main') {
        return { exitCode: 1, stderr: 'no such branch: main' };
      }
      return { exitCode: 0, stderr: '' };
    });
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await expect(
      checkoutPrBranch(
        { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
        deps
      )
    ).rejects.toThrow('Failed to fetch base branch "main"');
  });

  test('does not fetch base branch when baseBranch is omitted', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({ runCommand });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalledWith(['git', 'fetch', 'origin', 'main'], '/tmp/repo');
    expect(runCommand).not.toHaveBeenCalledWith(
      ['jj', 'git', 'fetch', '--branch', 'main'],
      '/tmp/repo'
    );
  });

  test('throws with descriptive error when both git checkout attempts fail', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'git' && args[1] === 'fetch') return { exitCode: 0, stderr: '' };
      return { exitCode: 1, stderr: 'error: pathspec did not match any file' };
    });
    const deps = makeBranchDeps({ runCommand });

    await expect(
      checkoutPrBranch({ branch: 'feature/unknown-branch', cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to switch to branch "feature/unknown-branch"');
  });

  test('throws with descriptive error when jj new fails', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'jj' && args[1] === 'bookmark') return { exitCode: 0, stderr: '' };
      return { exitCode: 1, stderr: 'No such bookmark: feature/unknown-branch' };
    });
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/unknown-branch', cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to switch to branch "feature/unknown-branch" with jj new');
  });

  test('falls back to refs/pull/<number>/head for fork-based git PRs', async () => {
    const commands: string[][] = [];
    const runCommand = vi.fn(async (args: string[]) => {
      commands.push(args);
      // git fetch origin branch succeeds
      if (args[1] === 'fetch' && args[3] === 'fork-feature') {
        return { exitCode: 0, stderr: '' };
      }
      // git checkout --detach origin/branch fails, forcing pull-ref fallback
      if (args[1] === 'checkout' && args[2] === '--detach' && args[3] === 'origin/fork-feature') {
        return { exitCode: 1, stderr: 'fatal: invalid reference' };
      }
      // fetch pull ref and detach FETCH_HEAD succeed
      if (args[1] === 'fetch' && args[3] === 'refs/pull/99/head') {
        return { exitCode: 0, stderr: '' };
      }
      if (args[1] === 'checkout' && args[2] === '--detach' && args[3] === 'FETCH_HEAD') {
        return { exitCode: 0, stderr: '' };
      }
      return { exitCode: 1, stderr: 'unexpected command' };
    });
    const deps = makeBranchDeps({ runCommand });

    await checkoutPrBranch(
      { branch: 'fork-feature', prNumber: 99, skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    // Should have fetched via refs/pull
    expect(commands).toContainEqual(['git', 'fetch', 'origin', 'refs/pull/99/head']);
    expect(commands).toContainEqual(['git', 'checkout', '--detach', 'FETCH_HEAD']);
  });

  test('falls back to refs/pull for fork-based jj PRs', async () => {
    const commands: string[][] = [];
    const runCommand = vi.fn(async (args: string[]) => {
      commands.push(args);
      return { exitCode: 0, stderr: '' };
    });
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await checkoutPrBranch(
      { branch: 'fork-feature', prNumber: 99, skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(commands).toContainEqual([
      'jj',
      'git',
      'fetch',
      '--remote',
      'origin',
      '--branch',
      'refs/pull/99/head',
    ]);
    expect(commands).toContainEqual([
      'jj',
      'bookmark',
      'set',
      'fork-feature',
      '-r',
      'refs/pull/99/head@origin',
    ]);
    expect(commands).toContainEqual(['jj', 'new', 'fork-feature']);
  });

  test('refreshes jj PR bookmark before jj new on reruns', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await checkoutPrBranch(
      { branch: 'fork-feature', prNumber: 99, skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      ['jj', 'git', 'fetch', '--remote', 'origin', '--branch', 'refs/pull/99/head'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['jj', 'bookmark', 'set', 'fork-feature', '-r', 'refs/pull/99/head@origin'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(3, ['jj', 'new', 'fork-feature'], '/tmp/repo');
  });
});
