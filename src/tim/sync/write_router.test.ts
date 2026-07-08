import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getPlanByUuid,
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../db/plan.js';
import { getArtifactByUuid } from '../db/artifact.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import { applyBatch, applyOperation } from './apply.js';
import {
  addPlanDependencyOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  patchPlanTextOperation,
  setProjectSettingOperation,
  setPlanScalarOperation,
} from './operations.js';
import type { SyncOperationEnvelope } from './types.js';
import { createBatchEnvelope } from './types.js';
import { listPendingOperations } from './queue.js';
import { rowsToFlushFrames } from './ws_client.js';
import { SyncWriteConflictError, SyncWriteRejectedError } from './errors.js';
import {
  beginSyncBatch,
  routeSyncOperation,
  routeSyncBatch,
  writePlanAddTask,
  writePlanArtifactAttach,
  writePlanArtifactHardDelete,
  writePlanArtifactRestore,
  writePlanArtifactSoftDelete,
  writePlanCreate,
  writePlanPatchText,
  writePlanRemoveTask,
  writePlanSetStatus,
  writeProjectDelete,
  writeProjectSettingSet,
  writeProjectUpsert,
} from './write_router.js';
import { mergeCanonicalRefresh } from './snapshots.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = 'router-node';

let db: Database;
let project: Project;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  const plan = {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Router test plan',
    status: 'pending',
    revision: 1,
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, plan);
  upsertProjectionPlanInTransaction(db, project.id, plan);
});

function syncOperationRows() {
  return db
    .prepare(
      'SELECT operation_type, status, origin_node_id FROM sync_operation ORDER BY local_sequence'
    )
    .all() as Array<{ operation_type: string; status: string; origin_node_id: string }>;
}

function syncOperationBatchId(): string {
  const row = db
    .prepare('SELECT batch_id FROM sync_operation WHERE batch_id IS NOT NULL LIMIT 1')
    .get() as { batch_id: string } | null;
  if (!row?.batch_id) {
    throw new Error('Expected a sync_operation batch_id');
  }
  return row.batch_id;
}

function sequenceCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM sync_sequence').get() as { count: number })
    .count;
}

function nodeSequenceRow() {
  return db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID);
}

function syncConflictCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get() as { count: number })
    .count;
}

