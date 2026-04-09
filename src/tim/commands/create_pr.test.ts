import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PlanSchema } from '../planSchema.js';

vi.mock('../plans.js', () => ({
  writePlanFile: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(() => ({ id: 'db' })),
}));

vi.mock('../plan_display.js', () => ({
  resolvePlan: vi.fn(async (..._args: unknown[]) => ({
    plan: {
      id: 317,
      uuid: 'plan-317',
      status: 'in_progress',
      tasks: [],
      pullRequest: ['https://github.com/acme/repo/pull/1'],
    } as unknown as PlanSchema,
    planPath: '/tmp/317.plan.md',
  })),
}));

vi.mock('../../common/github/pr_status_service.js', () => ({
  syncPlanPrLinks: vi.fn(async (..._args: unknown[]) => []),
}));

vi.mock('../../common/git.js', () => ({
  getUsingJj: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    execute: vi.fn(async (..._args: unknown[]) => {}),
  })),
}));

import {
  autoCreatePrForPlan,
  buildPrCreationPrompt,
  createOrUpdatePrForPlan,
  detectAndStorePrUrl,
  detectExistingPrUrl,
} from './create_pr.js';

import { writePlanFile as mockWritePlanFileFn } from '../plans.js';
import { getDatabase as mockGetDatabaseFn } from '../db/database.js';
import { resolvePlan as mockResolvePlanFn } from '../plan_display.js';
import { syncPlanPrLinks as mockSyncPlanPrLinksFn } from '../../common/github/pr_status_service.js';
import { getUsingJj as mockGetUsingJjFn } from '../../common/git.js';
import { buildExecutorAndLog as mockBuildExecutorAndLogFn } from '../executors/index.js';

const mockWritePlanFile = vi.mocked(mockWritePlanFileFn);
const mockGetDatabase = vi.mocked(mockGetDatabaseFn);
const mockResolvePlan = vi.mocked(mockResolvePlanFn);
const mockSyncPlanPrLinks = vi.mocked(mockSyncPlanPrLinksFn);
const mockGetUsingJj = vi.mocked(mockGetUsingJjFn);
const mockBuildExecutorAndLog = vi.mocked(mockBuildExecutorAndLogFn);

function createSpawnResult(exitCode: number, stdout: string, stderr = ''): any {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new Response(stdout).body,
    stderr: new Response(stderr).body,
  };
}

