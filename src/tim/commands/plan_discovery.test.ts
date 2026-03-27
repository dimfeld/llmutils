import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlanSchema } from '../planSchema.js';
import { clearAllTimCaches } from '../../testing.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';
import { writePlanToDb } from '../plans.js';
import {
  findLatestPlanFromDb,
  findNextPlanFromCollection,
  findNextPlanFromDb,
  findNextReadyDependencyFromCollection,
  findNextReadyDependencyFromDb,
} from './plan_discovery.js';

function makePlan(id: number, overrides: Partial<PlanWithFilename> = {}): PlanWithFilename {
  return {
    id,
    title: `Plan ${id}`,
    goal: `Goal ${id}`,
    status: 'pending',
    tasks: [{ title: `Task ${id}`, description: 'Do it', done: false }],
    dependencies: [],
    filename: `${id}.plan.md`,
    ...overrides,
  };
}

describe('plan_discovery collection helpers', () => {
  test('findNextPlanFromCollection prioritizes in-progress plans, then priority, and excludes maybe', () => {
    const plans = new Map<number, PlanWithFilename>([
      [1, makePlan(1, { priority: 'urgent' })],
      [2, makePlan(2, { status: 'in_progress', priority: 'low' })],
      [3, makePlan(3, { priority: 'maybe' })],
      [4, makePlan(4, { priority: 'high', dependencies: [5] })],
      [5, makePlan(5, { status: 'pending' })],
    ]);

    expect(
      findNextPlanFromCollection(plans, { includePending: true, includeInProgress: true })?.id
    ).toBe(2);
    expect(findNextPlanFromCollection(plans, { includePending: true })?.id).toBe(1);
  });

  test('findNextPlanFromCollection orders pending candidates across all non-maybe priorities', () => {
    const plans = new Map<number, PlanWithFilename>([
      [5, makePlan(5, { priority: 'maybe' })],
      [4, makePlan(4, { priority: 'low' })],
      [3, makePlan(3, { priority: 'medium' })],
      [2, makePlan(2, { priority: 'high' })],
      [1, makePlan(1, { priority: 'urgent' })],
    ]);

    expect(findNextPlanFromCollection(plans, { includePending: true })?.id).toBe(1);
  });

  test('findNextPlanFromCollection returns null for an empty plan collection', () => {
    expect(findNextPlanFromCollection(new Map(), { includePending: true })).toBeNull();
  });

  test('findNextPlanFromCollection returns null when only done or cancelled plans exist', () => {
    const plans = new Map<number, PlanWithFilename>([
      [1, makePlan(1, { status: 'done' })],
      [2, makePlan(2, { status: 'cancelled' })],
    ]);

    expect(findNextPlanFromCollection(plans, { includePending: true })).toBeNull();
  });

  test('findNextPlanFromCollection can restrict selection to in-progress plans only', () => {
    const plans = new Map<number, PlanWithFilename>([
      [1, makePlan(1, { status: 'pending', priority: 'urgent' })],
      [2, makePlan(2, { status: 'in_progress', priority: 'low' })],
    ]);

    expect(
      findNextPlanFromCollection(plans, {
        includePending: false,
        includeInProgress: true,
      })?.id
    ).toBe(2);
  });

  test('findNextReadyDependencyFromCollection returns an error when the parent plan does not exist', () => {
    const result = findNextReadyDependencyFromCollection(999, new Map(), false);

    expect(result.plan).toBeNull();
    expect(result.message).toContain('Plan not found: 999');
  });

  test('findNextReadyDependencyFromCollection returns the parent when it has no dependencies', () => {
    const plans = new Map<number, PlanWithFilename>([[10, makePlan(10)]]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(10);
    expect(result.message).toContain('No dependencies');
  });

  test('findNextReadyDependencyFromCollection returns the parent when all dependencies are done', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [1, 2] })],
      [1, makePlan(1, { status: 'done' })],
      [2, makePlan(2, { status: 'done' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(10);
    expect(result.message).toContain('All dependencies complete');
  });

  test('findNextReadyDependencyFromCollection handles cycles and prefers in-progress before priority', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [1, 2] })],
      [1, makePlan(1, { dependencies: [3], priority: 'urgent' })],
      [2, makePlan(2, { status: 'in_progress', priority: 'low' })],
      [3, makePlan(3, { dependencies: [10], priority: 'high' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(2);
  });

  test('findNextReadyDependencyFromCollection includes child plans during traversal', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10)],
      [11, makePlan(11, { parent: 10, priority: 'high' })],
      [12, makePlan(12, { parent: 10, priority: 'low' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(11);
    expect(result.message).toContain('Found ready dependency');
  });

  test('findNextReadyDependencyFromCollection traverses multi-level dependency chains', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [1] })],
      [1, makePlan(1, { dependencies: [2], priority: 'urgent' })],
      [2, makePlan(2, { dependencies: [3], priority: 'high' })],
      [3, makePlan(3, { status: 'done' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(2);
    expect(result.message).toContain('Found ready dependency');
  });

  test('findNextReadyDependencyFromCollection filters empty plans unless explicitly included', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [1] })],
      [1, makePlan(1, { tasks: [] })],
    ]);

    const excluded = findNextReadyDependencyFromCollection(10, plans, false);
    const included = findNextReadyDependencyFromCollection(10, plans, true);

    expect(excluded.plan).toBeNull();
    expect(excluded.message).toContain('Closest pending dependency is 1');
    expect(included.plan?.id).toBe(1);
  });

  test('findNextReadyDependencyFromCollection excludes maybe priority candidates', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [1, 2] })],
      [1, makePlan(1, { priority: 'maybe' })],
      [2, makePlan(2, { priority: 'low' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan?.id).toBe(2);
  });

  test('findNextReadyDependencyFromCollection reports blocked dependencies when their own prerequisites are unmet', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { dependencies: [2] })],
      [1, makePlan(1, { status: 'pending', tasks: [] })],
      [2, makePlan(2, { dependencies: [1], priority: 'high' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan).toBeNull();
    expect(result.message).toContain('Closest pending dependency is 2');
  });

  test('findNextReadyDependencyFromCollection returns null when the parent is done and no pending dependencies remain', () => {
    const plans = new Map<number, PlanWithFilename>([
      [10, makePlan(10, { status: 'done', dependencies: [1] })],
      [1, makePlan(1, { status: 'done' })],
    ]);

    const result = findNextReadyDependencyFromCollection(10, plans, false);

    expect(result.plan).toBeNull();
    expect(result.message).toBe('No ready dependencies found.');
  });
});

