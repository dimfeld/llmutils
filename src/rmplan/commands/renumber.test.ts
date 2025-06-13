import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { handleRenumber } from './renumber.js';
import { type PlanSchema } from '../planSchema.js';
import { readPlanFile } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

function writeTestPlan(path: string, plan: any) {
  return Bun.write(path, yaml.stringify(plan));
}

describe('rmplan renumber', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rmplan-renumber-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.promises.mkdir(tasksDir, { recursive: true });

    // Mock getGitRoot to return the temp directory
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    // Create a config file
    configPath = path.join(tempDir, '.rmplan.yml');
    await Bun.write(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks', // Use relative path since we're mocking git root
        },
      })
    );
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  const createMockCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  const createPlan = async (
    id: string | number,
    title: string,
    filename?: string,
    createdAt?: string
  ): Promise<void> => {
    const plan: PlanSchema = {
      // @ts-expect-error for testing this needs to possibly be a string
      id,
      title,
      goal: `Goal for ${title}`,
      details: `Details for ${title}`,
      status: 'pending',
      priority: 'medium',
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Use provided filename or default to id-based filename
    const file = filename || `${id}.yml`;
    const data = yaml.stringify(plan);
    await Bun.write(path.join(tasksDir, file), data);
  };

  test('resolves ID conflicts based on createdAt timestamp', async () => {
    // Create conflicting plans
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create two plans with the same ID 1 but different filenames
    await createPlan(1, 'Older plan', '1-old.yml', oldTime);
    await createPlan(1, 'Newer plan', '1-new.yml', newTime);

    await handleRenumber({}, createMockCommand());

    // Check that files still exist
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1-old.yml');
    expect(files).toContain('2-new.yml');

    // Check that IDs were updated correctly
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1); // Older plan keeps ID 1
    expect(oldPlan.title).toBe('Older plan');

    // The plan file should be renamed since it started with the plan ID
    const newPlan = await readPlanFile(path.join(tasksDir, '2-new.yml'));
    expect(newPlan.id).toBe(2); // Newer plan gets ID 2
    expect(newPlan.title).toBe('Newer plan');
  });

  test('dry run does not make changes', async () => {
    await createPlan(123, 'Test plan');

    // Read original content
    const originalPlan = yaml.parse(await Bun.file(path.join(tasksDir, '123.yml')).text());
    expect(originalPlan.id).toBe(123);

    await handleRenumber({ dryRun: true }, createMockCommand());

    // Verify the file still has original content
    const planAfter = yaml.parse(await Bun.file(path.join(tasksDir, '123.yml')).text());
    expect(planAfter.id).toBe(123);
    expect(planAfter).toEqual(originalPlan);
  });

  test('handles empty tasks directory', async () => {
    await handleRenumber({}, createMockCommand());
    // Should complete without errors
  });

  test('handles plans with missing createdAt', async () => {
    // Create a plan without createdAt
    const plan = {
      title: 'Plan without date',
      goal: 'Goal for plan without date',
      details: 'Details for plan without date',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    await Bun.write(path.join(tasksDir, '999.yml'), yaml.stringify(plan));

    await handleRenumber({}, createMockCommand());

    // Should renumber successfully
    const updatedPlan = await readPlanFile(path.join(tasksDir, '999.yml'));
    expect(updatedPlan.id).toBe(1);
    expect(updatedPlan.title).toBe('Plan without date');
  });

  test('renumbers two sets of conflicting plans with dependencies preserved', async () => {
    // Create first set of plans with IDs 1, 2, 3
    const set1Plan1: PlanSchema = {
      id: 1,
      title: 'Set 1 - Plan 1',
      goal: 'Goal 1-1',
      details: 'Details 1-1',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date('2024-01-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set1Plan2: PlanSchema = {
      id: 2,
      title: 'Set 1 - Plan 2',
      goal: 'Goal 1-2',
      details: 'Details 1-2',
      status: 'pending',
      priority: 'medium',
      dependencies: [1], // depends on plan 1
      createdAt: new Date('2024-01-02').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set1Plan3: PlanSchema = {
      id: 3,
      title: 'Set 1 - Plan 3',
      goal: 'Goal 1-3',
      details: 'Details 1-3',
      status: 'pending',
      priority: 'medium',
      dependencies: [1, 2], // depends on plans 1 and 2
      createdAt: new Date('2024-01-03').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Create second set of plans with IDs 1, 2, 3 (conflicting)
    const set2Plan1: PlanSchema = {
      id: 1,
      title: 'Set 2 - Plan 1',
      goal: 'Goal 2-1',
      details: 'Details 2-1',
      status: 'pending',
      priority: 'medium',
      dependencies: [],
      createdAt: new Date('2024-02-01').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set2Plan2: PlanSchema = {
      id: 2,
      title: 'Set 2 - Plan 2',
      goal: 'Goal 2-2',
      details: 'Details 2-2',
      status: 'pending',
      priority: 'medium',
      dependencies: [1], // depends on plan 1
      createdAt: new Date('2024-02-02').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const set2Plan3: PlanSchema = {
      id: 3,
      title: 'Set 2 - Plan 3',
      goal: 'Goal 2-3',
      details: 'Details 2-3',
      status: 'pending',
      priority: 'medium',
      dependencies: [1, 2], // depends on plans 1 and 2
      createdAt: new Date('2024-02-03').toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    // Write all plans with unique filenames
    await writeTestPlan(path.join(tasksDir, 'set1-plan1.yml'), set1Plan1);
    await writeTestPlan(path.join(tasksDir, 'set1-plan2.yml'), set1Plan2);
    await writeTestPlan(path.join(tasksDir, 'set1-plan3.yml'), set1Plan3);
    await writeTestPlan(path.join(tasksDir, 'set2-plan1.yml'), set2Plan1);
    await writeTestPlan(path.join(tasksDir, 'set2-plan2.yml'), set2Plan2);
    await writeTestPlan(path.join(tasksDir, 'set2-plan3.yml'), set2Plan3);

    await handleRenumber({}, createMockCommand());

    // Read all updated plans
    const updatedSet1Plan1 = await readPlanFile(path.join(tasksDir, 'set1-plan1.yml'));
    const updatedSet1Plan2 = await readPlanFile(path.join(tasksDir, 'set1-plan2.yml'));
    const updatedSet1Plan3 = await readPlanFile(path.join(tasksDir, 'set1-plan3.yml'));
    const updatedSet2Plan1 = await readPlanFile(path.join(tasksDir, 'set2-plan1.yml'));
    const updatedSet2Plan2 = await readPlanFile(path.join(tasksDir, 'set2-plan2.yml'));
    const updatedSet2Plan3 = await readPlanFile(path.join(tasksDir, 'set2-plan3.yml'));

    // First set should keep IDs 1, 2, 3 (older timestamps)
    expect(updatedSet1Plan1.id).toBe(1);
    expect(updatedSet1Plan2.id).toBe(2);
    expect(updatedSet1Plan3.id).toBe(3);

    // Second set should be renumbered to 4, 5, 6
    expect(updatedSet2Plan1.id).toBe(4);
    expect(updatedSet2Plan2.id).toBe(5);
    expect(updatedSet2Plan3.id).toBe(6);

    // Check that dependencies are preserved within set 1
    expect(updatedSet1Plan1.dependencies).toEqual([]);
    expect(updatedSet1Plan2.dependencies).toEqual([1]); // still depends on plan 1
    expect(updatedSet1Plan3.dependencies).toEqual([1, 2]); // still depends on plans 1 and 2

    // Check that dependencies are updated correctly for set 2
    expect(updatedSet2Plan1.dependencies).toEqual([]);
    expect(updatedSet2Plan2.dependencies).toEqual([4]); // updated from 1 to 4
    expect(updatedSet2Plan3.dependencies).toEqual([4, 5]); // updated from [1, 2] to [4, 5]
  });
});
