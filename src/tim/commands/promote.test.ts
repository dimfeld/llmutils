import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { getDefaultConfig } from '../configSchema.js';
import { clearConfigCache } from '../configLoader.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
  clearConfigCache: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('../id_utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../id_utils.js')>();
  return {
    ...actual,
    generateNumericPlanId: vi.fn(),
  };
});

import { getMaxNumericPlanId, readPlanFile, resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handlePromoteCommand } from './promote.js';
import { log, error } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import { generateNumericPlanId } from '../id_utils.js';

// Mock console functions
const logSpy = vi.mocked(log);
const errorSpy = vi.mocked(error);

describe('handlePromoteCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Clear mocks
    vi.clearAllMocks();

    // Clear plan cache
    clearConfigCache();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-promote-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, '.tim.yml'), 'paths:\n  tasks: tasks\n');
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, yaml.stringify({ paths: { tasks: tasksDir } }));

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
    } as any);
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
    vi.mocked(generateNumericPlanId).mockImplementation(async (dir: string) => {
      const maxId = await getMaxNumericPlanId(dir);
      return maxId + 1;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearConfigCache();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(id: string, plan: PlanSchema): Promise<string> {
    const planPath = path.join(tasksDir, `${id}.yml`);
    await writePlanFile(planPath, plan, { cwdForIdentity: tempDir });
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
    await handlePromoteCommand(['1.2'], { config: configPath });

    // Read and verify the original plan was updated
    const updatedOriginalPlan = (await resolvePlanFromDb('1', tempDir)).plan;
    expect(updatedOriginalPlan.tasks).toHaveLength(2);
    expect(updatedOriginalPlan.tasks![0].title).toBe('Set up database schema');
    expect(updatedOriginalPlan.tasks![1].title).toBe('Add password hashing');
    expect(updatedOriginalPlan.dependencies).toHaveLength(1);

    const newPlanId = updatedOriginalPlan.dependencies![0]!;
    const newPlan = (await resolvePlanFromDb(String(newPlanId), tempDir)).plan;
    expect(newPlan.id).toBe(newPlanId);
    expect(newPlan.title).toBe('Implement login endpoint');
    expect(newPlan.details).toBe('Create API endpoint for user authentication');
    expect(newPlan.tasks).toEqual([]);
    expect(newPlan.status).toBe('pending');

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });

  test('promoted plan carries over tags from original plan', async () => {
    const originalPlan: PlanSchema = {
      id: 1,
      goal: 'Tagged parent',
      title: 'Parent Plan',
      tags: ['backend', 'urgent'],
      tasks: [
        {
          title: 'Tagged Task',
          description: 'Needs its own plan',
        },
      ],
    };

    await createPlanFile('1', originalPlan);

    await handlePromoteCommand(['1.1'], { config: configPath });

    const updatedParent = (await resolvePlanFromDb('1', tempDir)).plan;
    expect(updatedParent.dependencies).toHaveLength(1);

    const childPlan = (await resolvePlanFromDb(String(updatedParent.dependencies![0]!), tempDir))
      .plan;
    expect(childPlan.tags).toEqual(['backend', 'urgent']);
    expect(updatedParent.tags).toEqual(['backend', 'urgent']);
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
    await handlePromoteCommand(['1.2-4'], { config: configPath });

    const updatedOriginalPlan = (await resolvePlanFromDb('1', tempDir)).plan;
    expect(updatedOriginalPlan.dependencies).toHaveLength(3);

    const promotedPlans = await Promise.all(
      updatedOriginalPlan.dependencies!.map(async (planId) => ({
        id: planId!,
        plan: (await resolvePlanFromDb(String(planId!), tempDir)).plan,
      }))
    );
    const promotedByTitle = new Map(promotedPlans.map(({ plan }) => [plan.title, plan]));

    const loginPlan = promotedByTitle.get('Implement login endpoint');
    const hashingPlan = promotedByTitle.get('Add password hashing');
    const registrationPlan = promotedByTitle.get('Create registration endpoint');

    expect(loginPlan?.details).toBe('Create API endpoint for user authentication');
    expect(loginPlan?.dependencies).toEqual([]);
    expect(hashingPlan?.details).toBe('Implement secure password storage');
    expect(hashingPlan?.dependencies).toContain(loginPlan?.id);
    expect(registrationPlan?.details).toBe('API endpoint for user registration');
    expect(registrationPlan?.dependencies).toContain(hashingPlan?.id);

    expect(updatedOriginalPlan.tasks).toHaveLength(2);
    expect(updatedOriginalPlan.tasks![0].title).toBe('Set up database schema');
    expect(updatedOriginalPlan.tasks![1].title).toBe('Add email verification');

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });

  test('writes promoted plans to external storage when configured', async () => {
    const externalBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-promote-external-'));
    const repositoryConfigDir = path.join(externalBase, 'repositories', 'example');
    const externalTasksDir = path.join(repositoryConfigDir, 'tasks');
    await fs.mkdir(externalTasksDir, { recursive: true });

    const config = {
      ...getDefaultConfig(),
      paths: undefined,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: repositoryConfigDir,
      resolvedConfigPath: path.join(repositoryConfigDir, '.rmfilter', 'config', 'tim.yml'),
      repositoryConfigName: 'example',
      repositoryRemoteUrl: null,
    };

    const { loadEffectiveConfig } = await import('../configLoader.js');
    vi.mocked(loadEffectiveConfig).mockResolvedValue(config);

    const originalTasksDir = tasksDir;
    tasksDir = externalTasksDir;
    try {
      const originalPlan: PlanSchema = {
        id: 1,
        goal: 'External plan',
        details: 'Plan stored outside repository',
        status: 'pending',
        tasks: [
          {
            title: 'External task',
            description: 'Move to new plan',
            steps: [],
          },
        ],
        dependencies: [],
      };

      await createPlanFile('1', originalPlan);

      await handlePromoteCommand(['1.1'], { config: config.resolvedConfigPath });

      const updatedOriginalPlan = (await resolvePlanFromDb('1', tempDir)).plan;
      expect(updatedOriginalPlan.dependencies).toHaveLength(1);

      const promotedPlan = (
        await resolvePlanFromDb(String(updatedOriginalPlan.dependencies![0]!), tempDir)
      ).plan;
      expect(promotedPlan.id).toBe(updatedOriginalPlan.dependencies![0]!);
      expect(promotedPlan.title).toBe('External task');
    } finally {
      tasksDir = originalTasksDir;
      await fs.rm(externalBase, { recursive: true, force: true });
    }
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
    await handlePromoteCommand(['1.1-3'], { config: configPath });

    const updatedOriginalPlan = (await resolvePlanFromDb('1', tempDir)).plan;
    expect(updatedOriginalPlan.dependencies).toHaveLength(3);

    const promotedPlans = await Promise.all(
      updatedOriginalPlan.dependencies!.map(async (planId) => ({
        id: planId!,
        plan: (await resolvePlanFromDb(String(planId!), tempDir)).plan,
      }))
    );
    const promotedByTitle = new Map(promotedPlans.map(({ plan }) => [plan.title, plan]));

    const taskOnePlan = promotedByTitle.get('Task one');
    const taskTwoPlan = promotedByTitle.get('Task two');
    const taskThreePlan = promotedByTitle.get('Task three');

    expect(taskOnePlan?.details).toBe('First task description');
    expect(taskOnePlan?.dependencies).toEqual([]);
    expect(taskTwoPlan?.details).toBe('Second task description');
    expect(taskTwoPlan?.dependencies).toContain(taskOnePlan?.id);
    expect(taskThreePlan?.details).toBe('Third task description');
    expect(taskThreePlan?.dependencies).toContain(taskTwoPlan?.id);

    // Original plan should now have empty tasks array
    expect(updatedOriginalPlan.tasks).toEqual([]);

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
    await handlePromoteCommand(['1.2', '2.1'], { config: configPath });

    // Read and verify both original plans were updated
    const updatedPlan1 = (await resolvePlanFromDb('1', tempDir)).plan;
    const updatedPlan2 = (await resolvePlanFromDb('2', tempDir)).plan;

    expect(updatedPlan1.dependencies).toHaveLength(1);
    expect(updatedPlan2.dependencies).toHaveLength(1);

    const newPlan3 = (await resolvePlanFromDb(String(updatedPlan1.dependencies![0]!), tempDir))
      .plan;
    const newPlan4 = (await resolvePlanFromDb(String(updatedPlan2.dependencies![0]!), tempDir))
      .plan;

    // Verify plan 3 (from task 1.2)
    expect(newPlan3.id).toBe(updatedPlan1.dependencies![0]!);
    expect(newPlan3.title).toBe('Plan 1 Task 2');
    expect(newPlan3.details).toBe('Second task in plan 1');
    expect(newPlan3.dependencies).toEqual([]);

    // Verify plan 4 (from task 2.1)
    expect(newPlan4.id).toBe(updatedPlan2.dependencies![0]!);
    expect(newPlan4.title).toBe('Plan 2 Task 1');
    expect(newPlan4.details).toBe('First task in plan 2');
    expect(newPlan4.dependencies).toEqual([]);

    // Plan 1 should have only the first task remaining
    expect(updatedPlan1.tasks).toHaveLength(1);
    expect(updatedPlan1.tasks![0].title).toBe('Plan 1 Task 1');

    // Plan 2 should have only the second task remaining
    expect(updatedPlan2.tasks).toHaveLength(1);
    expect(updatedPlan2.tasks![0].title).toBe('Plan 2 Task 2');

    // Verify logging was called
    expect(logSpy).toHaveBeenCalled();
  });
});