describe('plan_discovery DB wrappers', () => {
  let repoDir: string;
  let tasksDir: string;
  const originalEnv: Partial<Record<string, string | undefined>> = {};

  beforeEach(async () => {
    clearAllTimCaches();
    repoDir = await mkdtemp(path.join(os.tmpdir(), 'tim-plan-discovery-'));
    tasksDir = path.join(repoDir, 'tasks');
    await mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(repoDir).quiet();

    const configDir = path.join(repoDir, 'config');
    await mkdir(configDir, { recursive: true });
    originalEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    originalEnv.APPDATA = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;
  });

  afterEach(async () => {
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await rm(repoDir, { recursive: true, force: true });
    clearAllTimCaches();
  });

  async function createDbPlan(plan: PlanSchema & { filename?: string }) {
    await writePlanToDb(
      {
        ...plan,
        filename: plan.filename ?? `${plan.id}.plan.md`,
      },
      { cwdForIdentity: repoDir }
    );
  }

  test('findLatestPlanFromDb returns the most recently updated DB plan', async () => {
    await createDbPlan({
      id: 1,
      title: 'Older Plan',
      status: 'pending',
      tasks: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await createDbPlan({
      id: 2,
      title: 'Newest Plan',
      status: 'pending',
      tasks: [],
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    const plan = await findLatestPlanFromDb(tasksDir, repoDir);

    expect(plan?.id).toBe(2);
  });

  test('findNextPlanFromDb reads DB-backed plans using shared selection logic', async () => {
    await createDbPlan({
      id: 1,
      title: 'Pending High',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task', description: 'Do it', done: false }],
    });
    await createDbPlan({
      id: 2,
      title: 'In Progress Low',
      status: 'in_progress',
      priority: 'low',
      tasks: [{ title: 'Task', description: 'Do it', done: false }],
    });
    await createDbPlan({
      id: 3,
      title: 'Maybe Plan',
      status: 'pending',
      priority: 'maybe',
      tasks: [{ title: 'Task', description: 'Do it', done: false }],
    });

    const plan = await findNextPlanFromDb(tasksDir, repoDir, {
      includePending: true,
      includeInProgress: true,
    });

    expect(plan?.id).toBe(2);
  });

  test('findNextReadyDependencyFromDb finds ready DB-only dependencies', async () => {
    await createDbPlan({
      id: 1,
      title: 'Done Dependency',
      status: 'done',
      tasks: [],
    });
    await createDbPlan({
      id: 2,
      title: 'Ready Dependency',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task', description: 'Do it', done: false }],
      dependencies: [1],
    });
    await createDbPlan({
      id: 10,
      title: 'Parent Plan',
      status: 'pending',
      tasks: [{ title: 'Parent task', description: 'Do it', done: false }],
      dependencies: [2],
    });

    const result = await findNextReadyDependencyFromDb(10, tasksDir, repoDir, false);

    expect(result.plan?.id).toBe(2);
    expect(result.message).toContain('Found ready dependency');
  });
});
