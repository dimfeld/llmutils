import { describe, test, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { gatherPlanContext } from './context_gathering.js';
import type { DiffResult } from '../incremental_review.js';
import type { PlanSchema } from '../planSchema.js';

interface MockDependencies {
  resolvePlanFromDbOrSyncFile: (
    planFile: string,
    repoRoot: string,
    configBaseDir?: string
  ) => Promise<{
    plan: PlanSchema;
    planPath: string | null;
  }>;
  loadPlansFromDb: (searchDir: string, repositoryId: string) => { plans: Map<number, PlanSchema> };
  generateDiffForReview: (gitRoot: string, options?: any) => Promise<DiffResult>;
  getGitRoot: (cwd?: string) => Promise<string>;
  getParentChain: (plan: PlanSchema, allPlans: Map<number, PlanSchema>) => PlanSchema[];
  getCompletedChildren: (planId: number, allPlans: Map<number, PlanSchema>) => PlanSchema[];
  getIncrementalSummary: (gitRoot: string, planId: string, opts: any[]) => Promise<any>;
  resolveRepoRoot: (configPath?: string, fallbackDir?: string) => Promise<string>;
  getRepositoryIdentity: (options?: { cwd?: string }) => Promise<{
    repositoryId: string;
    remoteUrl: string | null;
    gitRoot: string;
  }>;
}

describe('gatherPlanContext', () => {
  let gitRoot: string;
  let repoRoot: string;
  let planFile: string;
  let basePlan: PlanSchema;
  let mockDeps: MockDependencies;

  beforeEach(() => {
    gitRoot = '/tmp/git-root';
    repoRoot = '/tmp/repo-root';
    planFile = '/tmp/repo-root/tasks/123-test-plan.plan.md';
    basePlan = {
      id: 123,
      uuid: '12345678-1234-4234-8234-123456789abc',
      title: 'Test Plan',
      goal: 'Test plan goal',
      details: 'Test plan details',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task description',
          done: false,
        },
      ],
      status: 'pending',
    };

    mockDeps = {
      resolvePlanFromDbOrSyncFile: async () => ({
        plan: basePlan,
        planPath: planFile,
      }),
      loadPlansFromDb: () => ({ plans: new Map() }),
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts', 'src/another.ts'],
        baseBranch: 'main',
        diffContent: 'mock diff content',
      }),
      getGitRoot: async () => gitRoot,
      getParentChain: () => [],
      getCompletedChildren: () => [],
      getIncrementalSummary: async () => null,
      resolveRepoRoot: async () => repoRoot,
      getRepositoryIdentity: async () => ({
        repositoryId: 'repo-id',
        remoteUrl: 'git@github.com:test/repo.git',
        gitRoot: repoRoot,
      }),
    };
  });

  test('should gather basic plan context successfully', async () => {
    const result = await gatherPlanContext(planFile, {}, {}, mockDeps);

    expect(result.resolvedPlanFile).toBe(planFile);
    expect(result.planData).toBeDefined();
    expect(result.planData.id).toBe(123);
    expect(result.planData.title).toBe('Test Plan');
    expect(result.planData.goal).toBe('Test plan goal');
    expect(result.repoRoot).toBe(repoRoot);
    expect(result.gitRoot).toBe(gitRoot);
    expect(result.parentChain).toEqual([]);
    expect(result.completedChildren).toEqual([]);
    expect(result.diffResult).toBeDefined();
    expect(result.diffResult.hasChanges).toBe(true);
    expect(result.diffResult.changedFiles).toEqual(['src/test.ts', 'src/another.ts']);
  });

  test('should resolve repo root using cwd and config path', async () => {
    let receivedArgs:
      | {
          configPath?: string;
          fallbackDir?: string;
        }
      | undefined;

    mockDeps.resolveRepoRoot = async (configPath, fallbackDir) => {
      receivedArgs = { configPath, fallbackDir };
      return repoRoot;
    };

    await gatherPlanContext(
      planFile,
      { cwd: '/tmp/switched-workspace' },
      { config: '/tmp/custom.tim.yml' },
      mockDeps
    );

    expect(receivedArgs).toEqual({
      configPath: '/tmp/custom.tim.yml',
      fallbackDir: '/tmp/switched-workspace',
    });
  });

  test('should resolve git root from the resolved repoRoot, not cwd', async () => {
    let receivedCwd: string | undefined;
    mockDeps.getGitRoot = async (cwd?: string) => {
      receivedCwd = cwd;
      return gitRoot;
    };

    await gatherPlanContext(planFile, { cwd: '/tmp/switched-workspace' }, {}, mockDeps);

    // getGitRoot should receive repoRoot (from resolveRepoRoot), not options.cwd
    expect(receivedCwd).toBe(repoRoot);
  });

  test('should load hierarchy from DB-backed plan map', async () => {
    const parentPlan: PlanSchema = {
      id: 100,
      title: 'Parent Plan',
      goal: 'Parent goal',
      tasks: [],
    };
    const completedChild: PlanSchema = {
      id: 124,
      title: 'Completed Child',
      goal: 'Child goal',
      status: 'done',
      parent: 123,
      tasks: [],
    };

    const allPlans = new Map<number, PlanSchema>();
    allPlans.set(100, parentPlan);
    allPlans.set(123, { ...basePlan, parent: 100 });
    allPlans.set(124, completedChild);

    mockDeps.resolvePlanFromDbOrSyncFile = async () => ({
      plan: { ...basePlan, parent: 100 },
      planPath: planFile,
    });
    mockDeps.loadPlansFromDb = (searchDir, repositoryId) => {
      expect(searchDir).toBe(path.join(gitRoot, '.tim', 'plans'));
      expect(repositoryId).toBe('repo-id');
      return { plans: allPlans };
    };
    mockDeps.getParentChain = () => [parentPlan];
    mockDeps.getCompletedChildren = () => [completedChild];

    const result = await gatherPlanContext(planFile, {}, {}, mockDeps);

    expect(result.parentChain).toHaveLength(1);
    expect(result.parentChain[0]?.id).toBe(100);
    expect(result.completedChildren).toHaveLength(1);
    expect(result.completedChildren[0]?.id).toBe(124);
  });

  test('should use plan id as resolvedPlanFile for DB-only plans', async () => {
    mockDeps.resolvePlanFromDbOrSyncFile = async () => ({
      plan: basePlan,
      planPath: null,
    });

    const result = await gatherPlanContext('123', {}, {}, mockDeps);

    expect(result.resolvedPlanFile).toBe('123');
  });

  test('should surface DB resolution failures', async () => {
    mockDeps.resolvePlanFromDbOrSyncFile = async () => {
      throw new Error('No plan found in the database for identifier: 123');
    };

    await expect(gatherPlanContext('123', {}, {}, mockDeps)).rejects.toThrow(
      'No plan found in the database for identifier: 123'
    );
  });

  test('should handle incremental review scenarios', async () => {
    const incrementalSummary = {
      lastReviewDate: new Date('2023-01-01'),
      totalFiles: 2,
      newFiles: ['new.ts'],
      modifiedFiles: ['modified.ts'],
    };

    mockDeps.getIncrementalSummary = async () => incrementalSummary;

    const result = await gatherPlanContext(planFile, { incremental: true }, {}, mockDeps);

    expect(result.incrementalSummary).toBeDefined();
    expect(result.incrementalSummary?.totalFiles).toBe(2);
    expect(result.incrementalSummary?.newFiles).toEqual(['new.ts']);
  });

  test('should handle no changes detected', async () => {
    mockDeps.generateDiffForReview = async () => ({
      hasChanges: false,
      changedFiles: [],
      baseBranch: 'main',
      diffContent: '',
    });

    const result = await gatherPlanContext(planFile, {}, {}, mockDeps);

    expect(result.diffResult.hasChanges).toBe(false);
    expect(result.diffResult.changedFiles).toEqual([]);
    expect(result.noChangesDetected).toBe(true);
  });

  test('should handle hierarchy errors gracefully', async () => {
    mockDeps.loadPlansFromDb = () => {
      throw new Error('Failed to load plans from DB');
    };

    const result = await gatherPlanContext(planFile, {}, {}, mockDeps);

    expect(result.planData).toBeDefined();
    expect(result.parentChain).toEqual([]);
    expect(result.completedChildren).toEqual([]);
  });

  test('should handle incremental review with no changes since last review', async () => {
    const incrementalSummary = {
      lastReviewDate: new Date('2023-01-01'),
      totalFiles: 0,
      newFiles: [],
      modifiedFiles: [],
    };

    mockDeps.getIncrementalSummary = async () => incrementalSummary;

    const result = await gatherPlanContext(planFile, { incremental: true }, {}, mockDeps);

    expect(result.incrementalSummary).toBeDefined();
    expect(result.incrementalSummary?.totalFiles).toBe(0);
    expect(result.noChangesDetected).toBe(true);
  });

  test('should handle dependency injection properly', async () => {
    const customDeps = {
      ...mockDeps,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['custom-file.ts'],
        baseBranch: 'feature-branch',
        diffContent: 'custom diff',
      }),
    };

    const result = await gatherPlanContext(planFile, {}, {}, customDeps);

    expect(result.diffResult.changedFiles).toEqual(['custom-file.ts']);
    expect(result.diffResult.baseBranch).toBe('feature-branch');
  });

  test('should pass incremental options correctly to diff generation', async () => {
    let capturedOptions: any;

    mockDeps.generateDiffForReview = async (_gitRoot: string, options?: any) => {
      capturedOptions = options;
      return {
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'diff',
      };
    };

    await gatherPlanContext(
      planFile,
      {
        incremental: true,
        sinceLastReview: true,
        since: 'abc123',
      },
      {},
      mockDeps
    );

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.incremental).toBe(true);
    expect(capturedOptions.sinceLastReview).toBe(true);
    expect(capturedOptions.sinceCommit).toBe('abc123');
    expect(capturedOptions.planId).toBe('123');
  });
});
