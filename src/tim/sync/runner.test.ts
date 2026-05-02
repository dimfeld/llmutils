import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import {
  getPlanByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../db/plan.js';
import { getOrCreateProject } from '../db/project.js';
import { getTimNodeCursor, insertSyncOperation, upsertTimNode } from '../db/sync_tables.js';
import {
  addPlanTagOperation,
  addPlanTaskOperation,
  promotePlanTaskOperation,
} from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  getPendingRollbackKeys,
  markOperationAcked,
  markOperationSending,
} from './queue.js';
import { createSyncRunner, flushPendingOperationsOnce, runSyncCatchUpOnce } from './runner.js';
import { createBatchEnvelope } from './types.js';

const clientMocks = vi.hoisted(() => ({
  httpCatchUp: vi.fn(),
  httpFetchSnapshots: vi.fn(),
  httpFlushBatch: vi.fn(),
  httpFlushOperations: vi.fn(),
}));

vi.mock('./client.js', async () => {
  const actual = await vi.importActual<typeof import('./client.js')>('./client.js');
  return {
    ...actual,
    httpCatchUp: clientMocks.httpCatchUp,
    httpFetchSnapshots: clientMocks.httpFetchSnapshots,
    httpFlushBatch: clientMocks.httpFlushBatch,
    httpFlushOperations: clientMocks.httpFlushOperations,
  };
});

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const NODE_ID = 'persistent-a';

beforeEach(() => {
  clientMocks.httpCatchUp.mockReset();
  clientMocks.httpFetchSnapshots.mockReset();
  clientMocks.httpFlushBatch.mockReset();
  clientMocks.httpFlushOperations.mockReset();
  clientMocks.httpFetchSnapshots.mockResolvedValue({
    ok: true,
    value: { snapshots: [], currentSequenceId: 0 },
  });
});

function createRunnerDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  upsertTimNode(db, { nodeId: NODE_ID, role: 'persistent' });
  getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  return db;
}

function seedPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  const plan = {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Source plan',
    status: 'pending',
    revision: 1,
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Promote me' }],
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, {
    ...plan,
    tasks: plan.tasks.map((task) => ({ ...task, revision: 1 })),
  });
  upsertProjectionPlanInTransaction(db, project.id, plan);
}

async function insertQueuedTagOperation(db: Database, tag: string, localSequence = 0) {
  const op = await addPlanTagOperation(
    PROJECT_UUID,
    { planUuid: PLAN_UUID, tag },
    { originNodeId: NODE_ID, localSequence }
  );
  insertSyncOperation(db, {
    operation_uuid: op.operationUuid,
    project_uuid: PROJECT_UUID,
    origin_node_id: NODE_ID,
    local_sequence: localSequence,
    target_type: op.targetType,
    target_key: op.targetKey,
    operation_type: op.op.type,
    base_revision: null,
    base_hash: null,
    payload: JSON.stringify(op.op),
    status: 'queued',
    last_error: null,
    acked_at: null,
    ack_metadata: null,
  });
  return op;
}

function operationStatus(db: Database, operationUuid: string): string {
  return (
    db.prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?').get(operationUuid) as {
      status: string;
    }
  ).status;
}

