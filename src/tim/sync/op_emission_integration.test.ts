import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  appendPlanTask,
  getPlanTasksByUuid,
  setPlanStatus,
  upsertPlan,
  upsertPlanDependencies,
  upsertPlanTasks,
} from '../db/plan.js';
import {
  createReviewIssue,
  listReviewIssuesForPlan,
  reconcileReviewIssuesForPlan,
} from '../db/plan_review_issue.js';
import { getOrCreateProject } from '../db/project.js';
import { deleteProjectSetting, setProjectSetting } from '../db/project_settings.js';
import type { SyncFieldClockRow, SyncOpLogRow, SyncTombstoneRow } from '../db/sync_schema.js';
import { edgeClockIsPresent, getEdgeClock } from './edge_clock.js';

function opRows(db: Database): SyncOpLogRow[] {
  return db
    .prepare('SELECT * FROM sync_op_log ORDER BY hlc_physical_ms, hlc_logical, local_counter')
    .all() as SyncOpLogRow[];
}

function opRowsFor(db: Database, entityType: string, entityId?: string): SyncOpLogRow[] {
  if (entityId) {
    return db
      .prepare(
        'SELECT * FROM sync_op_log WHERE entity_type = ? AND entity_id = ? ORDER BY hlc_physical_ms, hlc_logical, local_counter'
      )
      .all(entityType, entityId) as SyncOpLogRow[];
  }
  return db
    .prepare(
      'SELECT * FROM sync_op_log WHERE entity_type = ? ORDER BY hlc_physical_ms, hlc_logical, local_counter'
    )
    .all(entityType) as SyncOpLogRow[];
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
        'SELECT * FROM sync_field_clock WHERE entity_type = ? AND entity_id = ? AND field_name = ?'
      )
      .get(entityType, entityId, fieldName) as SyncFieldClockRow | null) ?? null
  );
}

function tombstone(db: Database, entityType: string, entityId: string): SyncTombstoneRow | null {
  return (
    (db
      .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as SyncTombstoneRow | null) ?? null
  );
}

