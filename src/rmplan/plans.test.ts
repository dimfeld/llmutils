import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import {
  findNextPlan,
  readAllPlans,
  resolvePlanFile,
  setPlanStatus,
  clearPlanCache,
  readPlanFile,
} from './plans.js';
import { planSchema, type PlanSchema } from './planSchema.js';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('resolvePlanFile', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeAll(async () => {
    // Create a temporary directory for test files
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-test-')));
    tasksDir = join(tempDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });

    // Clear the plan cache before tests
    clearPlanCache();

    // Set up module mocks with a getter to ensure tasksDir is evaluated lazily
    await moduleMocker.mock('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          get tasks() {
            return tasksDir;
          },
        },
      }),
    }));

    // Create test plan files
    const plan1 = {
      id: 1,
      title: 'Test Plan 1',
      goal: 'Test goal 1',
      details: 'Details for test plan 1',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };

    const plan2 = {
      id: 2,
      title: 'Implement Authentication',
      goal: 'Add authentication system',
      details: 'Add authentication to the application',
      status: 'in_progress',
      priority: 'high',
      dependencies: [1],
      tasks: [],
    };

    const planWithoutId = {
      title: 'Plan without ID',
      goal: 'This plan has no ID',
      details: 'Details for plan without ID',
      tasks: [],
    };

    await writeFile(join(tasksDir, '1.yml'), yaml.stringify(plan1));
    await writeFile(join(tasksDir, '2.yml'), yaml.stringify(plan2));
    await writeFile(join(tasksDir, 'no-id.yml'), yaml.stringify(planWithoutId));

    // Create a plan outside the tasks dir
    await writeFile(join(tempDir, 'outside-plan.yml'), yaml.stringify(plan1));
  });

  afterAll(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve an absolute file path that exists', async () => {
    const absolutePath = join(tasksDir, '1.yml');
    const resolved = await resolvePlanFile(absolutePath);
    expect(resolved).toBe(absolutePath);
  });

  it('should resolve a relative file path that exists', async () => {
    const originalCwd = process.cwd();
    process.chdir(tasksDir);

    try {
      const resolved = await resolvePlanFile('./1.yml');
      expect(resolved).toBe(join(tasksDir, '1.yml'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should resolve a plan ID to the correct file', async () => {
    const resolved = await resolvePlanFile('1');
    expect(resolved).toBe(join(tasksDir, '1.yml'));
  });

  it('should resolve a plan ID with dashes', async () => {
    const resolved = await resolvePlanFile('2');
    expect(resolved).toBe(join(tasksDir, '2.yml'));
  });

  it('should throw error for non-existent file path', async () => {
    await expect(resolvePlanFile('./non-existent.yml')).rejects.toThrow(
      'Plan file not found: ./non-existent.yml'
    );
  });

  it('should throw error for non-existent plan ID', async () => {
    await expect(resolvePlanFile('non-existent-id')).rejects.toThrow(
      'No plan found with ID or file path: non-existent-id'
    );
  });

  it('should handle plans in nested directories', async () => {
    // Create a nested directory with a plan
    const nestedDir = join(tasksDir, 'nested');
    await mkdir(nestedDir, { recursive: true });

    const nestedPlan = {
      id: 3,
      title: 'Nested Plan',
      goal: 'Test nested directory',
      details: 'Details for nested plan',
      tasks: [],
    };

    await writeFile(join(nestedDir, 'nested-plan.yml'), yaml.stringify(nestedPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('3');
    expect(resolved).toBe(join(nestedDir, 'nested-plan.yml'));
  });

  it('should resolve by a numeric string ID that corresponds to an existing [ID].yml file', async () => {
    // Create a numeric plan file with format [ID].yml
    const numericPlan = {
      id: 101,
      title: 'Numeric Plan 101',
      goal: 'Test numeric ID',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, '101.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('101');
    expect(resolved).toBe(join(tasksDir, '101.yml'));
  });

  it('should resolve by a numeric string ID where [ID].yml does not exist but another file contains that ID', async () => {
    // Create a plan with numeric ID 102 but in a different filename
    const numericPlan = {
      id: 102,
      title: 'Numeric Plan 102',
      goal: 'Test numeric ID in different file',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, 'my-plan.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('102');
    expect(resolved).toBe(join(tasksDir, 'my-plan.yml'));
  });

  it('should resolve by providing the direct filename [ID].yml', async () => {
    // Create a numeric plan file
    const numericPlan = {
      id: 103,
      title: 'Numeric Plan 103',
      goal: 'Test direct filename',
      details: 'Details for numeric plan',
      status: 'pending',
      tasks: [],
    };

    await writeFile(join(tasksDir, '103.yml'), yaml.stringify(numericPlan));

    // Clear cache to ensure the new file is found
    clearPlanCache();

    const resolved = await resolvePlanFile('103.yml');
    expect(resolved).toBe(join(tasksDir, '103.yml'));
  });

  it('should throw an error if the plan ID or filename cannot be resolved', async () => {
    await expect(resolvePlanFile('999')).rejects.toThrow('No plan found with ID or file path: 999');

    await expect(resolvePlanFile('non-existent-plan-id')).rejects.toThrow(
      'No plan found with ID or file path: non-existent-plan-id'
    );
  });
});

describe('readAllPlans', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-readall-test-')));

    // Create test structure
    const subDir = join(tempDir, 'subdir');
    await mkdir(subDir, { recursive: true });

    // Create various test files
    const plans = [
      {
        filename: 'plan1.yml',
        content: {
          id: 1,
          title: 'Plan 1',
          goal: 'Goal 1',
          details: 'Details for plan 1',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'plan2.yaml',
        content: {
          id: 2,
          title: 'Plan 2',
          goal: 'Goal 2',
          details: 'Details for plan 2',
          status: 'done',
          dependencies: [1],
          tasks: [],
        },
      },
      {
        filename: join('subdir', 'nested.yml'),
        content: {
          id: 3,
          title: 'Nested Plan',
          goal: 'Nested goal',
          details: 'Details for nested plan',
          tasks: [],
        },
      },
      {
        filename: 'no-id.yml',
        content: {
          title: 'No ID',
          goal: 'This has no ID',
          details: 'Details for no ID',
          tasks: [],
        },
      },
      {
        filename: 'invalid.yml',
        content: 'invalid yaml content {',
      },
      {
        filename: 'not-yaml.txt',
        content: 'This is not a YAML file',
      },
    ];

    for (const { filename, content } of plans) {
      const fullPath = join(tempDir, filename);
      if (typeof content === 'string') {
        await writeFile(fullPath, content);
      } else {
        await writeFile(fullPath, yaml.stringify(content));
      }
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should read all valid plan files recursively', async () => {
    const { plans, maxNumericId } = await readAllPlans(tempDir);

    expect(plans.size).toBe(3);
    expect(plans.has(1)).toBe(true);
    expect(plans.has(2)).toBe(true);
    expect(plans.has(3)).toBe(true);

    // The no-id.yml file should not be included
    const generatedIdPlan = Array.from(plans.values()).find((p) =>
      p.filename.endsWith('no-id.yml')
    );
    expect(generatedIdPlan).toBeUndefined();

    // Since all IDs are numeric, maxNumericId should be 3
    expect(maxNumericId).toBe(3);
  });

  it('should include correct plan summaries', async () => {
    const { plans } = await readAllPlans(tempDir);

    const plan1 = plans.get(1);
    expect(plan1).toBeDefined();
    expect(plan1!.title).toBe('Plan 1');
    expect(plan1!.goal).toBe('Goal 1');
    expect(plan1!.status).toBe('pending');
    expect(plan1!.priority).toBe('high');
    expect(plan1!.filename).toBe(join(tempDir, 'plan1.yml'));

    const plan2 = plans.get(2);
    expect(plan2).toBeDefined();
    expect(plan2!.status).toBe('done');
    expect(plan2!.dependencies).toEqual([1]);
  });

  it('should handle empty directories', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-'));
    try {
      const { plans, maxNumericId } = await readAllPlans(emptyDir);
      expect(plans.size).toBe(0);
      expect(maxNumericId).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should handle numeric IDs and calculate maxNumericId correctly', async () => {
    const numericIdDir = await mkdtemp(join(tmpdir(), 'numeric-id-test-'));
    try {
      // Create plans with numeric IDs
      const plans = [
        { id: 100, title: 'Plan 100', goal: 'Test', details: 'Test', tasks: [] },
        { id: 50, title: 'Plan 50', goal: 'Test', details: 'Test', tasks: [] },
        { id: 75, title: 'Plan 75', goal: 'Test', details: 'Test', tasks: [] },
      ];

      for (const plan of plans) {
        await writeFile(join(numericIdDir, `${plan.id}.yml`), yaml.stringify(plan));
      }

      const { plans: readPlans, maxNumericId } = await readAllPlans(numericIdDir);

      // Check that numeric IDs are stored as numbers
      expect(readPlans.get(100)).toBeDefined();
      expect(readPlans.get(100)!.id).toBe(100);
      expect(typeof readPlans.get(100)!.id).toBe('number');

      expect(readPlans.get(50)).toBeDefined();
      expect(readPlans.get(50)!.id).toBe(50);

      expect(readPlans.get(75)).toBeDefined();
      expect(readPlans.get(75)!.id).toBe(75);

      // maxNumericId should be the highest numeric ID
      expect(maxNumericId).toBe(100);
    } finally {
      await rm(numericIdDir, { recursive: true, force: true });
    }
  });

  it('should handle invalid YAML and empty files gracefully', async () => {
    const errorTestDir = await mkdtemp(join(tmpdir(), 'error-test-'));
    try {
      // Create some valid plans
      await writeFile(
        join(errorTestDir, 'valid.yml'),
        yaml.stringify({ id: 200, title: 'Valid', goal: 'Test', details: 'Test', tasks: [] })
      );

      // Create invalid YAML
      await writeFile(join(errorTestDir, 'invalid.yml'), '{ invalid yaml: }}}');

      // Create empty file
      await writeFile(join(errorTestDir, 'empty.yml'), '');

      // Should still read the valid plan
      const { plans, maxNumericId } = await readAllPlans(errorTestDir);

      expect(plans.size).toBe(1);
      expect(plans.get(200)).toBeDefined();
      expect(maxNumericId).toBe(200);
    } finally {
      await rm(errorTestDir, { recursive: true, force: true });
    }
  });

  it('should handle plans without IDs correctly', async () => {
    const mixedIdDir = await mkdtemp(join(tmpdir(), 'mixed-id-test-'));
    try {
      // Create plans with and without IDs
      await writeFile(
        join(mixedIdDir, 'with-id.yml'),
        yaml.stringify({ id: 300, title: 'With ID', goal: 'Test', details: 'Test', tasks: [] })
      );

      await writeFile(
        join(mixedIdDir, 'no-id.yml'),
        yaml.stringify({ title: 'No ID', goal: 'Test', details: 'Test', tasks: [] })
      );

      const { plans, maxNumericId } = await readAllPlans(mixedIdDir);

      // Only the plan with ID should be included
      expect(plans.size).toBe(1);
      expect(plans.get(300)).toBeDefined();
      expect(maxNumericId).toBe(300);
    } finally {
      await rm(mixedIdDir, { recursive: true, force: true });
    }
  });
});

describe('findNextReadyPlan', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-findnext-test-')));

    // Create test plans with various priorities and dependencies
    const plans = [
      {
        filename: 'low-priority-1.yml',
        content: {
          id: 1,
          title: 'Low Priority 1',
          goal: 'Low priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'low',
          tasks: [],
        },
      },
      {
        filename: 'urgent-priority.yml',
        content: {
          id: 2,
          title: 'Urgent Priority',
          goal: 'Urgent goal',
          details: 'Details',
          status: 'pending',
          priority: 'urgent',
          tasks: [],
        },
      },
      {
        filename: 'medium-priority.yml',
        content: {
          id: 3,
          title: 'Medium Priority',
          goal: 'Medium goal',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          tasks: [],
        },
      },
      {
        filename: 'high-priority.yml',
        content: {
          id: 4,
          title: 'High Priority',
          goal: 'High goal',
          details: 'Details',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'no-priority.yml',
        content: {
          id: 5,
          title: 'No Priority',
          goal: 'No priority goal',
          details: 'Details',
          status: 'pending',
          tasks: [],
        },
      },
      {
        filename: 'high-priority-2.yml',
        content: {
          id: 6,
          title: 'High Priority 2',
          goal: 'Second high priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'high',
          tasks: [],
        },
      },
      {
        filename: 'done-plan.yml',
        content: {
          id: 7,
          title: 'Done Plan',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          priority: 'urgent',
          tasks: [],
        },
      },
      {
        filename: 'blocked-plan.yml',
        content: {
          id: 8,
          title: 'Blocked Plan',
          goal: 'Blocked by dependency',
          details: 'Details',
          status: 'pending',
          priority: 'urgent',
          dependencies: [7, 1], // low-1 is not done, so this is blocked
          tasks: [],
        },
      },
      {
        filename: 'ready-with-deps.yml',
        content: {
          id: 9,
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: [7], // done-1 is done, so this is ready
          tasks: [],
        },
      },
    ];

    for (const { filename, content } of plans) {
      await writeFile(join(tempDir, filename), yaml.stringify(content));
    }
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return the highest priority ready plan', async () => {
    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).toBe(2);
  });

  it('should sort by ID when priorities are equal', async () => {
    // Remove the urgent plan to test high priority sorting
    await rm(join(tempDir, 'urgent-priority.yml'));

    // Clear cache after file removal to ensure fresh read
    clearPlanCache();

    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).toBe(4); // Plan 4 comes before plan 6
  });

  it('should skip blocked plans even if they have high priority', async () => {
    // The blocked-1 plan has urgent priority but depends on low-1 which is not done
    const { plans } = await readAllPlans(tempDir);
    const blockedPlan = plans.get(8);
    expect(blockedPlan).toBeDefined();
    expect(blockedPlan!.priority).toBe('urgent');

    // But it should not be returned as the next plan
    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).not.toBe(8);
  });

  it('should include plans with all dependencies done', async () => {
    const { plans } = await readAllPlans(tempDir);
    const readyWithDeps = plans.get(9);
    expect(readyWithDeps).toBeDefined();
    expect(readyWithDeps!.dependencies).toEqual([7]);

    // Create a fresh directory with only the dependency test plans
    const depTestDir = await mkdtemp(join(tmpdir(), 'dep-test-'));
    try {
      await writeFile(
        join(depTestDir, 'done-dep.yml'),
        yaml.stringify({
          id: 10,
          title: 'Done Dependency',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          tasks: [],
        })
      );

      await writeFile(
        join(depTestDir, 'ready-with-deps.yml'),
        yaml.stringify({
          id: 11,
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: [10],
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(depTestDir, { includePending: true });
      expect(nextPlan).toBeDefined();
      expect(nextPlan!.id).toBe(11);
    } finally {
      await rm(depTestDir, { recursive: true, force: true });
    }
  });

  it('should return null when no plans are ready', async () => {
    // Create a directory with only done plans
    const doneDir = await mkdtemp(join(tmpdir(), 'done-'));
    try {
      await writeFile(
        join(doneDir, 'done.yml'),
        yaml.stringify({
          id: 12,
          title: 'Done',
          goal: 'Already done',
          details: 'Details',
          status: 'done',
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(doneDir, { includePending: true });
      expect(nextPlan).toBeNull();
    } finally {
      await rm(doneDir, { recursive: true, force: true });
    }
  });

  it('should prioritize plans without priority lower than those with low priority', async () => {
    // Create a fresh directory with only no-priority and low-priority plans
    const priorityTestDir = await mkdtemp(join(tmpdir(), 'priority-test-'));
    try {
      await writeFile(
        join(priorityTestDir, 'no-priority.yml'),
        yaml.stringify({
          id: 13,
          title: 'No Priority',
          goal: 'No priority goal',
          details: 'Details',
          status: 'pending',
          tasks: [],
        })
      );

      await writeFile(
        join(priorityTestDir, 'low-priority.yml'),
        yaml.stringify({
          id: 14,
          title: 'Low Priority',
          goal: 'Low priority goal',
          details: 'Details',
          status: 'pending',
          priority: 'low',
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(priorityTestDir, { includePending: true });
      expect(nextPlan).toBeDefined();
      expect(nextPlan!.id).toBe(14); // Low priority is higher than no priority
    } finally {
      await rm(priorityTestDir, { recursive: true, force: true });
    }
  });
});

describe('setPlanStatus', () => {
  let tempDir: string;

  beforeAll(async () => {
    // Clear the plan cache before tests
    clearPlanCache();

    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-setstatus-test-')));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should successfully update status and updatedAt for a valid plan', async () => {
    const planPath = join(tempDir, 'test-plan.yml');
    const originalPlan: PlanSchema = {
      id: 15,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    const beforeTime = new Date();
    await setPlanStatus(planPath, 'in_progress');
    const afterTime = new Date();

    const updatedContent = await readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.id).toBe(originalPlan.id);
    expect(updatedPlan.title).toBe(originalPlan.title);
    expect(updatedPlan.goal).toBe(originalPlan.goal);
    expect(updatedPlan.details).toBe(originalPlan.details);
    expect(updatedPlan.priority).toBe(originalPlan.priority);
    expect(updatedPlan.createdAt).toBe(originalPlan.createdAt);

    // Check that updatedAt is more recent
    const updatedAt = new Date(updatedPlan.updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
  });

  it('should handle non-existent plan files', async () => {
    const nonExistentPath = join(tempDir, 'non-existent.yml');

    await expect(setPlanStatus(nonExistentPath, 'done')).rejects.toThrow();
  });

  it('should handle files that are not valid YAML', async () => {
    const invalidYamlPath = join(tempDir, 'invalid.yml');
    await writeFile(invalidYamlPath, 'invalid yaml content {{{');

    await expect(setPlanStatus(invalidYamlPath, 'done')).rejects.toThrow();
  });

  it('should ensure updatedAt is more recent after an update', async () => {
    const planPath = join(tempDir, 'time-test-plan.yml');
    const originalTime = '2024-01-01T00:00:00.000Z';
    const originalPlan: PlanSchema = {
      id: 16,
      title: 'Time Test Plan',
      goal: 'Test time update',
      details: 'Test details',
      status: 'pending',
      updatedAt: originalTime,
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    // Wait a bit to ensure time difference
    await new Promise((resolve) => setTimeout(resolve, 10));

    await setPlanStatus(planPath, 'done');

    const updatedContent = await readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    expect(new Date(updatedPlan.updatedAt!).getTime()).toBeGreaterThan(
      new Date(originalTime).getTime()
    );
  });

  it('should handle plans without updatedAt field', async () => {
    const planPath = join(tempDir, 'no-updatedat-plan.yml');
    const originalPlan: PlanSchema = {
      id: 17,
      title: 'No UpdatedAt Plan',
      goal: 'Test without updatedAt',
      details: 'Test details',
      status: 'pending',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    const beforeTime = new Date();
    await setPlanStatus(planPath, 'in_progress');

    const updatedContent = await readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as PlanSchema;

    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.updatedAt).toBeDefined();

    const updatedAt = new Date(updatedPlan.updatedAt!);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
  });

  it('should validate against plan schema and throw on invalid structure', async () => {
    const invalidPlanPath = join(tempDir, 'invalid-plan.yml');
    const invalidPlan = {
      // Missing required fields like 'goal' and 'details'
      id: 'invalid',
      title: 'Invalid Plan',
      tasks: 'not-an-array', // Invalid type
    };

    await writeFile(invalidPlanPath, yaml.stringify(invalidPlan));

    await expect(setPlanStatus(invalidPlanPath, 'done')).rejects.toThrow();
  });

  it('should handle empty YAML file', async () => {
    const emptyPath = join(tempDir, 'empty.yml');
    await writeFile(emptyPath, '');

    await expect(setPlanStatus(emptyPath, 'done')).rejects.toThrow();
  });

  it('should handle file with only comments', async () => {
    const commentOnlyPath = join(tempDir, 'comments-only.yml');
    await writeFile(commentOnlyPath, '# Just a comment\n# Another comment');

    await expect(setPlanStatus(commentOnlyPath, 'done')).rejects.toThrow();
  });

  it('should preserve other fields when updating status', async () => {
    const planPath = join(tempDir, 'preserve-fields.yml');
    const originalPlan: PlanSchema = {
      id: 18,
      title: 'Preserve Fields Test',
      goal: 'Test field preservation',
      details: 'Detailed description',
      status: 'pending',
      priority: 'high',
      dependencies: [19, 20],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      tasks: [
        {
          title: 'Task 1',
          description: 'Task description',
          files: [],
          steps: [
            { prompt: 'Step 1', done: true },
            { prompt: 'Step 2', done: false },
          ],
        },
      ],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    await setPlanStatus(planPath, 'in_progress');

    const updatedContent = await readFile(planPath, 'utf-8');
    const updatedPlan = yaml.parse(updatedContent) as any;

    // Check that all fields are preserved
    expect(updatedPlan.id).toBe(originalPlan.id);
    expect(updatedPlan.title).toBe(originalPlan.title);
    expect(updatedPlan.goal).toBe(originalPlan.goal);
    expect(updatedPlan.details).toBe(originalPlan.details);
    expect(updatedPlan.priority).toBe(originalPlan.priority);
    expect(updatedPlan.dependencies).toEqual(originalPlan.dependencies);
    expect(updatedPlan.createdAt).toBe(originalPlan.createdAt);
    expect(updatedPlan.tasks).toEqual(originalPlan.tasks);

    // Only status and updatedAt should change
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.updatedAt).not.toBe(originalPlan.updatedAt);
  });

  it('should handle concurrent updates gracefully', async () => {
    const planPath = join(tempDir, 'concurrent-test.yml');
    const originalPlan: PlanSchema = {
      id: 21,
      title: 'Concurrent Test',
      goal: 'Test concurrent updates',
      details: 'Testing',
      status: 'pending',
      tasks: [],
    };

    await writeFile(planPath, yaml.stringify(originalPlan));

    // Attempt concurrent updates
    const promises = [
      setPlanStatus(planPath, 'in_progress'),
      setPlanStatus(planPath, 'done'),
      setPlanStatus(planPath, 'pending'),
    ];

    // All should complete without error
    await expect(Promise.all(promises)).resolves.toBeDefined();

    // Final state should be one of the statuses
    const finalContent = await readFile(planPath, 'utf-8');
    const finalPlan = yaml.parse(finalContent) as PlanSchema;
    expect(['pending', 'in_progress', 'done']).toContain(finalPlan.status);
  });
});

describe('Plan File Reading and Writing', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-frontmatter-test-')));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should read plan file with YAML front matter correctly', async () => {
    const planPath = join(tempDir, 'front-matter-plan.md');
    const frontMatterContent = `---
id: 100
title: Test Plan with Front Matter
goal: Test the new front matter format
status: pending
priority: high
dependencies: [1, 2]
createdAt: 2024-01-01T00:00:00.000Z
tasks:
  - title: Task 1
    description: First task
    files: []
    steps:
      - prompt: Step 1
        done: false
---

# Implementation Details

This is the markdown body that contains the details of the plan.

## Background

The plan should support:
- Multiple lines of markdown
- Various markdown features
- Code blocks

\`\`\`typescript
const example = "code block";
\`\`\`

And more content here.`;

    await writeFile(planPath, frontMatterContent);

    const plan = await readPlanFile(planPath);

    expect(plan.id).toBe(100);
    expect(plan.title).toBe('Test Plan with Front Matter');
    expect(plan.goal).toBe('Test the new front matter format');
    expect(plan.status).toBe('pending');
    expect(plan.priority).toBe('high');
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks![0].title).toBe('Task 1');

    // The markdown body should be placed in the details field
    expect(plan.details).toContain('# Implementation Details');
    expect(plan.details).toContain('This is the markdown body');
    expect(plan.details).toContain('const example = "code block";');
  });

  it('should maintain backward compatibility with pure YAML files', async () => {
    const planPath = join(tempDir, 'legacy-plan.yml');
    const legacyPlan = {
      id: 101,
      title: 'Legacy YAML Plan',
      goal: 'Test backward compatibility',
      details: 'This is the details field in the YAML itself',
      status: 'in_progress',
      priority: 'medium',
      dependencies: [3],
      tasks: [
        {
          title: 'Legacy Task',
          description: 'A task in the old format',
          files: ['src/legacy.ts'],
          steps: [
            { prompt: 'Legacy step 1', done: true },
            { prompt: 'Legacy step 2', done: false },
          ],
        },
      ],
    };

    // Write as pure YAML (old format)
    await writeFile(planPath, yaml.stringify(legacyPlan));

    const plan = await readPlanFile(planPath);

    // Verify all fields are read correctly
    expect(plan.id).toBe(101);
    expect(plan.title).toBe('Legacy YAML Plan');
    expect(plan.goal).toBe('Test backward compatibility');
    expect(plan.details).toBe('This is the details field in the YAML itself');
    expect(plan.status).toBe('in_progress');
    expect(plan.priority).toBe('medium');
    expect(plan.dependencies).toEqual([3]);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks![0].title).toBe('Legacy Task');
    expect(plan.tasks![0].steps).toHaveLength(2);
  });
});

describe('schema validation and YAML serialization', () => {
  it('should serialize numeric IDs as numbers in YAML', () => {
    const planWithNumericId: PlanSchema = {
      id: 123,
      title: 'Test Plan with Numeric ID',
      goal: 'Test numeric ID serialization',
      details: 'This plan has a numeric ID',
      status: 'pending',
      tasks: [],
    };

    const yamlString = yaml.stringify(planWithNumericId);

    // Verify the YAML contains the number, not a string
    expect(yamlString).toContain('id: 123');
    expect(yamlString).not.toContain('id: "123"');
    expect(yamlString).not.toContain("id: '123'");
  });

  it('should parse numeric IDs from YAML as numbers', () => {
    const yamlWithNumericId = `
id: 456
title: Test Plan
goal: Test parsing
details: Test details
tasks: []
`;

    const parsed = yaml.parse(yamlWithNumericId);
    const validatedPlan = planSchema.parse(parsed);

    expect(validatedPlan.id).toBe(456);
    expect(typeof validatedPlan.id).toBe('number');
  });

  it('should accept plans without IDs', () => {
    const planWithoutId: PlanSchema = {
      title: 'Test Plan without ID',
      goal: 'Test optional ID',
      details: 'This plan has no ID',
      status: 'pending',
      tasks: [],
    };

    const yamlString = yaml.stringify(planWithoutId);

    // Verify the YAML doesn't contain an ID field
    expect(yamlString).not.toContain('id:');

    // Parse it back and verify
    const parsed = yaml.parse(yamlString);
    const validatedPlan = planSchema.parse(parsed);

    expect(validatedPlan.id).toBeUndefined();
  });

  it('should reject invalid numeric IDs', () => {
    const invalidNumericIds = [
      { id: 0, title: 'Zero ID', goal: 'Test', details: 'Test', tasks: [] },
      { id: -5, title: 'Negative ID', goal: 'Test', details: 'Test', tasks: [] },
      { id: 1.5, title: 'Float ID', goal: 'Test', details: 'Test', tasks: [] },
    ];

    for (const invalidPlan of invalidNumericIds) {
      expect(() => planSchema.parse(invalidPlan)).toThrow();
    }
  });

  it('should handle mixed ID types in a plan collection', () => {
    const plans = [
      { id: 100, title: 'Numeric ID Plan', goal: 'Test', details: 'Test', tasks: [] },
      { title: 'No ID Plan', goal: 'Test', details: 'Test', tasks: [] },
    ];

    // All should be valid
    for (const plan of plans) {
      expect(() => planSchema.parse(plan)).not.toThrow();
    }
  });
});
