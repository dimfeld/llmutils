import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDefaultConfig } from '../configSchema.js';
import { readPlanFile, getMaxNumericPlanId } from '../plans.js';
import { ModuleMocker, clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { createPlanTool } from './create_plan.js';
import type { ToolContext } from './context.js';
import type { TimConfig } from '../configSchema.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createPlanTool references', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: TimConfig;
  let context: ToolContext;
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    clearAllTimCaches();

    // Mock generateNumericPlanId to use local-only ID generation (avoids shared storage)
    await moduleMocker.mock('../id_utils.js', () => ({
      generateNumericPlanId: mock(async (dir: string) => {
        const maxId = await getMaxNumericPlanId(dir);
        return maxId + 1;
      }),
    }));

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-create-plan-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    config = {
      ...getDefaultConfig(),
      paths: { tasks: tasksDir },
    };

    context = {
      config,
      gitRoot: tempDir,
    };
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllTimCaches();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('creates plan with uuid', async () => {
    const result = await createPlanTool(
      {
        title: 'Test Plan',
        goal: 'Test goal',
        details: 'Test details',
        priority: 'medium',
      },
      context
    );

    const planPath = path.join(tasksDir, '1-test-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.uuid).toMatch(UUID_REGEX);
    expect(result.data?.id).toBe(1);
  });

  test('creates plan with parent references', async () => {
    const parentUuid = crypto.randomUUID();
    await fs.writeFile(
      path.join(tasksDir, '1-parent.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        uuid: parentUuid,
        title: 'Parent Plan',
        goal: 'Parent goal',
        details: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    const result = await createPlanTool(
      {
        title: 'Child Plan',
        goal: 'Child goal',
        details: '',
        priority: 'medium',
        parent: 1,
      },
      context
    );

    const childPath = path.join(tasksDir, '2-child-plan.plan.md');
    const childPlan = await readPlanFile(childPath);
    expect(childPlan.uuid).toMatch(UUID_REGEX);
    expect(childPlan.parent).toBe(1);
    // Child should have reference to parent
    expect(childPlan.references).toBeDefined();
    expect(childPlan.references![1]).toBe(parentUuid);

    // Parent should have reference to child
    const parentPlan = await readPlanFile(path.join(tasksDir, '1-parent.yml'));
    expect(parentPlan.dependencies).toEqual([2]);
    expect(parentPlan.references).toBeDefined();
    expect(parentPlan.references![2]).toBe(childPlan.uuid);
  });

  test('creates plan with dependsOn references', async () => {
    // Create dependency plans without UUIDs to test generation
    await fs.writeFile(
      path.join(tasksDir, '1-dep.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Dependency 1',
        goal: 'Goal',
        details: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    await fs.writeFile(
      path.join(tasksDir, '2-dep.yml'),
      stringifyPlanWithFrontmatter({
        id: 2,
        title: 'Dependency 2',
        goal: 'Goal',
        details: '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    await createPlanTool(
      {
        title: 'Plan With Deps',
        goal: 'Goal',
        details: '',
        priority: 'medium',
        dependsOn: [1, 2],
      },
      context
    );

    const planPath = path.join(tasksDir, '3-plan-with-deps.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.dependencies).toEqual([1, 2]);
    expect(plan.references).toBeDefined();
    expect(plan.references![1]).toMatch(UUID_REGEX);
    expect(plan.references![2]).toMatch(UUID_REGEX);

    // Referenced plans should have UUIDs generated
    const dep1 = await readPlanFile(path.join(tasksDir, '1-dep.yml'));
    const dep2 = await readPlanFile(path.join(tasksDir, '2-dep.yml'));
    expect(dep1.uuid).toMatch(UUID_REGEX);
    expect(dep2.uuid).toMatch(UUID_REGEX);
    expect(plan.references![1]).toBe(dep1.uuid);
    expect(plan.references![2]).toBe(dep2.uuid);
  });

  test('creates plan with discoveredFrom reference', async () => {
    await fs.writeFile(
      path.join(tasksDir, '1-source.yml'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Source Plan',
        goal: 'Goal',
        details: '',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );

    await createPlanTool(
      {
        title: 'Discovered Plan',
        goal: 'Goal',
        details: '',
        priority: 'medium',
        discoveredFrom: 1,
      },
      context
    );

    const planPath = path.join(tasksDir, '2-discovered-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.discoveredFrom).toBe(1);
    expect(plan.references).toBeDefined();
    expect(plan.references![1]).toMatch(UUID_REGEX);

    const sourcePlan = await readPlanFile(path.join(tasksDir, '1-source.yml'));
    expect(sourcePlan.uuid).toMatch(UUID_REGEX);
    expect(plan.references![1]).toBe(sourcePlan.uuid);
  });

  test('creates plan without references when no relationships', async () => {
    await createPlanTool(
      {
        title: 'Standalone Plan',
        goal: 'Goal',
        details: '',
        priority: 'medium',
      },
      context
    );

    const planPath = path.join(tasksDir, '1-standalone-plan.plan.md');
    const plan = await readPlanFile(planPath);
    expect(plan.uuid).toMatch(UUID_REGEX);
    // No references should exist since there are no relationships
    expect(plan.references === undefined || Object.keys(plan.references).length === 0).toBe(true);
  });
});
