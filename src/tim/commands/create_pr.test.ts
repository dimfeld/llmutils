import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PlanSchema } from '../planSchema.js';

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    writePlanFile: vi.fn(async (..._args: unknown[]) => {}),
    resolvePlanByNumericId: vi.fn(async (..._args: unknown[]) => ({
      plan: {
        id: 317,
        uuid: 'plan-317',
        status: 'in_progress',
        tasks: [],
        pullRequest: ['https://github.com/acme/repo/pull/1'],
      } as unknown as PlanSchema,
      planPath: '/tmp/317.plan.md',
    })),
  };
});

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
  ensureJjPublishedCommitsHaveDescriptions: vi.fn(async (..._args: unknown[]) => []),
  fetchRemoteBranch: vi.fn(async (..._args: unknown[]) => true),
  getMergeBase: vi.fn(async (..._args: unknown[]) => 'merge-base-sha'),
  getTrunkBranch: vi.fn(async (..._args: unknown[]) => 'main'),
  getUsingJj: vi.fn(async (..._args: unknown[]) => true),
  remoteBranchExists: vi.fn(async (..._args: unknown[]) => true),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    execute: vi.fn(async (..._args: unknown[]) => {}),
  })),
}));

vi.mock('../plan_materialize.js', () => ({
  materializeRelatedPlans: vi.fn(async (..._args: unknown[]) => []),
  resolveProjectContext: vi.fn(async (..._args: unknown[]) => ({ projectId: 1 })),
}));

vi.mock('./branch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./branch.js')>();
  return {
    ...actual,
    resolveBranchPrefix: vi.fn(() => 'team/'),
  };
});

import {
  autoCreatePrForPlan,
  buildPrCreationPrompt,
  createOrUpdatePrForPlan,
  detectAndStorePrUrl,
  detectExistingPrUrl,
  resolveEffectivePrBase,
} from './create_pr.js';

import {
  writePlanFile as mockWritePlanFileFn,
  resolvePlanByNumericId as mockResolvePlanByNumericIdFn,
} from '../plans.js';
import { getDatabase as mockGetDatabaseFn } from '../db/database.js';
import { resolvePlan as mockResolvePlanFn } from '../plan_display.js';
import { syncPlanPrLinks as mockSyncPlanPrLinksFn } from '../../common/github/pr_status_service.js';
import {
  ensureJjPublishedCommitsHaveDescriptions as mockEnsureJjPublishedCommitsHaveDescriptionsFn,
  fetchRemoteBranch as mockFetchRemoteBranchFn,
  getMergeBase as mockGetMergeBaseFn,
  getTrunkBranch as mockGetTrunkBranchFn,
  getUsingJj as mockGetUsingJjFn,
  remoteBranchExists as mockRemoteBranchExistsFn,
} from '../../common/git.js';
import { buildExecutorAndLog as mockBuildExecutorAndLogFn } from '../executors/index.js';
import {
  materializeRelatedPlans as mockMaterializeRelatedPlansFn,
  resolveProjectContext as mockResolveProjectContextFn,
} from '../plan_materialize.js';
import { resolveBranchPrefix as mockResolveBranchPrefixFn } from './branch.js';

