import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherPlanContext } from './context_gathering.js';
import type { DiffResult } from '../incremental_review.js';
import type { PlanWithFilename } from './hierarchy.js';

// Mock dependencies for testing
interface MockDependencies {
  resolvePlanFile: (planFile: string, config?: string) => Promise<string>;
  readPlanFile: (filePath: string) => Promise<any>;
  readAllPlans: (config: string) => Promise<{ plans: Map<number, PlanWithFilename> }>;
  generateDiffForReview: (gitRoot: string, options?: any) => Promise<DiffResult>;
  getGitRoot: () => Promise<string>;
  getParentChain: (
    plan: PlanWithFilename,
    allPlans: Map<number, PlanWithFilename>
  ) => PlanWithFilename[];
  getCompletedChildren: (
    planId: number,
    allPlans: Map<number, PlanWithFilename>
  ) => PlanWithFilename[];
  getIncrementalSummary: (gitRoot: string, planId: string, opts: any[]) => Promise<any>;
}

describe('gatherPlanContext', () => {
  let tempDir: string;
  let gitRoot: string;
  let planFile: string;
  let mockDeps: MockDependencies;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'context-gathering-test-'));
    gitRoot = tempDir;
    planFile = join(tempDir, 'test-plan.md');

    // Create a basic plan file
    await writeFile(
      planFile,
      JSON.stringify({
        id: 123,
        title: 'Test Plan',
        goal: 'Test plan goal',
        details: 'Test plan details',
        tasks: [
          {
            title: 'Task 1',
            description: 'First task description',
            steps: [
              { prompt: 'Step 1', done: true },
              { prompt: 'Step 2', done: false },
            ],
          },
        ],
      })
    );

    // Setup mock dependencies
    mockDeps = {
      resolvePlanFile: async (file) => file,
      readPlanFile: async (file) => JSON.parse(await readFile(file, 'utf-8')),
      readAllPlans: async () => ({ plans: new Map() }),
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
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('should gather basic plan context successfully', async () => {
    const options = {};
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

    expect(result.planData).toBeDefined();
    expect(result.planData.id).toBe(123);
    expect(result.planData.title).toBe('Test Plan');
    expect(result.planData.goal).toBe('Test plan goal');
    expect(result.parentChain).toEqual([]);
    expect(result.completedChildren).toEqual([]);
    expect(result.diffResult).toBeDefined();
    expect(result.diffResult.hasChanges).toBe(true);
    expect(result.diffResult.changedFiles).toEqual(['src/test.ts', 'src/another.ts']);
  });

  test('should handle parent chain loading', async () => {
    const parentPlan: PlanWithFilename = {
      id: 100,
      title: 'Parent Plan',
      goal: 'Parent goal',
      filename: 'parent.md',
    };

    const childPlan = {
      id: 123,
      title: 'Child Plan',
      goal: 'Child goal',
      parent: 100,
      tasks: [
        {
          title: 'Child Task',
          description: 'Child task description',
        },
      ],
    };

    // Update plan file to have a parent
    await writeFile(planFile, JSON.stringify(childPlan));

    const allPlans = new Map<number, PlanWithFilename>();
    allPlans.set(100, parentPlan);
    allPlans.set(123, { ...childPlan, filename: planFile });

    mockDeps.readAllPlans = async () => ({ plans: allPlans });
    mockDeps.getParentChain = () => [parentPlan];

    const options = {};
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

    expect(result.parentChain).toHaveLength(1);
    expect(result.parentChain[0].id).toBe(100);
    expect(result.parentChain[0].title).toBe('Parent Plan');
  });

  test('should handle completed children loading', async () => {
    const completedChild: PlanWithFilename = {
      id: 124,
      title: 'Completed Child',
      goal: 'Child goal',
      status: 'done',
      parent: 123,
      filename: 'child.md',
    };

    const allPlans = new Map<number, PlanWithFilename>();
    allPlans.set(123, { id: 123, title: 'Parent Plan', goal: 'Parent goal', filename: planFile });
    allPlans.set(124, completedChild);

    mockDeps.readAllPlans = async () => ({ plans: allPlans });
    mockDeps.getCompletedChildren = () => [completedChild];

    const options = {};
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

    expect(result.completedChildren).toHaveLength(1);
    expect(result.completedChildren[0].id).toBe(124);
    expect(result.completedChildren[0].title).toBe('Completed Child');
    expect(result.completedChildren[0].status).toBe('done');
  });

  test('should handle incremental review scenarios', async () => {
    const incrementalSummary = {
      lastReviewDate: new Date('2023-01-01'),
      totalFiles: 2,
      newFiles: ['new.ts'],
      modifiedFiles: ['modified.ts'],
    };

    mockDeps.getIncrementalSummary = async () => incrementalSummary;

    const options = { incremental: true };
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

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

    const options = {};
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

    expect(result.diffResult.hasChanges).toBe(false);
    expect(result.diffResult.changedFiles).toEqual([]);
  });

  test('should validate task structure', async () => {
    // Create plan with invalid task
    const planWithInvalidTask = {
      id: 123,
      title: 'Test Plan',
      goal: 'Test goal',
      tasks: [
        {
          // missing title
          description: 'Task description',
        },
      ],
    };
    await writeFile(planFile, JSON.stringify(planWithInvalidTask));

    // Use real readPlanFile function for validation in this test
    const { readPlanFile } = await import('../plans.js');
    const validationMockDeps = {
      ...mockDeps,
      readPlanFile,
    };

    const options = {};
    const globalOpts = {};

    await expect(
      gatherPlanContext(planFile, options, globalOpts, validationMockDeps)
    ).rejects.toThrow(/tasks\.0\.title.*expected string, received undefined/);
  });

  test('should handle hierarchy errors gracefully', async () => {
    const allPlans = new Map<number, PlanWithFilename>();

    mockDeps.readAllPlans = async () => {
      throw new Error('Failed to read plans');
    };

    const options = {};
    const globalOpts = {};

    // Should not throw but continue with empty hierarchy
    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

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

    const options = { incremental: true };
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, mockDeps);

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

    const options = {};
    const globalOpts = {};

    const result = await gatherPlanContext(planFile, options, globalOpts, customDeps);

    expect(result.diffResult.changedFiles).toEqual(['custom-file.ts']);
    expect(result.diffResult.baseBranch).toBe('feature-branch');
  });

  test('should pass incremental options correctly to diff generation', async () => {
    let capturedOptions: any;

    mockDeps.generateDiffForReview = async (gitRoot: string, options?: any) => {
      capturedOptions = options;
      return {
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'diff',
      };
    };

    const options = {
      incremental: true,
      sinceLastReview: true,
      since: 'abc123',
    };
    const globalOpts = {};

    await gatherPlanContext(planFile, options, globalOpts, mockDeps);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions.incremental).toBe(true);
    expect(capturedOptions.sinceLastReview).toBe(true);
    expect(capturedOptions.sinceCommit).toBe('abc123');
    expect(capturedOptions.planId).toBe('123');
  });
});
