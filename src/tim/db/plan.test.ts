import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  deletePlan,
  getPlanDependenciesByProject,
  getPlanByUuid,
  getPlansByProject,
  getPlansNotInSet,
  getPlanTagsByProject,
  getPlanTagsByUuid,
  getPlanTasksByProject,
  getPlanTasksByUuid,
  clearPlanBaseTracking,
  setPlanBaseTracking,
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
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
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
      simple: true,
      tdd: false,
      discoveredFrom: 3,
      issue: ['https://github.com/example/repo/issues/1'],
      pullRequest: ['https://github.com/example/repo/pull/2'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      epic: true,
      tags: ['backend', 'sqlite'],
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
    expect(inserted?.simple).toBe(1);
    expect(inserted?.tdd).toBe(0);
    expect(inserted?.discovered_from).toBe(3);
    expect(inserted?.issue).toBe('["https://github.com/example/repo/issues/1"]');
    expect(inserted?.pull_request).toBe('["https://github.com/example/repo/pull/2"]');
    expect(inserted?.assigned_to).toBe('dimfeld');
    expect(inserted?.base_branch).toBe('main');
    expect(inserted?.epic).toBe(1);
    const insertedTags = getPlanTagsByUuid(db, 'plan-1');
    expect(insertedTags.map((row) => row.tag)).toEqual(['backend', 'sqlite']);

    let tasks = getPlanTasksByUuid(db, 'plan-1');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.uuid).toEqual(expect.any(String));
    expect(tasks[0]?.order_key).toBe('0000000000');
    expect(tasks[0]?.task_index).toBe(0);
    expect(tasks[0]?.title).toBe('task a');
    expect(tasks[1]?.order_key).toBe('0000000001');
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
      simple: false,
      tdd: true,
      discoveredFrom: null,
      issue: ['https://github.com/example/repo/issues/8'],
      pullRequest: [],
      assignedTo: 'other-user',
      baseBranch: 'release',
      epic: false,
      tags: ['migration'],
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
    expect(updated?.simple).toBe(0);
    expect(updated?.tdd).toBe(1);
    expect(updated?.discovered_from).toBeNull();
    expect(updated?.issue).toBe('["https://github.com/example/repo/issues/8"]');
    expect(updated?.pull_request).toBe('[]');
    expect(updated?.assigned_to).toBe('other-user');
    expect(updated?.base_branch).toBe('release');
    expect(updated?.parent_uuid).toBeNull();
    expect(updated?.epic).toBe(0);
    const updatedTags = getPlanTagsByUuid(db, 'plan-1');
    expect(updatedTags.map((row) => row.tag)).toEqual(['migration']);

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
    upsertPlan(db, projectId, { uuid: 'plan-a', planId: 1 });
    upsertPlan(db, projectId, { uuid: 'plan-b', planId: 2 });
    upsertPlan(db, otherProjectId, { uuid: 'plan-c', planId: 3 });

    const plans = getPlansByProject(db, projectId);
    expect(plans.map((plan) => plan.uuid)).toEqual(['plan-a', 'plan-b']);
  });

  test('getPlanByUuid returns inserted row and null for missing row', () => {
    expect(getPlanByUuid(db, 'missing')).toBeNull();

    upsertPlan(db, projectId, {
      uuid: 'plan-get',
      planId: 77,
      title: 'Lookup plan',
    });

    const found = getPlanByUuid(db, 'plan-get');
    expect(found).not.toBeNull();
    expect(found?.plan_id).toBe(77);
    expect(found?.title).toBe('Lookup plan');
  });

  test('upsertPlan stores branch and clears it when omitted in later updates', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-branch',
      planId: 78,
      title: 'Branch tracking plan',
      branch: 'feature/branch-a',
    });

    let found = getPlanByUuid(db, 'plan-branch');
    expect(found).not.toBeNull();
    expect(found?.branch).toBe('feature/branch-a');

    upsertPlan(db, projectId, {
      uuid: 'plan-branch',
      planId: 79,
      title: 'Branch tracking plan updated',
      branch: 'feature/branch-b',
    });

    found = getPlanByUuid(db, 'plan-branch');
    expect(found).not.toBeNull();
    expect(found?.branch).toBe('feature/branch-b');

    upsertPlan(db, projectId, {
      uuid: 'plan-branch',
      planId: 80,
      title: 'Branch tracking plan cleared',
    });

    found = getPlanByUuid(db, 'plan-branch');
    expect(found).not.toBeNull();
    expect(found?.branch).toBeNull();
  });

  test('upsertPlan stores and updates base tracking fields', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-base',
      planId: 81,
      baseBranch: 'feature/base',
      baseCommit: 'abc123',
      baseChangeId: 'xyzzzz',
    });

    let found = getPlanByUuid(db, 'plan-base');
    expect(found?.base_branch).toBe('feature/base');
    expect(found?.base_commit).toBe('abc123');
    expect(found?.base_change_id).toBe('xyzzzz');

    upsertPlan(db, projectId, {
      uuid: 'plan-base',
      planId: 82,
      baseBranch: null,
      baseCommit: null,
      baseChangeId: null,
    });

    found = getPlanByUuid(db, 'plan-base');
    expect(found?.base_branch).toBeNull();
    expect(found?.base_commit).toBeNull();
    expect(found?.base_change_id).toBeNull();
  });

  test('setPlanBaseTracking updates only provided fields and clearPlanBaseTracking clears all', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-base-tracking',
      planId: 83,
      baseBranch: 'feature/base',
      baseCommit: 'commit-1',
      baseChangeId: 'change-1',
    });

    setPlanBaseTracking(db, 'plan-base-tracking', {
      baseCommit: 'commit-2',
    });

    let found = getPlanByUuid(db, 'plan-base-tracking');
    expect(found?.base_branch).toBe('feature/base');
    expect(found?.base_commit).toBe('commit-2');
    expect(found?.base_change_id).toBe('change-1');

    setPlanBaseTracking(db, 'plan-base-tracking', {
      baseBranch: 'feature/other',
      baseChangeId: null,
    });
    found = getPlanByUuid(db, 'plan-base-tracking');
    expect(found?.base_branch).toBe('feature/other');
    expect(found?.base_commit).toBe('commit-2');
    expect(found?.base_change_id).toBeNull();

    clearPlanBaseTracking(db, 'plan-base-tracking');
    found = getPlanByUuid(db, 'plan-base-tracking');
    expect(found?.base_branch).toBeNull();
    expect(found?.base_commit).toBeNull();
    expect(found?.base_change_id).toBeNull();
  });

  test('getPlanTasksByUuid returns tasks ordered by order_key', () => {
    upsertPlan(db, projectId, { uuid: 'plan-order', planId: 50 });

    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('task-3', 'plan-order', 2, '0000003000', 'third', 'third', 0);
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('task-1', 'plan-order', 0, '0000001000', 'first', 'first', 0);
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('task-2', 'plan-order', 1, '0000000000', 'second', 'second', 1);

    const tasks = getPlanTasksByUuid(db, 'plan-order');
    expect(tasks.map((task) => task.title)).toEqual(['second', 'first', 'third']);
    expect(tasks.map((task) => task.task_index)).toEqual([1, 0, 2]);
  });

  test('getPlanTasksByProject and getPlanDependenciesByProject are project-scoped', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-proj-a',
      planId: 101,
      tasks: [{ title: 'task-a', description: 'a', done: false }],
      dependencyUuids: ['dep-a'],
    });
    upsertPlan(db, projectId, {
      uuid: 'dep-a',
      planId: 100,
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'plan-proj-b',
      planId: 201,
      tasks: [{ title: 'task-b', description: 'b', done: false }],
      dependencyUuids: ['dep-b'],
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'dep-b',
      planId: 200,
    });

    const projectTasks = getPlanTasksByProject(db, projectId);
    expect(projectTasks).toHaveLength(1);
    expect(projectTasks[0]?.plan_uuid).toBe('plan-proj-a');
    expect(projectTasks[0]?.title).toBe('task-a');

    const projectDeps = getPlanDependenciesByProject(db, projectId);
    expect(projectDeps).toHaveLength(1);
    expect(projectDeps[0]?.plan_uuid).toBe('plan-proj-a');
    expect(projectDeps[0]?.depends_on_uuid).toBe('dep-a');
  });

  test('getPlanTagsByProject is project-scoped', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-tag-a',
      planId: 301,
      tags: ['a', 'b'],
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'plan-tag-b',
      planId: 302,
      tags: ['c'],
    });

    const tags = getPlanTagsByProject(db, projectId);
    expect(tags.map((tag) => `${tag.plan_uuid}:${tag.tag}`)).toEqual([
      'plan-tag-a:a',
      'plan-tag-a:b',
    ]);
  });

  test('deletePlan removes tasks and dependencies via cascade', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-delete',
      planId: 99,
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
    upsertPlan(db, projectId, { uuid: 'plan-1', planId: 1 });
    upsertPlan(db, projectId, { uuid: 'plan-2', planId: 2 });
    upsertPlan(db, projectId, { uuid: 'plan-3', planId: 3 });

    const notInSet = getPlansNotInSet(db, projectId, new Set(['plan-2']));
    expect(notInSet.map((plan) => plan.uuid)).toEqual(['plan-1', 'plan-3']);
  });

  test('getPlansNotInSet with an empty set returns all project plans', () => {
    upsertPlan(db, projectId, { uuid: 'plan-1', planId: 1 });
    upsertPlan(db, projectId, { uuid: 'plan-2', planId: 2 });
    upsertPlan(db, otherProjectId, { uuid: 'plan-3', planId: 3 });

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
      });
    }
    upsertPlan(db, projectId, {
      uuid: keepUuid,
      planId: planCount + 1,
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

  test('upsertPlan stores and updates docsUpdatedAt and lessonsAppliedAt', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-finish-fields',
      planId: 500,
      title: 'Finish fields plan',
      sourceDocsUpdatedAt: '2026-03-01T10:00:00.000Z',
      sourceLessonsAppliedAt: '2026-03-02T12:00:00.000Z',
    });

    let found = getPlanByUuid(db, 'plan-finish-fields');
    expect(found).not.toBeNull();
    expect(found?.docs_updated_at).toBe('2026-03-01T10:00:00.000Z');
    expect(found?.lessons_applied_at).toBe('2026-03-02T12:00:00.000Z');

    // Update with new values
    upsertPlan(db, projectId, {
      uuid: 'plan-finish-fields',
      planId: 500,
      title: 'Finish fields plan updated',
      sourceDocsUpdatedAt: '2026-04-01T10:00:00.000Z',
      sourceLessonsAppliedAt: null,
    });

    found = getPlanByUuid(db, 'plan-finish-fields');
    expect(found?.docs_updated_at).toBe('2026-04-01T10:00:00.000Z');
    expect(found?.lessons_applied_at).toBeNull();
  });

  test('upsertPlan defaults docsUpdatedAt and lessonsAppliedAt to null', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-no-finish-fields',
      planId: 501,
      title: 'No finish fields',
    });

    const found = getPlanByUuid(db, 'plan-no-finish-fields');
    expect(found).not.toBeNull();
    expect(found?.docs_updated_at).toBeNull();
    expect(found?.lessons_applied_at).toBeNull();
  });

  test('new tasks inserted via upsertPlan get distinct non-null UUIDs and sequential order_keys', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-uuid-check',
      planId: 600,
      tasks: [
        { title: 'first', description: 'd1', done: false },
        { title: 'second', description: 'd2', done: false },
        { title: 'third', description: 'd3', done: true },
      ],
    });

    const tasks = getPlanTasksByUuid(db, 'plan-uuid-check');
    expect(tasks).toHaveLength(3);

    // All UUIDs are non-null and non-empty
    for (const task of tasks) {
      expect(task.uuid).toBeTruthy();
    }

    // All UUIDs are distinct
    const uuids = tasks.map((t) => t.uuid);
    expect(new Set(uuids).size).toBe(3);

    // Order keys match the expected zero-padded index pattern
    expect(tasks.map((t) => t.order_key)).toEqual(['0000000000', '0000000001', '0000000002']);
  });

  test('upsertPlan does not preserve UUIDs for incoming tasks without explicit UUIDs', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-uuid-preserve',
      planId: 601,
      tasks: [
        { title: 'alpha', description: 'da', done: false },
        { title: 'beta', description: 'db', done: false },
      ],
    });

    const original = getPlanTasksByUuid(db, 'plan-uuid-preserve');
    const originalUuids = original.map((t) => t.uuid);

    upsertPlan(db, projectId, {
      uuid: 'plan-uuid-preserve',
      planId: 601,
      tasks: [
        { title: 'alpha updated', description: 'da-updated', done: true },
        { title: 'beta updated', description: 'db-updated', done: false },
      ],
    });

    const updated = getPlanTasksByUuid(db, 'plan-uuid-preserve');
    expect(updated).toHaveLength(2);
    expect(updated.map((t) => t.uuid)).not.toEqual(originalUuids);
    expect(updated[0]?.title).toBe('alpha updated');
    expect(updated[1]?.title).toBe('beta updated');
  });

  test('upsertPlan preserves explicit task UUIDs across inserts at front and swaps', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-reorder-stable',
      planId: 602,
      tasks: [
        {
          uuid: '11111111-1111-4111-8111-111111111111',
          title: 'alpha',
          description: 'da',
          done: false,
        },
        {
          uuid: '22222222-2222-4222-8222-222222222222',
          title: 'beta',
          description: 'db',
          done: false,
        },
      ],
    });

    upsertPlan(db, projectId, {
      uuid: 'plan-reorder-stable',
      planId: 602,
      tasks: [
        { title: 'new front', description: 'dn', done: false },
        {
          uuid: '11111111-1111-4111-8111-111111111111',
          title: 'alpha',
          description: 'da',
          done: false,
        },
        {
          uuid: '22222222-2222-4222-8222-222222222222',
          title: 'beta',
          description: 'db',
          done: false,
        },
      ],
    });

    let tasks = getPlanTasksByUuid(db, 'plan-reorder-stable');
    expect(tasks.map((task) => task.title)).toEqual(['new front', 'alpha', 'beta']);
    expect(tasks[1]?.uuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(tasks[2]?.uuid).toBe('22222222-2222-4222-8222-222222222222');

    upsertPlan(db, projectId, {
      uuid: 'plan-reorder-stable',
      planId: 602,
      tasks: [
        {
          uuid: '22222222-2222-4222-8222-222222222222',
          orderKey: tasks[2]!.order_key,
          title: 'beta',
          description: 'db',
          done: false,
        },
        {
          uuid: '11111111-1111-4111-8111-111111111111',
          orderKey: tasks[1]!.order_key,
          title: 'alpha',
          description: 'da',
          done: false,
        },
      ],
    });

    tasks = getPlanTasksByUuid(db, 'plan-reorder-stable');
    expect(tasks.map((task) => task.uuid)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(tasks.map((task) => task.task_index)).toEqual([0, 1]);
  });

  test('tasks from two different plans have distinct UUIDs', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-distinct-a',
      planId: 700,
      tasks: [{ title: 'task', description: 'd', done: false }],
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-distinct-b',
      planId: 701,
      tasks: [{ title: 'task', description: 'd', done: false }],
    });

    const tasksA = getPlanTasksByUuid(db, 'plan-distinct-a');
    const tasksB = getPlanTasksByUuid(db, 'plan-distinct-b');

    expect(tasksA[0]?.uuid).not.toBe(tasksB[0]?.uuid);
  });
});
