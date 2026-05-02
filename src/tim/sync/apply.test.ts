import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAssignment, importAssignment } from '../db/assignment.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertCanonicalPlanInTransaction,
  upsertPlan,
  upsertProjectionPlanInTransaction,
  type UpsertPlanInput,
} from '../db/plan.js';
import { SyncFifoGapError, SyncValidationError } from './errors.js';
import {
  applyBatch,
  clonePlanWithBump,
  applyOperation,
  resolveSyncConflict,
  setApplyBatchOperationHookForTesting,
} from './apply.js';
import { mergeCanonicalRefresh } from './queue.js';
import { loadCanonicalSnapshot } from './server.js';
import {
  addPlanDependencyOperation,
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  promotePlanTaskOperation,
  removePlanDependencyOperation,
  removePlanListItemOperation,
  removePlanTagOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
} from './operations.js';
import { createBatchEnvelope } from './types.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const THIRD_PLAN_UUID = '44444444-4444-4444-8444-444444444444';
const TASK_UUID = '55555555-5555-4555-8555-555555555555';
const TASK_UUID_2 = '66666666-6666-4666-8666-666666666666';
const TASK_UUID_3 = '77777777-7777-4777-8777-777777777777';
const TASK_UUID_4 = '88888888-8888-4888-8888-888888888888';
const NODE_A = 'node-a';
const NODE_B = 'node-b';

let db: Database;
let project: Project;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
});

