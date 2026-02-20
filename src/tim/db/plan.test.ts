import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase } from './database.js';
import {
  deletePlan,
  getPlanByUuid,
  getPlansByProject,
  getPlansNotInSet,
  getPlanTasksByUuid,
  upsertPlan,
  upsertPlanDependencies,
  upsertPlanTasks,
} from './plan.js';
import { getOrCreateProject } from './project.js';

describe('tim db/plan', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-db-test-'));
    db = openDatabase(path.join(tempDir, 'tim.db'));
    projectId = getOrCreateProject(db, 'repo-plan-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-plan-2').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('upsertPlan inserts and updates plan metadata, tasks, and dependencies', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 10,
      title: 'First plan',
      goal: 'Ship first version',
      details: 'Initial details',
      status: 'pending',
      priority: 'high',
      parentUuid: 'parent-uuid',
      epic: true,
      filename: '10-first.plan.md',
      tasks: [
        { title: 'task a', description: 'desc a', done: false },
        { title: 'task b', description: 'desc b', done: true },
      ],
      dependencyUuids: ['dep-1', 'dep-2'],
    });

    const inserted = getPlanByUuid(db, 'plan-1');
    expect(inserted).not.toBeNull();
    expect(inserted?.project_id).toBe(projectId);
    expect(inserted?.plan_id).toBe(10);
    expect(inserted?.details).toBe('Initial details');
    expect(inserted?.epic).toBe(1);

    let tasks = getPlanTasksByUuid(db, 'plan-1');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.task_index).toBe(0);
    expect(tasks[0]?.title).toBe('task a');
    expect(tasks[1]?.task_index).toBe(1);
    expect(tasks[1]?.done).toBe(1);

    const initialDeps = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all('plan-1') as Array<{ depends_on_uuid: string }>;
    expect(initialDeps.map((entry) => entry.depends_on_uuid)).toEqual(['dep-1', 'dep-2']);

    upsertPlan(db, otherProjectId, {
      uuid: 'plan-1',
      planId: 20,
      title: 'Updated plan',
      goal: 'Ship second version',
      details: 'Updated details',
      status: 'in_progress',
      priority: 'urgent',
      parentUuid: null,
      epic: false,
      filename: '20-updated.plan.md',
      tasks: [{ title: 'task c', description: 'desc c', done: false }],
      dependencyUuids: ['dep-3'],
    });

    const updated = getPlanByUuid(db, 'plan-1');
    expect(updated).not.toBeNull();
    expect(updated?.project_id).toBe(otherProjectId);
    expect(updated?.plan_id).toBe(20);
    expect(updated?.details).toBe('Updated details');
    expect(updated?.status).toBe('in_progress');
    expect(updated?.priority).toBe('urgent');
    expect(updated?.parent_uuid).toBeNull();
    expect(updated?.epic).toBe(0);
    expect(updated?.filename).toBe('20-updated.plan.md');

    tasks = getPlanTasksByUuid(db, 'plan-1');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.task_index).toBe(0);
    expect(tasks[0]?.title).toBe('task c');

    const updatedDeps = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all('plan-1') as Array<{ depends_on_uuid: string }>;
    expect(updatedDeps.map((entry) => entry.depends_on_uuid)).toEqual(['dep-3']);
  });

  test('upsertPlanTasks replaces existing task list', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-tasks',
      planId: 11,
      filename: '11.plan.md',
      tasks: [{ title: 'original', description: 'original', done: false }],
    });

    upsertPlanTasks(db, 'plan-tasks', [
      { title: 'new 1', description: 'd1', done: true },
      { title: 'new 2', description: 'd2', done: false },
    ]);

    const tasks = getPlanTasksByUuid(db, 'plan-tasks');
    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.title)).toEqual(['new 1', 'new 2']);
    expect(tasks.map((task) => task.task_index)).toEqual([0, 1]);
  });

  test('upsertPlanDependencies replaces existing dependencies', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-deps',
      planId: 12,
      filename: '12.plan.md',
      dependencyUuids: ['dep-a', 'dep-b'],
    });

    upsertPlanDependencies(db, 'plan-deps', ['dep-c']);
    const deps = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all('plan-deps') as Array<{ depends_on_uuid: string }>;

    expect(deps.map((entry) => entry.depends_on_uuid)).toEqual(['dep-c']);
  });

  test('getPlansByProject only returns plans for requested project', () => {
    upsertPlan(db, projectId, { uuid: 'plan-a', planId: 1, filename: '1.plan.md' });
    upsertPlan(db, projectId, { uuid: 'plan-b', planId: 2, filename: '2.plan.md' });
    upsertPlan(db, otherProjectId, { uuid: 'plan-c', planId: 3, filename: '3.plan.md' });

    const plans = getPlansByProject(db, projectId);
    expect(plans.map((plan) => plan.uuid)).toEqual(['plan-a', 'plan-b']);
  });

  test('getPlanByUuid returns inserted row and null for missing row', () => {
    expect(getPlanByUuid(db, 'missing')).toBeNull();

    upsertPlan(db, projectId, {
      uuid: 'plan-get',
      planId: 77,
      title: 'Lookup plan',
      filename: '77.plan.md',
    });

    const found = getPlanByUuid(db, 'plan-get');
    expect(found).not.toBeNull();
    expect(found?.plan_id).toBe(77);
    expect(found?.title).toBe('Lookup plan');
  });

  test('getPlanTasksByUuid returns tasks ordered by task_index', () => {
    upsertPlan(db, projectId, { uuid: 'plan-order', planId: 50, filename: '50.plan.md' });

    db.prepare(
      'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
    ).run('plan-order', 2, 'third', 'third', 0);
    db.prepare(
      'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
    ).run('plan-order', 0, 'first', 'first', 0);
    db.prepare(
      'INSERT INTO plan_task (plan_uuid, task_index, title, description, done) VALUES (?, ?, ?, ?, ?)'
    ).run('plan-order', 1, 'second', 'second', 1);

    const tasks = getPlanTasksByUuid(db, 'plan-order');
    expect(tasks.map((task) => task.title)).toEqual(['first', 'second', 'third']);
    expect(tasks.map((task) => task.task_index)).toEqual([0, 1, 2]);
  });

  test('deletePlan removes tasks and dependencies via cascade', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-delete',
      planId: 99,
      filename: '99.plan.md',
      tasks: [{ title: 'task', description: 'task', done: false }],
      dependencyUuids: ['dep-x'],
    });

    expect(deletePlan(db, 'plan-delete')).toBe(true);
    expect(deletePlan(db, 'plan-delete')).toBe(false);
    expect(getPlanByUuid(db, 'plan-delete')).toBeNull();

    const taskCount = db
      .prepare('SELECT COUNT(*) as count FROM plan_task WHERE plan_uuid = ?')
      .get('plan-delete') as { count: number };
    const depCount = db
      .prepare('SELECT COUNT(*) as count FROM plan_dependency WHERE plan_uuid = ?')
      .get('plan-delete') as { count: number };
    expect(taskCount.count).toBe(0);
    expect(depCount.count).toBe(0);
  });

  test('getPlansNotInSet finds prune candidates', () => {
    upsertPlan(db, projectId, { uuid: 'plan-1', planId: 1, filename: '1.plan.md' });
    upsertPlan(db, projectId, { uuid: 'plan-2', planId: 2, filename: '2.plan.md' });
    upsertPlan(db, projectId, { uuid: 'plan-3', planId: 3, filename: '3.plan.md' });

    const notInSet = getPlansNotInSet(db, projectId, new Set(['plan-2']));
    expect(notInSet.map((plan) => plan.uuid)).toEqual(['plan-1', 'plan-3']);
  });

  test('getPlansNotInSet with an empty set returns all project plans', () => {
    upsertPlan(db, projectId, { uuid: 'plan-1', planId: 1, filename: '1.plan.md' });
    upsertPlan(db, projectId, { uuid: 'plan-2', planId: 2, filename: '2.plan.md' });
    upsertPlan(db, otherProjectId, { uuid: 'plan-3', planId: 3, filename: '3.plan.md' });

    const notInSet = getPlansNotInSet(db, projectId, new Set());
    expect(notInSet.map((plan) => plan.uuid)).toEqual(['plan-1', 'plan-2']);
  });

  test('getPlansNotInSet handles large exclusion sets beyond sqlite variable limits', () => {
    const planCount = 1100;
    const keepUuid = 'plan-keep';

    for (let i = 0; i < planCount; i += 1) {
      upsertPlan(db, projectId, {
        uuid: `plan-${i}`,
        planId: i,
        filename: `${i}.plan.md`,
      });
    }
    upsertPlan(db, projectId, {
      uuid: keepUuid,
      planId: planCount + 1,
      filename: `${planCount + 1}.plan.md`,
    });

    const uuidSet = new Set<string>(Array.from({ length: planCount }, (_, i) => `plan-${i}`));
    const notInSet = getPlansNotInSet(db, projectId, uuidSet);

    expect(notInSet).toHaveLength(1);
    expect(notInSet[0]?.uuid).toBe(keepUuid);
  });

  test('upsertPlan skips stale source updates unless forceOverwrite is set', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-stale-check',
      planId: 90,
      title: 'Current title',
      details: 'Current details',
      filename: '90.plan.md',
      tasks: [{ title: 'current task', description: 'current', done: false }],
      dependencyUuids: ['dep-current'],
    });

    db.prepare('UPDATE plan SET updated_at = ? WHERE uuid = ?').run(
      '2026-01-02T00:00:00.000Z',
      'plan-stale-check'
    );

    upsertPlan(db, projectId, {
      uuid: 'plan-stale-check',
      planId: 91,
      title: 'Stale title',
      details: 'Stale details',
      filename: '91.plan.md',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      tasks: [{ title: 'stale task', description: 'stale', done: true }],
      dependencyUuids: ['dep-stale'],
    });

    let saved = getPlanByUuid(db, 'plan-stale-check');
    expect(saved?.plan_id).toBe(90);
    expect(saved?.title).toBe('Current title');
    expect(saved?.details).toBe('Current details');

    let tasks = getPlanTasksByUuid(db, 'plan-stale-check');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('current task');

    let deps = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY 1')
      .all('plan-stale-check') as Array<{ depends_on_uuid: string }>;
    expect(deps.map((entry) => entry.depends_on_uuid)).toEqual(['dep-current']);

    upsertPlan(db, projectId, {
      uuid: 'plan-stale-check',
      planId: 92,
      title: 'Forced title',
      details: 'Forced details',
      filename: '92.plan.md',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      forceOverwrite: true,
      tasks: [{ title: 'forced task', description: 'forced', done: true }],
      dependencyUuids: ['dep-forced'],
    });

    saved = getPlanByUuid(db, 'plan-stale-check');
    expect(saved?.plan_id).toBe(92);
    expect(saved?.title).toBe('Forced title');
    expect(saved?.details).toBe('Forced details');

    tasks = getPlanTasksByUuid(db, 'plan-stale-check');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('forced task');

    deps = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY 1')
      .all('plan-stale-check') as Array<{ depends_on_uuid: string }>;
    expect(deps.map((entry) => entry.depends_on_uuid)).toEqual(['dep-forced']);
  });
});
