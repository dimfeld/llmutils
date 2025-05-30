import { describe, it, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';
import { readAllPlans, resolvePlanFile } from './plans.js';

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

    expect(plans.size).toBe(3); // Only plans with valid IDs
    expect(plans.has('plan-1')).toBe(true);
    expect(plans.has('plan-2')).toBe(true);
    expect(plans.has('nested-plan')).toBe(true);
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
