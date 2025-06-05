import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { handleRenumber } from './renumber.js';
import { type PlanSchema } from '../planSchema.js';
import { writePlanFile, readPlanFile } from '../plans.js';

describe('rmplan renumber', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rmplan-renumber-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.promises.mkdir(tasksDir, { recursive: true });

    // Mock getGitRoot to return the temp directory
    mock.module('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    // Create a config file
    configPath = path.join(tempDir, '.rmplan.yml');
    await fs.promises.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks', // Use relative path since we're mocking git root
        },
      })
    );
  });

  afterEach(async () => {
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
    await writePlanFile(path.join(tasksDir, file), plan);
  };

  test('renumbers alphanumeric IDs to numeric IDs', async () => {
    // Create plans with alphanumeric IDs
    await createPlan('abc123', 'First plan', 'abc123.yml');
    await createPlan('def456', 'Second plan', 'def456.yml');
    await createPlan(1, 'Existing numeric plan', '1.yml');

    await handleRenumber({}, createMockCommand());

    // Check that files still exist with same names
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1.yml');
    expect(files).toContain('abc123.yml');
    expect(files).toContain('def456.yml');

    // Check that IDs were updated in file content
    const plan1 = await readPlanFile(path.join(tasksDir, '1.yml'));
    expect(plan1.id).toBe(1);
    expect(plan1.title).toBe('Existing numeric plan');

    const planAbc = await readPlanFile(path.join(tasksDir, 'abc123.yml'));
    expect(planAbc.id).toBe(2);
    expect(planAbc.title).toBe('First plan');

    const planDef = await readPlanFile(path.join(tasksDir, 'def456.yml'));
    expect(planDef.id).toBe(3);
    expect(planDef.title).toBe('Second plan');
  });

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
    expect(files).toContain('1-new.yml');

    // Check that IDs were updated correctly
    const oldPlan = await readPlanFile(path.join(tasksDir, '1-old.yml'));
    expect(oldPlan.id).toBe(1); // Older plan keeps ID 1
    expect(oldPlan.title).toBe('Older plan');

    const newPlan = await readPlanFile(path.join(tasksDir, '1-new.yml'));
    expect(newPlan.id).toBe(2); // Newer plan gets ID 2
    expect(newPlan.title).toBe('Newer plan');
  });

  test('preserves relative order when renumbering', async () => {
    // Create plans with mixed IDs to test sorting
    await createPlan('b-second', 'B plan');
    await createPlan('a-first', 'A plan');
    await createPlan(5, 'Numeric 5');
    await createPlan(3, 'Numeric 3');
    await createPlan('c-third', 'C plan');

    await handleRenumber({}, createMockCommand());

    // Check that all files are preserved
    const files = await fs.promises.readdir(tasksDir);
    expect(files.length).toBe(5);

    // Read all plans and check their new IDs
    const plans = await Promise.all(
      files.map(async (file) => {
        const plan = await readPlanFile(path.join(tasksDir, file));
        return { id: plan.id, title: plan.title, filename: file };
      })
    );

    // Find the plans by their titles to verify correct ID assignment
    const planA = plans.find((p) => p.title === 'A plan');
    const planB = plans.find((p) => p.title === 'B plan');
    const planC = plans.find((p) => p.title === 'C plan');
    const plan3 = plans.find((p) => p.title === 'Numeric 3');
    const plan5 = plans.find((p) => p.title === 'Numeric 5');

    // Original numeric IDs should be preserved (3, 5)
    expect(plan3?.id).toBe(3);
    expect(plan5?.id).toBe(5);

    // Alphanumeric IDs should be renumbered starting from 6 in alphabetical order
    expect(planA?.id).toBe(6); // a-first
    expect(planB?.id).toBe(7); // b-second
    expect(planC?.id).toBe(8); // c-third

    // Filenames should be preserved
    expect(planA?.filename).toBe('a-first.yml');
    expect(planB?.filename).toBe('b-second.yml');
    expect(planC?.filename).toBe('c-third.yml');
  });

  test('dry run does not make changes', async () => {
    await createPlan('test123', 'Test plan');

    // Read original content
    const originalPlan = await readPlanFile(path.join(tasksDir, 'test123.yml'));
    expect(originalPlan.id).toBe('test123');

    await handleRenumber({ dryRun: true }, createMockCommand());

    // Verify the file still has original content
    const planAfter = await readPlanFile(path.join(tasksDir, 'test123.yml'));
    expect(planAfter.id).toBe('test123');
    expect(planAfter).toEqual(originalPlan);
  });

  test('handles empty tasks directory', async () => {
    await handleRenumber({}, createMockCommand());
    // Should complete without errors
  });

  test('handles plans with missing createdAt', async () => {
    // Create a plan without createdAt
    const plan = {
      id: 'nodate',
      title: 'Plan without date',
      goal: 'Goal for plan without date',
      details: 'Details for plan without date',
      status: 'pending',
      priority: 'medium',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, 'nodate.yml'), plan);

    await handleRenumber({}, createMockCommand());

    // Should renumber successfully
    const updatedPlan = await readPlanFile(path.join(tasksDir, 'nodate.yml'));
    expect(updatedPlan.id).toBe(1);
    expect(updatedPlan.title).toBe('Plan without date');
  });

  test('updates dependencies when renumbering', async () => {
    // Create plans with dependencies
    await createPlan('feature-a', 'Feature A');
    await createPlan('feature-b', 'Feature B');
    await createPlan('feature-c', 'Feature C');

    // Create a plan that depends on the above plans
    const dependentPlan: PlanSchema = {
      id: 1,
      title: 'Dependent Plan',
      goal: 'Goal for dependent plan',
      details: 'Details for dependent plan',
      status: 'pending',
      priority: 'medium',
      dependencies: ['feature-a', 'feature-b', 'feature-c'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, 'dependent.yml'), dependentPlan);

    await handleRenumber({}, createMockCommand());

    // Check that the alphanumeric IDs were renumbered
    const planA = await readPlanFile(path.join(tasksDir, 'feature-a.yml'));
    expect(planA.id).toBe(2); // feature-a -> 2

    const planB = await readPlanFile(path.join(tasksDir, 'feature-b.yml'));
    expect(planB.id).toBe(3); // feature-b -> 3

    const planC = await readPlanFile(path.join(tasksDir, 'feature-c.yml'));
    expect(planC.id).toBe(4); // feature-c -> 4

    // Check that the dependencies were updated
    const dependent = await readPlanFile(path.join(tasksDir, 'dependent.yml'));
    expect(dependent.dependencies).toEqual(['2', '3', '4']);
  });

  test('updates mixed numeric and string dependencies', async () => {
    // Create plans with various IDs
    await createPlan('old-feature', 'Old Feature');
    await createPlan(10, 'Numeric Plan 10');
    await createPlan('another-feature', 'Another Feature');

    // Create plans with dependencies on the above
    const plan1: PlanSchema = {
      id: 5,
      title: 'Plan with mixed deps',
      goal: 'Goal',
      details: 'Details',
      status: 'pending',
      priority: 'medium',
      dependencies: ['old-feature', '10', 'another-feature', '999'], // 999 doesn't exist
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, 'plan-with-deps.yml'), plan1);

    await handleRenumber({}, createMockCommand());

    // Check that dependencies were correctly updated
    const updatedPlan = await readPlanFile(path.join(tasksDir, 'plan-with-deps.yml'));
    expect(updatedPlan.dependencies).toEqual([
      '12', // old-feature -> 12 (alphabetically second)
      '10', // 10 stays as is (not renumbered)
      '11', // another-feature -> 11 (alphabetically first)
      '999', // 999 stays as is (doesn't exist)
    ]);
  });

  test('handles circular dependencies during renumbering', async () => {
    // Create plans with circular dependencies
    const planA: PlanSchema = {
      id: 'plan-a',
      title: 'Plan A',
      goal: 'Goal A',
      details: 'Details A',
      status: 'pending',
      priority: 'medium',
      dependencies: ['plan-b'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    const planB: PlanSchema = {
      id: 'plan-b',
      title: 'Plan B',
      goal: 'Goal B',
      details: 'Details B',
      status: 'pending',
      priority: 'medium',
      dependencies: ['plan-a'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
    };

    await writePlanFile(path.join(tasksDir, 'plan-a.yml'), planA);
    await writePlanFile(path.join(tasksDir, 'plan-b.yml'), planB);

    await handleRenumber({}, createMockCommand());

    // Both should be renumbered and dependencies updated
    const updatedPlanA = await readPlanFile(path.join(tasksDir, 'plan-a.yml'));
    const updatedPlanB = await readPlanFile(path.join(tasksDir, 'plan-b.yml'));

    expect(updatedPlanA.id).toBe(1);
    expect(updatedPlanB.id).toBe(2);

    expect(updatedPlanA.dependencies).toEqual(['2']); // plan-b -> 2
    expect(updatedPlanB.dependencies).toEqual(['1']); // plan-a -> 1
  });
});