describe('apply helpers', () => {
  test('clonePlanWithBump preserves updated_at when skipUpdatedAt is true', () => {
    const plan = {
      uuid: PLAN_UUID,
      project_id: 1,
      plan_id: 1,
      title: 'Plan',
      goal: null,
      note: null,
      details: null,
      status: 'pending' as const,
      priority: null,
      branch: null,
      simple: null,
      tdd: null,
      discovered_from: null,
      issue: null,
      pull_request: null,
      assigned_to: null,
      base_branch: null,
      base_commit: null,
      base_change_id: null,
      temp: null,
      docs: null,
      changed_files: null,
      plan_generated_at: null,
      docs_updated_at: null,
      lessons_applied_at: null,
      review_issues: null,
      parent_uuid: null,
      epic: 0,
      revision: 7,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    };

    expect(clonePlanWithBump(plan, { title: 'Updated' }, { skipUpdatedAt: true })).toMatchObject({
      title: 'Updated',
      revision: 8,
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });
});

function seedPlan(uuid = PLAN_UUID, planId = 1, taskUuid = TASK_UUID): void {
  seedPlanRow({
    uuid,
    planId,
    title: `Plan ${planId}`,
    details: 'alpha\nbeta\ngamma\n',
    status: 'pending',
    tasks: [{ uuid: taskUuid, title: 'Task one', description: 'old description' }],
    forceOverwrite: true,
  });
}

function seedPlanRow(input: UpsertPlanInput): void {
  const withRevision = {
    revision: input.revision ?? 1,
    ...input,
    tasks: input.tasks?.map((task) => ({ revision: task.revision ?? 1, ...task })),
  };
  upsertCanonicalPlanInTransaction(db, project.id, withRevision);
  upsertProjectionPlanInTransaction(db, project.id, input);
}

function mirrorProjectionPlanToCanonical(planUuid = PLAN_UUID): void {
  db.prepare(
    'DELETE FROM plan_dependency_canonical WHERE plan_uuid = ? OR depends_on_uuid = ?'
  ).run(planUuid, planUuid);
  db.prepare('DELETE FROM plan_tag_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM task_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan_canonical WHERE uuid = ?').run(planUuid);
  db.prepare(
    `
      INSERT INTO plan_canonical (
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      )
      SELECT
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      FROM plan
      WHERE uuid = ?
    `
  ).run(planUuid);
  db.prepare(
    `
      INSERT INTO task_canonical (uuid, plan_uuid, task_index, title, description, done, revision)
      SELECT uuid, plan_uuid, task_index, title, description, done, revision
      FROM plan_task
      WHERE plan_uuid = ?
    `
  ).run(planUuid);
  db.prepare(
    `
      INSERT OR IGNORE INTO plan_dependency_canonical (plan_uuid, depends_on_uuid)
      SELECT plan_uuid, depends_on_uuid
      FROM plan_dependency
      WHERE plan_uuid = ?
        AND EXISTS (SELECT 1 FROM plan_canonical WHERE uuid = plan_dependency.depends_on_uuid)
    `
  ).run(planUuid);
  db.prepare(
    `
      INSERT OR IGNORE INTO plan_tag_canonical (plan_uuid, tag)
      SELECT plan_uuid, tag
      FROM plan_tag
      WHERE plan_uuid = ?
    `
  ).run(planUuid);
}

function seedAssignment(planUuid = PLAN_UUID): void {
  importAssignment(
    db,
    project.id,
    planUuid,
    1,
    null,
    'agent',
    'in_progress',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function canonicalCounts() {
  return {
    plan: countRows('plan'),
    planTask: countRows('plan_task'),
    planTag: countRows('plan_tag'),
    planDependency: countRows('plan_dependency'),
    syncSequence: countRows('sync_sequence'),
  };
}

function sequenceTargets(): string[] {
  return (
    db.prepare('SELECT target_key FROM sync_sequence ORDER BY sequence').all() as Array<{
      target_key: string;
    }>
  ).map((row) => row.target_key);
}

function highestPlanId(targetDb = db): number {
  return (
    targetDb.prepare('SELECT highest_plan_id FROM project WHERE uuid = ?').get(PROJECT_UUID) as {
      highest_plan_id: number;
    }
  ).highest_plan_id;
}

function ackMetadata(operationUuid: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT ack_metadata FROM sync_operation WHERE operation_uuid = ?')
    .get(operationUuid) as { ack_metadata: string } | null;
  return row ? (JSON.parse(row.ack_metadata) as Record<string, unknown>) : {};
}

function operationRows(): Array<{
  operation_uuid: string;
  local_sequence: number;
  status: string;
  attempts: number;
  last_error: string | null;
}> {
  return db
    .prepare(
      `SELECT operation_uuid, local_sequence, status, attempts, last_error
       FROM sync_operation
       ORDER BY local_sequence`
    )
    .all() as Array<{
    operation_uuid: string;
    local_sequence: number;
    status: string;
    attempts: number;
    last_error: string | null;
  }>;
}

function operationPlanRefs(operationUuid: string) {
  return db
    .prepare(
      'SELECT plan_uuid, role FROM sync_operation_plan_ref WHERE operation_uuid = ? ORDER BY role, plan_uuid'
    )
    .all(operationUuid) as Array<{ plan_uuid: string; role: string }>;
}

describe('main-node sync apply engine', () => {
  test('batch rolls back every mutation when a later operation is invalid', async () => {
    const create = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Parent',
      },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const batch = createBatchEnvelope({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      originNodeId: NODE_A,
      operations: [create, invalidDependency],
    });

    const result = applyBatch(db, batch);

    expect(result.status).toBe('rejected');
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(operationRows()).toMatchObject([
      {
        operation_uuid: create.operationUuid,
        local_sequence: 1,
        status: 'rejected',
        attempts: 1,
      },
      {
        operation_uuid: invalidDependency.operationUuid,
        local_sequence: 2,
        status: 'rejected',
        attempts: 1,
      },
    ]);
    expect(operationRows()[1]!.last_error).toContain(`Unknown plan ${OTHER_PLAN_UUID}`);
    expect(operationRows()[0]!.last_error).toBe(
      'Operation rolled back because its batch did not commit'
    );
    expect(countRows('sync_sequence')).toBe(0);

    // Make the originally-invalid dependency valid before replay. A real replay
    // must return the persisted rejection rows instead of re-running validation
    // against this changed canonical state.
    seedPlan(OTHER_PLAN_UUID, 2, TASK_UUID_2);
    const replay = applyBatch(db, batch);
    expect(replay.status).toBe('rejected');
    expect(replay.results.map((item) => item.status)).toEqual(['rejected', 'rejected']);
    expect(countRows('sync_operation')).toBe(2);
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(countRows('plan_dependency')).toBe(0);
  });

  test('batch commits applied operations and accepted conflicts together', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'alpha\nmain edit\ngamma\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const tag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const conflictingText = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\nremote edit\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        originNodeId: NODE_A,
        operations: [tag, conflictingText],
      })
    );

    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'conflict']);
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((row) => row.tag)).toEqual(['sync']);
    expect(countRows('sync_conflict')).toBe(1);
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('applyOperation records normalized plan refs for received operations', async () => {
    seedPlan();
    seedPlan(OTHER_PLAN_UUID, 2, TASK_UUID_2);
    const op = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(applyOperation(db, op).status).toBe('applied');
    expect(operationPlanRefs(op.operationUuid)).toEqual([
      { plan_uuid: OTHER_PLAN_UUID, role: 'depends_on' },
      { plan_uuid: PLAN_UUID, role: 'target' },
    ]);
  });

  test('canonical adapter writes canonical and projection rows for plan operations', async () => {
    seedPlan();
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'canonical' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((row) => row.tag)).toEqual(['canonical']);
    expect(
      db.prepare('SELECT tag FROM plan_tag_canonical WHERE plan_uuid = ?').all(PLAN_UUID)
    ).toEqual([{ tag: 'canonical' }]);
    expect(db.prepare('SELECT revision FROM plan_canonical WHERE uuid = ?').get(PLAN_UUID)).toEqual(
      { revision: 2 }
    );
  });

  test('canonical adapter rejects stale CAS as a conflict without mutating canonical rows', async () => {
    seedPlan();
    const op = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('conflict');
    expect(getPlanByUuid(db, PLAN_UUID)?.status).toBe('pending');
    expect(db.prepare('SELECT status FROM plan_canonical WHERE uuid = ?').get(PLAN_UUID)).toEqual({
      status: 'pending',
    });
    expect(
      db.prepare('SELECT reason FROM sync_conflict WHERE operation_uuid = ?').get(op.operationUuid)
    ).toEqual({ reason: 'stale_revision' });
  });

  test('canonical adapter preserves cycle validation for dependency operations', async () => {
    seedPlan();
    seedPlan(OTHER_PLAN_UUID, 2, TASK_UUID_2);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      OTHER_PLAN_UUID,
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical(OTHER_PLAN_UUID);
    const op = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, op)).toThrow(SyncValidationError);
  });

  test('atomic batch rolls back applied operations when a later operation conflicts', async () => {
    const seedColor = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, seedColor);
    const abbreviation = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'abbreviation', value: 'AB', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const staleColor = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'red', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 3 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
        originNodeId: NODE_A,
        atomic: true,
        operations: [abbreviation, staleColor],
      })
    );

    expect(result.status).toBe('conflict');
    expect(result.results.map((item) => item.status)).toEqual(['rejected', 'conflict']);
    expect(result.results[1].conflictId).toBeUndefined();
    expect(result.results[1].error?.message).toContain('Atomic batch aborted');
    expect(operationRows().slice(1)).toMatchObject([
      {
        operation_uuid: abbreviation.operationUuid,
        local_sequence: 2,
        status: 'rejected',
        attempts: 1,
      },
      {
        operation_uuid: staleColor.operationUuid,
        local_sequence: 3,
        status: 'rejected',
        attempts: 1,
      },
    ]);
    expect(operationRows()[2]!.last_error).toContain(
      'Atomic batch aborted: conflict diagnosed but not persisted'
    );
    expect(countRows('sync_conflict')).toBe(0);
    expect(
      db.prepare('SELECT value, revision FROM project_setting WHERE setting = ?').get('color')
    ).toEqual({
      value: '"blue"',
      revision: 1,
    });
    expect(
      db.prepare('SELECT value FROM project_setting WHERE setting = ?').get('abbreviation')
    ).toBeNull();
    expect(countRows('sync_sequence')).toBe(1);

    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
        originNodeId: NODE_A,
        atomic: true,
        operations: [abbreviation, staleColor],
      })
    );
    expect(replay.status).toBe('rejected');
    expect(replay.results.map((item) => item.status)).toEqual(['rejected', 'rejected']);
  });

  test('non-atomic batch still commits applied operations when a later operation conflicts', async () => {
    const seedColor = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, seedColor);
    const abbreviation = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'abbreviation', value: 'AB', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const staleColor = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'red', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 3 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
        originNodeId: NODE_A,
        operations: [abbreviation, staleColor],
      })
    );

    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'conflict']);
    expect(countRows('sync_conflict')).toBe(1);
    expect(db.prepare('SELECT value FROM project_setting WHERE setting = ?').get('color')).toEqual({
      value: '"blue"',
    });
    expect(
      db.prepare('SELECT value FROM project_setting WHERE setting = ?').get('abbreviation')
    ).toEqual({ value: '"AB"' });
  });

  test('atomic batch accepts multiple plan scalar ops with the same pre-batch baseRevision', async () => {
    seedPlan();
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const priority = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'priority', value: 'high', baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101',
        originNodeId: NODE_A,
        atomic: true,
        operations: [status, priority],
      })
    );

    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'applied']);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      revision: 3,
    });
  });

  test('atomic batch accepts set_scalar and set_parent with the same pre-batch baseRevision', async () => {
    seedPlan();
    seedPlan(OTHER_PLAN_UUID, 2, TASK_UUID_2);
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const parent = await setPlanParentOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        newParentUuid: OTHER_PLAN_UUID,
        previousParentUuid: null,
        baseRevision: 1,
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa102',
        originNodeId: NODE_A,
        atomic: true,
        operations: [status, parent],
      })
    );

    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'applied']);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      parent_uuid: OTHER_PLAN_UUID,
      revision: 3,
    });
    expect(
      getPlanDependenciesByUuid(db, OTHER_PLAN_UUID).map((row) => row.depends_on_uuid)
    ).toEqual([PLAN_UUID]);
  });

  test('non-atomic plan batch still conflicts on the second stale same-plan op', async () => {
    seedPlan();
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const priority = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'priority', value: 'high', baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa103',
        originNodeId: NODE_A,
        operations: [status, priority],
      })
    );

    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'conflict']);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      priority: null,
      revision: 2,
    });
    expect(countRows('sync_conflict')).toBe(1);
  });

  test('atomic batch with stale baseRevision predating the batch rolls back', async () => {
    seedPlan();
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const priority = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'priority', value: 'high', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa104',
        originNodeId: NODE_A,
        atomic: true,
        operations: [status, priority],
      })
    );

    expect(result.status).toBe('conflict');
    expect(result.results.map((item) => item.status)).toEqual(['conflict', 'rejected']);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'pending',
      priority: null,
      revision: 1,
    });
    expect(countRows('sync_conflict')).toBe(0);
  });

  test('atomic batch accepts two task text ops with the same pre-batch task baseRevision', async () => {
    seedPlan();
    const title = await updatePlanTaskTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        field: 'title',
        base: 'Task one',
        new: 'Renamed task',
        baseRevision: 1,
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const description = await updatePlanTaskTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        field: 'description',
        base: 'old description',
        new: 'new description',
        baseRevision: 1,
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa105',
        originNodeId: NODE_A,
        atomic: true,
        operations: [title, description],
      })
    );

    const task = getPlanTasksByUuid(db, PLAN_UUID)[0]!;
    expect(result.status).toBe('applied');
    expect(result.results.map((item) => item.status)).toEqual(['applied', 'applied']);
    expect(task).toMatchObject({
      title: 'Renamed task',
      description: 'new description',
      revision: 3,
    });
  });

  test('batch replay returns recorded results without applying twice', async () => {
    seedPlan();
    const firstTag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'one' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const secondTag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'two' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const batch = createBatchEnvelope({
      batchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      originNodeId: NODE_A,
      operations: [firstTag, secondTag],
    });

    const first = applyBatch(db, batch);
    const second = applyBatch(db, batch);

    expect(second).toEqual(first);
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((row) => row.tag)
        .sort()
    ).toEqual(['one', 'two']);
    expect(countRows('sync_sequence')).toBe(2);
  });

  test('batch enforces per-origin FIFO before committing any operation', async () => {
    const first = await createPlanOperation(
      { projectUuid: PROJECT_UUID, planUuid: PLAN_UUID, title: 'Late start' },
      { originNodeId: NODE_A, localSequence: 5 }
    );
    const second = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: NODE_A, localSequence: 6 }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        originNodeId: NODE_A,
        operations: [first, second],
      })
    );

    expect(result.status).toBe('deferred');
    expect(result.error).toBeInstanceOf(SyncFifoGapError);
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(countRows('sync_operation')).toBe(0);
  });

  test('atomic batch rejection persists FIFO floor so later operations can advance', async () => {
    seedPlan();
    const prior = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'prior' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    expect(applyOperation(db, prior).status).toBe('applied');
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sibling' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        originNodeId: NODE_A,
        localSequence: 3,
      }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
        originNodeId: NODE_A,
        atomic: true,
        operations: [invalidDependency, sibling],
      })
    );

    expect(result.status).toBe('rejected');
    expect(operationRows().map((row) => [row.local_sequence, row.status])).toEqual([
      [1, 'applied'],
      [2, 'rejected'],
      [3, 'rejected'],
    ]);
    expect(operationRows()[2]!.last_error).toBe(
      'Operation rolled back because its batch did not commit'
    );
    const next = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'next' },
      {
        operationUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        originNodeId: NODE_A,
        localSequence: 4,
      }
    );
    expect(applyOperation(db, next).status).toBe('applied');
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((row) => row.tag)
        .sort()
    ).toEqual(['next', 'prior']);
  });

  test('partial batch replay persists missing operation rejections so FIFO can advance', async () => {
    seedPlan();
    const first = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'first' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const missing = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'missing' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const batch = createBatchEnvelope({
      batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
      originNodeId: NODE_A,
      operations: [first, missing],
    });

    expect(applyBatch(db, batch).status).toBe('applied');
    db.prepare('DELETE FROM sync_operation WHERE operation_uuid = ?').run(missing.operationUuid);

    const replay = applyBatch(db, batch);

    expect(replay.status).toBe('rejected');
    expect(operationRows().map((row) => [row.local_sequence, row.status])).toEqual([
      [1, 'applied'],
      [2, 'rejected'],
    ]);
    expect(operationRows()[1]!.last_error).toBe(
      'Operation rolled back because its batch did not commit'
    );

    const next = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'next' },
      {
        operationUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        originNodeId: NODE_A,
        localSequence: 3,
      }
    );
    expect(applyOperation(db, next).status).toBe('applied');
  });

  test('batch rolls back via SyncValidationError catch path on duplicate-sequence collision and marks all results rejected', async () => {
    seedPlan();
    const applied = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'applied' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    expect(applyOperation(db, applied).status).toBe('applied');

    const duplicateSequence = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'duplicate' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sibling' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );

    const result = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        originNodeId: NODE_A,
        operations: [duplicateSequence, sibling],
      })
    );

    expect(result.status).toBe('rejected');
    expect(result.error).toBeInstanceOf(SyncValidationError);
    expect(result.results.map((item) => item.status)).toEqual(['rejected', 'rejected']);
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((row) => row.tag)
        .sort()
    ).toEqual(['applied']);
    expect(countRows('sync_operation')).toBe(2);
    expect(operationRows()).toMatchObject([
      {
        operation_uuid: applied.operationUuid,
        local_sequence: 1,
        status: 'applied',
      },
      {
        operation_uuid: sibling.operationUuid,
        local_sequence: 2,
        status: 'rejected',
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sync_operation
           WHERE operation_uuid IN (?, ?)`
        )
        .get(duplicateSequence.operationUuid, sibling.operationUuid)
    ).toMatchObject({ count: 1 });

    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        originNodeId: NODE_A,
        operations: [duplicateSequence, sibling],
      })
    );
    expect(replay.status).toBe('rejected');
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((row) => row.tag)
        .sort()
    ).toEqual(['applied']);
  });

  test('rolled-back batch persistence errors surface to caller', async () => {
    seedPlan();
    const cause = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'cause' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sibling' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const originalTransaction = db.transaction.bind(db);
    const persistError = new Error('persist failed');
    let transactionCalls = 0;
    const transactionSpy = vi.spyOn(db, 'transaction').mockImplementation(((fn: unknown) => {
      transactionCalls += 1;
      if (transactionCalls === 2) {
        return {
          immediate() {
            throw persistError;
          },
        };
      }
      return originalTransaction(fn as Parameters<typeof originalTransaction>[0]);
    }) as typeof db.transaction);
    setApplyBatchOperationHookForTesting((index) => {
      if (index !== 0) {
        return;
      }
      return {
        status: 'rejected',
        sequenceIds: [],
        invalidations: [],
        acknowledged: true,
        error: new SyncValidationError('synthetic rejection', {
          operationUuid: cause.operationUuid,
          issues: [],
        }),
      };
    });
    try {
      expect(() =>
        applyBatch(
          db,
          createBatchEnvelope({
            batchId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddf',
            originNodeId: NODE_A,
            operations: [cause, sibling],
          })
        )
      ).toThrow(persistError);
    } finally {
      setApplyBatchOperationHookForTesting(null);
      transactionSpy.mockRestore();
    }
  });

  test('batch rollback preserves non-validation cause error and chains sibling errors', async () => {
    seedPlan();
    const cause = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'cause' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sibling' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const originalError = new Error('synthetic non-validation rejection');

    setApplyBatchOperationHookForTesting((index) => {
      if (index !== 0) {
        return;
      }
      return {
        status: 'rejected',
        sequenceIds: [],
        invalidations: [],
        acknowledged: true,
        error: originalError,
      };
    });
    try {
      const result = applyBatch(
        db,
        createBatchEnvelope({
          batchId: 'dddddddd-dddd-4ddd-8ddd-ddddddddddde',
          originNodeId: NODE_A,
          operations: [cause, sibling],
        })
      );

      expect(result.status).toBe('rejected');
      expect(result.error).toBe(originalError);
      expect(result.results[0].error).toBe(originalError);
      expect(result.results[1].error).toBeInstanceOf(SyncValidationError);
      expect(result.results[1].error?.message).toBe(
        'Operation rolled back because its batch did not commit'
      );
      expect(result.results[1].error?.cause).toBe(originalError);
    } finally {
      setApplyBatchOperationHookForTesting(null);
    }
  });

  test('secondary catch path: SyncValidationError thrown from hook preserves cause error and chains siblings', async () => {
    seedPlan();
    const cause = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'cause' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sibling' },
      {
        operationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );
    const thrownError = new SyncValidationError('synthetic thrown validation error', {
      operationUuid: cause.operationUuid,
      issues: [],
    });

    // Hook THROWS (not returns) so the error escapes the transaction directly
    // and hits the secondary catch path (lines 215-236) rather than BatchAbort.
    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw thrownError;
      }
    });
    try {
      const result = applyBatch(
        db,
        createBatchEnvelope({
          batchId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
          originNodeId: NODE_A,
          operations: [cause, sibling],
        })
      );

      expect(result.status).toBe('rejected');
      expect(result.error).toBe(thrownError);
      // Cause's slot must retain the original thrown error, not a generic "rolled back" message.
      expect(result.results[0].error).toBe(thrownError);
      // Sibling's slot is a generic rollback error with .cause chained back to the original.
      expect(result.results[1].error).toBeInstanceOf(SyncValidationError);
      expect(result.results[1].error?.message).toBe(
        'Operation rolled back because its batch did not commit'
      );
      expect(result.results[1].error?.cause).toBe(thrownError);
      // No tags should have been applied.
      expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
    } finally {
      setApplyBatchOperationHookForTesting(null);
    }
  });

  test('secondary catch path: SyncFifoGapError thrown from hook produces deferred status', async () => {
    seedPlan();
    const cause = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'gap-cause' },
      {
        operationUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccf',
        originNodeId: NODE_A,
        localSequence: 5,
      }
    );
    const sibling = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'gap-sibling' },
      {
        operationUuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddf',
        originNodeId: NODE_A,
        localSequence: 6,
      }
    );
    const thrownGapError = new SyncFifoGapError('synthetic thrown gap error', {
      operationUuid: cause.operationUuid,
      originNodeId: NODE_A,
      localSequence: 5,
      expectedSequence: 1,
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw thrownGapError;
      }
    });
    try {
      const result = applyBatch(
        db,
        createBatchEnvelope({
          batchId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          originNodeId: NODE_A,
          operations: [cause, sibling],
        })
      );

      expect(result.status).toBe('deferred');
      expect(result.error).toBe(thrownGapError);
      expect(result.results[0].status).toBe('deferred');
      expect(result.results[0].error).toBe(thrownGapError);
      expect(result.results[1].status).toBe('deferred');
      expect(result.results[1].error?.cause).toBe(thrownGapError);
      expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
    } finally {
      setApplyBatchOperationHookForTesting(null);
    }
  });

  test('batch rejects duplicate operation UUIDs before applying', async () => {
    seedPlan();
    const first = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'one' },
      {
        operationUuid: '99999999-9999-4999-8999-999999999999',
        originNodeId: NODE_A,
        localSequence: 1,
      }
    );
    const second = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'two' },
      {
        operationUuid: first.operationUuid,
        originNodeId: NODE_A,
        localSequence: 2,
      }
    );

    expect(() =>
      applyBatch(db, {
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
        originNodeId: NODE_A,
        createdAt: new Date().toISOString(),
        operations: [first, second],
      })
    ).toThrow(SyncValidationError);
    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
    expect(countRows('sync_operation')).toBe(0);
  });

  test('plan.set_scalar cleans local assignment when status reaches cleanup state', async () => {
    seedPlan();
    seedAssignment();
    const op = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'done' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(getAssignment(db, project.id, PLAN_UUID)).toBeNull();
  });

  test('plan.set_scalar preserves local assignment for non-cleanup status transition', async () => {
    seedPlan();
    seedAssignment();
    const op = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(getAssignment(db, project.id, PLAN_UUID)).not.toBeNull();
  });

  test('plan.delete cleans local assignment for deleted plan', async () => {
    seedPlan();
    seedAssignment();
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(getAssignment(db, project.id, PLAN_UUID)).toBeNull();
  });

  test('plan.create with embedded tasks is atomic and idempotent', async () => {
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Offline plan',
        goal: 'Converge',
        tags: ['sync'],
        tasks: [{ taskUuid: TASK_UUID, title: 'Initial task', description: 'Do it' }],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const first = applyOperation(db, op);
    const second = applyOperation(db, op);

    expect(first.status).toBe('applied');
    expect(second).toEqual(first);
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM plan_task').get()).toMatchObject({ count: 1 });
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['sync']);
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.create preserves non-conflicting numericPlanId and advances project high-water mark', async () => {
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 42,
        title: 'Offline plan',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.resolvedNumericPlanId).toBe(42);
    expect(ackMetadata(op.operationUuid).resolvedNumericPlanId).toBe(42);
    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(42);
    expect(highestPlanId()).toBe(42);
  });

  test('plan.create renumbers a conflicting numericPlanId on the main node', async () => {
    db.prepare('UPDATE project SET highest_plan_id = 5 WHERE id = ?').run(project.id);
    seedPlan(OTHER_PLAN_UUID, 5, TASK_UUID_2);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 5,
        title: 'Renumbered plan',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.resolvedNumericPlanId).toBe(6);
    expect(ackMetadata(op.operationUuid).resolvedNumericPlanId).toBe(6);
    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(6);
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.plan_id).toBe(5);
    expect(highestPlanId()).toBe(6);
    expect(result.invalidations).toEqual([`plan:${PLAN_UUID}`]);
    expect(sequenceTargets()).toEqual([`plan:${PLAN_UUID}`]);
    expect(logSpy).toHaveBeenCalledWith(`[sync] plan.create renumbered ${PLAN_UUID} from 5 to 6`);
    logSpy.mockRestore();

    const persistentDb = new Database(':memory:');
    runMigrations(persistentDb);
    const persistentProject = getOrCreateProject(persistentDb, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      highestPlanId: 5,
    });
    upsertPlan(persistentDb, persistentProject.id, {
      uuid: PLAN_UUID,
      planId: 5,
      title: 'Renumbered plan',
      status: 'pending',
      forceOverwrite: true,
    });
    // Before canonical refresh: persistent node still has the offline-selected plan_id
    expect(getPlanByUuid(persistentDb, PLAN_UUID)?.plan_id).toBe(5);

    const snapshot = loadCanonicalSnapshot(db, `plan:${PLAN_UUID}`);
    if (!snapshot) {
      throw new Error('Expected canonical snapshot for renumbered plan');
    }

    mergeCanonicalRefresh(persistentDb, snapshot);

    // After canonical refresh: persistent node reflects the main-node renumbered plan_id
    expect(getPlanByUuid(persistentDb, PLAN_UUID)?.plan_id).toBe(6);
  });

  test('plan.create idempotent replay keeps the renumbered numericPlanId', async () => {
    db.prepare('UPDATE project SET highest_plan_id = 5 WHERE id = ?').run(project.id);
    seedPlan(OTHER_PLAN_UUID, 5);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 5,
        title: 'Replay plan',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const first = applyOperation(db, op);
    const second = applyOperation(db, op);

    expect(first.status).toBe('applied');
    expect(second).toEqual(first);
    expect(second.resolvedNumericPlanId).toBe(6);
    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(6);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM plan WHERE uuid = ?').get(PLAN_UUID) as {
        count: number;
      }
    ).toMatchObject({ count: 1 });
    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  test('plan.create renumbers when requested ID equals project.highest_plan_id without an existing row', async () => {
    // reserveNextPlanId on the main node bumps highest_plan_id to 10 but the
    // local insert has not happened yet. An incoming plan.create requesting
    // exactly 10 must NOT be preserved or it will collide with the pending
    // local insert.
    db.prepare('UPDATE project SET highest_plan_id = 10 WHERE id = ?').run(project.id);

    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 10,
        title: 'Renumbered against high-water reservation',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.resolvedNumericPlanId).toBe(11);
    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(11);
    expect(highestPlanId()).toBe(11);
  });

  test('plan.create renumber honors project.highest_plan_id ahead of MAX(plan_id)', async () => {
    // Simulate a CLI command that called reserveNextPlanId (advancing
    // highest_plan_id) but has not yet inserted its plan row. A conflicting
    // sync plan.create must not pick the same reserved ID.
    seedPlan(OTHER_PLAN_UUID, 5);
    db.prepare('UPDATE project SET highest_plan_id = 10 WHERE id = ?').run(project.id);

    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 5,
        title: 'Renumbered above highest',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.resolvedNumericPlanId).toBe(11);
    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(11);
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.plan_id).toBe(5);
    expect(highestPlanId()).toBe(11);
  });

  test('plan.create with parentUuid sequences and invalidates both child and parent', async () => {
    seedPlan(OTHER_PLAN_UUID, 2);
    const parentBefore = getPlanByUuid(db, OTHER_PLAN_UUID)?.revision;
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Child plan',
        parentUuid: OTHER_PLAN_UUID,
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.invalidations.sort()).toEqual(
      [`plan:${OTHER_PLAN_UUID}`, `plan:${PLAN_UUID}`].sort()
    );
    expect(sequenceTargets().sort()).toEqual(
      [`plan:${OTHER_PLAN_UUID}`, `plan:${PLAN_UUID}`].sort()
    );
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(1);
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.revision).toBe((parentBefore ?? 0) + 1);
    expect(
      db
        .prepare(
          'SELECT COUNT(*) AS count FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?'
        )
        .get(OTHER_PLAN_UUID, PLAN_UUID)
    ).toEqual({ count: 1 });
  });

  test('plan.create ignores projection-only parent dependency edge during canonical apply', async () => {
    seedPlan(OTHER_PLAN_UUID, 2);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      OTHER_PLAN_UUID,
      PLAN_UUID
    );
    const parentBefore = getPlanByUuid(db, OTHER_PLAN_UUID)?.revision;
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Child plan',
        parentUuid: OTHER_PLAN_UUID,
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.invalidations.sort()).toEqual(
      [`plan:${OTHER_PLAN_UUID}`, `plan:${PLAN_UUID}`].sort()
    );
    expect(sequenceTargets().sort()).toEqual(
      [`plan:${OTHER_PLAN_UUID}`, `plan:${PLAN_UUID}`].sort()
    );
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.revision).toBe((parentBefore ?? 0) + 1);
  });

  test('FIFO gap defers later operations from the same node', async () => {
    seedPlan();
    const later = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'later' },
      { originNodeId: NODE_A, localSequence: 3 }
    );

    expect(() => applyOperation(db, later)).toThrow(SyncFifoGapError);
    expect(
      db
        .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
        .get(later.operationUuid)
    ).toMatchObject({
      status: 'received',
    });
  });

  test('rejects op with localSequence below the highest seen for origin', async () => {
    seedPlan();
    const higher = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'higher' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, higher);
    const before = canonicalCounts();

    const late = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'late' },
      { originNodeId: NODE_A, localSequence: 0 }
    );

    expect(() => applyOperation(db, late)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual(before);
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['higher']);
  });

  test('rejects late seq when gap was already filled', async () => {
    seedPlan();
    for (const [sequence, tag] of [
      [0, 'zero'],
      [1, 'one'],
      [2, 'two'],
    ] as const) {
      const op = await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag },
        { originNodeId: NODE_A, localSequence: sequence }
      );
      applyOperation(db, op);
    }
    const before = canonicalCounts();
    const late = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'late-one' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, late)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual(before);
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((tag) => tag.tag)
        .sort()
    ).toEqual(['one', 'two', 'zero']);
  });

  test('operations from different nodes apply in arrival order', async () => {
    seedPlan();
    const opA = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'a' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const opB = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'b' },
      { originNodeId: NODE_B, localSequence: 1 }
    );

    applyOperation(db, opB);
    applyOperation(db, opA);

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['a', 'b']);
    expect(db.prepare('SELECT origin_node_id FROM sync_sequence ORDER BY sequence').all()).toEqual([
      { origin_node_id: NODE_B },
      { origin_node_id: NODE_A },
    ]);
  });

  test('set-like operations with stale baseRevision conflict and no-op replay does not add sequence', async () => {
    seedPlan();
    const statusOp = await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const tagOp = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    applyOperation(db, statusOp);
    applyOperation(db, tagOp);
    applyOperation(db, tagOp);

    expect(getPlanByUuid(db, PLAN_UUID)?.status).toBe('pending');
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('unknown project and unknown non-create plan reject with SyncValidationError', async () => {
    const unknownProject = await addPlanTagOperation(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    expect(() => applyOperation(db, unknownProject)).toThrow(SyncValidationError);

    const unknownPlan = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    expect(() => applyOperation(db, unknownPlan)).toThrow(SyncValidationError);
  });

  test('text patch applies directly and cleanly merges non-overlapping current edits', async () => {
    seedPlan();
    const direct = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\nBETA\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, direct);

    db.prepare(
      "UPDATE plan SET details = details || 'delta\n', revision = revision + 1 WHERE uuid = ?"
    ).run(PLAN_UUID);
    mirrorProjectionPlanToCanonical();
    const clean = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nBETA\ngamma\n',
        new: 'ALPHA\nBETA\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    applyOperation(db, clean);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('ALPHA\nBETA\ngamma\ndelta\n');
  });

  test('pure insertion merges over concurrent append', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'A\nC\nD\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'A\nC\n',
        new: 'A\nB\nC\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('A\nB\nC\nD\n');
  });

  test('pure insertion merges over concurrent prefix-prepend', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'Z\nA\nC\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'A\nC\n',
        new: 'A\nB\nC\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('Z\nA\nB\nC\n');
  });

  test('deletion merges over concurrent independent edit', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'alpha\nbeta\ngamma\ndelta\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('alpha\ngamma\ndelta\n');
  });

  test('vacuous text patch is a no-op over concurrent edits', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main changed\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const beforeRevision = getPlanByUuid(db, PLAN_UUID)?.revision;
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\nbeta\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('main changed\n');
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(beforeRevision);
    expect(countRows('sync_sequence')).toBe(0);
  });

  test('purely additive appended divergence merges when context is independent', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'A\ncurrent tail\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'A\n',
        new: 'A\nincoming tail\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('A\nincoming tail\ncurrent tail\n');
  });

  test('unmergeable text patch records conflict without overwriting target field', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'alpha\nmain edit\ngamma\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\nremote edit\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);
    const conflict = db.prepare('SELECT * FROM sync_conflict').get() as Record<string, unknown>;

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    expect(conflict.reason).toBe('text_merge_failed');
    expect(conflict.base_value).toBe('alpha\nbeta\ngamma\n');
    expect(conflict.incoming_value).toBe('alpha\nremote edit\ngamma\n');
    expect(conflict.current_value).toBe('alpha\nmain edit\ngamma\n');
    expect(JSON.parse(conflict.normalized_payload as string)).toMatchObject({
      type: 'plan.patch_text',
    });
    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('alpha\nmain edit\ngamma\n');
    expect(countRows('sync_sequence')).toBe(0);
  });

  test('rejected plan.create leaves no canonical rows for unknown parent or dependency', async () => {
    const unknownParent = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Invalid parent',
        parentUuid: OTHER_PLAN_UUID,
        tags: ['should-not-write'],
        tasks: [{ taskUuid: TASK_UUID, title: 'Should not write' }],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, unknownParent)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual({
      plan: 0,
      planTask: 0,
      planTag: 0,
      planDependency: 0,
      syncSequence: 0,
    });

    const unknownDependency = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: OTHER_PLAN_UUID,
        numericPlanId: 21,
        title: 'Invalid dependency',
        dependencies: [THIRD_PLAN_UUID],
        tags: ['should-not-write'],
        tasks: [{ taskUuid: TASK_UUID_2, title: 'Should not write' }],
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    expect(() => applyOperation(db, unknownDependency)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual({
      plan: 0,
      planTask: 0,
      planTag: 0,
      planDependency: 0,
      syncSequence: 0,
    });
  });

  test('rejected plan.create leaves no new canonical rows for cyclic parent dependency', async () => {
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Parent',
      status: 'pending',
      forceOverwrite: true,
    });
    const before = canonicalCounts();
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Cyclic child',
        parentUuid: OTHER_PLAN_UUID,
        dependencies: [OTHER_PLAN_UUID],
        tags: ['should-not-write'],
        tasks: [{ taskUuid: TASK_UUID, title: 'Should not write' }],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, op)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual(before);
  });

  test('plan.create with duplicate task UUIDs rejects with SyncValidationError and writes no canonical state', async () => {
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Duplicate tasks',
        tasks: [
          { taskUuid: TASK_UUID, title: 'Task one' },
          { taskUuid: TASK_UUID, title: 'Task two' },
        ],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, op)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual({
      plan: 0,
      planTask: 0,
      planTag: 0,
      planDependency: 0,
      syncSequence: 0,
    });
  });

  test('delete records tombstones and recoverable tombstoned edits become accepted conflicts', async () => {
    seedPlan();
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);
    const edit = await patchPlanTextOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field: 'details', base: 'old', new: 'new' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const result = applyOperation(db, edit);

    expect(result.status).toBe('conflict');
    expect(
      db.prepare('SELECT * FROM sync_tombstone WHERE entity_type = ?').all('plan')
    ).toMatchObject([
      {
        entity_key: `plan:${PLAN_UUID}`,
        deletion_operation_uuid: del.operationUuid,
        deleted_revision: 2,
        origin_node_id: NODE_A,
      },
    ]);
    expect(db.prepare('SELECT reason FROM sync_conflict').get()).toEqual({
      reason: 'tombstoned_target',
    });
  });

  test('plan.add_task against a tombstoned owning plan creates a sync_conflict', async () => {
    seedPlan();
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);
    const add = await addPlanTaskOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID_2,
        title: 'Recovered task',
        description: 'work done offline',
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyOperation(db, add);

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    expect(result.conflictId).toBeTruthy();
    // Canonical state untouched: plan stays deleted, no new task row.
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM plan_task WHERE uuid = ?').get(TASK_UUID_2)
    ).toMatchObject({ count: 0 });
    const conflict = db.prepare('SELECT reason, original_payload FROM sync_conflict').get() as {
      reason: string;
      original_payload: string;
    };
    expect(conflict.reason).toBe('tombstoned_target');
    // Full incoming payload preserved so resolution tooling can replay the addition.
    const parsed = JSON.parse(conflict.original_payload) as {
      type: string;
      taskUuid: string;
      title: string;
      description: string;
      planUuid: string;
    };
    expect(parsed).toMatchObject({
      type: 'plan.add_task',
      taskUuid: TASK_UUID_2,
      title: 'Recovered task',
      description: 'work done offline',
      planUuid: PLAN_UUID,
    });
  });

  test('plan.create clears a plan tombstone so task ops can apply after resurrect', async () => {
    seedPlan();
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);

    const resurrect = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 30,
        title: 'Resurrected plan',
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    expect(applyOperation(db, resurrect).status).toBe('applied');
    expect(
      db
        .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
        .get('plan', `plan:${PLAN_UUID}`)
    ).toBeNull();

    const add = await addPlanTaskOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID_2,
        title: 'Task after resurrect',
        description: '',
      },
      { originNodeId: NODE_A, localSequence: 3 }
    );
    const result = applyOperation(db, add);

    expect(result.status).toBe('applied');
    expect(result.conflictId).toBeUndefined();
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).toContain(TASK_UUID_2);
    expect(countRows('sync_conflict')).toBe(0);
  });

  test('plan.update_task_text against a task whose owning plan is tombstoned creates a sync_conflict', async () => {
    seedPlan();
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);
    const edit = await updatePlanTaskTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        field: 'description',
        base: 'old description',
        new: 'updated description',
      },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyOperation(db, edit);

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    const conflict = db.prepare('SELECT reason, original_payload FROM sync_conflict').get() as {
      reason: string;
      original_payload: string;
    };
    expect(conflict.reason).toBe('tombstoned_target');
    expect(JSON.parse(conflict.original_payload)).toMatchObject({
      type: 'plan.update_task_text',
      taskUuid: TASK_UUID,
      planUuid: PLAN_UUID,
      new: 'updated description',
    });
  });

  test('plan.mark_task_done against a task whose owning plan is tombstoned creates a sync_conflict', async () => {
    seedPlan();
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);
    const op = await markPlanTaskDoneOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    const conflict = db.prepare('SELECT reason, original_payload FROM sync_conflict').get() as {
      reason: string;
      original_payload: string;
    };
    expect(conflict.reason).toBe('tombstoned_target');
    expect(JSON.parse(conflict.original_payload)).toMatchObject({
      type: 'plan.mark_task_done',
      taskUuid: TASK_UUID,
      planUuid: PLAN_UUID,
      done: true,
    });
  });

  test('graph operation targeting tombstoned plan rejects', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Other',
      status: 'pending',
      forceOverwrite: true,
    });
    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);
    const dep = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    expect(() => applyOperation(db, dep)).toThrow(SyncValidationError);
  });

  test('plan.mark_task_done applies, bumps plan revision, and is idempotent by UUID', async () => {
    seedPlan();
    const op = await markPlanTaskDoneOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const first = applyOperation(db, op);
    const planRevAfterFirst = (
      db.prepare('SELECT revision FROM plan WHERE uuid = ?').get(PLAN_UUID) as { revision: number }
    ).revision;
    const second = applyOperation(db, op); // replay

    expect(first.status).toBe('applied');
    expect(second).toEqual(first); // same idempotent result
    const task = db
      .prepare('SELECT done, revision FROM plan_task WHERE uuid = ?')
      .get(TASK_UUID) as { done: number; revision: number };
    expect(task.done).toBe(1);
    // Replay must not bump revisions
    const planRevAfterSecond = (
      db.prepare('SELECT revision FROM plan WHERE uuid = ?').get(PLAN_UUID) as { revision: number }
    ).revision;
    expect(planRevAfterSecond).toBe(planRevAfterFirst);
    // mark_task_done produces 2 mutations (task + plan bump), so 2 sequence entries
    expect(countRows('sync_sequence')).toBe(2);
  });

  test('plan.add_task is idempotent by task UUID', async () => {
    seedPlan();
    const op = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID_2, title: 'New task', description: 'details' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);
    applyOperation(db, op); // replay

    expect(db.prepare('SELECT COUNT(*) AS count FROM plan_task').get()).toMatchObject({ count: 2 });
    // add_task produces 2 mutations (plan bump + task), so 2 sequence entries; replay adds none
    expect(countRows('sync_sequence')).toBe(2);
  });

  test('plan.add_task inserts at the beginning without task_index collisions', async () => {
    seedPlan();
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_3, PLAN_UUID, 1, 'Second task', '');
    mirrorProjectionPlanToCanonical();
    const op = await addPlanTaskOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID_2,
        taskIndex: 0,
        title: 'Inserted first',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => [task.uuid, task.task_index])).toEqual([
      [TASK_UUID_2, 0],
      [TASK_UUID, 1],
      [TASK_UUID_3, 2],
    ]);
  });

  test('plan.add_task inserts in the middle without task_index collisions', async () => {
    seedPlan();
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_2, PLAN_UUID, 1, 'Second task', '');
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_3, PLAN_UUID, 2, 'Third task', '');
    mirrorProjectionPlanToCanonical();
    const op = await addPlanTaskOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID_4,
        taskIndex: 1,
        title: 'Inserted middle',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => [task.uuid, task.task_index])).toEqual([
      [TASK_UUID, 0],
      [TASK_UUID_4, 1],
      [TASK_UUID_2, 2],
      [TASK_UUID_3, 3],
    ]);
  });

  test('plan.remove_tag is idempotent', async () => {
    seedPlan();
    db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(
      PLAN_UUID,
      'old-tag'
    );
    mirrorProjectionPlanToCanonical();

    const op = await removePlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'old-tag' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, op);
    applyOperation(db, op); // replay

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).not.toContain('old-tag');
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.remove_dependency applies and is idempotent', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Other',
      status: 'pending',
      forceOverwrite: true,
    });
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      PLAN_UUID,
      OTHER_PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();

    const op = await removePlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, op);
    applyOperation(db, op); // replay

    const row = db
      .prepare('SELECT * FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .get(PLAN_UUID, OTHER_PLAN_UUID);
    expect(row).toBeNull();
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.remove_list_item removes an existing item and is idempotent', async () => {
    seedPlan();
    const issue = { severity: 'minor' as const, category: 'style', content: 'Lint error' };
    db.prepare('UPDATE plan SET review_issues = ? WHERE uuid = ?').run(
      JSON.stringify([issue]),
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();

    const op = await removePlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'reviewIssues', value: issue },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, op);
    applyOperation(db, op); // replay

    const plan = getPlanByUuid(db, PLAN_UUID);
    expect(JSON.parse(plan?.review_issues ?? 'null')).toBeNull();
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.add_list_item allows duplicate primitive values', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET issue = ? WHERE uuid = ?').run(
      JSON.stringify(['https://example.com/1']),
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();

    const op = await addPlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'issue', value: 'https://example.com/1' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)?.issue ?? '[]')).toEqual([
      'https://example.com/1',
      'https://example.com/1',
    ]);
  });

  test('plan.remove_list_item removes one duplicate primitive occurrence', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET issue = ? WHERE uuid = ?').run(
      JSON.stringify(['https://example.com/1', 'https://example.com/1']),
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();

    const op = await removePlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'issue', value: 'https://example.com/1' },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)?.issue ?? '[]')).toEqual([
      'https://example.com/1',
    ]);
  });

  test('plan.add_list_item does not duplicate an existing logical item', async () => {
    seedPlan();
    const issue = { severity: 'minor' as const, category: 'style', content: 'Lint error' };
    const first = await addPlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'reviewIssues', value: issue },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const second = await addPlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'reviewIssues', value: issue },
      { originNodeId: NODE_A, localSequence: 2 }
    );

    applyOperation(db, first);
    applyOperation(db, second);
    applyOperation(db, second); // replay

    const plan = getPlanByUuid(db, PLAN_UUID);
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([issue]);
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.add_list_item compares object values with canonical key ordering', async () => {
    seedPlan();
    const existingIssue = { content: 'Fix this', category: 'bug', severity: 'major' };
    db.prepare('UPDATE plan SET review_issues = ? WHERE uuid = ?').run(
      JSON.stringify([existingIssue]),
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const op = await addPlanListItemOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        list: 'reviewIssues',
        value: { severity: 'major', category: 'bug', content: 'Fix this' },
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)?.review_issues ?? '[]')).toEqual([
      existingIssue,
    ]);
    expect(countRows('sync_sequence')).toBe(0);
  });

  test('plan.remove_list_item matches stored item using canonical key ordering', async () => {
    seedPlan();
    const storedIssue = { content: 'Fix this', category: 'bug', severity: 'major' as const };
    db.prepare('UPDATE plan SET review_issues = ? WHERE uuid = ?').run(
      JSON.stringify([storedIssue]),
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();

    const op = await removePlanListItemOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        list: 'reviewIssues',
        value: { severity: 'major' as const, category: 'bug', content: 'Fix this' },
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)?.review_issues ?? 'null')).toBeNull();
    expect(countRows('sync_sequence')).toBe(1);
  });

  test('plan.update_task_text merges cleanly', async () => {
    seedPlan();
    const op = await updatePlanTaskTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        field: 'description',
        base: 'old description',
        new: 'new description',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const result = applyOperation(db, op);
    const task = db.prepare('SELECT description FROM plan_task WHERE uuid = ?').get(TASK_UUID) as {
      description: string;
    };

    expect(result.status).toBe('applied');
    expect(task.description).toBe('new description');
  });

  test('plan.update_task_text unmergeable conflict records sync_conflict and acks op', async () => {
    seedPlan();
    // Simulate a main-node edit to task description
    db.prepare('UPDATE plan_task SET description = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main-node edit',
      TASK_UUID
    );
    db.prepare(
      'UPDATE task_canonical SET description = ?, revision = revision + 1 WHERE uuid = ?'
    ).run('main-node edit', TASK_UUID);

    const op = await updatePlanTaskTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        field: 'description',
        base: 'old description',
        new: 'remote edit',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const result = applyOperation(db, op);
    const conflict = db.prepare('SELECT * FROM sync_conflict').get() as Record<string, unknown>;
    const task = db.prepare('SELECT description FROM plan_task WHERE uuid = ?').get(TASK_UUID) as {
      description: string;
    };

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    expect(conflict.reason).toBe('text_merge_failed');
    expect(conflict.field_path).toBe('description');
    expect(task.description).toBe('main-node edit'); // not overwritten
    expect(countRows('sync_sequence')).toBe(0); // no canonical change
  });

  test('resolving a plan text conflict writes canonical and projection rows', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main-node edit',
      PLAN_UUID
    );
    db.prepare('UPDATE plan_canonical SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main-node edit',
      PLAN_UUID
    );
    const op = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'incoming edit',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);
    const conflict = db.prepare('SELECT conflict_id FROM sync_conflict').get() as {
      conflict_id: string;
    };
    const resolved = resolveSyncConflict(db, conflict.conflict_id, {
      mode: 'manual',
      manualValue: 'resolved text',
      resolvedByNode: NODE_B,
    });

    expect(result.status).toBe('conflict');
    expect(resolved.status).toBe('resolved_applied');
    expect(db.prepare('SELECT details FROM plan WHERE uuid = ?').get(PLAN_UUID)).toEqual({
      details: 'resolved text',
    });
    expect(db.prepare('SELECT details FROM plan_canonical WHERE uuid = ?').get(PLAN_UUID)).toEqual({
      details: 'resolved text',
    });
  });

  test('plan.set_parent updates parent_uuid and dependency edges', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Parent plan',
      status: 'pending',
      forceOverwrite: true,
    });

    const op = await setPlanParentOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, newParentUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const result = applyOperation(db, op);

    const child = db.prepare('SELECT parent_uuid FROM plan WHERE uuid = ?').get(PLAN_UUID) as {
      parent_uuid: string | null;
    };
    const dep = db
      .prepare('SELECT * FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .get(OTHER_PLAN_UUID, PLAN_UUID);

    expect(result.status).toBe('applied');
    expect(child.parent_uuid).toBe(OTHER_PLAN_UUID);
    expect(dep).not.toBeNull();
  });

  test('plan.create with parent also listed in dependencies rejects cyclically', async () => {
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Parent',
      status: 'pending',
      forceOverwrite: true,
    });
    const before = canonicalCounts();
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 20,
        title: 'Cyclic child',
        parentUuid: OTHER_PLAN_UUID,
        dependencies: [OTHER_PLAN_UUID],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, op)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual(before);
  });

  test('set_parent rejects when child already depends on the new parent via plan_dependency', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Parent plan',
      status: 'pending',
      forceOverwrite: true,
    });
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      PLAN_UUID,
      OTHER_PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const before = canonicalCounts();

    const op = await setPlanParentOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, newParentUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() => applyOperation(db, op)).toThrow(SyncValidationError);
    expect(canonicalCounts()).toEqual(before);
    expect(getPlanByUuid(db, PLAN_UUID)?.parent_uuid).toBeNull();
  });

  test('plan.set_parent removes old parent dependency when changing parent', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Old parent',
      status: 'pending',
      forceOverwrite: true,
    });
    seedPlanRow({
      uuid: THIRD_PLAN_UUID,
      planId: 3,
      title: 'New parent',
      status: 'pending',
      forceOverwrite: true,
    });

    // Set initial parent
    const setOld = await setPlanParentOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, newParentUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, setOld);

    // Change to new parent
    const setNew = await setPlanParentOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, newParentUuid: THIRD_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    applyOperation(db, setNew);

    const oldDep = db
      .prepare('SELECT * FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .get(OTHER_PLAN_UUID, PLAN_UUID);
    const newDep = db
      .prepare('SELECT * FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .get(THIRD_PLAN_UUID, PLAN_UUID);
    const child = db.prepare('SELECT parent_uuid FROM plan WHERE uuid = ?').get(PLAN_UUID) as {
      parent_uuid: string;
    };

    expect(oldDep).toBeNull();
    expect(newDep).not.toBeNull();
    expect(child.parent_uuid).toBe(THIRD_PLAN_UUID);
  });

  test('plan.add_dependency cycle detection rejects circular deps', async () => {
    seedPlan();
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Other',
      status: 'pending',
      forceOverwrite: true,
    });

    // PLAN depends on OTHER
    const dep1 = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, dep1);

    // Now try OTHER depends on PLAN (creates cycle)
    const cycleDep = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: OTHER_PLAN_UUID, dependsOnPlanUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    expect(() => applyOperation(db, cycleDep)).toThrow(SyncValidationError);
  });

  test('plan.promote_task creates new plan and marks source task done', async () => {
    seedPlan();
    const NEW_PLAN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';

    const op = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid: NEW_PLAN_UUID,
        numericPlanId: 42,
        title: 'Promoted plan',
        description: 'Promoted from task',
        tags: [],
        dependencies: [],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    const newPlan = getPlanByUuid(db, NEW_PLAN_UUID);
    expect(newPlan).not.toBeNull();
    expect(newPlan?.title).toBe('Promoted plan');
    const task = db.prepare('SELECT done FROM plan_task WHERE uuid = ?').get(TASK_UUID) as {
      done: number;
    };
    expect(task.done).toBe(1);
  });

  test('plan.promote_task renumbers a conflicting numericPlanId through plan.create', async () => {
    db.prepare('UPDATE project SET highest_plan_id = 5 WHERE id = ?').run(project.id);
    seedPlan(PLAN_UUID, 1);
    seedPlan(OTHER_PLAN_UUID, 5, TASK_UUID_2);
    const NEW_PLAN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003';
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const op = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid: NEW_PLAN_UUID,
        numericPlanId: 5,
        title: 'Promoted plan',
        description: 'Promoted from task',
        tags: [],
        dependencies: [],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.resolvedNumericPlanId).toBe(6);
    expect(ackMetadata(op.operationUuid).resolvedNumericPlanId).toBe(6);
    expect(getPlanByUuid(db, NEW_PLAN_UUID)?.plan_id).toBe(6);
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.plan_id).toBe(5);
    expect(logSpy).toHaveBeenCalledWith(
      `[sync] plan.promote_task renumbered ${NEW_PLAN_UUID} from 5 to 6`
    );
    logSpy.mockRestore();
  });

  test('plan.promote_task is idempotent when new plan already exists', async () => {
    seedPlan();
    const NEW_PLAN_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002';

    const op = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid: NEW_PLAN_UUID,
        numericPlanId: 43,
        title: 'Promoted plan',
        description: 'From task',
        tags: [],
        dependencies: [],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, op);
    const second = applyOperation(db, op); // replay

    expect(second).toEqual(applyOperation(db, op));
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM plan WHERE uuid = ?').get(NEW_PLAN_UUID) as {
        count: number;
      }
    ).toMatchObject({ count: 1 });
  });

  test('project_setting.delete applies and is idempotent', async () => {
    // First set the setting
    const setOp = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, setOp);

    // Delete it
    const delOp = await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const result = applyOperation(db, delOp);
    applyOperation(db, delOp); // replay - should be no-op

    expect(result.status).toBe('applied');
    const row = db.prepare('SELECT * FROM project_setting WHERE setting = ?').get('color');
    expect(row).toBeNull();
    expect(countRows('sync_sequence')).toBe(2); // set + delete, no extra for replay
  });

  test('project_setting.delete with stale baseRevision conflicts', async () => {
    const setOp = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, setOp);
    // Advance the revision
    db.prepare('UPDATE project_setting SET revision = revision + 1 WHERE setting = ?').run('color');

    const delOp = await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const result = applyOperation(db, delOp);

    expect(result.status).toBe('conflict');
    expect(result.acknowledged).toBe(true);
    const row = db.prepare('SELECT * FROM project_setting WHERE setting = ?').get('color');
    expect(row).not.toBeNull(); // not deleted
  });

  test('task tombstones are recorded for each task when a plan is deleted', async () => {
    seedPlan(); // seeds 1 task with TASK_UUID
    // Add a second task
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_2, PLAN_UUID, 1, 'Second task', '');
    mirrorProjectionPlanToCanonical();

    const del = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, del);

    const tombstones = db
      .prepare('SELECT entity_type, entity_key FROM sync_tombstone ORDER BY entity_key')
      .all() as Array<{ entity_type: string; entity_key: string }>;

    expect(tombstones).toHaveLength(3); // 1 plan + 2 tasks
    const planTombstone = tombstones.find((t) => t.entity_type === 'plan');
    const taskTombstones = tombstones.filter((t) => t.entity_type === 'task');
    expect(planTombstone?.entity_key).toBe(`plan:${PLAN_UUID}`);
    expect(taskTombstones.map((t) => t.entity_key).sort()).toEqual(
      [`task:${TASK_UUID}`, `task:${TASK_UUID_2}`].sort()
    );
  });

  test('plan.delete bumps and sequences every surviving dependent plan', async () => {
    seedPlan(PLAN_UUID, 1);
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Dependent one',
      status: 'pending',
      forceOverwrite: true,
    });
    seedPlanRow({
      uuid: THIRD_PLAN_UUID,
      planId: 3,
      title: 'Dependent two',
      status: 'pending',
      forceOverwrite: true,
    });
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      OTHER_PLAN_UUID,
      PLAN_UUID
    );
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      THIRD_PLAN_UUID,
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical(OTHER_PLAN_UUID);
    mirrorProjectionPlanToCanonical(THIRD_PLAN_UUID);
    const otherBefore = getPlanByUuid(db, OTHER_PLAN_UUID)?.revision;
    const thirdBefore = getPlanByUuid(db, THIRD_PLAN_UUID)?.revision;
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.status).toBe('applied');
    expect(result.invalidations.sort()).toEqual(
      [
        `plan:${OTHER_PLAN_UUID}`,
        `plan:${PLAN_UUID}`,
        `plan:${THIRD_PLAN_UUID}`,
        `task:${TASK_UUID}`,
      ].sort()
    );
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.revision).toBe((otherBefore ?? 0) + 1);
    expect(getPlanByUuid(db, THIRD_PLAN_UUID)?.revision).toBe((thirdBefore ?? 0) + 1);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM plan_dependency WHERE depends_on_uuid = ?')
        .get(PLAN_UUID)
    ).toEqual({ count: 0 });
    expect(sequenceTargets().sort()).toEqual(result.invalidations.sort());
  });

  test('plan.delete emits sequence rows for the deleted plan and each deleted task tombstone', async () => {
    seedPlan();
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_2, PLAN_UUID, 1, 'Second task', '');
    mirrorProjectionPlanToCanonical();
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    applyOperation(db, op);

    expect(sequenceTargets().sort()).toEqual(
      [`plan:${PLAN_UUID}`, `task:${TASK_UUID}`, `task:${TASK_UUID_2}`].sort()
    );
    expect(
      db
        .prepare('SELECT target_type, target_key, revision FROM sync_sequence ORDER BY target_key')
        .all()
    ).toEqual([
      { target_type: 'plan', target_key: `plan:${PLAN_UUID}`, revision: 2 },
      { target_type: 'task', target_key: `task:${TASK_UUID}`, revision: 2 },
      { target_type: 'task', target_key: `task:${TASK_UUID_2}`, revision: 2 },
    ]);
  });

  test('plan.delete is idempotent on replay without resequencing dependents', async () => {
    seedPlan(PLAN_UUID, 1);
    seedPlanRow({
      uuid: OTHER_PLAN_UUID,
      planId: 2,
      title: 'Dependent one',
      status: 'pending',
      forceOverwrite: true,
    });
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      OTHER_PLAN_UUID,
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical(OTHER_PLAN_UUID);
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const first = applyOperation(db, op);
    const revisionAfterFirst = getPlanByUuid(db, OTHER_PLAN_UUID)?.revision;
    const second = applyOperation(db, op);

    expect(second).toEqual(first);
    expect(countRows('sync_sequence')).toBe(3); // deleted plan + task tombstone + dependent
    expect(getPlanByUuid(db, OTHER_PLAN_UUID)?.revision).toBe(revisionAfterFirst);
  });

  test('plan.delete with no dependents emits only deleted plan and task tombstone sequences', async () => {
    seedPlan();
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const result = applyOperation(db, op);

    expect(result.invalidations.sort()).toEqual([`plan:${PLAN_UUID}`, `task:${TASK_UUID}`].sort());
    expect(sequenceTargets().sort()).toEqual([`plan:${PLAN_UUID}`, `task:${TASK_UUID}`].sort());
  });

  test('FIFO gap: re-submitting a deferred op succeeds after gap is filled', async () => {
    seedPlan();

    // Op with localSequence=2 arrives before localSequence=1
    const opSeq2 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'second' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    expect(() => applyOperation(db, opSeq2)).toThrow(SyncFifoGapError);
    // op is stored as 'received'
    expect(
      db
        .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
        .get(opSeq2.operationUuid)
    ).toMatchObject({ status: 'received' });

    // Now send the missing sequence=1 op
    const opSeq1 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'first' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const res1 = applyOperation(db, opSeq1);
    expect(res1.status).toBe('applied');

    // Re-submit seq=2, now the gap is filled
    const res2 = applyOperation(db, opSeq2);
    expect(res2.status).toBe('applied');
    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((t) => t.tag)
        .sort()
    ).toEqual(['first', 'second'].sort());
  });

  test('duplicate localSequence from same node with different op UUID throws SyncValidationError', async () => {
    seedPlan();

    const op1 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'alpha' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, op1);

    // Different op UUID but same node + same localSequence
    const op2 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'beta' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    expect(() => applyOperation(db, op2)).toThrow(SyncValidationError);
  });

  test('sync_sequence advances once per real mutation and not on no-ops or conflicts', async () => {
    seedPlan();

    // Real mutation: add tag
    const tagOp = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'x' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, tagOp);
    expect(countRows('sync_sequence')).toBe(1);

    // No-op: add same tag again (idempotent)
    const noop = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'x' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    applyOperation(db, noop);
    expect(countRows('sync_sequence')).toBe(1); // no increment

    // Conflict: unmergeable text patch
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'conflicting edit\n',
      PLAN_UUID
    );
    mirrorProjectionPlanToCanonical();
    const conflictOp = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'alpha\nbeta\ngamma\n',
        new: 'alpha\nremote\ngamma\n',
      },
      { originNodeId: NODE_A, localSequence: 3 }
    );
    applyOperation(db, conflictOp);
    expect(countRows('sync_sequence')).toBe(1); // no increment on conflict
  });

  test('project setting stale replacement conflicts and reviewIssues list schema round-trips', async () => {
    seedPlan();
    const setting = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    applyOperation(db, setting);
    const stale = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'red', baseRevision: 0 },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    applyOperation(db, stale);
    const reviewIssue = await addPlanListItemOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        list: 'reviewIssues',
        value: { severity: 'major', category: 'bug', content: 'Fix this' },
      },
      { originNodeId: NODE_A, localSequence: 3 }
    );
    applyOperation(db, reviewIssue);

    expect(db.prepare('SELECT value FROM project_setting WHERE setting = ?').get('color')).toEqual({
      value: '"blue"',
    });
    expect(
      db.prepare('SELECT reason FROM sync_conflict WHERE target_type = ?').get('project_setting')
    ).toEqual({
      reason: 'stale_revision',
    });
    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)?.review_issues ?? '[]')).toEqual([
      { severity: 'major', category: 'bug', content: 'Fix this' },
    ]);
  });
});
