import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import type { Command } from 'commander';

import {
  assertUuidBackfillAllowed,
  backfillMissingPlanAndTaskUuids,
  handleBackfillUuidsCommand,
} from './backfill-uuids.js';
import type { TimConfig } from '../configSchema.js';
import { runMigrations } from '../db/migrations.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createMigratedDatabase(): Database {
  const db = new Database(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertProject(db: Database, id: number, repositoryId: string, uuid: string | null): void {
  db.prepare(
    `INSERT INTO project (
      id,
      uuid,
      repository_id,
      remote_url,
      last_git_root,
      external_config_path,
      external_tasks_dir,
      remote_label,
      highest_plan_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  ).run(id, uuid, repositoryId);
}

function insertPlan(
  db: Database,
  uuid: string | null,
  projectId: number,
  planId: number,
  title: string
): void {
  for (const table of ['plan', 'plan_canonical'] as const) {
    db.prepare(`INSERT INTO ${table} (uuid, project_id, plan_id, title) VALUES (?, ?, ?, ?)`).run(
      uuid,
      projectId,
      planId,
      title
    );
  }
}

function insertTask(
  db: Database,
  id: number,
  uuid: string | null,
  planUuid: string,
  taskIndex: number,
  title: string
): void {
  for (const table of ['plan_task', 'task_canonical'] as const) {
    db.prepare(
      `INSERT INTO ${table} (
        id,
        uuid,
        plan_uuid,
        task_index,
        title,
        description,
        done
      ) VALUES (?, ?, ?, ?, ?, 'desc', 0)`
    ).run(id, uuid, planUuid, taskIndex, title);
  }
}

function getProjectUuids(db: Database): Array<string | null> {
  return (
    db.prepare('SELECT uuid FROM project ORDER BY id').all() as Array<{ uuid: string | null }>
  ).map((row) => row.uuid);
}

function getPlanUuids(db: Database): Array<string | null> {
  return (
    db.prepare('SELECT uuid FROM plan ORDER BY plan_id').all() as Array<{ uuid: string | null }>
  ).map((row) => row.uuid);
}

function getTaskUuids(db: Database): Array<string | null> {
  return (
    db.prepare('SELECT uuid FROM plan_task ORDER BY id').all() as Array<{ uuid: string | null }>
  ).map((row) => row.uuid);
}

function getCanonicalTaskUuids(db: Database): Array<string | null> {
  return (
    db.prepare('SELECT uuid FROM task_canonical ORDER BY id').all() as Array<{
      uuid: string | null;
    }>
  ).map((row) => row.uuid);
}

function expectUniqueIndexes(db: Database): void {
  const projectIndexes = db.prepare("PRAGMA index_list('project')").all() as Array<{
    name: string;
    unique: number;
  }>;
  expect(
    projectIndexes.some((index) => index.name === 'idx_project_uuid_unique' && index.unique === 1)
  ).toBe(true);

  const taskIndexes = db.prepare("PRAGMA index_list('plan_task')").all() as Array<{
    name: string;
    unique: number;
  }>;
  expect(
    taskIndexes.some((index) => index.name === 'idx_plan_task_uuid_unique' && index.unique === 1)
  ).toBe(true);
}

describe('backfill-uuids command helpers', () => {
  let db: Database;

  beforeEach(() => {
    db = createMigratedDatabase();
  });

  afterEach(() => {
    db.close(false);
  });

  test('backfills NULL UUIDs across project and plan_task rows', () => {
    expectUniqueIndexes(db);

    insertProject(db, 1, 'repo-null-project', null);
    insertProject(db, 2, 'repo-existing-project', '11111111-1111-4111-8111-111111111111');

    insertPlan(db, '22222222-2222-4222-8222-222222222222', 1, 1, 'Existing UUID plan');

    insertTask(db, 1, null, '22222222-2222-4222-8222-222222222222', 0, 'Null task');
    insertTask(
      db,
      2,
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      1,
      'Existing task'
    );

    const result = backfillMissingPlanAndTaskUuids(db);

    expect(result).toEqual({ projectsUpdated: 1, plansUpdated: 0, tasksUpdated: 1 });

    const projectUuids = getProjectUuids(db);
    expect(projectUuids).toHaveLength(2);
    expect(projectUuids[0]).toMatch(uuidPattern);
    expect(projectUuids[1]).toBe('11111111-1111-4111-8111-111111111111');
    expect(projectUuids[0]).not.toBe(projectUuids[1]);

    const planUuids = getPlanUuids(db);
    expect(planUuids).toEqual(['22222222-2222-4222-8222-222222222222']);

    const taskUuids = getTaskUuids(db);
    expect(taskUuids).toHaveLength(2);
    expect(taskUuids[0]).toMatch(uuidPattern);
    expect(taskUuids[1]).toBe('33333333-3333-4333-8333-333333333333');
    expect(taskUuids[0]).not.toBe(taskUuids[1]);
    expect(getCanonicalTaskUuids(db)).toEqual(taskUuids);
  });

  test('returns zeros when every row already has a UUID', () => {
    insertProject(db, 1, 'repo-existing-project', '11111111-1111-4111-8111-111111111111');
    insertPlan(db, '22222222-2222-4222-8222-222222222222', 1, 1, 'Existing UUID plan');
    insertTask(
      db,
      1,
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      0,
      'Existing task'
    );

    const result = backfillMissingPlanAndTaskUuids(db);

    expect(result).toEqual({ projectsUpdated: 0, plansUpdated: 0, tasksUpdated: 0 });
    expect(getProjectUuids(db)).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(getPlanUuids(db)).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(getTaskUuids(db)).toEqual(['33333333-3333-4333-8333-333333333333']);
    expect(getCanonicalTaskUuids(db)).toEqual(['33333333-3333-4333-8333-333333333333']);
  });

  test('is idempotent on a second run and preserves existing UUIDs in mixed state', () => {
    insertProject(db, 1, 'repo-null-project', null);
    insertProject(db, 2, 'repo-existing-project', '11111111-1111-4111-8111-111111111111');

    insertPlan(db, '22222222-2222-4222-8222-222222222222', 1, 1, 'Existing UUID plan');

    insertTask(db, 1, null, '22222222-2222-4222-8222-222222222222', 0, 'Null task');
    insertTask(
      db,
      2,
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
      1,
      'Existing task'
    );

    const firstRun = backfillMissingPlanAndTaskUuids(db);
    const firstProjectUuids = getProjectUuids(db);
    const firstPlanUuids = getPlanUuids(db);
    const firstTaskUuids = getTaskUuids(db);

    expect(firstRun).toEqual({ projectsUpdated: 1, plansUpdated: 0, tasksUpdated: 1 });
    expect(firstProjectUuids[0]).toMatch(uuidPattern);
    expect(firstPlanUuids).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(firstTaskUuids[0]).toMatch(uuidPattern);

    const secondRun = backfillMissingPlanAndTaskUuids(db);

    expect(secondRun).toEqual({ projectsUpdated: 0, plansUpdated: 0, tasksUpdated: 0 });
    expect(getProjectUuids(db)).toEqual(firstProjectUuids);
    expect(getPlanUuids(db)).toEqual(firstPlanUuids);
    expect(getTaskUuids(db)).toEqual(firstTaskUuids);
    expect(getCanonicalTaskUuids(db)).toEqual(firstTaskUuids);
  });

  test('repairs canonical UUIDs left NULL by the old projection-only backfill', () => {
    insertProject(db, 1, 'repo', '11111111-1111-4111-8111-111111111111');
    insertPlan(db, '22222222-2222-4222-8222-222222222222', 1, 1, 'Plan');
    insertTask(db, 1, null, '22222222-2222-4222-8222-222222222222', 0, 'Task');

    const projectionUuid = '33333333-3333-4333-8333-333333333333';
    db.prepare('UPDATE plan_task SET uuid = ? WHERE id = ?').run(projectionUuid, 1);

    const beforeMetadata = db
      .prepare(
        `SELECT plan_uuid, task_index, title, description, done, revision
         FROM task_canonical WHERE id = ?`
      )
      .get(1);

    expect(backfillMissingPlanAndTaskUuids(db)).toEqual({
      projectsUpdated: 0,
      plansUpdated: 0,
      tasksUpdated: 1,
    });
    expect(getTaskUuids(db)).toEqual([projectionUuid]);
    expect(getCanonicalTaskUuids(db)).toEqual([projectionUuid]);
    expect(
      db
        .prepare(
          `SELECT plan_uuid, task_index, title, description, done, revision
           FROM task_canonical WHERE id = ?`
        )
        .get(1)
    ).toEqual(beforeMetadata);
  });

  test('rolls back all UUID updates when projection and canonical task metadata differ', () => {
    insertProject(db, 1, 'repo', null);
    insertPlan(db, '22222222-2222-4222-8222-222222222222', 1, 1, 'Plan');
    insertTask(db, 1, null, '22222222-2222-4222-8222-222222222222', 0, 'First task');
    insertTask(db, 2, null, '22222222-2222-4222-8222-222222222222', 1, 'Second task');
    db.prepare('UPDATE task_canonical SET description = ? WHERE id = ?').run('different', 2);

    expect(() => backfillMissingPlanAndTaskUuids(db)).toThrow(
      'projection and canonical task metadata differ'
    );
    expect(getProjectUuids(db)).toEqual([null]);
    expect(getTaskUuids(db)).toEqual([null, null]);
    expect(getCanonicalTaskUuids(db)).toEqual([null, null]);
  });

  test('rejects direct UUID maintenance while synced writes are active', async () => {
    expect(() =>
      assertUuidBackfillAllowed({ sync: { role: 'main', nodeId: 'main' } } as TimConfig)
    ).toThrow('sync-main');
    expect(() =>
      assertUuidBackfillAllowed({
        sync: { role: 'persistent', nodeId: 'persistent' },
      } as TimConfig)
    ).toThrow('sync-persistent');
    expect(() =>
      assertUuidBackfillAllowed({
        sync: { role: 'persistent', nodeId: 'persistent', disabled: true },
      } as TimConfig)
    ).not.toThrow();

    const command = { optsWithGlobals: () => ({}) } as Command;
    await expect(
      handleBackfillUuidsCommand(command, {
        db,
        config: { sync: { role: 'main', nodeId: 'main' } } as TimConfig,
      })
    ).rejects.toThrow('sync-main');
  });
});
