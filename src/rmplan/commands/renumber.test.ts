import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import { handleRenumber } from './renumber.js';
import { type PlanSchema } from '../planSchema.js';
import { writePlanFile } from '../plans.js';

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

    const filename = `${id}.yml`;
    await writePlanFile(path.join(tasksDir, filename), plan);
  };

  test('renumbers alphanumeric IDs to numeric IDs', async () => {
    // Create plans with alphanumeric IDs
    await createPlan('abc123', 'First plan');
    await createPlan('def456', 'Second plan');
    await createPlan(1, 'Existing numeric plan');

    await handleRenumber({}, createMockCommand());

    // Check that alphanumeric IDs were renumbered
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1.yml'); // Existing numeric plan
    expect(files).toContain('2.yml'); // abc123 -> 2
    expect(files).toContain('3.yml'); // def456 -> 3
    expect(files).not.toContain('abc123.yml');
    expect(files).not.toContain('def456.yml');

    // Verify plan contents were updated
    const plan2 = yaml.parse(await fs.promises.readFile(path.join(tasksDir, '2.yml'), 'utf-8'));
    expect(plan2.id).toBe(2);
    expect(plan2.title).toBe('First plan');

    const plan3 = yaml.parse(await fs.promises.readFile(path.join(tasksDir, '3.yml'), 'utf-8'));
    expect(plan3.id).toBe(3);
    expect(plan3.title).toBe('Second plan');
  });

  test('resolves ID conflicts based on createdAt timestamp', async () => {
    // Create conflicting plans
    const oldTime = new Date('2024-01-01').toISOString();
    const newTime = new Date('2024-06-01').toISOString();

    // Create first plan with ID 1
    await createPlan(1, 'Older plan', oldTime);

    // Create second plan also with ID 1 (simulating a merge conflict)
    // We need to rename the first file temporarily to create the conflict
    await fs.promises.rename(path.join(tasksDir, '1.yml'), path.join(tasksDir, '1-old.yml'));
    await createPlan(1, 'Newer plan', newTime);
    await fs.promises.rename(
      path.join(tasksDir, '1-old.yml'),
      path.join(tasksDir, '1-conflict.yml')
    );

    // Update the plan in the conflict file to have the same ID
    const conflictPlan = yaml.parse(
      await fs.promises.readFile(path.join(tasksDir, '1-conflict.yml'), 'utf-8')
    );
    await fs.promises.writeFile(
      path.join(tasksDir, '1-conflict.yml'),
      yaml.stringify(conflictPlan)
    );

    await handleRenumber({}, createMockCommand());

    // Check results
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1.yml'); // Older plan keeps ID 1
    expect(files).toContain('2.yml'); // Newer plan gets ID 2

    // Verify the correct plan kept ID 1
    const plan1 = yaml.parse(await fs.promises.readFile(path.join(tasksDir, '1.yml'), 'utf-8'));
    expect(plan1.title).toBe('Older plan');

    const plan2 = yaml.parse(await fs.promises.readFile(path.join(tasksDir, '2.yml'), 'utf-8'));
    expect(plan2.title).toBe('Newer plan');
    expect(plan2.id).toBe(2);
  });

  test('preserves relative order when renumbering', async () => {
    // Create plans with mixed IDs to test sorting
    await createPlan('b-second', 'B plan');
    await createPlan('a-first', 'A plan');
    await createPlan(5, 'Numeric 5');
    await createPlan(3, 'Numeric 3');
    await createPlan('c-third', 'C plan');

    await handleRenumber({}, createMockCommand());

    // Check that numeric IDs come first, then alphabetic
    const files = await fs.promises.readdir(tasksDir);
    const plans = await Promise.all(
      files.map(async (file) => {
        const content = yaml.parse(await fs.promises.readFile(path.join(tasksDir, file), 'utf-8'));
        return { id: content.id, title: content.title };
      })
    );

    // Sort by ID to check order
    plans.sort((a, b) => a.id - b.id);

    // Original numeric IDs should be preserved (3, 5)
    // Alphanumeric IDs should be renumbered starting from 6 in alphabetical order
    expect(plans[0]).toEqual({ id: 3, title: 'Numeric 3' });
    expect(plans[1]).toEqual({ id: 5, title: 'Numeric 5' });
    expect(plans[2]).toEqual({ id: 6, title: 'A plan' }); // a-first
    expect(plans[3]).toEqual({ id: 7, title: 'B plan' }); // b-second
    expect(plans[4]).toEqual({ id: 8, title: 'C plan' }); // c-third
  });

  test('dry run does not make changes', async () => {
    await createPlan('test123', 'Test plan');

    const originalFiles = await fs.promises.readdir(tasksDir);

    await handleRenumber({ dryRun: true }, createMockCommand());

    const filesAfter = await fs.promises.readdir(tasksDir);
    expect(filesAfter).toEqual(originalFiles);

    // Verify the original file still exists with original content
    const plan = yaml.parse(
      await fs.promises.readFile(path.join(tasksDir, 'test123.yml'), 'utf-8')
    );
    expect(plan.id).toBe('test123');
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
    const files = await fs.promises.readdir(tasksDir);
    expect(files).toContain('1.yml');
    expect(files).not.toContain('nodate.yml');
  });
});