describe('sync write router', () => {
  test('sync-disabled config applies project setting canonically and emits sequence', async () => {
    const config = { sync: { disabled: true, nodeId: NODE_ID } } as TimConfig;

    const result = await writeProjectSettingSet(
      db,
      config,
      project.id,
      'color',
      '#3498db',
      'latest'
    );

    expect(result.mode).toBe('applied');
    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: '#3498db',
      revision: 1,
      updatedByNode: NODE_ID,
    });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project_setting.set', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(sequenceCount()).toBe(1);
  });

  test('main-local rejected writes throw a typed write error', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await expect(
      writePlanPatchText(db, config, PROJECT_UUID, {
        planUuid: '33333333-3333-4333-8333-333333333333',
        field: 'details',
        base: '',
        new: 'no target',
        baseRevision: 0,
      })
    ).rejects.toBeInstanceOf(SyncWriteRejectedError);
  });

  test('main-local failed batch persists durable rejection rows', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    const valid = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'rolled-back' },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const invalid = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: '33333333-3333-4333-8333-333333333333' },
      { originNodeId: NODE_ID, localSequence: 1 }
    );

    await expect(
      routeSyncBatch(db, config, { originNodeId: NODE_ID, operations: [valid, invalid] })
    ).rejects.toBeInstanceOf(SyncWriteRejectedError);

    expect(syncOperationRows()).toEqual([
      // The unannounced project is announced before the batch, even though the
      // batch itself fails.
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_tag', status: 'rejected', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_dependency', status: 'rejected', origin_node_id: NODE_ID },
    ]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 3 });
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({ revision: 1 });
    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: syncOperationBatchId(),
        originNodeId: NODE_ID,
        operations: [
          { ...valid, originNodeId: NODE_ID, localSequence: 1 },
          { ...invalid, originNodeId: NODE_ID, localSequence: 2 },
        ],
      })
    );
    expect(replay.status).toBe('rejected');
    expect(replay.results.map((item) => item.status)).toEqual(['rejected', 'rejected']);
  });

  test('main-local atomic conflicted batch persists durable rejection rows', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main edit\n',
      PLAN_UUID
    );
    db.prepare('UPDATE plan_canonical SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main edit\n',
      PLAN_UUID
    );
    const before = getPlanByUuid(db, PLAN_UUID)!;
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'status',
        value: 'in_progress',
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const conflict = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'base text\n',
        new: 'incoming edit\n',
        baseRevision: before.revision + 1,
      },
      { originNodeId: NODE_ID, localSequence: 1 }
    );

    await expect(
      routeSyncBatch(db, config, {
        originNodeId: NODE_ID,
        atomic: true,
        operations: [status, conflict],
      })
    ).rejects.toBeInstanceOf(SyncWriteConflictError);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'pending',
      details: 'main edit\n',
      revision: before.revision,
    });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.set_scalar', status: 'rejected', origin_node_id: NODE_ID },
      { operation_type: 'plan.patch_text', status: 'rejected', origin_node_id: NODE_ID },
    ]);
    expect(syncConflictCount()).toBe(0);
    expect(nodeSequenceRow()).toEqual({ next_sequence: 3 });
    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: syncOperationBatchId(),
        originNodeId: NODE_ID,
        atomic: true,
        operations: [
          { ...status, originNodeId: NODE_ID, localSequence: 1 },
          { ...conflict, originNodeId: NODE_ID, localSequence: 2 },
        ],
      })
    );
    expect(replay.status).toBe('rejected');
    expect(replay.results.map((item) => item.status)).toEqual(['rejected', 'rejected']);
  });

  test('main-local conflicted batch persists when conflict is accepted', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main edit\n',
      PLAN_UUID
    );
    db.prepare('UPDATE plan_canonical SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main edit\n',
      PLAN_UUID
    );
    const before = getPlanByUuid(db, PLAN_UUID)!;
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'status',
        value: 'in_progress',
      },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    const conflict = await patchPlanTextOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'base text\n',
        new: 'incoming edit\n',
        baseRevision: before.revision + 1,
      },
      { originNodeId: NODE_ID, localSequence: 1 }
    );

    const result = await routeSyncBatch(
      db,
      config,
      { originNodeId: NODE_ID, operations: [status, conflict] },
      { acceptConflict: true }
    );

    expect(result.mode).toBe('applied');
    expect(result.result.results.map((item) => item.status)).toEqual(['applied', 'conflict']);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      details: 'main edit\n',
      revision: before.revision + 1,
    });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.set_scalar', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.patch_text', status: 'conflict', origin_node_id: NODE_ID },
    ]);
    expect(syncConflictCount()).toBe(1);
    expect(nodeSequenceRow()).toEqual({ next_sequence: 3 });
  });

  test('main-local failed operation build does not leak allocated local sequence values', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await expect(
      routeSyncOperation(db, config, async () => {
        throw new Error('builder failed before envelope creation');
      })
    ).rejects.toThrow('builder failed before envelope creation');

    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toBeNull();

    const result = await routeSyncOperation(db, config, (options) =>
      addPlanTagOperation(PROJECT_UUID, { planUuid: PLAN_UUID, tag: 'after-failure' }, options)
    );

    expect(result.mode).toBe('applied');
    // The project announcement consumes sequence 0 ahead of the routed write.
    expect(
      db
        .prepare(
          `SELECT local_sequence, operation_type
           FROM sync_operation
           WHERE origin_node_id = ?
           ORDER BY local_sequence`
        )
        .all(NODE_ID)
    ).toEqual([
      { local_sequence: 0, operation_type: 'project.upsert' },
      { local_sequence: 1, operation_type: 'plan.add_tag' },
    ]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 2 });
  });

  test('main-local failed operation apply does not leak allocated local sequence values', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await expect(
      routeSyncOperation(db, config, async (options) => {
        const valid = await addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag: 'invalid-envelope' },
          options
        );
        return {
          ...valid,
          targetKey: 'plan:33333333-3333-4333-8333-333333333333',
        } as SyncOperationEnvelope;
      })
    ).rejects.toBeInstanceOf(SyncWriteRejectedError);

    // The project announcement applied (consuming sequence 0) before the
    // routed operation failed, but the failed operation itself leaked nothing.
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 1 });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
    ]);

    const result = await routeSyncOperation(db, config, (options) =>
      addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'after-apply-failure' },
        options
      )
    );

    expect(result.mode).toBe('applied');
    expect(
      db
        .prepare(
          `SELECT local_sequence, operation_type
           FROM sync_operation
           WHERE origin_node_id = ?
           ORDER BY local_sequence`
        )
        .all(NODE_ID)
    ).toEqual([
      { local_sequence: 0, operation_type: 'project.upsert' },
      { local_sequence: 1, operation_type: 'plan.add_tag' },
    ]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 2 });
  });

  test('main-local writes repair cleared sequence gaps before allocating', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    const applied = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'already-applied' },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    db.prepare(
      `
        INSERT INTO sync_operation (
          operation_uuid,
          project_uuid,
          origin_node_id,
          local_sequence,
          target_type,
          target_key,
          operation_type,
          payload,
          status,
          attempts,
          created_at,
          updated_at,
          batch_atomic
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)
      `
    ).run(
      applied.operationUuid,
      PROJECT_UUID,
      NODE_ID,
      0,
      applied.targetType,
      applied.targetKey,
      applied.op.type,
      JSON.stringify(applied.op)
    );
    db.prepare(
      "INSERT INTO tim_node_sequence (node_id, next_sequence, updated_at) VALUES (?, 3, '2026-01-01T00:00:00.000Z')"
    ).run(NODE_ID);

    const result = await routeSyncOperation(db, config, (options) =>
      addPlanTagOperation(PROJECT_UUID, { planUuid: PLAN_UUID, tag: 'after-gap' }, options)
    );

    expect(result.mode).toBe('applied');
    // The project announcement runs first: it repairs the gap markers and
    // takes sequence 3, so the routed operation lands at sequence 4.
    expect(
      db
        .prepare(
          `
            SELECT local_sequence, status, operation_type
            FROM sync_operation
            WHERE origin_node_id = ?
            ORDER BY local_sequence
          `
        )
        .all(NODE_ID)
    ).toEqual([
      { local_sequence: 0, status: 'applied', operation_type: 'plan.add_tag' },
      { local_sequence: 1, status: 'cleared_rejected', operation_type: 'sync.cleared_rejected' },
      { local_sequence: 2, status: 'cleared_rejected', operation_type: 'sync.cleared_rejected' },
      { local_sequence: 3, status: 'applied', operation_type: 'project.upsert' },
      { local_sequence: 4, status: 'applied', operation_type: 'plan.add_tag' },
    ]);
    expect(nodeSequenceRow()).toEqual({ next_sequence: 5 });
  });

  test('main-local conflicted writes throw a typed write error by default', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    db.prepare('UPDATE plan SET details = ?, revision = revision + 1 WHERE uuid = ?').run(
      'main edit\n',
      PLAN_UUID
    );

    await expect(
      writePlanPatchText(db, config, PROJECT_UUID, {
        planUuid: PLAN_UUID,
        field: 'details',
        base: 'base text\n',
        new: 'incoming edit\n',
        baseRevision: 1,
      })
    ).rejects.toBeInstanceOf(SyncWriteConflictError);

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('main edit\n');
  });

  test('main role applies plan status canonically and records sync metadata', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;
    const before = getPlanByUuid(db, PLAN_UUID)!;

    const result = await writePlanSetStatus(
      db,
      config,
      PROJECT_UUID,
      PLAN_UUID,
      'in_progress',
      before.revision
    );

    expect(result.mode).toBe('applied');
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: before.revision + 1,
    });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.set_scalar', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(sequenceCount()).toBe(2);
  });

  test('persistent role queues operation and applies optimistic state', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_ID,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;

    const result = await writePlanAddTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'Queued task',
      description: 'Created while disconnected',
    });

    expect(result.mode).toBe('queued');
    expect(listPendingOperations(db)).toHaveLength(2);
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'queued', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_task', status: 'queued', origin_node_id: NODE_ID },
    ]);
    expect(
      db.prepare('SELECT sync_announced_at FROM project WHERE uuid = ?').get(PROJECT_UUID)
    ).toMatchObject({ sync_announced_at: expect.any(String) });
    expect(
      db.prepare('SELECT title, description FROM plan_task WHERE plan_uuid = ?').all(PLAN_UUID)
    ).toEqual([
      {
        title: 'Queued task',
        description: 'Created while disconnected',
      },
    ]);
    expect(sequenceCount()).toBe(0);
  });

  test('persistent role queues task removal and removes local optimistic row', async () => {
    const add = await writePlanAddTask(
      db,
      { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig,
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        taskUuid: '33333333-3333-4333-8333-333333333333',
        title: 'Task to remove',
        description: 'temporary',
      }
    );
    expect(add.mode).toBe('applied');
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_ID,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;

    const result = await writePlanRemoveTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      taskUuid: '33333333-3333-4333-8333-333333333333',
    });

    expect(result.mode).toBe('queued');
    expect(syncOperationRows().at(-1)).toEqual({
      operation_type: 'plan.remove_task',
      status: 'queued',
      origin_node_id: NODE_ID,
    });
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM plan_task WHERE uuid = ?')
        .get('33333333-3333-4333-8333-333333333333')
    ).toEqual({ count: 0 });
  });

  test('local-operation mode (no sync role) applies operations canonically', async () => {
    const config = { sync: { nodeId: NODE_ID } } as TimConfig;
    const before = getPlanByUuid(db, PLAN_UUID)!;

    const result = await writePlanSetStatus(
      db,
      config,
      PROJECT_UUID,
      PLAN_UUID,
      'in_progress',
      before.revision
    );

    expect(result.mode).toBe('applied');
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: before.revision + 1,
    });
    expect(syncOperationRows()).toEqual([
      { operation_type: 'plan.set_scalar', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(sequenceCount()).toBe(1);
  });

  test('beginSyncBatch with no sync role applies the batch locally', async () => {
    const config = { sync: { nodeId: NODE_ID } } as TimConfig;
    const batch = await beginSyncBatch(db, config);
    batch.add((options) =>
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'Local task A', description: 'a' },
        options
      )
    );
    batch.add((options) =>
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'Local task B', description: 'b' },
        options
      )
    );

    const result = await batch.commit();
    expect(result.mode).toBe('applied');
    expect(syncOperationRows().every((row) => row.status === 'applied')).toBe(true);
    expect(syncOperationRows()).toHaveLength(2);
    expect(
      db
        .prepare('SELECT title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
        .all(PLAN_UUID)
    ).toEqual([{ title: 'Local task A' }, { title: 'Local task B' }]);
    expect(listPendingOperations(db)).toHaveLength(0);
  });

  test('beginSyncBatch with persistent role queues all operations', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_ID,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;

    const batch = await beginSyncBatch(db, config);
    batch.add((options) =>
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'Queued in batch', description: 'a' },
        options
      )
    );
    const result = await batch.commit();

    expect(result.mode).toBe('queued');
    expect(syncOperationRows().every((row) => row.status === 'queued')).toBe(true);
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'project.upsert',
      'plan.add_task',
    ]);
    expect(listPendingOperations(db)).toHaveLength(2);
    expect(sequenceCount()).toBe(0);
  });

  test('persistent atomic batch remains atomic when replayed on the main node', async () => {
    const mainDb = new Database(':memory:');
    runMigrations(mainDb);
    getOrCreateProject(mainDb, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      highestPlanId: 10,
    });
    const seedColor = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
      { originNodeId: 'main-node', localSequence: 0 }
    );
    applyOperation(mainDb, seedColor);

    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_ID,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;
    const batch = await beginSyncBatch(db, config, { atomic: true });
    batch.add((options) =>
      setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'abbreviation', value: 'AB', baseRevision: 0 },
        options
      )
    );
    batch.add((options) =>
      setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'red', baseRevision: 0 },
        options
      )
    );
    await batch.commit();

    const frames = rowsToFlushFrames(db, listPendingOperations(db, { originNodeId: NODE_ID }));
    expect(frames).toHaveLength(2);
    // The first frame is the bootstrap project announcement; apply it so the
    // batch replay keeps per-origin FIFO ordering on the main node.
    expect(frames[0].type).toBe('op_batch');
    if (frames[0].type !== 'op_batch') {
      throw new Error('expected op_batch frame');
    }
    expect(frames[0].operations).toHaveLength(1);
    expect(frames[0].operations[0].op.type).toBe('project.upsert');
    expect(applyOperation(mainDb, frames[0].operations[0]).status).toBe('applied');
    expect(frames[1].type).toBe('batch');
    if (frames[1].type !== 'batch') {
      throw new Error('expected batch frame');
    }
    expect(frames[1].batch.atomic).toBe(true);

    const result = applyBatch(mainDb, frames[1].batch);

    expect(result.status).toBe('conflict');
    expect(
      mainDb.prepare('SELECT value FROM project_setting WHERE setting = ?').get('color')
    ).toEqual({
      value: '"blue"',
    });
    expect(
      mainDb.prepare('SELECT value FROM project_setting WHERE setting = ?').get('abbreviation')
    ).toBeNull();
    expect(mainDb.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get()).toMatchObject({
      count: 0,
    });
    mainDb.close(false);
  });

  test('local-operation mode rejects empty plan UUIDs', async () => {
    const config = { sync: { nodeId: NODE_ID } } as TimConfig;

    await expect(writePlanSetStatus(db, config, PROJECT_UUID, '', 'in_progress')).rejects.toThrow(
      'Invalid plan UUID'
    );

    expect(syncOperationRows()).toEqual([]);
    expect(sequenceCount()).toBe(0);
  });
});

