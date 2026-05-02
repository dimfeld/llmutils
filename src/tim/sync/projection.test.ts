import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanTasksByUuid,
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../db/plan.js';
import {
  getProjectSettingWithMetadata,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import {
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  deleteProjectSettingOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
} from './operations.js';
import { assertValidPayload } from './types.js';
import { writeProjectSettingSet } from './write_router.js';
import {
  enqueueOperation,
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  markOperationSending,
} from './queue.js';
import { rebuildPlanProjection, rebuildProjectSettingProjection } from './projection.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const NODE_A = 'persistent-a';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';

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

describe('rebuildPlanProjection', () => {
  test('copies canonical plan when there are no active operations', () => {
    writeCanonicalPlan({
      revision: 4,
      title: 'Canonical',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: '', done: false, revision: 2 }],
    });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical',
      revision: 4,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toHaveLength(1);
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      uuid: TASK_UUID,
      revision: 2,
    });
  });

  test('folds one set_scalar operation over canonical and advances projected revision', async () => {
    writeCanonicalPlan({ revision: 4, title: 'Canonical', status: 'pending' });
    await enqueuePlanSetScalar('status', 'in_progress', 4);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: 5,
    });
  });

  test('folds multiple active operations in sequence', async () => {
    writeCanonicalPlan({ revision: 1, title: 'Canonical' });
    await enqueuePlanSetScalar('status', 'in_progress', 1, 1);
    await enqueuePlanAddTask('Added task', 2);
    await enqueuePlanAddTag('sync', 3);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: 4,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.title)).toEqual(['Added task']);
    expect(db.prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?').all(PLAN_UUID)).toEqual([
      { tag: 'sync' },
    ]);
  });

  test('creates projection from ghost canonical plus plan.create operation', async () => {
    await enqueueOperation(
      db,
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          numericPlanId: 42,
          title: 'Local create',
          tasks: [{ taskUuid: TASK_UUID, title: 'First', description: '', done: false }],
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Local create',
      revision: 1,
      plan_id: 42,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      uuid: TASK_UUID,
      revision: 1,
    });
  });

  test('skips add_task against tombstoned canonical and deletes projection', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Deleted canonical' });
    upsertProjectionPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 12,
      title: 'Old projection',
    });
    db.prepare(
      "INSERT INTO sync_tombstone (entity_type, entity_key, project_uuid, deletion_operation_uuid, deleted_revision, deleted_at, origin_node_id) VALUES ('plan', ?, ?, ?, ?, datetime('now'), ?)"
    ).run(`plan:${PLAN_UUID}`, PROJECT_UUID, crypto.randomUUID(), 3, 'main');
    await enqueuePlanAddTask('Skipped task');

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('preserves local-only base tracking fields while rebuilding from canonical', () => {
    writeCanonicalPlan({ revision: 4, title: 'Canonical update' });
    upsertProjectionPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 12,
      title: 'Old projection',
      baseCommit: 'abc123',
      baseChangeId: 'change-1',
    });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical update',
      base_commit: 'abc123',
      base_change_id: 'change-1',
    });
  });
});

