import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  deletePlan,
  getPlanTasksByUuid,
  upsertPlan,
  upsertPlanDependencies,
  upsertPlanTasks,
} from '../db/plan.js';
import { createReviewIssue, softDeleteReviewIssue } from '../db/plan_review_issue.js';
import { getOrCreateProject } from '../db/project.js';
import { deleteProjectSetting, setProjectSetting } from '../db/project_settings.js';
import type { SyncFieldClockRow, SyncOpLogRow, SyncTombstoneRow } from '../db/sync_schema.js';

function opRows(db: Database): SyncOpLogRow[] {
  return db
    .prepare('SELECT * FROM sync_op_log ORDER BY hlc_physical_ms, hlc_logical, local_counter')
    .all() as SyncOpLogRow[];
}

function fieldClock(
  db: Database,
  entityType: string,
  entityId: string,
  fieldName: string
): SyncFieldClockRow | null {
  return (
    (db
      .prepare(
        `
          SELECT *
          FROM sync_field_clock
          WHERE entity_type = ?
            AND entity_id = ?
            AND field_name = ?
        `
      )
      .get(entityType, entityId, fieldName) as SyncFieldClockRow | null) ?? null
  );
}

describe('sync op emission', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-emission-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('plan creates and scalar updates emit ops and field clocks, while no-op updates do not', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-sync-1',
      planId: 1,
      title: 'Initial',
      status: 'pending',
      docs: ['docs/a.md'],
    });

    expect(opRows(db).filter((op) => op.entity_type === 'plan')).toMatchObject([
      {
        entity_id: 'plan-sync-1',
        op_type: 'create',
      },
    ]);
    expect(fieldClock(db, 'plan', 'plan-sync-1', 'title')).not.toBeNull();
    expect(fieldClock(db, 'plan', 'plan-sync-1', 'docs')).not.toBeNull();

    const beforeNoopCount = opRows(db).length;
    upsertPlan(db, projectId, {
      uuid: 'plan-sync-1',
      planId: 1,
      title: 'Initial',
      status: 'pending',
      docs: ['docs/a.md'],
    });
    expect(opRows(db)).toHaveLength(beforeNoopCount);

    upsertPlan(db, projectId, {
      uuid: 'plan-sync-1',
      planId: 1,
      title: 'Updated',
      status: 'pending',
      docs: ['docs/a.md'],
    });

    const planOps = opRows(db).filter((op) => op.entity_type === 'plan');
    expect(planOps.at(-1)).toMatchObject({
      entity_id: 'plan-sync-1',
      op_type: 'update_fields',
    });
    expect(JSON.parse(planOps.at(-1)?.payload ?? '{}')).toMatchObject({
      fields: { title: 'Updated' },
      planIdHint: 1,
    });
    expect(JSON.parse(planOps.at(-1)?.payload ?? '{}').projectIdentity).toBeDefined();
  });

  test('replacePlanTasks emits create, update, set_order, delete, and skips idempotent reapply', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-sync-tasks',
      planId: 2,
      tasks: [
        { uuid: 'task-a', title: 'A', description: 'first', done: false },
        { uuid: 'task-b', title: 'B', description: 'second', done: false },
      ],
    });
    const createOps = opRows(db).filter((op) => op.entity_type === 'plan_task');
    expect(createOps.map((op) => op.op_type)).toEqual(['create', 'create']);

    const beforeNoopCount = opRows(db).length;
    upsertPlanTasks(db, 'plan-sync-tasks', [
      {
        uuid: 'task-a',
        orderKey: '0000000000',
        title: 'A',
        description: 'first',
        done: false,
      },
      {
        uuid: 'task-b',
        orderKey: '0000000001',
        title: 'B',
        description: 'second',
        done: false,
      },
    ]);
    expect(opRows(db)).toHaveLength(beforeNoopCount);

    upsertPlanTasks(db, 'plan-sync-tasks', [
      {
        uuid: 'task-b',
        orderKey: '0000000000',
        title: 'B updated',
        description: 'second',
        done: true,
      },
    ]);

    expect(getPlanTasksByUuid(db, 'plan-sync-tasks').map((task) => task.uuid)).toEqual(['task-b']);
    const taskOps = opRows(db)
      .filter((op) => op.entity_type === 'plan_task')
      .map((op) => op.op_type);
    expect(taskOps).toEqual(['create', 'create', 'update_fields', 'set_order', 'delete']);
    expect(fieldClock(db, 'plan_task', 'task-b', 'done')).not.toBeNull();

    const tombstone = db
      .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
      .get('plan_task', 'task-a') as SyncTombstoneRow | null;
    expect(tombstone).not.toBeNull();
    const deletedTask = db
      .prepare('SELECT deleted_hlc FROM plan_task WHERE uuid = ?')
      .get('task-a') as { deleted_hlc: string | null } | null;
    expect(deletedTask?.deleted_hlc).toMatch(/^\d+\.\d+$/);
  });

  test('edges, review issue deletes, plan deletes, and project settings emit sync metadata', () => {
    upsertPlan(db, projectId, { uuid: 'plan-sync-edges', planId: 3 });
    upsertPlan(db, projectId, { uuid: 'dep-plan', planId: 4 });

    upsertPlanDependencies(db, 'plan-sync-edges', ['dep-plan']);
    upsertPlanDependencies(db, 'plan-sync-edges', []);

    const edgeOps = opRows(db).filter((op) => op.entity_type === 'plan_dependency');
    expect(edgeOps.map((op) => op.op_type)).toEqual(['add_edge', 'remove_edge']);
    expect(
      db
        .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
        .get('plan_dependency', 'plan-sync-edges->dep-plan')
    ).not.toBeNull();

    const issue = createReviewIssue(db, {
      planUuid: 'plan-sync-edges',
      content: 'Fix it',
      severity: 'major',
      category: 'bug',
    });
    softDeleteReviewIssue(db, issue.uuid);
    expect(
      opRows(db)
        .filter((op) => op.entity_type === 'plan_review_issue')
        .map((op) => op.op_type)
    ).toEqual(['create', 'delete']);

    setProjectSetting(db, projectId, 'featured', true);
    setProjectSetting(db, projectId, 'featured', true);
    deleteProjectSetting(db, projectId, 'featured');
    const settingOps = opRows(db).filter((op) => op.entity_type === 'project_setting');
    expect(settingOps.map((op) => op.op_type)).toEqual(['update_fields', 'delete']);
    expect(settingOps[0]?.entity_id).toBe('github.com__owner__repo:featured');
    expect(
      fieldClock(db, 'project_setting', 'github.com__owner__repo:featured', 'value')
    ).toMatchObject({
      deleted: 1,
    });

    expect(deletePlan(db, 'dep-plan')).toBe(true);
    expect(
      opRows(db).filter((op) => op.entity_type === 'plan' && op.op_type === 'delete')
    ).toHaveLength(1);
  });

  test('sequential operations have increasing HLCs and unique operation ids', () => {
    upsertPlan(db, projectId, { uuid: 'plan-sync-clock', planId: 5, title: 'One' });
    upsertPlan(db, projectId, { uuid: 'plan-sync-clock', planId: 5, title: 'Two' });
    upsertPlan(db, projectId, { uuid: 'plan-sync-clock', planId: 5, title: 'Three' });

    const ops = opRows(db).filter((op) => op.entity_id === 'plan-sync-clock');
    expect(new Set(ops.map((op) => op.op_id)).size).toBe(ops.length);
    for (let index = 1; index < ops.length; index += 1) {
      const previous = ops[index - 1]!;
      const current = ops[index]!;
      expect(
        current.hlc_physical_ms > previous.hlc_physical_ms ||
          (current.hlc_physical_ms === previous.hlc_physical_ms &&
            current.hlc_logical > previous.hlc_logical)
      ).toBe(true);
    }
  });
});