describe('persistent-node project announcements', () => {
  const persistentConfig = {
    sync: {
      role: 'persistent',
      nodeId: NODE_ID,
      mainUrl: 'http://127.0.0.1:9999',
      nodeToken: 'secret-token',
      offline: true,
    },
  } as TimConfig;

  function projectAnnouncedAt(): string | null {
    const row = db
      .prepare('SELECT sync_announced_at FROM project WHERE uuid = ?')
      .get(PROJECT_UUID) as { sync_announced_at: string | null } | null;
    return row?.sync_announced_at ?? null;
  }

  test('announces an unannounced project once, ahead of the queued operation', async () => {
    expect(projectAnnouncedAt()).toBeNull();

    await writePlanAddTask(db, persistentConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'First task',
      description: 'first',
    });

    const rows = db
      .prepare(
        'SELECT operation_type, local_sequence, payload FROM sync_operation ORDER BY local_sequence'
      )
      .all() as Array<{ operation_type: string; local_sequence: number; payload: string }>;
    expect(rows.map((row) => row.operation_type)).toEqual(['project.upsert', 'plan.add_task']);
    expect(rows[0].local_sequence).toBeLessThan(rows[1].local_sequence);
    expect(JSON.parse(rows[0].payload)).toMatchObject({
      projectUuid: PROJECT_UUID,
      repositoryId: 'github.com__example__repo',
      highestPlanId: 10,
    });
    expect(projectAnnouncedAt()).not.toBeNull();

    // A second write must not queue another announcement.
    await writePlanAddTask(db, persistentConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'Second task',
      description: 'second',
    });
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'project.upsert',
      'plan.add_task',
      'plan.add_task',
    ]);
  });

  test('announced project bootstraps on a main node that has never seen it', async () => {
    const mainDb = new Database(':memory:');
    runMigrations(mainDb);
    expect(
      mainDb.prepare('SELECT COUNT(*) AS count FROM project').get() as { count: number }
    ).toEqual({ count: 0 });

    const newPlanUuid = '44444444-4444-4444-8444-444444444444';
    await writePlanCreate(db, persistentConfig, {
      projectUuid: PROJECT_UUID,
      planUuid: newPlanUuid,
      title: 'Plan in new project',
    });

    for (const frame of rowsToFlushFrames(
      db,
      listPendingOperations(db, { originNodeId: NODE_ID })
    )) {
      if (frame.type === 'op_batch') {
        for (const operation of frame.operations) {
          expect(applyOperation(mainDb, operation).status).toBe('applied');
        }
      } else {
        expect(applyBatch(mainDb, frame.batch).status).toBe('applied');
      }
    }

    expect(mainDb.prepare('SELECT uuid, repository_id FROM project').get()).toMatchObject({
      uuid: PROJECT_UUID,
      repository_id: 'github.com__example__repo',
    });
    mainDb.close(false);
  });

  test('explicit project.upsert marks the project announced without a duplicate', async () => {
    const result = await writeProjectUpsert(db, persistentConfig, {
      projectUuid: PROJECT_UUID,
      repositoryId: project.repository_id,
      remoteUrl: project.remote_url,
      remoteLabel: project.remote_label,
      highestPlanId: project.highest_plan_id,
    });

    expect(result.mode).toBe('queued');
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'queued', origin_node_id: NODE_ID },
    ]);
    expect(projectAnnouncedAt()).not.toBeNull();

    await writePlanAddTask(db, persistentConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'After register',
      description: 'no announcement needed',
    });
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'project.upsert',
      'plan.add_task',
    ]);
  });

  test('project.delete does not trigger an announcement', async () => {
    const result = await writeProjectDelete(db, persistentConfig, {
      projectUuid: PROJECT_UUID,
    });

    expect(result.mode).toBe('queued');
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.delete', status: 'queued', origin_node_id: NODE_ID },
    ]);
  });

  test('adopting a canonical project snapshot marks it announced', async () => {
    expect(projectAnnouncedAt()).toBeNull();

    mergeCanonicalRefresh(db, {
      type: 'project',
      project: {
        uuid: PROJECT_UUID,
        repositoryId: 'github.com__example__repo',
        remoteUrl: null,
        remoteLabel: null,
        highestPlanId: 12,
      },
    });

    expect(projectAnnouncedAt()).not.toBeNull();

    await writePlanAddTask(db, persistentConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'After catch-up',
      description: 'main already knows this project',
    });
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual(['plan.add_task']);
  });
});