describe('rebuildProjectSettingProjection', () => {
  test('copies canonical setting when there are no active operations', () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      revision: 4,
      updatedByNode: 'main',
    });
  });

  test('copies canonical revision when there are no active operations', () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      revision: 5,
      updatedByNode: 'main',
    });
  });

  test('folds one active set operation over canonical', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      revision: 5,
      updatedByNode: NODE_A,
    });
  });

  test('increments projection revision for one matching set operation over canonical', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      revision: 6,
      updatedByNode: NODE_A,
    });
  });

  test('folds multiple operations in origin and local sequence order', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');
    await enqueueSet('color', 'orange');
    await enqueueDelete('color');
    await enqueueSet('color', 'purple');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('purple');
  });

  test('projects a set operation against missing canonical state', async () => {
    await enqueueSet('featured', true);

    rebuildProjectSettingProjection(db, project.id, 'featured');

    expect(getProjectSettingWithMetadata(db, project.id, 'featured')?.value).toBe(true);
    expect(getProjectSettingWithMetadata(db, project.id, 'featured')?.revision).toBe(1);
  });

  test('projects a set operation against absent canonical after local projection is cleared', async () => {
    await enqueueSet('abbreviation', 'TIM');
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      'abbreviation'
    );

    rebuildProjectSettingProjection(db, project.id, 'abbreviation');

    expect(getProjectSettingWithMetadata(db, project.id, 'abbreviation')?.value).toBe('TIM');
  });

  test('delete operation collapses projection when no later set remains', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueDelete('color');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toBeNull();
  });

  test('skips stale baseRevision on set operation', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 4);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      revision: 5,
      updatedByNode: 'main',
    });
  });

  test('skips stale baseRevision on delete operation', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueDelete('color', 4);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });

  test('skips second operation when stale relative to running projected revision', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);
    await enqueueSet('color', 'orange', 5);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('folds chained baseRevision operations', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);
    await enqueueSet('color', 'orange', 6);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('orange');
    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.revision).toBe(7);
  });

  test('persistent latest write uses projected revision and remains visible locally', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_A,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    rebuildProjectSettingProjection(db, project.id, 'color');

    const result = await writeProjectSettingSet(db, config, project.id, 'color', 'green', 'latest');

    expect(result.mode).toBe('queued');
    const row = db
      .prepare(
        `
          SELECT payload
          FROM sync_operation
          WHERE operation_uuid = ?
        `
      )
      .get(result.operation.operationUuid) as { payload: string };
    const payload = assertValidPayload(JSON.parse(row.payload));
    expect(payload).toMatchObject({
      type: 'project_setting.set',
      baseRevision: 5,
    });
    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      revision: 6,
      updatedByNode: NODE_A,
    });
  });

  test('applies operation with undefined baseRevision regardless of canonical revision', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('ignores terminal operations when rebuilding', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const acked = await enqueueSet('color', 'acked');
    markOperationSending(db, acked.operationUuid);
    markOperationAcked(db, acked.operationUuid, {});
    const conflicted = await enqueueSet('color', 'conflicted');
    markOperationSending(db, conflicted.operationUuid);
    markOperationConflict(db, conflicted.operationUuid, 'conflict-1', {});
    const rejected = await enqueueSet('color', 'rejected');
    markOperationSending(db, rejected.operationUuid);
    markOperationRejected(db, rejected.operationUuid, 'bad setting', {});

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('blue');
  });

  test('includes sending operations during restart-style rebuild', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const op = await enqueueSet('color', 'green');
    markOperationSending(db, op.operationUuid);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('includes failed_retryable operations in rebuild (post-restart state)', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const op = await enqueueSet('color', 'green');
    markOperationSending(db, op.operationUuid);
    markOperationFailedRetryable(db, op.operationUuid, 'network error');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });
});

async function enqueueSet(setting: string, value: unknown, baseRevision?: number) {
  return enqueueOperation(
    db,
    await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting, value, baseRevision },
      { originNodeId: NODE_A, localSequence: 999 }
    )
  ).operation;
}

async function enqueueDelete(setting: string, baseRevision?: number) {
  return enqueueOperation(
    db,
    await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting, baseRevision },
      { originNodeId: NODE_A, localSequence: 999 }
    )
  ).operation;
}

function writeCanonicalPlan(
  input: Partial<Parameters<typeof upsertCanonicalPlanInTransaction>[2]> & {
    revision: number;
    title: string;
  }
) {
  return upsertCanonicalPlanInTransaction(db, project.id, {
    uuid: PLAN_UUID,
    planId: 12,
    title: input.title,
    status: input.status ?? 'pending',
    revision: input.revision,
    tasks: input.tasks ?? [],
    dependencyUuids: input.dependencyUuids ?? [],
    tags: input.tags ?? [],
  });
}

async function enqueuePlanSetScalar(
  field: 'status',
  value: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred' | 'needs_review',
  baseRevision?: number,
  localSequence = 1
) {
  return enqueueOperation(
    db,
    await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field, value, baseRevision },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}

async function enqueuePlanAddTask(title: string, localSequence = 1) {
  return enqueueOperation(
    db,
    await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: crypto.randomUUID(), title },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}

async function enqueuePlanAddTag(tag: string, localSequence = 1) {
  return enqueueOperation(
    db,
    await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}
