import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { findNextPlan, readAllPlans, resolvePlanFile, setPlanStatus } from './plans.js';
import type { PlanSchema } from './planSchema.js';

describe('resolvePlanFile', () => {
  let tempDir: string;
  let tasksDir: string;

  // Set up module mocks before all tests
  beforeAll(() => {
    mock.module('./configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));
  });

  beforeAll(async () => {
    // Create a temporary directory for test files
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-test-')));
    tasksDir = join(tempDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });

    // Create test plan files
    const plan1 = {
      id: 'test-plan-1',
      title: 'Test Plan 1',
      goal: 'Test goal 1',
      details: 'Details for test plan 1',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };

    const plan2 = {
      id: 'feature-auth',
      title: 'Implement Authentication',
      goal: 'Add authentication system',
      details: 'Add authentication to the application',
      status: 'in_progress',
      priority: 'high',
      dependencies: ['test-plan-1'],
      tasks: [],
    };

    const planWithoutId = {
      title: 'Plan without ID',
      goal: 'This plan has no ID',
      details: 'Details for plan without ID',
      tasks: [],
    };

    await writeFile(join(tasksDir, 'test-plan-1.yml'), yaml.stringify(plan1));
    await writeFile(join(tasksDir, 'feature-auth.yml'), yaml.stringify(plan2));
    await writeFile(join(tasksDir, 'no-id.yml'), yaml.stringify(planWithoutId));

    // Create a plan outside the tasks dir
    await writeFile(join(tempDir, 'outside-plan.yml'), yaml.stringify(plan1));
  });

  afterAll(async () => {
    // Clean up temporary directory
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should resolve an absolute file path that exists', async () => {
    const absolutePath = join(tasksDir, 'test-plan-1.yml');
    const resolved = await resolvePlanFile(absolutePath);
    expect(resolved).toBe(absolutePath);
  });

  it('should resolve a relative file path that exists', async () => {
    const originalCwd = process.cwd();
    process.chdir(tasksDir);

    try {
      const resolved = await resolvePlanFile('./test-plan-1.yml');
      expect(resolved).toBe(join(tasksDir, 'test-plan-1.yml'));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('should resolve a plan ID to the correct file', async () => {
    const resolved = await resolvePlanFile('test-plan-1');
    expect(resolved).toBe(join(tasksDir, 'test-plan-1.yml'));
  });

  it('should resolve a plan ID with dashes', async () => {
    const resolved = await resolvePlanFile('feature-auth');
    expect(resolved).toBe(join(tasksDir, 'feature-auth.yml'));
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
      id: 'nested-plan',
      title: 'Nested Plan',
      goal: 'Test nested directory',
      details: 'Details for nested plan',
      tasks: [],
    };

    await writeFile(join(nestedDir, 'nested-plan.yml'), yaml.stringify(nestedPlan));

    const resolved = await resolvePlanFile('nested-plan');
    expect(resolved).toBe(join(nestedDir, 'nested-plan.yml'));
  });
});

describe('readAllPlans', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-readall-test-')));

    // Create test structure
    const subDir = join(tempDir, 'subdir');
    await mkdir(subDir, { recursive: true });

    // Create various test files
    const plans = [
      {
        filename: 'plan1.yml',
        content: {
          id: 'plan-1',
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
          id: 'plan-2',
          title: 'Plan 2',
          goal: 'Goal 2',
          details: 'Details for plan 2',
          status: 'done',
          dependencies: ['plan-1'],
          tasks: [],
        },
      },
      {
        filename: join('subdir', 'nested.yml'),
        content: {
          id: 'nested-plan',
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
    const plans = await readAllPlans(tempDir);

    expect(plans.size).toBe(3);
    expect(plans.has('plan-1')).toBe(true);
    expect(plans.has('plan-2')).toBe(true);
    expect(plans.has('nested-plan')).toBe(true);

    // The no-id.yml file should not be included
    const generatedIdPlan = Array.from(plans.values()).find((p) =>
      p.filename.endsWith('no-id.yml')
    );
    expect(generatedIdPlan).toBeUndefined();
  });

  it('should include correct plan summaries', async () => {
    const plans = await readAllPlans(tempDir);

    const plan1 = plans.get('plan-1');
    expect(plan1).toBeDefined();
    expect(plan1!.title).toBe('Plan 1');
    expect(plan1!.goal).toBe('Goal 1');
    expect(plan1!.status).toBe('pending');
    expect(plan1!.priority).toBe('high');
    expect(plan1!.filename).toBe(join(tempDir, 'plan1.yml'));

    const plan2 = plans.get('plan-2');
    expect(plan2).toBeDefined();
    expect(plan2!.status).toBe('done');
    expect(plan2!.dependencies).toEqual(['plan-1']);
  });

  it('should handle empty directories', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'empty-'));
    try {
      const plans = await readAllPlans(emptyDir);
      expect(plans.size).toBe(0);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('findNextReadyPlan', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-findnext-test-')));

    // Create test plans with various priorities and dependencies
    const plans = [
      {
        filename: 'low-priority-1.yml',
        content: {
          id: 'low-1',
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
          id: 'urgent-1',
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
          id: 'medium-1',
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
          id: 'high-1',
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
          id: 'no-priority-1',
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
          id: 'high-2',
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
          id: 'done-1',
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
          id: 'blocked-1',
          title: 'Blocked Plan',
          goal: 'Blocked by dependency',
          details: 'Details',
          status: 'pending',
          priority: 'urgent',
          dependencies: ['done-1', 'low-1'], // low-1 is not done, so this is blocked
          tasks: [],
        },
      },
      {
        filename: 'ready-with-deps.yml',
        content: {
          id: 'ready-deps-1',
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: ['done-1'], // done-1 is done, so this is ready
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
    expect(nextPlan!.id).toBe('urgent-1');
  });

  it('should sort by ID when priorities are equal', async () => {
    // Remove the urgent plan to test high priority sorting
    await rm(join(tempDir, 'urgent-priority.yml'));

    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).toBe('high-1'); // high-1 comes before high-2 alphabetically
  });

  it('should skip blocked plans even if they have high priority', async () => {
    // The blocked-1 plan has urgent priority but depends on low-1 which is not done
    const plans = await readAllPlans(tempDir);
    const blockedPlan = plans.get('blocked-1');
    expect(blockedPlan).toBeDefined();
    expect(blockedPlan!.priority).toBe('urgent');

    // But it should not be returned as the next plan
    const nextPlan = await findNextPlan(tempDir, { includePending: true });
    expect(nextPlan).toBeDefined();
    expect(nextPlan!.id).not.toBe('blocked-1');
  });

  it('should include plans with all dependencies done', async () => {
    const plans = await readAllPlans(tempDir);
    const readyWithDeps = plans.get('ready-deps-1');
    expect(readyWithDeps).toBeDefined();
    expect(readyWithDeps!.dependencies).toEqual(['done-1']);

    // Create a fresh directory with only the dependency test plans
    const depTestDir = await mkdtemp(join(tmpdir(), 'dep-test-'));
    try {
      await writeFile(
        join(depTestDir, 'done-dep.yml'),
        yaml.stringify({
          id: 'done-dep',
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
          id: 'ready-with-deps',
          title: 'Ready with Dependencies',
          goal: 'Has dependencies but they are done',
          details: 'Details',
          status: 'pending',
          priority: 'medium',
          dependencies: ['done-dep'],
          tasks: [],
        })
      );

      const nextPlan = await findNextPlan(depTestDir, { includePending: true });
      expect(nextPlan).toBeDefined();
      expect(nextPlan!.id).toBe('ready-with-deps');
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
          id: 'done-plan',
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
          id: 'no-priority',
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
          id: 'low-priority',
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
      expect(nextPlan!.id).toBe('low-priority'); // Low priority is higher than no priority
    } finally {
      await rm(priorityTestDir, { recursive: true, force: true });
    }
  });
});

describe('setPlanStatus', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'rmplan-setstatus-test-')));
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should successfully update status and updatedAt for a valid plan', async () => {
    const planPath = join(tempDir, 'test-plan.yml');
    const originalPlan: PlanSchema = {
      id: 'test-plan',
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
      id: 'time-test',
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
      id: 'no-updatedat',
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
});
