import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { resolvePlanFromDb, writePlanToDb } from '../plans.js';
import { createPlanTool } from './create_plan.js';
import type { ToolContext } from './context.js';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createPlanTool references', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: TimConfig;
  let context: ToolContext;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-create-plan-test-'));
    tasksDir = path.join(tempDir, 'tasks');

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
    clearAllTimCaches();
    closeDatabaseForTesting();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function seedPlan(plan: Partial<PlanSchema> & Pick<PlanSchema, 'id' | 'title' | 'goal'>) {
    await writePlanToDb(
      {
        id: plan.id,
        uuid: plan.uuid,
        title: plan.title,
        goal: plan.goal,
        details: plan.details ?? '',
        status: plan.status ?? 'pending',
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies ?? [],
        discoveredFrom: plan.discoveredFrom,
        assignedTo: plan.assignedTo,
        issue: plan.issue ?? [],
        docs: plan.docs ?? [],
        tags: plan.tags ?? [],
        epic: plan.epic ?? false,
        temp: plan.temp ?? false,
        tasks: plan.tasks ?? [],
        references: plan.references,
        createdAt: plan.createdAt ?? new Date().toISOString(),
        updatedAt: plan.updatedAt ?? new Date().toISOString(),
        filename: `${plan.id}-seed.plan.md`,
      },
      { cwdForIdentity: tempDir, skipUpdatedAt: true }
    );
  }

  test('creates a DB-only plan with uuid and no tasks directory requirement', async () => {
    const result = await createPlanTool(
      {
        title: 'Test Plan',
        goal: 'Test goal',
        details: 'Test details',
        priority: 'medium',
      },
      context
    );

    const { plan, planPath } = await resolvePlanFromDb('1', tempDir);
    expect(plan.uuid).toMatch(UUID_REGEX);
    expect(plan.title).toBe('Test Plan');
    expect(plan.details).toBe('Test details');
    expect(planPath).toBeNull();
    expect(result.data).toEqual({ id: 1, path: 'plan 1' });
    await expect(fs.access(tasksDir)).rejects.toThrow();
  });

  test('creates plan with parent references and updates the parent in DB', async () => {
    const parentUuid = crypto.randomUUID();
    await seedPlan({
      id: 1,
      uuid: parentUuid,
      title: 'Parent Plan',
      goal: 'Parent goal',
      epic: true,
      status: 'done',
    });

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

    const { plan: childPlan } = await resolvePlanFromDb(String(result.data?.id), tempDir);
    expect(childPlan.uuid).toMatch(UUID_REGEX);
    expect(childPlan.parent).toBe(1);
    expect(childPlan.references).toBeUndefined();

    const { plan: parentPlan } = await resolvePlanFromDb('1', tempDir);
    expect(parentPlan.dependencies).toEqual([2]);
    expect(parentPlan.references).toBeUndefined();
    expect(parentPlan.status).toBe('in_progress');
  });

  test('creates plan with dependsOn references from DB-backed dependency plans', async () => {
    await seedPlan({
      id: 1,
      title: 'Dependency 1',
      goal: 'Goal',
    });
    await seedPlan({
      id: 2,
      title: 'Dependency 2',
      goal: 'Goal',
    });

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

    const { plan } = await resolvePlanFromDb('3', tempDir);
    const { plan: dep1 } = await resolvePlanFromDb('1', tempDir);
    const { plan: dep2 } = await resolvePlanFromDb('2', tempDir);

    expect([...plan.dependencies].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(plan.references).toBeUndefined();
    expect(dep1.uuid).toMatch(UUID_REGEX);
    expect(dep2.uuid).toMatch(UUID_REGEX);
    expect(dep1.uuid).not.toBe(dep2.uuid);
  });

  test('creates plan with discoveredFrom reference from the DB', async () => {
    await seedPlan({
      id: 1,
      title: 'Source Plan',
      goal: 'Goal',
      status: 'in_progress',
    });

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

    const { plan } = await resolvePlanFromDb('2', tempDir);
    const { plan: sourcePlan } = await resolvePlanFromDb('1', tempDir);

    expect(plan.discoveredFrom).toBe(1);
    expect(plan.references).toBeUndefined();
    expect(sourcePlan.uuid).toMatch(UUID_REGEX);
  });

  test('creates plan without references when no relationships exist', async () => {
    await createPlanTool(
      {
        title: 'Standalone Plan',
        goal: 'Goal',
        details: '',
        priority: 'medium',
      },
      context
    );

    const { plan } = await resolvePlanFromDb('1', tempDir);
    expect(plan.uuid).toMatch(UUID_REGEX);
    expect(plan.references === undefined || Object.keys(plan.references).length === 0).toBe(true);
  });
});