describe('create_pr command helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('buildPrCreationPrompt', () => {
    test('includes jj-specific commands and plan context', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'jj',
        baseBranch: 'main',
        baseRef: 'latest(ancestors(trunk()) & ancestors(@))',
        planId: 317,
        planTitle: 'Create PR flow',
        issueRef: 'DF-123',
        prCreationConfig: {
          draft: true,
          titlePrefix: '[Feature] ',
        },
      });

      expect(prompt).toContain('jj status');
      expect(prompt).toContain('jj log -r @ -n 1');
      expect(prompt).toContain('jj bookmark track <branch-name> --remote origin');
      expect(prompt).toContain('--draft --head <branch-name> --base main');
      expect(prompt).toContain('Prefix the PR title with: [Feature]');
      expect(prompt).toContain('Plan ID: 317');
      expect(prompt).toContain('Issue reference: DF-123');
      expect(prompt).toContain('latest(ancestors(trunk()) & ancestors(@))');
    });

    test('includes git-specific commands and merge-base reference', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'git',
        baseBranch: 'release',
        baseRef: 'abc123mergebase',
        planTitle: 'Create PR flow',
        prCreationConfig: {
          draft: false,
        },
      });

      expect(prompt).toContain('git status --short --branch');
      expect(prompt).toContain('git rev-parse --abbrev-ref HEAD');
      expect(prompt).toContain('git diff --name-status abc123mergebase...HEAD');
      expect(prompt).toContain('git push -u origin <branch-name>');
      expect(prompt).toContain('git add -A && git commit -m "<message>"');
      expect(prompt).toContain('gh pr create --head <branch-name> --base release');
      expect(prompt).not.toContain('--draft --head');
      expect(prompt).toContain('comparison base is `abc123mergebase`');
    });

    test('falls back comparison base to baseBranch when baseRef is not provided', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'git',
        baseBranch: 'main',
      });

      expect(prompt).toContain('comparison base is `main`');
      expect(prompt).toContain('git diff --name-status main...HEAD');
      expect(prompt).toContain('gh pr create --draft --head <branch-name> --base main');
    });

    test('omits draft flag when draft is false for jj prompts', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'jj',
        baseBranch: 'main',
        baseRef: 'latest(ancestors(trunk()) & ancestors(@))',
        prCreationConfig: {
          draft: false,
        },
      });

      expect(prompt).toContain('gh pr create --head <branch-name> --base main');
      expect(prompt).not.toContain('gh pr create --draft --head <branch-name> --base main');
    });
  });

  describe('detectAndStorePrUrl', () => {
    test('stores URL in plan and syncs plan_pr links when gh returns a PR', async () => {
      const spawnSpy = vi
        .spyOn(Bun, 'spawn')
        .mockReturnValue(
          createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/42' }]))
        );
      mockResolvePlan.mockResolvedValueOnce({
        plan: {
          id: 317,
          uuid: 'plan-317',
          status: 'in_progress',
          tasks: [],
          pullRequest: ['https://github.com/acme/repo/pull/1'],
        } as unknown as PlanSchema,
        planPath: '/tmp/317.plan.md',
      });

      const prUrl = await detectAndStorePrUrl(
        317,
        'plan-317',
        '/tmp/317.plan.md',
        'feature-branch',
        '/tmp'
      );

      expect(prUrl).toBe('https://github.com/acme/repo/pull/42');
      expect(spawnSpy).toHaveBeenCalledWith(
        ['gh', 'pr', 'list', '--head', 'feature-branch', '--json', 'url'],
        expect.objectContaining({ cwd: '/tmp' })
      );
      expect(mockResolvePlan).toHaveBeenCalledWith('317', { gitRoot: '/tmp' });
      expect(mockWritePlanFile).toHaveBeenCalledTimes(1);
      expect(mockGetDatabase).toHaveBeenCalledTimes(1);
      expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(
        { id: 'db' },
        'plan-317',
        expect.arrayContaining([
          'https://github.com/acme/repo/pull/1',
          'https://github.com/acme/repo/pull/42',
        ])
      );
    });

    test('returns null and does not write when gh returns no PRs', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(createSpawnResult(0, JSON.stringify([])));

      const prUrl = await detectAndStorePrUrl(
        318,
        'plan-318',
        '/tmp/318.plan.md',
        'feature-branch',
        '/tmp'
      );

      expect(prUrl).toBeNull();
      expect(mockResolvePlan).not.toHaveBeenCalled();
      expect(mockWritePlanFile).not.toHaveBeenCalled();
      expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    });

    test('deduplicates URL when detected PR already exists in plan pullRequest list', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/42' }]))
      );
      mockResolvePlan.mockResolvedValueOnce({
        plan: {
          id: 319,
          uuid: 'plan-319',
          status: 'in_progress',
          tasks: [],
          pullRequest: ['https://github.com/acme/repo/pull/42'],
        } as unknown as PlanSchema,
        planPath: '/tmp/319.plan.md',
      });

      await detectAndStorePrUrl(319, 'plan-319', '/tmp/319.plan.md', 'feature-branch', '/tmp');

      expect(mockWritePlanFile).toHaveBeenCalledTimes(1);
      expect(mockSyncPlanPrLinks).toHaveBeenCalledWith({ id: 'db' }, 'plan-319', [
        'https://github.com/acme/repo/pull/42',
      ]);
    });

    test('throws when gh list command fails', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(createSpawnResult(1, '', 'gh: not authenticated'));

      await expect(
        detectAndStorePrUrl(320, 'plan-320', '/tmp/320.plan.md', 'feature-branch', '/tmp')
      ).rejects.toThrow('gh: not authenticated');

      expect(mockResolvePlan).not.toHaveBeenCalled();
      expect(mockWritePlanFile).not.toHaveBeenCalled();
      expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    });

    test('throws when plan UUID is missing', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/42' }]))
      );

      await expect(
        detectAndStorePrUrl(321, undefined, '/tmp/321.plan.md', 'feature-branch', '/tmp')
      ).rejects.toThrow('Plan 321 is missing UUID');

      expect(mockResolvePlan).not.toHaveBeenCalled();
      expect(mockWritePlanFile).not.toHaveBeenCalled();
      expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    });
  });

  describe('detectExistingPrUrl', () => {
    test('returns first URL when multiple PRs are returned', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(
          0,
          JSON.stringify([
            { url: 'https://github.com/acme/repo/pull/100' },
            { url: 'https://github.com/acme/repo/pull/101' },
          ])
        )
      );

      const prUrl = await detectExistingPrUrl('feature-branch', '/tmp');
      expect(prUrl).toBe('https://github.com/acme/repo/pull/100');
    });

    test('skips entries with empty URL and returns first valid one', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: '   ' }, { url: 'https://example.com/pr/2' }]))
      );

      const prUrl = await detectExistingPrUrl('feature-branch', '/tmp');
      expect(prUrl).toBe('https://example.com/pr/2');
    });

    test('returns null when all URL fields are empty', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: '   ' }, { url: '' }]))
      );

      const prUrl = await detectExistingPrUrl('feature-branch', '/tmp');
      expect(prUrl).toBeNull();
    });

    test('throws when gh pr list fails', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(createSpawnResult(1, '', 'gh failed'));

      await expect(detectExistingPrUrl('feature-branch', '/tmp')).rejects.toThrow('gh failed');
    });
  });

  describe('createOrUpdatePrForPlan', () => {
    test('returns null when plan has no branch', async () => {
      const executeMock = vi.fn(async (..._args: unknown[]) => {});
      mockBuildExecutorAndLog.mockReturnValueOnce({ execute: executeMock } as any);
      const spawnSpy = vi.spyOn(Bun, 'spawn');

      const result = await createOrUpdatePrForPlan(
        {
          id: 400,
          uuid: 'plan-400',
          status: 'in_progress',
          tasks: [],
        } as unknown as PlanSchema,
        '/tmp/400.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(result).toBeNull();
      expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    test('always runs executor even when PR already exists', async () => {
      mockGetUsingJj.mockResolvedValueOnce(true);
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/77' }]))
      );

      const result = await createOrUpdatePrForPlan(
        {
          id: 401,
          uuid: 'plan-401',
          status: 'needs_review',
          tasks: [],
          title: 'Create PR',
          branch: 'feature-401',
          pullRequest: [],
        } as unknown as PlanSchema,
        '/tmp/401.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(mockBuildExecutorAndLog).toHaveBeenCalledTimes(1);
      const builtExecutor = mockBuildExecutorAndLog.mock.results[0]?.value as
        | { execute?: ReturnType<typeof vi.fn> }
        | undefined;
      expect(builtExecutor?.execute).toHaveBeenCalledTimes(1);
      expect(result).toBe('https://github.com/acme/repo/pull/77');
    });
  });

  describe('autoCreatePrForPlan', () => {
    test('returns null when plan has no branch', async () => {
      const executeMock = vi.fn(async (..._args: unknown[]) => {});
      mockBuildExecutorAndLog.mockReturnValueOnce({ execute: executeMock } as any);
      const spawnSpy = vi.spyOn(Bun, 'spawn');

      const result = await autoCreatePrForPlan(
        {
          id: 500,
          uuid: 'plan-500',
          status: 'in_progress',
          tasks: [],
        } as unknown as PlanSchema,
        '/tmp/500.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(result).toBeNull();
      expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    });

    test('stores existing PR URL and returns early without executor', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/88' }]))
      );
      mockResolvePlan.mockResolvedValueOnce({
        plan: {
          id: 501,
          uuid: 'plan-501',
          status: 'needs_review',
          tasks: [],
          pullRequest: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/501.plan.md',
      });

      const result = await autoCreatePrForPlan(
        {
          id: 501,
          uuid: 'plan-501',
          status: 'needs_review',
          tasks: [],
          title: 'Plan 501',
          branch: 'feature-501',
          pullRequest: [],
        } as unknown as PlanSchema,
        '/tmp/501.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(result).toBe('https://github.com/acme/repo/pull/88');
      expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
      expect(mockWritePlanFile).toHaveBeenCalledTimes(1);
      expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(
        { id: 'db' },
        'plan-501',
        expect.arrayContaining(['https://github.com/acme/repo/pull/88'])
      );
    });

    test('creates PR with executor when no PR exists, then stores detected URL', async () => {
      mockGetUsingJj.mockResolvedValueOnce(true);
      const spawnSpy = vi
        .spyOn(Bun, 'spawn')
        .mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])))
        .mockReturnValueOnce(
          createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/99' }]))
        );
      mockResolvePlan.mockResolvedValueOnce({
        plan: {
          id: 502,
          uuid: 'plan-502',
          status: 'needs_review',
          tasks: [],
          pullRequest: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/502.plan.md',
      });

      const result = await autoCreatePrForPlan(
        {
          id: 502,
          uuid: 'plan-502',
          status: 'needs_review',
          tasks: [],
          title: 'Plan 502',
          branch: 'feature-502',
          pullRequest: [],
        } as unknown as PlanSchema,
        '/tmp/502.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(mockBuildExecutorAndLog).toHaveBeenCalledTimes(1);
      const builtExecutor = mockBuildExecutorAndLog.mock.results[0]?.value as
        | { execute?: ReturnType<typeof vi.fn> }
        | undefined;
      expect(builtExecutor?.execute).toHaveBeenCalledTimes(1);
      expect(spawnSpy).toHaveBeenCalledTimes(2);
      expect(result).toBe('https://github.com/acme/repo/pull/99');
      expect(mockWritePlanFile).toHaveBeenCalledTimes(1);
      expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(
        { id: 'db' },
        'plan-502',
        expect.arrayContaining(['https://github.com/acme/repo/pull/99'])
      );
    });
  });
});