describe('sync runner', () => {
  test('runOnce calls share the in-progress sync promise', async () => {
    const db = createRunnerDb();
    clientMocks.httpCatchUp.mockImplementation(
      () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('offline')), 10);
        })
    );
    const runner = createSyncRunner({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    const first = runner.runOnce();
    const second = runner.runOnce();

    expect(second).toBe(first);
    await expect(first).rejects.toThrow();
  });

  test('flushPendingOperationsOnce leaves in-flight sending rows alone by default', async () => {
    const db = createRunnerDb();
    const op = await insertQueuedTagOperation(db, 'in-flight');
    markOperationSending(db, op.operationUuid);

    await flushPendingOperationsOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    expect(operationStatus(db, op.operationUuid)).toBe('sending');
    expect(clientMocks.httpFlushOperations).not.toHaveBeenCalled();

    markOperationAcked(db, op.operationUuid, { sequenceIds: [], invalidations: [] });
    await flushPendingOperationsOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });
    expect(operationStatus(db, op.operationUuid)).toBe('acked');
    expect(clientMocks.httpFlushOperations).not.toHaveBeenCalled();
  });

  test('flushPendingOperationsOnce can opt into stranded sending recovery', async () => {
    const db = createRunnerDb();
    const op = await insertQueuedTagOperation(db, 'stranded');
    markOperationSending(db, op.operationUuid);
    clientMocks.httpFlushOperations.mockResolvedValue({
      ok: true,
      value: {
        results: [
          {
            operationId: op.operationUuid,
            status: 'applied',
            sequenceIds: [99],
            invalidations: [],
          },
        ],
        currentSequenceId: 99,
      },
    });

    await flushPendingOperationsOnce(
      {
        db,
        serverUrl: 'http://127.0.0.1:9',
        nodeId: NODE_ID,
        token: 'token',
      },
      { recoverStranded: true }
    );

    expect(operationStatus(db, op.operationUuid)).toBe('acked');
    expect(clientMocks.httpFlushOperations).toHaveBeenCalledTimes(1);
    expect(getTimNodeCursor(db, NODE_ID).last_known_sequence_id).toBe(0);
  });

  test('flushPendingOperationsOnce only marks unprocessed rows retryable when a later frame fails', async () => {
    const db = createRunnerDb();
    const batched = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'batched' },
      { originNodeId: NODE_ID, localSequence: 0 }
    );
    enqueueBatch(
      db,
      createBatchEnvelope({
        batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: NODE_ID,
        operations: [batched],
      })
    );
    const later = await insertQueuedTagOperation(db, 'later', 1);
    clientMocks.httpFlushBatch.mockResolvedValue({
      ok: true,
      value: {
        results: [
          {
            operationId: batched.operationUuid,
            status: 'applied',
            sequenceIds: [100],
            invalidations: [],
          },
        ],
        currentSequenceId: 100,
      },
    });
    clientMocks.httpFlushOperations.mockRejectedValue(new Error('second frame failed'));

    await expect(
      flushPendingOperationsOnce({
        db,
        serverUrl: 'http://127.0.0.1:9',
        nodeId: NODE_ID,
        token: 'token',
      })
    ).rejects.toThrow('second frame failed');

    expect(operationStatus(db, batched.operationUuid)).toBe('acked');
    expect(operationStatus(db, later.operationUuid)).toBe('failed_retryable');
  });

  test('flushPendingOperationsOnce rejects plan op by rebuilding projection without rollback fetches', async () => {
    const db = createRunnerDb();
    seedPlan(db);
    const queued = enqueueOperation(
      db,
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'optimistic-rejected' },
        { originNodeId: NODE_ID, localSequence: 0 }
      )
    );
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((row) => row.tag)).toEqual(['optimistic-rejected']);
    clientMocks.httpFlushOperations.mockResolvedValue({
      ok: true,
      value: {
        results: [
          {
            operationId: queued.operation.operationUuid,
            status: 'rejected',
            error: 'main rejected operation',
          },
        ],
        currentSequenceId: 0,
      },
    });
    await flushPendingOperationsOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    expect(clientMocks.httpFetchSnapshots).not.toHaveBeenCalled();
    expect(getPendingRollbackKeys(db)).toEqual([]);
    expect(operationStatus(db, queued.operation.operationUuid)).toBe('rejected');
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((row) => row.tag)).toEqual([]);
  });

  test('markOperationAcked tolerates operations already acked by another transport', async () => {
    const db = createRunnerDb();
    const op = await insertQueuedTagOperation(db, 'acked');
    markOperationSending(db, op.operationUuid);
    markOperationAcked(db, op.operationUuid, { sequenceIds: [1], invalidations: ['first'] });

    expect(() =>
      markOperationAcked(db, op.operationUuid, { sequenceIds: [1], invalidations: ['second'] })
    ).not.toThrow();
    expect(operationStatus(db, op.operationUuid)).toBe('acked');
  });

  test('plan_deleted canonical merge does not trigger follow-up fetch; active promote_task op keeps destination plan in projection', async () => {
    // Under the new projection model, plan_deleted writes a canonical tombstone
    // and rebuilds the source plan's projection. It does NOT reject the pending
    // promote_task op or generate follow-up snapshot keys. The destination plan
    // created by the promote_task op stays visible until the main node explicitly
    // rejects the op via a result transition.
    const db = createRunnerDb();
    seedPlan(db);
    const newPlanUuid = '44444444-4444-4444-8444-444444444444';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_ID, localSequence: 999 }
    );
    enqueueOperation(db, promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    clientMocks.httpCatchUp.mockResolvedValue({
      ok: true,
      value: {
        invalidations: [{ sequenceId: 1, entityKeys: [`plan:${PLAN_UUID}`] }],
        currentSequenceId: 1,
      },
    });
    clientMocks.httpFetchSnapshots.mockResolvedValueOnce({
      ok: true,
      value: {
        snapshots: [
          {
            type: 'plan_deleted',
            projectUuid: PROJECT_UUID,
            planUuid: PLAN_UUID,
            deletedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        currentSequenceId: 1,
      },
    });

    await runSyncCatchUpOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    // Only one snapshot fetch — no follow-up keys generated
    expect(clientMocks.httpFetchSnapshots).toHaveBeenCalledTimes(1);
    // Source plan tombstoned; projection cleared
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    // promote_task op stays active (canonical merge does not reject it)
    expect(operationStatus(db, promoteOp.operationUuid)).toBe('queued');
    // Destination plan still in projection because the op is active
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();
    // No pending rollback keys written under the new model
    expect(getPendingRollbackKeys(db)).toEqual([]);
  });

  test('never_existed for plan does not trigger follow-up fetch; active promote_task op keeps destination plan in projection', async () => {
    // never_existed behaves like plan_deleted under the new model: tombstones
    // the canonical store and rebuilds projection without rejecting queued ops.
    const db = createRunnerDb();
    seedPlan(db);
    const newPlanUuid = '44444444-4444-4444-8444-444444444445';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_ID, localSequence: 999 }
    );
    enqueueOperation(db, promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    clientMocks.httpCatchUp.mockResolvedValueOnce({
      ok: true,
      value: {
        invalidations: [{ sequenceId: 1, entityKeys: [`plan:${PLAN_UUID}`] }],
        currentSequenceId: 1,
      },
    });
    clientMocks.httpFetchSnapshots.mockResolvedValueOnce({
      ok: true,
      value: {
        snapshots: [
          {
            type: 'never_existed',
            entityKey: `plan:${PLAN_UUID}`,
            targetType: 'plan',
            planUuid: PLAN_UUID,
          },
        ],
        currentSequenceId: 1,
      },
    });

    await runSyncCatchUpOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    // Only one snapshot fetch — no follow-up keys generated
    expect(clientMocks.httpFetchSnapshots).toHaveBeenCalledTimes(1);
    // Source plan tombstoned; projection cleared
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    // promote_task op stays active
    expect(operationStatus(db, promoteOp.operationUuid)).toBe('queued');
    // Destination plan still in projection
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();
    expect(getPendingRollbackKeys(db)).toEqual([]);
  });

  test('promote_task rejection via result transition collapses destination plan from projection', async () => {
    // When the main node rejects a promote_task op, applyOperationResultTransitions
    // rebuilds the projection for all affected plans. The destination plan created
    // optimistically must disappear, and the source task must be restored.
    const db = createRunnerDb();
    seedPlan(db);
    const newPlanUuid = '44444444-4444-4444-8444-444444444446';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_ID, localSequence: 1001 }
    );
    enqueueOperation(db, promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();
    // promote_task marks source task as done (not removes it)
    expect(getPlanTasksByUuid(db, PLAN_UUID).find((t) => t.uuid === TASK_UUID)?.done).toBe(1);

    clientMocks.httpFlushOperations.mockResolvedValueOnce({
      ok: true,
      value: {
        results: [
          {
            operationId: promoteOp.operationUuid,
            status: 'rejected',
            error: 'promote not allowed',
          },
        ],
        currentSequenceId: 0,
      },
    });

    await flushPendingOperationsOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    // Rejection triggers projection rebuild via applyOperationResultTransitions
    expect(operationStatus(db, promoteOp.operationUuid)).toBe('rejected');
    // Destination plan disappears (no active op creates it anymore)
    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
    // Source task reverted to not-done (projection rebuilt from canonical)
    expect(getPlanTasksByUuid(db, PLAN_UUID).find((t) => t.uuid === TASK_UUID)?.done).toBe(0);
  });

  test('runSyncCatchUpOnce applies task never_existed without recursive rollback fetches', async () => {
    const db = createRunnerDb();
    seedPlan(db);
    const addedTaskUuid = '55555555-5555-4555-8555-555555555555';
    const addTaskOp = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: addedTaskUuid, title: 'Optimistic task' },
      { originNodeId: NODE_ID, localSequence: 999 }
    );
    enqueueOperation(db, addTaskOp);
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).toContain(addedTaskUuid);

    clientMocks.httpCatchUp.mockResolvedValue({
      ok: true,
      value: {
        invalidations: [{ sequenceId: 1, entityKeys: [`task:${addedTaskUuid}`] }],
        currentSequenceId: 1,
      },
    });
    clientMocks.httpFetchSnapshots.mockResolvedValue({
      ok: true,
      value: {
        snapshots: [
          {
            type: 'never_existed',
            entityKey: `task:${addedTaskUuid}`,
            targetType: 'task',
            taskUuid: addedTaskUuid,
          },
        ],
        currentSequenceId: 1,
      },
    });

    await runSyncCatchUpOnce({
      db,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_ID,
      token: 'token',
    });

    expect(clientMocks.httpFetchSnapshots).toHaveBeenCalledTimes(1);
    expect(clientMocks.httpFetchSnapshots.mock.calls[0]?.[3]).toEqual([`task:${addedTaskUuid}`]);
    expect(operationStatus(db, addTaskOp.operationUuid)).toBe('queued');
    expect(getPendingRollbackKeys(db)).toEqual([]);
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).not.toContain(addedTaskUuid);
  });
});