const mockWritePlanFile = vi.mocked(mockWritePlanFileFn);
const mockResolvePlanByNumericId = vi.mocked(mockResolvePlanByNumericIdFn);
const mockGetDatabase = vi.mocked(mockGetDatabaseFn);
const mockResolvePlan = vi.mocked(mockResolvePlanFn);
const mockSyncPlanPrLinks = vi.mocked(mockSyncPlanPrLinksFn);
const mockEnsureJjPublishedCommitsHaveDescriptions = vi.mocked(
  mockEnsureJjPublishedCommitsHaveDescriptionsFn
);
const mockFetchRemoteBranch = vi.mocked(mockFetchRemoteBranchFn);
const mockGetMergeBase = vi.mocked(mockGetMergeBaseFn);
const mockGetTrunkBranch = vi.mocked(mockGetTrunkBranchFn);
const mockGetUsingJj = vi.mocked(mockGetUsingJjFn);
const mockRemoteBranchExists = vi.mocked(mockRemoteBranchExistsFn);
const mockBuildExecutorAndLog = vi.mocked(mockBuildExecutorAndLogFn);
const mockMaterializeRelatedPlans = vi.mocked(mockMaterializeRelatedPlansFn);
const mockResolveProjectContext = vi.mocked(mockResolveProjectContextFn);
const mockResolveBranchPrefix = vi.mocked(mockResolveBranchPrefixFn);

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
    mockEnsureJjPublishedCommitsHaveDescriptions.mockResolvedValue([]);
    mockFetchRemoteBranch.mockResolvedValue(true);
    mockGetMergeBase.mockResolvedValue('merge-base-sha');
    mockGetTrunkBranch.mockResolvedValue('main');
    mockRemoteBranchExists.mockResolvedValue(true);
    mockMaterializeRelatedPlans.mockResolvedValue([]);
    mockResolveProjectContext.mockResolvedValue({ projectId: 1 } as any);
    mockResolveBranchPrefix.mockReturnValue('team/');
    mockResolvePlanByNumericId.mockResolvedValue({
      plan: {
        id: 317,
        uuid: 'plan-317',
        status: 'in_progress',
        tasks: [],
        pullRequest: ['https://github.com/acme/repo/pull/1'],
      } as unknown as PlanSchema,
      planPath: '/tmp/317.plan.md',
    });
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
      expect(prompt).toContain('do not ask for confirmation at any point');
      expect(prompt).toContain('Prefix the PR title with: [Feature]');
      expect(prompt).toContain('Plan ID: 317');
      expect(prompt).toContain('Issue reference: DF-123');
      expect(prompt).toContain('latest(ancestors(trunk()) & ancestors(@))');
      expect(prompt).toContain('Manual Testing Runbooks section copied from the Plan Context');
      expect(prompt).toContain('include an "Out of scope" subsection');
    });

    test('instructs PR creation to preserve runbooks from plan details', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'git',
        baseBranch: 'main',
        planTitle: 'Create PR flow',
        planDetails: `## Manual Testing Runbooks

### Happy path
1. Open the dashboard.
2. Confirm the new widget renders.`,
      });

      expect(prompt).toContain('Manual Testing Runbooks section copied from the Plan Context');
      expect(prompt).toContain('preserve the runbook titles, steps, and expected outcomes');
      expect(prompt).toContain('### Happy path');
    });

    test('includes sibling plan scope in plan context', () => {
      const prompt = buildPrCreationPrompt({
        vcsType: 'git',
        baseBranch: 'main',
        planTitle: 'Create PR flow',
        siblingPlans: [
          {
            id: 318,
            title: 'Follow-up permissions',
            status: 'pending',
            goal: 'Add permission checks after the base flow lands',
          },
        ],
      });

      expect(prompt).toContain('Sibling plans that may own adjacent or follow-up scope');
      expect(prompt).toContain(
        'Plan 318: Follow-up permissions [pending] - Add permission checks after the base flow lands'
      );
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
      expect(prompt).toContain('Push Changes Without Confirmation');
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
      mockResolvePlanByNumericId.mockResolvedValueOnce({
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
      expect(mockResolvePlanByNumericId).toHaveBeenCalledWith(317, '/tmp');
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
      expect(mockResolvePlanByNumericId).not.toHaveBeenCalled();
      expect(mockWritePlanFile).not.toHaveBeenCalled();
      expect(mockSyncPlanPrLinks).not.toHaveBeenCalled();
    });

    test('deduplicates URL when detected PR already exists in plan pullRequest list', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(
        createSpawnResult(0, JSON.stringify([{ url: 'https://github.com/acme/repo/pull/42' }]))
      );
      mockResolvePlanByNumericId.mockResolvedValueOnce({
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
      expect(mockSyncPlanPrLinks).toHaveBeenCalledWith(
        { id: 'db' },
        'plan-319',
        expect.arrayContaining(['https://github.com/acme/repo/pull/42'])
      );
    });

    test('throws when gh list command fails', async () => {
      vi.spyOn(Bun, 'spawn').mockReturnValue(createSpawnResult(1, '', 'gh: not authenticated'));

      await expect(
        detectAndStorePrUrl(320, 'plan-320', '/tmp/320.plan.md', 'feature-branch', '/tmp')
      ).rejects.toThrow('gh: not authenticated');

      expect(mockResolvePlanByNumericId).not.toHaveBeenCalled();
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

      expect(mockResolvePlanByNumericId).not.toHaveBeenCalled();
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

  describe('resolveEffectivePrBase', () => {
    test('uses basePlan predecessor branch when it exists on remote', async () => {
      mockResolvePlanByNumericId.mockResolvedValueOnce({
        plan: {
          id: 122,
          uuid: 'plan-122',
          status: 'in_progress',
          title: 'Predecessor',
          branch: 'feature-122',
          tasks: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/122.plan.md',
      });
      mockRemoteBranchExists.mockResolvedValueOnce(true);

      const baseBranch = await resolveEffectivePrBase(
        {
          id: 123,
          uuid: 'plan-123',
          status: 'needs_review',
          title: 'Followup',
          branch: 'feature-123',
          basePlan: 122,
          tasks: [],
        } as unknown as PlanSchema,
        '/repo',
        {}
      );

      expect(baseBranch).toBe('feature-122');
      expect(mockResolvePlanByNumericId).toHaveBeenCalledWith(122, '/repo');
      expect(mockRemoteBranchExists).toHaveBeenCalledWith('/repo', 'feature-122');
      expect(mockFetchRemoteBranch).not.toHaveBeenCalled();
    });

    test('falls back to trunk when basePlan predecessor branch is missing on remote', async () => {
      mockGetTrunkBranch.mockResolvedValueOnce('trunk');
      mockResolvePlanByNumericId.mockResolvedValueOnce({
        plan: {
          id: 122,
          uuid: 'plan-122',
          status: 'done',
          title: 'Merged predecessor',
          branch: 'feature-122',
          tasks: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/122.plan.md',
      });
      mockRemoteBranchExists.mockResolvedValueOnce(false);

      const baseBranch = await resolveEffectivePrBase(
        {
          id: 123,
          uuid: 'plan-123',
          status: 'needs_review',
          title: 'Followup',
          branch: 'feature-123',
          basePlan: 122,
          tasks: [],
        } as unknown as PlanSchema,
        '/repo',
        {}
      );

      expect(baseBranch).toBe('trunk');
      expect(mockRemoteBranchExists).toHaveBeenCalledWith('/repo', 'feature-122');
      expect(mockFetchRemoteBranch).not.toHaveBeenCalled();
    });

    test('lets explicit baseBranch win over basePlan', async () => {
      const baseBranch = await resolveEffectivePrBase(
        {
          id: 123,
          uuid: 'plan-123',
          status: 'needs_review',
          title: 'Followup',
          branch: 'feature-123',
          baseBranch: 'release',
          basePlan: 122,
          tasks: [],
        } as unknown as PlanSchema,
        '/repo',
        {}
      );

      expect(baseBranch).toBe('release');
      expect(mockGetTrunkBranch).not.toHaveBeenCalled();
      expect(mockResolvePlanByNumericId).not.toHaveBeenCalled();
      expect(mockRemoteBranchExists).not.toHaveBeenCalled();
    });

    test('generates basePlan branch with configured prefix when predecessor has no branch', async () => {
      mockResolvePlanByNumericId.mockResolvedValueOnce({
        plan: {
          id: 122,
          uuid: 'plan-122',
          status: 'in_progress',
          title: 'Generated predecessor',
          tasks: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/122.plan.md',
      });

      const baseBranch = await resolveEffectivePrBase(
        {
          id: 123,
          uuid: 'plan-123',
          status: 'needs_review',
          title: 'Followup',
          branch: 'feature-123',
          basePlan: 122,
          tasks: [],
        } as unknown as PlanSchema,
        '/repo',
        { branchPrefix: 'fallback' }
      );

      expect(baseBranch).toBe('team/122-generated-predecessor');
      expect(mockResolveBranchPrefix).toHaveBeenCalledWith({
        config: { branchPrefix: 'fallback' },
        db: { id: 'db' },
        projectId: 1,
      });
      expect(mockRemoteBranchExists).toHaveBeenCalledWith(
        '/repo',
        'team/122-generated-predecessor'
      );
    });
  });

  describe('createOrUpdatePrForPlan', () => {
    test('returns null when plan has no branch', async () => {
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

    test('passes resolved basePlan remote bookmark through JJ prompt comparison base and PR base', async () => {
      const executeMock = vi.fn(async (..._args: unknown[]) => {});
      mockBuildExecutorAndLog.mockReturnValueOnce({ execute: executeMock } as any);
      mockGetUsingJj.mockResolvedValueOnce(true);
      mockGetTrunkBranch.mockResolvedValueOnce('main');
      mockResolvePlanByNumericId.mockResolvedValueOnce({
        plan: {
          id: 122,
          uuid: 'plan-122',
          status: 'in_progress',
          title: 'Predecessor plan',
          branch: 'feature-122',
          tasks: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/122.plan.md',
      });
      mockRemoteBranchExists.mockResolvedValueOnce(true);
      vi.spyOn(Bun, 'spawn').mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])));

      const result = await createOrUpdatePrForPlan(
        {
          id: 401,
          uuid: 'plan-401',
          status: 'needs_review',
          tasks: [],
          title: 'Followup PR',
          branch: 'feature-401',
          basePlan: 122,
          pullRequest: [],
        } as unknown as PlanSchema,
        '/tmp/401.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(result).toBeNull();
      expect(executeMock).toHaveBeenCalledTimes(1);
      const prompt = executeMock.mock.calls[0]?.[0] as string;
      const resolvedBaseBranch = 'feature-122';
      const resolvedBaseRevset = 'latest(ancestors(feature-122@origin) & ancestors(@))';

      expect(mockResolvePlanByNumericId).toHaveBeenCalledWith(122, '/tmp');
      expect(mockRemoteBranchExists).toHaveBeenCalledWith('/tmp', resolvedBaseBranch);
      expect(mockFetchRemoteBranch).not.toHaveBeenCalled();
      expect(prompt).toContain(resolvedBaseRevset);
      expect(prompt).toContain(
        `gh pr create --draft --head <branch-name> --base ${resolvedBaseBranch}`
      );
      expect(prompt).toContain(
        `Base branch is \`${resolvedBaseBranch}\` and comparison base is \`${resolvedBaseRevset}\``
      );
      expect(prompt).not.toContain('latest(ancestors(trunk()) & ancestors(@))');
      expect(prompt).not.toContain(
        'latest(ancestors(latest(present(feature-122) | present(feature-122@origin))) & ancestors(@))'
      );
      expect(prompt).not.toContain('gh pr create --draft --head <branch-name> --base main');
    });

    test('uses original repo path for TIM_REPO_PATH when creating from workspace directory', async () => {
      const executeMock = vi.fn(async (..._args: unknown[]) => {});
      mockBuildExecutorAndLog.mockReturnValueOnce({ execute: executeMock } as any);
      mockGetUsingJj.mockResolvedValueOnce(true);
      mockGetTrunkBranch.mockResolvedValueOnce('main');
      vi.spyOn(Bun, 'spawn').mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])));

      await createOrUpdatePrForPlan(
        {
          id: 410,
          uuid: 'plan-410',
          status: 'needs_review',
          tasks: [],
          title: 'Workspace PR',
          branch: 'feature-410',
          pullRequest: [],
        } as unknown as PlanSchema,
        '/workspaces/repo-410/.tim/plans/410.plan.md',
        {
          baseDir: '/workspaces/repo-410',
          repoPath: '/repo',
          config: {},
        }
      );

      expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          baseDir: '/workspaces/repo-410',
          timEnvironment: expect.objectContaining({
            context: expect.objectContaining({
              repoPath: '/repo',
              workspacePath: '/workspaces/repo-410',
            }),
          }),
        }),
        expect.any(Object),
        expect.any(Object)
      );
    });

    test('materializes related plans when current plan has a materialized file', async () => {
      mockGetUsingJj.mockResolvedValueOnce(true);
      vi.spyOn(Bun, 'spawn').mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])));

      await createOrUpdatePrForPlan(
        {
          id: 411,
          uuid: 'plan-411',
          status: 'needs_review',
          tasks: [],
          title: 'Materialized PR',
          branch: 'feature-411',
          pullRequest: [],
        } as unknown as PlanSchema,
        '/repo/.tim/plans/411.plan.md',
        {
          baseDir: '/repo',
          config: {},
        }
      );

      expect(mockMaterializeRelatedPlans).toHaveBeenCalledWith(411, '/repo');
      expect(mockMaterializeRelatedPlans).toHaveBeenCalledTimes(1);
    });

    test('does not materialize related plans for DB-only current plan', async () => {
      mockGetUsingJj.mockResolvedValueOnce(true);
      vi.spyOn(Bun, 'spawn').mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])));

      await createOrUpdatePrForPlan(
        {
          id: 412,
          uuid: 'plan-412',
          status: 'needs_review',
          tasks: [],
          title: 'DB-only PR',
          branch: 'feature-412',
          pullRequest: [],
        } as unknown as PlanSchema,
        null,
        {
          baseDir: '/repo',
          config: {},
        }
      );

      expect(mockMaterializeRelatedPlans).not.toHaveBeenCalled();
    });

    test('fetches resolved basePlan branch before computing git merge-base', async () => {
      const executeMock = vi.fn(async (..._args: unknown[]) => {});
      mockBuildExecutorAndLog.mockReturnValueOnce({ execute: executeMock } as any);
      mockGetUsingJj.mockResolvedValueOnce(false);
      mockGetTrunkBranch.mockResolvedValueOnce('main');
      mockResolvePlanByNumericId.mockResolvedValueOnce({
        plan: {
          id: 122,
          uuid: 'plan-122',
          status: 'in_progress',
          title: 'Predecessor plan',
          branch: 'feature-122',
          tasks: [],
        } as unknown as PlanSchema,
        planPath: '/tmp/122.plan.md',
      });
      mockRemoteBranchExists.mockResolvedValueOnce(true);
      mockFetchRemoteBranch.mockResolvedValueOnce(true);
      mockGetMergeBase.mockResolvedValueOnce('merge-base-after-fetch');
      vi.spyOn(Bun, 'spawn').mockReturnValueOnce(createSpawnResult(0, JSON.stringify([])));

      const result = await createOrUpdatePrForPlan(
        {
          id: 402,
          uuid: 'plan-402',
          status: 'needs_review',
          tasks: [],
          title: 'Followup Git PR',
          branch: 'feature-402',
          basePlan: 122,
          pullRequest: [],
        } as unknown as PlanSchema,
        '/tmp/402.plan.md',
        {
          baseDir: '/tmp',
          config: {},
        }
      );

      expect(result).toBeNull();
      expect(mockRemoteBranchExists).toHaveBeenCalledWith('/tmp', 'feature-122');
      expect(mockFetchRemoteBranch).toHaveBeenCalledWith('/tmp', 'feature-122');
      expect(mockGetMergeBase).toHaveBeenCalledWith('/tmp', 'feature-122');
      expect(mockFetchRemoteBranch.mock.invocationCallOrder[0]).toBeLessThan(
        mockGetMergeBase.mock.invocationCallOrder[0]
      );
      const prompt = executeMock.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('git diff --name-status merge-base-after-fetch...HEAD');
      expect(prompt).toContain('gh pr create --draft --head <branch-name> --base feature-122');
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
      expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
        'claude-code',
        expect.objectContaining({ baseDir: '/tmp', model: 'haiku', terminalInput: false }),
        {},
        expect.objectContaining({
          allowedTools: expect.arrayContaining([
            'Bash(gh pr create:*)',
            'Bash(jj bookmark track:*)',
            'Bash(jj git push --branch:*)',
          ]),
        })
      );
      const builtExecutor = mockBuildExecutorAndLog.mock.results[0]?.value as
        | { execute?: ReturnType<typeof vi.fn> }
        | undefined;
      expect(builtExecutor?.execute).toHaveBeenCalledTimes(1);
      expect(mockEnsureJjPublishedCommitsHaveDescriptions).toHaveBeenCalledWith('/tmp');
      expect(result).toBe('https://github.com/acme/repo/pull/77');
    });
  });

  describe('autoCreatePrForPlan', () => {
    test('returns null when plan has no branch', async () => {
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
      mockResolvePlanByNumericId.mockResolvedValueOnce({
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
      mockResolvePlanByNumericId.mockResolvedValueOnce({
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
      expect(mockBuildExecutorAndLog).toHaveBeenCalledWith(
        'claude-code',
        expect.objectContaining({ baseDir: '/tmp', model: 'haiku', terminalInput: false }),
        {},
        expect.objectContaining({
          allowedTools: expect.arrayContaining([
            'Bash(gh pr create:*)',
            'Bash(jj bookmark track:*)',
            'Bash(jj git push --branch:*)',
          ]),
        })
      );
      const builtExecutor = mockBuildExecutorAndLog.mock.results[0]?.value as
        | { execute?: ReturnType<typeof vi.fn> }
        | undefined;
      expect(builtExecutor?.execute).toHaveBeenCalledTimes(1);
      expect(mockEnsureJjPublishedCommitsHaveDescriptions).toHaveBeenCalledWith('/tmp');
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
