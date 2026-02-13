import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { handleRemoveCommand } from './remove.js';
import { readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

describe('tim remove command', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  const makeCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-remove-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );
  });

  afterEach(async () => {
    clearAllTimCaches();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writePlan(id: number, overrides: Partial<PlanSchema> = {}): Promise<string> {
    const filePath = path.join(tasksDir, `${id}.plan.md`);
    const basePlan: PlanSchema = {
      id,
      uuid: crypto.randomUUID(),
      title: `Plan ${id}`,
      goal: `Goal ${id}`,
      details: `Details ${id}`,
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(filePath, stringifyPlanWithFrontmatter({ ...basePlan, ...overrides }));
    return filePath;
  }

  test('removes a plan file with no dependents', async () => {
    const planPath = await writePlan(1);

    await handleRemoveCommand(['1'], {}, makeCommand());

    await expect(fs.stat(planPath)).rejects.toThrow();
  });

  test('fails without --force when another plan depends on the target', async () => {
    const planPath = await writePlan(1);
    const dependentPath = await writePlan(2, { dependencies: [1] });

    await expect(handleRemoveCommand(['1'], {}, makeCommand())).rejects.toThrow(
      'Refusing to remove plans with dependents without --force'
    );

    await expect(fs.stat(planPath)).resolves.toBeDefined();
    await expect(fs.stat(dependentPath)).resolves.toBeDefined();
  });

  test('fails without --force when another plan has the target as parent', async () => {
    const planPath = await writePlan(1);
    const childPath = await writePlan(2, { parent: 1 });

    await expect(handleRemoveCommand(['1'], {}, makeCommand())).rejects.toThrow(
      'Refusing to remove plans with dependents without --force'
    );

    await expect(fs.stat(planPath)).resolves.toBeDefined();
    await expect(fs.stat(childPath)).resolves.toBeDefined();
  });

  test('removes with --force and cleans dependencies and references', async () => {
    const removedUuid = '11111111-1111-4111-8111-111111111111';
    await writePlan(1, { uuid: removedUuid });
    const dependentPath = await writePlan(2, {
      dependencies: [1, 3],
      references: {
        '1': removedUuid,
        '999': removedUuid,
        '3': '33333333-3333-4333-8333-333333333333',
      },
    });

    await handleRemoveCommand(['1'], { force: true }, makeCommand());

    await expect(fs.stat(path.join(tasksDir, '1.plan.md'))).rejects.toThrow();
    const dependent = await readPlanFile(dependentPath);
    expect(dependent.dependencies).toEqual([3]);
    expect(dependent.references).toEqual({
      '3': '33333333-3333-4333-8333-333333333333',
    });
  });

  test('removes with --force and clears child parent references', async () => {
    await writePlan(1);
    const childPath = await writePlan(2, { parent: 1 });

    await handleRemoveCommand(['1'], { force: true }, makeCommand());

    const childPlan = await readPlanFile(childPath);
    expect(childPlan.parent).toBeUndefined();
  });

  test('errors when removing a non-existent plan', async () => {
    await expect(handleRemoveCommand(['9999'], {}, makeCommand())).rejects.toThrow(
      'No plan found with ID or file path: 9999'
    );
  });

  test('removes multiple plans at once and cleans remaining references', async () => {
    await writePlan(1, { uuid: '11111111-1111-4111-8111-111111111111' });
    await writePlan(2, { uuid: '22222222-2222-4222-8222-222222222222' });
    const remainingPath = await writePlan(3, {
      dependencies: [1, 2],
      parent: 2,
      references: {
        '1': '11111111-1111-4111-8111-111111111111',
        '2': '22222222-2222-4222-8222-222222222222',
      },
    });

    await handleRemoveCommand(['1', '2'], { force: true }, makeCommand());

    await expect(fs.stat(path.join(tasksDir, '1.plan.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(tasksDir, '2.plan.md'))).rejects.toThrow();

    const remaining = await readPlanFile(remainingPath);
    expect(remaining.dependencies).toEqual([]);
    expect(remaining.parent).toBeUndefined();
    expect(remaining.references).toEqual({});
  });

  test('removes multiple dependent targets without --force when all dependents are selected', async () => {
    await writePlan(1);
    await writePlan(2, { dependencies: [1] });

    await handleRemoveCommand(['1', '2'], {}, makeCommand());

    await expect(fs.stat(path.join(tasksDir, '1.plan.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(tasksDir, '2.plan.md'))).rejects.toThrow();
  });
});