describe('main-node project announcements', () => {
  const mainConfig = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

  function projectAnnouncedAt(): string | null {
    const row = db
      .prepare('SELECT sync_announced_at FROM project WHERE uuid = ?')
      .get(PROJECT_UUID) as { sync_announced_at: string | null } | null;
    return row?.sync_announced_at ?? null;
  }

  test('applies a project.upsert ahead of the first write for an unannounced project', async () => {
    expect(projectAnnouncedAt()).toBeNull();

    await writePlanAddTask(db, mainConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'First task',
      description: 'first',
    });

    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_task', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(
      db
        .prepare('SELECT target_key FROM sync_sequence WHERE target_key = ?')
        .get(`project:${PROJECT_UUID}`)
    ).toEqual({ target_key: `project:${PROJECT_UUID}` });
    expect(projectAnnouncedAt()).not.toBeNull();

    // A second write must not apply another announcement.
    await writePlanAddTask(db, mainConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'Second task',
      description: 'second',
    });
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'project.upsert',
      'plan.add_task',
      'plan.add_task',
    ]);
  });

  test('applies the announcement before a batch and still applies the batch', async () => {
    expect(projectAnnouncedAt()).toBeNull();

    const batch = await beginSyncBatch(db, mainConfig);
    batch.add((options) =>
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'Batch task A', description: 'a' },
        options
      )
    );
    batch.add((options) =>
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'Batch task B', description: 'b' },
        options
      )
    );

    const result = await batch.commit();
    expect(result.mode).toBe('applied');
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_task', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_task', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(projectAnnouncedAt()).not.toBeNull();
    expect(
      db
        .prepare('SELECT title FROM plan_task WHERE plan_uuid = ? ORDER BY task_index')
        .all(PLAN_UUID)
    ).toEqual([{ title: 'Batch task A' }, { title: 'Batch task B' }]);
  });

  test('local-operation mode does not announce the project', async () => {
    const config = { sync: { nodeId: NODE_ID } } as TimConfig;

    await writePlanAddTask(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'Local task',
      description: 'no announcement',
    });

    expect(syncOperationRows()).toEqual([
      { operation_type: 'plan.add_task', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(projectAnnouncedAt()).toBeNull();
  });

  test('explicit project.upsert applies once and marks the project announced', async () => {
    const result = await writeProjectUpsert(db, mainConfig, {
      projectUuid: PROJECT_UUID,
      repositoryId: project.repository_id,
      remoteUrl: project.remote_url,
      remoteLabel: project.remote_label,
      highestPlanId: project.highest_plan_id,
    });

    expect(result.mode).toBe('applied');
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(projectAnnouncedAt()).not.toBeNull();

    // Subsequent writes need no bootstrap announcement.
    await writePlanAddTask(db, mainConfig, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      title: 'After explicit upsert',
      description: 'no announcement needed',
    });
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'project.upsert',
      'plan.add_task',
    ]);
  });
});

