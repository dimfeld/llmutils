import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
      base_sha: 'base123',
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
    resolvePlanByNumericId: vi.fn(async () => ({
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

    expect(deps.resolvePlanByNumericId).toHaveBeenCalled();
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
      readHeadSha: vi.fn(async () => 'head-sha'),
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

  test('uses git checkout even when the repository uses jj', async () => {
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
      ['git', 'fetch', 'origin', 'feature/pr-123'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenCalledWith(
      ['git', 'checkout', '--detach', 'origin/feature/pr-123'],
      '/tmp/repo'
    );
  });

  test('fetches base branch with git even when the repository uses jj', async () => {
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

  test('throws when base branch fetch fails in a jj repository using git checkout', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      // Checkout succeeds, but base branch fetch fails
      if (args[0] === 'git' && args[1] === 'fetch' && args[3] === 'main') {
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

  test('throws with descriptive error when git checkout fails in a jj repository', async () => {
    const runCommand = vi.fn(async (args: string[]) => {
      if (args[0] === 'git' && args[1] === 'fetch') return { exitCode: 0, stderr: '' };
      return { exitCode: 1, stderr: 'No such bookmark: feature/unknown-branch' };
    });
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/unknown-branch', cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to switch to branch "feature/unknown-branch" with git checkout');
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

  test('falls back to refs/pull through git for fork-based jj PRs', async () => {
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

    expect(commands).toContainEqual(['git', 'fetch', 'origin', 'fork-feature']);
    expect(commands).toContainEqual(['git', 'checkout', '--detach', 'origin/fork-feature']);
  });

  test('uses git branch checkout for jj PR reruns', async () => {
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
      ['git', 'fetch', 'origin', 'fork-feature'],
      '/tmp/repo'
    );
    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      ['git', 'checkout', '--detach', 'origin/fork-feature'],
      '/tmp/repo'
    );
  });

  test('returns the checked-out PR head SHA', async () => {
    const deps = makeBranchDeps({ readHeadSha: vi.fn(async () => 'pr-head') });

    const headSha = await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(headSha).toBe('pr-head');
  });

  test('does not run jj commands in a git repository', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({ runCommand });

    await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(runCommand.mock.calls.some(([args]) => args[0] === 'jj')).toBe(false);
  });

  test('imports Git refs into jj after the base fetch and keeps an unchanged HEAD', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
      readHeadSha: vi.fn(async () => 'pr-head'),
    });

    const headSha = await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(headSha).toBe('pr-head');
    expect(runCommand).toHaveBeenNthCalledWith(3, ['git', 'fetch', 'origin', 'main'], '/tmp/repo');
    expect(runCommand).toHaveBeenNthCalledWith(4, ['jj', 'git', 'import'], '/tmp/repo');
    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  test('restores the PR head when the jj import rewrites it', async () => {
    const runCommand = vi.fn(async () => ({ exitCode: 0, stderr: '' }));
    const readHeadSha = vi
      .fn<(cwd: string) => Promise<string>>()
      .mockResolvedValueOnce('pr-head')
      .mockResolvedValueOnce('rewritten-head')
      .mockResolvedValueOnce('pr-head');
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
      readHeadSha,
    });

    const headSha = await checkoutPrBranch(
      { branch: 'feature/pr-123', baseBranch: 'main', skipDirtyCheck: true, cwd: '/tmp/repo' },
      deps
    );

    expect(headSha).toBe('pr-head');
    expect(runCommand).toHaveBeenNthCalledWith(4, ['jj', 'git', 'import'], '/tmp/repo');
    expect(runCommand).toHaveBeenNthCalledWith(5, ['jj', 'new', 'pr-head'], '/tmp/repo');
  });

  test('throws when HEAD is still wrong after restoring the PR head', async () => {
    const readHeadSha = vi
      .fn<(cwd: string) => Promise<string>>()
      .mockResolvedValueOnce('pr-head')
      .mockResolvedValue('rewritten-head');
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      readHeadSha,
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to restore PR head pr-head: Git HEAD is rewritten-head');
  });

  test('throws when jj new fails while restoring the PR head', async () => {
    const runCommand = vi.fn(async (args: string[]) =>
      args[0] === 'jj' && args[1] === 'new'
        ? { exitCode: 1, stderr: 'Revision not found' }
        : { exitCode: 0, stderr: '' }
    );
    const readHeadSha = vi
      .fn<(cwd: string) => Promise<string>>()
      .mockResolvedValueOnce('pr-head')
      .mockResolvedValue('rewritten-head');
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
      readHeadSha,
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to restore PR head pr-head with jj new: Revision not found');
  });

  test('throws when the jj import fails', async () => {
    const runCommand = vi.fn(async (args: string[]) =>
      args[0] === 'jj' ? { exitCode: 1, stderr: 'jj exploded' } : { exitCode: 0, stderr: '' }
    );
    const deps = makeBranchDeps({
      getUsingJj: vi.fn(async () => true),
      runCommand,
    });

    await expect(
      checkoutPrBranch({ branch: 'feature/pr-123', skipDirtyCheck: true, cwd: '/tmp/repo' }, deps)
    ).rejects.toThrow('Failed to import Git refs into jj after PR checkout: jj exploded');
  });
});

describe.skipIf(!Bun.which('jj'))('checkoutPrBranch in a colocated jj repository', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-checkout-jj-'));
    vi.stubEnv('JJ_USER', 'Test User');
    vi.stubEnv('JJ_EMAIL', 'test@example.com');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function headCommit(cwd: string): Promise<string> {
    return (await $`git rev-parse HEAD`.cwd(cwd).quiet().text()).trim();
  }

  test('keeps the PR head when the base branch was rewritten and pushed without its child', async () => {
    const remote = path.join(tempDir, 'remote.git');
    const author = path.join(tempDir, 'author');
    const workspace = path.join(tempDir, 'workspace');
    await $`git init -q --bare ${remote}`.quiet();

    // The author pushes a base branch and a stacked child branch with jj, so the commits carry
    // jj change IDs.
    await $`jj git init --colocate ${author}`.quiet();
    await $`git remote add origin ${remote}`.cwd(author).quiet();
    await fs.writeFile(path.join(author, 'a.txt'), 'base\n');
    await $`jj commit -m base`.cwd(author).quiet();
    await $`jj bookmark set base -r @-`.cwd(author).quiet();
    await fs.writeFile(path.join(author, 'b.txt'), 'child\n');
    await $`jj commit -m child`.cwd(author).quiet();
    await $`jj bookmark set child -r @-`.cwd(author).quiet();
    await $`jj git push -b base -b child`.cwd(author).quiet();

    // A reused review workspace already tracks both bookmarks.
    await $`git clone -q ${remote} ${workspace}`.quiet();
    await $`jj git init --colocate`.cwd(workspace).quiet();
    await $`jj bookmark track base --remote origin`.cwd(workspace).quiet();
    await $`jj bookmark track child --remote origin`.cwd(workspace).quiet();
    const childHead = (await $`git rev-parse origin/child`.cwd(workspace).quiet().text()).trim();

    // The author rewrites the base and pushes only the base.
    await $`jj edit base`.cwd(author).quiet();
    await fs.writeFile(path.join(author, 'a.txt'), 'base v2\n');
    await $`jj new`.cwd(author).quiet();
    await $`jj git push -b base`.cwd(author).quiet();

    const headSha = await checkoutPrBranch({
      branch: 'child',
      baseBranch: 'base',
      skipDirtyCheck: true,
      cwd: workspace,
    });

    expect(headSha).toBe(childHead);
    expect(await headCommit(workspace)).toBe(childHead);

    // Later jj commands must not move HEAD again.
    await $`jj status`.cwd(workspace).quiet();
    expect(await headCommit(workspace)).toBe(childHead);
  });
});
