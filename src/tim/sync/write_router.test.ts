import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import { getPlanByUuid, upsertPlan } from '../db/plan.js';
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
  writePlanPatchText,
  writePlanRemoveTask,
  writePlanSetStatus,
  writeProjectSettingSet,
} from './write_router.js';

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
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Router test plan',
    status: 'pending',
    forceOverwrite: true,
  });
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
      { operation_type: 'plan.add_tag', status: 'rejected', origin_node_id: NODE_ID },
      { operation_type: 'plan.add_dependency', status: 'rejected', origin_node_id: NODE_ID },
    ]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 2 });
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({ revision: 1 });
    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: syncOperationBatchId(),
        originNodeId: NODE_ID,
        operations: [
          { ...valid, originNodeId: NODE_ID, localSequence: 0 },
          { ...invalid, originNodeId: NODE_ID, localSequence: 1 },
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
    const before = getPlanByUuid(db, PLAN_UUID)!;
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'status',
        value: 'in_progress',
        baseRevision: before.revision,
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
        baseRevision: before.revision,
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
      { operation_type: 'plan.set_scalar', status: 'rejected', origin_node_id: NODE_ID },
      { operation_type: 'plan.patch_text', status: 'rejected', origin_node_id: NODE_ID },
    ]);
    expect(syncConflictCount()).toBe(0);
    expect(nodeSequenceRow()).toEqual({ next_sequence: 2 });
    const replay = applyBatch(
      db,
      createBatchEnvelope({
        batchId: syncOperationBatchId(),
        originNodeId: NODE_ID,
        atomic: true,
        operations: [
          { ...status, originNodeId: NODE_ID, localSequence: 0 },
          { ...conflict, originNodeId: NODE_ID, localSequence: 1 },
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
    const before = getPlanByUuid(db, PLAN_UUID)!;
    const status = await setPlanScalarOperation(
      PROJECT_UUID,
      {
        planUuid: PLAN_UUID,
        field: 'status',
        value: 'in_progress',
        baseRevision: before.revision,
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
        baseRevision: before.revision,
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
      { operation_type: 'plan.set_scalar', status: 'applied', origin_node_id: NODE_ID },
      { operation_type: 'plan.patch_text', status: 'conflict', origin_node_id: NODE_ID },
    ]);
    expect(syncConflictCount()).toBe(1);
    expect(nodeSequenceRow()).toEqual({ next_sequence: 2 });
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
    expect(
      db
        .prepare(
          `SELECT local_sequence
           FROM sync_operation
           WHERE origin_node_id = ?
           ORDER BY local_sequence`
        )
        .all(NODE_ID)
    ).toEqual([{ local_sequence: 0 }]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 1 });
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

    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toBeNull();

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
          `SELECT local_sequence
           FROM sync_operation
           WHERE origin_node_id = ?
           ORDER BY local_sequence`
        )
        .all(NODE_ID)
    ).toEqual([{ local_sequence: 0 }]);
    expect(
      db.prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?').get(NODE_ID)
    ).toEqual({ next_sequence: 1 });
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
      { operation_type: 'plan.set_scalar', status: 'applied', origin_node_id: NODE_ID },
    ]);
    expect(sequenceCount()).toBe(1);
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
    expect(listPendingOperations(db)).toHaveLength(1);
    expect(syncOperationRows()).toEqual([
      { operation_type: 'plan.add_task', status: 'queued', origin_node_id: NODE_ID },
    ]);
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
    expect(listPendingOperations(db)).toHaveLength(1);
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
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe('batch');
    if (frames[0].type !== 'batch') {
      throw new Error('expected batch frame');
    }
    expect(frames[0].batch.atomic).toBe(true);

    const result = applyBatch(mainDb, frames[0].batch);

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