const ARTIFACT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('artifact write_router helpers', () => {
  const attachInput = {
    planUuid: PLAN_UUID,
    artifactUuid: ARTIFACT_UUID,
    filename: 'report.PDF',
    mimeType: 'application/pdf',
    size: 2048,
    sha256: 'deadbeef',
    message: 'initial upload',
  } as const;

  test('writePlanArtifactAttach inserts artifact row and emits sequence', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    const result = await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);

    expect(result.mode).toBe('applied');
    const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
    expect(artifact).toMatchObject({
      uuid: ARTIFACT_UUID,
      planUuid: PLAN_UUID,
      projectUuid: PROJECT_UUID,
      filename: 'report.PDF',
      mimeType: 'application/pdf',
      size: 2048,
      sha256: 'deadbeef',
      message: 'initial upload',
      deletedAt: null,
      revision: 1,
    });
    expect(artifact?.storagePath).toContain(`${ARTIFACT_UUID}.pdf`);
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan_artifact.attach', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(sequenceCount()).toBe(2);
  });

  test('writePlanArtifactSoftDelete sets deleted_at on existing artifact', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);
    const result = await writePlanArtifactSoftDelete(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });

    expect(result.mode).toBe('applied');
    const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
    expect(artifact?.deletedAt).not.toBeNull();
    expect(artifact?.revision).toBe(2);
    expect(syncOperationRows().at(-1)).toMatchObject({
      operation_type: 'plan_artifact.soft_delete',
      status: 'applied',
    });
    expect(sequenceCount()).toBe(3);
  });

  test('writePlanArtifactRestore clears deleted_at after soft-delete', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);
    await writePlanArtifactSoftDelete(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });

    const result = await writePlanArtifactRestore(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });

    expect(result.mode).toBe('applied');
    const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
    expect(artifact?.deletedAt).toBeNull();
    expect(artifact?.revision).toBe(3);
    expect(syncOperationRows().at(-1)).toMatchObject({
      operation_type: 'plan_artifact.restore',
      status: 'applied',
    });
    expect(sequenceCount()).toBe(4);
  });

  test('writePlanArtifactHardDelete removes artifact row and writes sync_tombstone', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);
    const result = await writePlanArtifactHardDelete(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });

    expect(result.mode).toBe('applied');
    expect(getArtifactByUuid(db, ARTIFACT_UUID)).toBeUndefined();
    expect(
      db
        .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
        .get('plan_artifact', ARTIFACT_UUID)
    ).toEqual({ entity_key: ARTIFACT_UUID });
    expect(syncOperationRows().at(-1)).toMatchObject({
      operation_type: 'plan_artifact.hard_delete',
      status: 'applied',
    });
    expect(sequenceCount()).toBe(3);
  });

  test('soft-delete then restore round-trip leaves deleted_at null', async () => {
    const config = { sync: { role: 'main', nodeId: NODE_ID } } as TimConfig;

    await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);
    await writePlanArtifactSoftDelete(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });
    await writePlanArtifactRestore(db, config, PROJECT_UUID, {
      planUuid: PLAN_UUID,
      artifactUuid: ARTIFACT_UUID,
    });

    const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
    expect(artifact?.deletedAt).toBeNull();
    expect(artifact?.revision).toBe(3);
    // No tombstone should have been written (only hard-delete creates one)
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_tombstone WHERE entity_type = ?')
        .get('plan_artifact')
    ).toEqual({ count: 0 });
  });

  test('persistent role queues artifact attach and applies optimistic projection', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_ID,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;

    const result = await writePlanArtifactAttach(db, config, PROJECT_UUID, attachInput);

    expect(result.mode).toBe('queued');
    expect(listPendingOperations(db)).toHaveLength(2);
    expect(syncOperationRows()).toEqual([
      { operation_type: 'project.upsert', status: 'queued', origin_node_id: NODE_ID },
      { operation_type: 'plan_artifact.attach', status: 'queued', origin_node_id: NODE_ID },
    ]);
    // Optimistic projection: the artifact row is visible immediately
    const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
    expect(artifact).toMatchObject({
      uuid: ARTIFACT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: null,
    });
    expect(sequenceCount()).toBe(0);
  });
});
