import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handlePromoteCommand } from './promote.js';
import { clearPlanCache, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

describe('handlePromoteCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-promote-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
      })),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(id: string, plan: PlanSchema): Promise<string> {
    const planPath = path.join(tasksDir, `${id}.yml`);
    const yamlContent = yaml.stringify(plan);
    const schemaLine =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
    await fs.writeFile(planPath, schemaLine + yamlContent);
    return planPath;
  }

  test('should promote a single task to a new top-level plan', async () => {
    // Create a sample plan with multiple tasks
    const originalPlan: PlanSchema = {
      id: 1,
      goal: 'Implement authentication system',
      details: 'Add user login and registration functionality',
      status: 'pending',
      tasks: [
        {
          title: 'Set up database schema',
          description: 'Create user table and authentication fields',
          steps: [],
        },
        {
          title: 'Implement login endpoint',
          description: 'Create API endpoint for user authentication',
          steps: [],
        },
        {
          title: 'Add password hashing',
          description: 'Implement secure password storage',
          steps: [],
        },
      ],
      dependencies: [],
    };

    await createPlanFile('1', originalPlan);

    // Promote the second task (1.2)
    await handlePromoteCommand(['1.2'], {});

    // Check that the new plan file was created (should be 2.plan.md)
    const newPlanPath = path.join(tasksDir, '2.plan.md');
    const newPlanExists = await fs
      .access(newPlanPath)
      .then(() => true)
      .catch(() => false);
    expect(newPlanExists).toBe(true);

    // Read and verify the new plan content
    const newPlan = await readPlanFile(newPlanPath);
    expect(newPlan.id).toBe(2);
    expect(newPlan.title).toBe('Implement login endpoint');
    expect(newPlan.details).toBe('Create API endpoint for user authentication');
    expect(newPlan.tasks).toEqual([]);
    expect(newPlan.status).toBe('pending');

    // Read and verify the original plan was updated
    const updatedOriginalPlan = await readPlanFile(path.join(tasksDir, '1.yml'));
    expect(updatedOriginalPlan.tasks).toHaveLength(2);
    expect(updatedOriginalPlan.tasks![0].title).toBe('Set up database schema');
    expect(updatedOriginalPlan.tasks![1].title).toBe('Add password hashing');
    expect(updatedOriginalPlan.dependencies).toContain(2);

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });

  test('should promote a range of tasks to new top-level plans with chained dependencies', async () => {
    // Create a sample plan with multiple tasks
    const originalPlan: PlanSchema = {
      id: 1,
      goal: 'Implement authentication system',
      details: 'Add user login and registration functionality',
      status: 'pending',
      tasks: [
        {
          title: 'Set up database schema',
          description: 'Create user table and authentication fields',
          steps: [],
        },
        {
          title: 'Implement login endpoint',
          description: 'Create API endpoint for user authentication',
          steps: [],
        },
        {
          title: 'Add password hashing',
          description: 'Implement secure password storage',
          steps: [],
        },
        {
          title: 'Create registration endpoint',
          description: 'API endpoint for user registration',
          steps: [],
        },
        {
          title: 'Add email verification',
          description: 'Send verification emails to new users',
          steps: [],
        },
      ],
      dependencies: [],
    };

    await createPlanFile('1', originalPlan);

    // Promote tasks 2-4 (1.2-4)
    await handlePromoteCommand(['1.2-4'], {});

    // Check that three new plan files were created (2.plan.md, 3.plan.md, 4.plan.md)
    const plan2Path = path.join(tasksDir, '2.plan.md');
    const plan3Path = path.join(tasksDir, '3.plan.md');
    const plan4Path = path.join(tasksDir, '4.plan.md');

    const plan2Exists = await fs
      .access(plan2Path)
      .then(() => true)
      .catch(() => false);
    const plan3Exists = await fs
      .access(plan3Path)
      .then(() => true)
      .catch(() => false);
    const plan4Exists = await fs
      .access(plan4Path)
      .then(() => true)
      .catch(() => false);

    expect(plan2Exists).toBe(true);
    expect(plan3Exists).toBe(true);
    expect(plan4Exists).toBe(true);

    // Read and verify the new plans
    const newPlan2 = await readPlanFile(plan2Path);
    const newPlan3 = await readPlanFile(plan3Path);
    const newPlan4 = await readPlanFile(plan4Path);

    // Verify plan 2 (from task 1.2)
    expect(newPlan2.id).toBe(2);
    expect(newPlan2.title).toBe('Implement login endpoint');
    expect(newPlan2.details).toBe('Create API endpoint for user authentication');
    expect(newPlan2.dependencies).toEqual([]);

    // Verify plan 3 (from task 1.3) depends on plan 2
    expect(newPlan3.id).toBe(3);
    expect(newPlan3.title).toBe('Add password hashing');
    expect(newPlan3.details).toBe('Implement secure password storage');
    expect(newPlan3.dependencies).toContain(2);

    // Verify plan 4 (from task 1.4) depends on plan 3
    expect(newPlan4.id).toBe(4);
    expect(newPlan4.title).toBe('Create registration endpoint');
    expect(newPlan4.details).toBe('API endpoint for user registration');
    expect(newPlan4.dependencies).toContain(3);

    // Read and verify the original plan was updated
    const updatedOriginalPlan = await readPlanFile(path.join(tasksDir, '1.yml'));
    expect(updatedOriginalPlan.tasks).toHaveLength(2);
    expect(updatedOriginalPlan.tasks![0].title).toBe('Set up database schema');
    expect(updatedOriginalPlan.tasks![1].title).toBe('Add email verification');

    // Original plan should depend on all new plans
    expect(updatedOriginalPlan.dependencies).toContain(2);
    expect(updatedOriginalPlan.dependencies).toContain(3);
    expect(updatedOriginalPlan.dependencies).toContain(4);

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });

  test('should promote all tasks from a plan leaving empty tasks array', async () => {
    // Create a sample plan with multiple tasks
    const originalPlan: PlanSchema = {
      id: 1,
      goal: 'Small feature implementation',
      details: 'A small feature with just a few tasks',
      status: 'pending',
      tasks: [
        {
          title: 'Task one',
          description: 'First task description',
          steps: [],
        },
        {
          title: 'Task two',
          description: 'Second task description',
          steps: [],
        },
        {
          title: 'Task three',
          description: 'Third task description',
          steps: [],
        },
      ],
      dependencies: [],
    };

    await createPlanFile('1', originalPlan);

    // Promote all tasks (1.1-3)
    await handlePromoteCommand(['1.1-3'], {});

    // Check that three new plan files were created (2.plan.md, 3.plan.md, 4.plan.md)
    const plan2Path = path.join(tasksDir, '2.plan.md');
    const plan3Path = path.join(tasksDir, '3.plan.md');
    const plan4Path = path.join(tasksDir, '4.plan.md');

    const plan2Exists = await fs
      .access(plan2Path)
      .then(() => true)
      .catch(() => false);
    const plan3Exists = await fs
      .access(plan3Path)
      .then(() => true)
      .catch(() => false);
    const plan4Exists = await fs
      .access(plan4Path)
      .then(() => true)
      .catch(() => false);

    expect(plan2Exists).toBe(true);
    expect(plan3Exists).toBe(true);
    expect(plan4Exists).toBe(true);

    // Read and verify the new plans
    const newPlan2 = await readPlanFile(plan2Path);
    const newPlan3 = await readPlanFile(plan3Path);
    const newPlan4 = await readPlanFile(plan4Path);

    // Verify plan 2 (from task 1.1)
    expect(newPlan2.id).toBe(2);
    expect(newPlan2.title).toBe('Task one');
    expect(newPlan2.details).toBe('First task description');
    expect(newPlan2.dependencies).toEqual([]);

    // Verify plan 3 (from task 1.2) depends on plan 2
    expect(newPlan3.id).toBe(3);
    expect(newPlan3.title).toBe('Task two');
    expect(newPlan3.details).toBe('Second task description');
    expect(newPlan3.dependencies).toContain(2);

    // Verify plan 4 (from task 1.3) depends on plan 3
    expect(newPlan4.id).toBe(4);
    expect(newPlan4.title).toBe('Task three');
    expect(newPlan4.details).toBe('Third task description');
    expect(newPlan4.dependencies).toContain(3);

    // Read and verify the original plan was updated
    const updatedOriginalPlan = await readPlanFile(path.join(tasksDir, '1.yml'));
    // Original plan should now have empty tasks array
    expect(updatedOriginalPlan.tasks).toEqual([]);

    // Original plan should depend on all new plans
    expect(updatedOriginalPlan.dependencies).toContain(2);
    expect(updatedOriginalPlan.dependencies).toContain(3);
    expect(updatedOriginalPlan.dependencies).toContain(4);

    // Status should remain unchanged
    expect(updatedOriginalPlan.status).toBe('pending');

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });

  test('should promote tasks from multiple different plans in single command', async () => {
    // Create two sample plans
    const plan1: PlanSchema = {
      id: 1,
      goal: 'First plan',
      details: 'First plan details',
      status: 'pending',
      tasks: [
        {
          title: 'Plan 1 Task 1',
          description: 'First task in plan 1',
          steps: [],
        },
        {
          title: 'Plan 1 Task 2',
          description: 'Second task in plan 1',
          steps: [],
        },
      ],
      dependencies: [],
    };

    const plan2: PlanSchema = {
      id: 2,
      goal: 'Second plan',
      details: 'Second plan details',
      status: 'pending',
      tasks: [
        {
          title: 'Plan 2 Task 1',
          description: 'First task in plan 2',
          steps: [],
        },
        {
          title: 'Plan 2 Task 2',
          description: 'Second task in plan 2',
          steps: [],
        },
      ],
      dependencies: [],
    };

    await createPlanFile('1', plan1);
    await createPlanFile('2', plan2);

    // Promote task 2 from plan 1 and task 1 from plan 2 (1.2 2.1)
    await handlePromoteCommand(['1.2', '2.1'], {});

    // Check that two new plan files were created (3.plan.md, 4.plan.md)
    const plan3Path = path.join(tasksDir, '3.plan.md');
    const plan4Path = path.join(tasksDir, '4.plan.md');

    const plan3Exists = await fs
      .access(plan3Path)
      .then(() => true)
      .catch(() => false);
    const plan4Exists = await fs
      .access(plan4Path)
      .then(() => true)
      .catch(() => false);

    expect(plan3Exists).toBe(true);
    expect(plan4Exists).toBe(true);

    // Read and verify the new plans
    const newPlan3 = await readPlanFile(plan3Path);
    const newPlan4 = await readPlanFile(plan4Path);

    // Verify plan 3 (from task 1.2)
    expect(newPlan3.id).toBe(3);
    expect(newPlan3.title).toBe('Plan 1 Task 2');
    expect(newPlan3.details).toBe('Second task in plan 1');
    expect(newPlan3.dependencies).toEqual([]);

    // Verify plan 4 (from task 2.1)
    expect(newPlan4.id).toBe(4);
    expect(newPlan4.title).toBe('Plan 2 Task 1');
    expect(newPlan4.details).toBe('First task in plan 2');
    expect(newPlan4.dependencies).toEqual([]);

    // Read and verify both original plans were updated
    const updatedPlan1 = await readPlanFile(path.join(tasksDir, '1.yml'));
    const updatedPlan2 = await readPlanFile(path.join(tasksDir, '2.yml'));

    // Plan 1 should have only the first task remaining
    expect(updatedPlan1.tasks).toHaveLength(1);
    expect(updatedPlan1.tasks![0].title).toBe('Plan 1 Task 1');
    expect(updatedPlan1.dependencies).toContain(3);

    // Plan 2 should have only the second task remaining
    expect(updatedPlan2.tasks).toHaveLength(1);
    expect(updatedPlan2.tasks![0].title).toBe('Plan 2 Task 2');
    expect(updatedPlan2.dependencies).toContain(4);

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });
});