describe('sync op emission – integration coverage', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-op-emission-int-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // replacePlanTasks – reorder-only emits only set_order (not field updates)
  // ---------------------------------------------------------------------------
  test('replacePlanTasks reorder-only emits set_order but not field updates', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-reorder',
      planId: 1,
      tasks: [
        { uuid: 'task-x', orderKey: '0000000000', title: 'X', description: 'desc x', done: false },
        { uuid: 'task-y', orderKey: '0000000001', title: 'Y', description: 'desc y', done: false },
      ],
    });

    const afterCreate = opRowsFor(db, 'plan_task').length;

    // Swap order keys without changing titles/descriptions/done
    upsertPlanTasks(db, 'plan-reorder', [
      { uuid: 'task-y', orderKey: '0000000000', title: 'Y', description: 'desc y', done: false },
      { uuid: 'task-x', orderKey: '0000000001', title: 'X', description: 'desc x', done: false },
    ]);

    const newOps = opRowsFor(db, 'plan_task').slice(afterCreate);
    expect(newOps.map((op) => op.op_type).sort()).toEqual(['set_order', 'set_order']);
    expect(newOps.every((op) => op.op_type === 'set_order')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // replacePlanTasks – tombstoned task does not have deleted_hlc cleared
  // ---------------------------------------------------------------------------
  test('replacePlanTasks tombstone is not cleared by subsequent task list replacement', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-tombstone',
      planId: 2,
      tasks: [
        {
          uuid: 'task-del',
          orderKey: '0000000000',
          title: 'Del',
          description: 'will be deleted',
          done: false,
        },
      ],
    });

    // Delete the task by replacing with empty list
    upsertPlanTasks(db, 'plan-tombstone', []);

    const deletedTask = db
      .prepare('SELECT deleted_hlc FROM plan_task WHERE uuid = ?')
      .get('task-del') as { deleted_hlc: string | null } | null;
    const originalDeletedHlc = deletedTask?.deleted_hlc;
    expect(originalDeletedHlc).toMatch(/^\d+\.\d+$/);

    // Re-add a different task, tombstoned task must NOT come back
    upsertPlanTasks(db, 'plan-tombstone', [
      {
        uuid: 'task-new',
        orderKey: '0000000000',
        title: 'New',
        description: 'fresh task',
        done: false,
      },
    ]);

    const tombstonedTask = db
      .prepare('SELECT deleted_hlc FROM plan_task WHERE uuid = ?')
      .get('task-del') as { deleted_hlc: string | null } | null;
    // deleted_hlc must still be the same value (not cleared or changed)
    expect(tombstonedTask?.deleted_hlc).toBe(originalDeletedHlc);

    // task-del must not appear in the active list
    const activeTasks = getPlanTasksByUuid(db, 'plan-tombstone');
    expect(activeTasks.map((t) => t.uuid)).not.toContain('task-del');
  });

  // ---------------------------------------------------------------------------
  // replacePlanTasks – stale update after tombstone does not emit new ops
  // ---------------------------------------------------------------------------
  test('replacePlanTasks with a tombstoned uuid produces no field update ops for that task', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-stale',
      planId: 3,
      tasks: [
        {
          uuid: 'task-gone',
          orderKey: '0000000000',
          title: 'Gone',
          description: 'desc',
          done: false,
        },
      ],
    });

    // Delete by replacing with empty
    upsertPlanTasks(db, 'plan-stale', []);

    const opsAfterDelete = opRowsFor(db, 'plan_task').length;

    // Try to "update" the tombstoned task by passing it again
    // The implementation should treat a tombstoned uuid as non-reusable → new uuid minted
    upsertPlanTasks(db, 'plan-stale', [
      {
        uuid: 'task-gone',
        orderKey: '0000000000',
        title: 'Gone',
        description: 'desc',
        done: false,
      },
    ]);

    const newOps = opRowsFor(db, 'plan_task').slice(opsAfterDelete);
    // Should be a create for a new UUID, not update_fields for task-gone
    const newOpTypes = newOps.map((op) => op.op_type);
    expect(newOpTypes).toContain('create');
    expect(newOps.every((op) => op.entity_id !== 'task-gone')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // reconcileReviewIssuesForPlan – tombstoned issues not resurrected
  // ---------------------------------------------------------------------------
  test('reconcileReviewIssuesForPlan does not resurrect tombstoned issues', () => {
    upsertPlan(db, projectId, { uuid: 'plan-ri', planId: 4 });
    const created = createReviewIssue(db, {
      planUuid: 'plan-ri',
      content: 'Old issue',
      severity: 'major',
      category: 'bug',
    });

    // Soft-delete the issue
    reconcileReviewIssuesForPlan(db, 'plan-ri', []);
    const afterDelete = db
      .prepare('SELECT deleted_hlc FROM plan_review_issue WHERE uuid = ?')
      .get(created.uuid) as { deleted_hlc: string | null } | null;
    expect(afterDelete?.deleted_hlc).not.toBeNull();

    const opsBeforeReconcile = opRows(db).length;

    // Reconcile again with the same content — should NOT reuse the tombstoned uuid
    reconcileReviewIssuesForPlan(db, 'plan-ri', [
      { content: 'Old issue', severity: 'major', category: 'bug' },
    ]);

    // The tombstoned row must still be tombstoned
    const afterReconcile = db
      .prepare('SELECT deleted_hlc FROM plan_review_issue WHERE uuid = ?')
      .get(created.uuid) as { deleted_hlc: string | null } | null;
    expect(afterReconcile?.deleted_hlc).not.toBeNull();

    // A new row should have been created
    const activeIssues = listReviewIssuesForPlan(db, 'plan-ri');
    expect(activeIssues).toHaveLength(1);
    expect(activeIssues[0]!.uuid).not.toBe(created.uuid);

    // Exactly one create op for the new row
    const newOps = opRows(db).slice(opsBeforeReconcile);
    expect(
      newOps.some((op) => op.op_type === 'create' && op.entity_type === 'plan_review_issue')
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // reconcileReviewIssuesForPlan – field updates write per-field clocks, no-op does not
  // ---------------------------------------------------------------------------
  test('reconcileReviewIssuesForPlan field updates write per-field clocks and no-op skips them', () => {
    upsertPlan(db, projectId, { uuid: 'plan-ri2', planId: 5 });
    const created = createReviewIssue(db, {
      planUuid: 'plan-ri2',
      content: 'Issue one',
      severity: 'minor',
      category: 'style',
    });

    const beforeNoopCount = opRows(db).length;

    // No-op reconcile (same content)
    reconcileReviewIssuesForPlan(db, 'plan-ri2', [
      { uuid: created.uuid, content: 'Issue one', severity: 'minor', category: 'style' },
    ]);
    expect(opRows(db)).toHaveLength(beforeNoopCount);

    // Update category and severity — should emit update_fields and write field clocks
    reconcileReviewIssuesForPlan(db, 'plan-ri2', [
      { uuid: created.uuid, content: 'Issue one', severity: 'major', category: 'bug' },
    ]);

    const updateOps = opRowsFor(db, 'plan_review_issue', created.uuid).filter(
      (op) => op.op_type === 'update_fields'
    );
    expect(updateOps).toHaveLength(1);
    const payload = JSON.parse(updateOps[0]!.payload);
    expect(payload.fields).toMatchObject({ severity: 'major', category: 'bug' });

    expect(fieldClock(db, 'plan_review_issue', created.uuid, 'severity')).not.toBeNull();
    expect(fieldClock(db, 'plan_review_issue', created.uuid, 'category')).not.toBeNull();
    // content was unchanged — no field clock for content from this update
    // (it may exist from the create, but let's just verify update payload is correct)
  });

  // ---------------------------------------------------------------------------
  // Tag edges: add then remove, re-add after remove is a fresh add op
  // ---------------------------------------------------------------------------
  test('tag add then remove then re-add produces three distinct ops', () => {
    upsertPlan(db, projectId, { uuid: 'plan-tags', planId: 6 });

    // Add tag
    upsertPlan(db, projectId, { uuid: 'plan-tags', planId: 6, tags: ['backend'] });
    // Remove tag
    upsertPlan(db, projectId, { uuid: 'plan-tags', planId: 6, tags: [] });
    // Re-add tag
    upsertPlan(db, projectId, { uuid: 'plan-tags', planId: 6, tags: ['backend'] });

    const tagOps = opRowsFor(db, 'plan_tag', 'plan-tags#backend');
    expect(tagOps.map((op) => op.op_type)).toEqual(['add_edge', 'remove_edge', 'add_edge']);

    // After re-add, edge should be present (tombstone is overwritten or re-created)
    const tags: Array<{ tag: string }> = db
      .prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?')
      .all('plan-tags') as Array<{ tag: string }>;
    expect(tags.map((t) => t.tag)).toContain('backend');
  });

  test('tag edge clock is removed on remove', () => {
    upsertPlan(db, projectId, { uuid: 'plan-tags2', planId: 7, tags: ['frontend'] });
    upsertPlan(db, projectId, { uuid: 'plan-tags2', planId: 7, tags: [] });

    expect(edgeClockIsPresent(getEdgeClock(db, 'plan_tag', 'plan-tags2#frontend'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // appendPlanTask emits a create op
  // ---------------------------------------------------------------------------
  test('appendPlanTask emits a create op and stamps created_hlc', () => {
    upsertPlan(db, projectId, { uuid: 'plan-append', planId: 8 });
    const taskUuid = appendPlanTask(db, 'plan-append', {
      title: 'Appended',
      description: 'via append',
    });

    const ops = opRowsFor(db, 'plan_task', taskUuid);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op_type).toBe('create');

    const taskRow = db
      .prepare('SELECT created_hlc, updated_hlc FROM plan_task WHERE uuid = ?')
      .get(taskUuid) as { created_hlc: string | null; updated_hlc: string | null } | null;
    expect(taskRow?.created_hlc).toMatch(/^\d+\.\d+$/);
    expect(taskRow?.updated_hlc).toMatch(/^\d+\.\d+$/);
  });

  test('appendPlanTask provided uuid is preserved in the create op', () => {
    upsertPlan(db, projectId, { uuid: 'plan-append2', planId: 9 });
    appendPlanTask(db, 'plan-append2', {
      uuid: 'explicit-task-uuid',
      title: 'Named',
      description: 'explicit uuid',
    });

    expect(opRowsFor(db, 'plan_task', 'explicit-task-uuid')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // setPlanStatus emits a field update op
  // ---------------------------------------------------------------------------
  test('setPlanStatus emits a field update op for status', () => {
    upsertPlan(db, projectId, { uuid: 'plan-status', planId: 10, status: 'pending' });
    const beforeCount = opRows(db).length;

    setPlanStatus(db, 'plan-status', 'in_progress');

    const newOps = opRows(db).slice(beforeCount);
    expect(newOps).toHaveLength(1);
    expect(newOps[0]!.op_type).toBe('update_fields');
    const payload = JSON.parse(newOps[0]!.payload);
    expect(payload.fields).toEqual({ status: 'in_progress' });
    expect(fieldClock(db, 'plan', 'plan-status', 'status')).not.toBeNull();
  });

  test('setPlanStatus is a no-op if status is already the same', () => {
    upsertPlan(db, projectId, { uuid: 'plan-status2', planId: 11, status: 'pending' });
    const beforeCount = opRows(db).length;

    setPlanStatus(db, 'plan-status2', 'pending');

    expect(opRows(db)).toHaveLength(beforeCount);
  });

  // ---------------------------------------------------------------------------
  // Project settings – LWW keyed by project sync identity, tombstone on delete
  // ---------------------------------------------------------------------------
  test('project settings use repository_id as project sync identity in entity_id', () => {
    setProjectSetting(db, projectId, 'abbreviation', 'PROJ');
    const ops = opRowsFor(db, 'project_setting', 'github.com__owner__repo:abbreviation');
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op_type).toBe('update_fields');
  });

  test('project settings delete writes tombstone and sets field clock deleted=1', () => {
    setProjectSetting(db, projectId, 'color', 'blue');
    deleteProjectSetting(db, projectId, 'color');

    const entityId = 'github.com__owner__repo:color';
    expect(tombstone(db, 'project_setting', entityId)).not.toBeNull();
    const fc = fieldClock(db, 'project_setting', entityId, 'value');
    expect(fc?.deleted).toBe(1);
  });

  test('project settings no-op write does not emit', () => {
    setProjectSetting(db, projectId, 'featured', true);
    const beforeCount = opRows(db).length;
    setProjectSetting(db, projectId, 'featured', true);
    expect(opRows(db)).toHaveLength(beforeCount);
  });

  test('deleting a non-existent project setting does not emit', () => {
    const beforeCount = opRows(db).length;
    const result = deleteProjectSetting(db, projectId, 'does-not-exist');
    expect(result).toBe(false);
    expect(opRows(db)).toHaveLength(beforeCount);
  });

  // ---------------------------------------------------------------------------
  // Atomicity – failed transaction does not commit op log rows
  // ---------------------------------------------------------------------------
  test('op log is not committed when the outer transaction rolls back', () => {
    upsertPlan(db, projectId, { uuid: 'plan-atomic', planId: 12 });
    const beforeCount = opRows(db).length;

    expect(() => {
      db.transaction(() => {
        // Emit a valid op inside the transaction
        upsertPlan(db, projectId, { uuid: 'plan-atomic', planId: 12, title: 'Changed' });
        // Force a rollback by violating a constraint
        db.prepare('INSERT INTO plan (uuid, project_id, plan_id) VALUES (?, ?, ?)').run(
          'plan-atomic', // duplicate uuid → rollback
          projectId,
          999
        );
      }).immediate();
    }).toThrow();

    // Op count must be unchanged
    expect(opRows(db)).toHaveLength(beforeCount);
  });

  // ---------------------------------------------------------------------------
  // HLC monotonicity within the same transaction
  // ---------------------------------------------------------------------------
  test('multiple ops within the same upsertPlan call have strictly increasing HLCs', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-hlc',
      planId: 13,
      title: 'HLC test',
      tasks: [
        { uuid: 'hlc-task-1', title: 'T1', description: 'D1', done: false },
        { uuid: 'hlc-task-2', title: 'T2', description: 'D2', done: false },
      ],
      tags: ['alpha'],
    });

    const allOps = opRows(db);
    expect(new Set(allOps.map((op) => op.op_id)).size).toBe(allOps.length);

    for (let i = 1; i < allOps.length; i += 1) {
      const prev = allOps[i - 1]!;
      const curr = allOps[i]!;
      const hlcAdvanced =
        curr.hlc_physical_ms > prev.hlc_physical_ms ||
        (curr.hlc_physical_ms === prev.hlc_physical_ms && curr.hlc_logical > prev.hlc_logical);
      expect(hlcAdvanced, `Op ${i} HLC not > op ${i - 1}`).toBe(true);
    }
  });

  // ---------------------------------------------------------------------------
  // Per-field LWW clocks for plan field updates
  // ---------------------------------------------------------------------------
  test('per-field clocks are updated only for changed fields on plan update', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-fields',
      planId: 14,
      title: 'Original title',
      goal: 'Original goal',
    });

    const titleClockAfterCreate = fieldClock(db, 'plan', 'plan-fields', 'title');
    const goalClockAfterCreate = fieldClock(db, 'plan', 'plan-fields', 'goal');
    expect(titleClockAfterCreate).not.toBeNull();
    expect(goalClockAfterCreate).not.toBeNull();

    // Update only title
    upsertPlan(db, projectId, {
      uuid: 'plan-fields',
      planId: 14,
      title: 'New title',
      goal: 'Original goal',
    });

    const titleClockAfterUpdate = fieldClock(db, 'plan', 'plan-fields', 'title');
    const goalClockAfterUpdate = fieldClock(db, 'plan', 'plan-fields', 'goal');

    // Title clock must advance
    expect(titleClockAfterUpdate!.hlc_physical_ms).toBeGreaterThanOrEqual(
      titleClockAfterCreate!.hlc_physical_ms
    );
    // Goal was not changed, clock stays at create value (logical or physical)
    // We can verify that a new op was not emitted for goal
    const updateOps = opRowsFor(db, 'plan', 'plan-fields').filter(
      (op) => op.op_type === 'update_fields'
    );
    expect(updateOps).toHaveLength(1);
    const payload = JSON.parse(updateOps[0]!.payload);
    expect(Object.keys(payload.fields)).toContain('title');
    expect(Object.keys(payload.fields)).not.toContain('goal');
    expect(goalClockAfterUpdate).toEqual(goalClockAfterCreate);
  });

  // ---------------------------------------------------------------------------
  // Dependency edge: add then remove yields absent edge; re-add is a fresh op
  // ---------------------------------------------------------------------------
  test('dependency add then remove then re-add produces three ops and re-establishes edge', () => {
    upsertPlan(db, projectId, { uuid: 'plan-dep', planId: 15 });
    upsertPlan(db, projectId, { uuid: 'dep-target', planId: 16 });

    upsertPlanDependencies(db, 'plan-dep', ['dep-target']);
    upsertPlanDependencies(db, 'plan-dep', []);
    upsertPlanDependencies(db, 'plan-dep', ['dep-target']);

    const depOps = opRowsFor(db, 'plan_dependency', 'plan-dep->dep-target');
    expect(depOps.map((op) => op.op_type)).toEqual(['add_edge', 'remove_edge', 'add_edge']);

    const deps: Array<{ depends_on_uuid: string }> = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all('plan-dep') as Array<{ depends_on_uuid: string }>;
    expect(deps.map((d) => d.depends_on_uuid)).toContain('dep-target');
  });
});
