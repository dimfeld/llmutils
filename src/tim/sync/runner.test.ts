import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '../db/plan.js';
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
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Source plan',
    status: 'pending',
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Promote me' }],
    forceOverwrite: true,
  });
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

  test('runSyncCatchUpOnce fetches follow-up snapshots for locally rejected optimistic ops', async () => {
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
    clientMocks.httpFetchSnapshots
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          snapshots: [
            {
              type: 'never_existed',
              entityKey: `plan:${newPlanUuid}`,
              targetType: 'plan',
              planUuid: newPlanUuid,
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

    expect(clientMocks.httpFetchSnapshots).toHaveBeenCalledTimes(2);
    expect(clientMocks.httpFetchSnapshots.mock.calls[0]?.[3]).toEqual([`plan:${PLAN_UUID}`]);
    expect(clientMocks.httpFetchSnapshots.mock.calls[1]?.[3]).toEqual(
      expect.arrayContaining([`plan:${newPlanUuid}`, `task:${TASK_UUID}`])
    );
    expect(operationStatus(db, promoteOp.operationUuid)).toBe('rejected');
    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
  });

  test('runSyncCatchUpOnce drains pending rollback keys on next run after a follow-up fetch failure', async () => {
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
    clientMocks.httpFetchSnapshots
      .mockResolvedValueOnce({
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
      })
      .mockRejectedValueOnce(new Error('follow-up fetch failed'));

    await expect(
      runSyncCatchUpOnce({
        db,
        serverUrl: 'http://127.0.0.1:9',
        nodeId: NODE_ID,
        token: 'token',
      })
    ).rejects.toThrow('follow-up fetch failed');

    expect(operationStatus(db, promoteOp.operationUuid)).toBe('rejected');
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();
    expect(getPendingRollbackKeys(db)).toEqual(
      expect.arrayContaining([`plan:${newPlanUuid}`, `task:${TASK_UUID}`])
    );

    clientMocks.httpCatchUp.mockResolvedValueOnce({
      ok: true,
      value: { invalidations: [], currentSequenceId: 1 },
    });
    clientMocks.httpFetchSnapshots.mockResolvedValueOnce({
      ok: true,
      value: {
        snapshots: [
          {
            type: 'never_existed',
            entityKey: `plan:${newPlanUuid}`,
            targetType: 'plan',
            planUuid: newPlanUuid,
          },
          {
            type: 'never_existed',
            entityKey: `task:${TASK_UUID}`,
            targetType: 'task',
            taskUuid: TASK_UUID,
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

    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
    expect(getPendingRollbackKeys(db)).toEqual([]);
  });

  test('runSyncCatchUpOnce clears task-keyed pending rollback when server omits the task snapshot', async () => {
    // The real sync server's loadTaskSnapshot returns the owning plan snapshot
    // when the task exists, and returns null (omits the entry) when the task
    // is tombstoned. In neither case does it return a task-keyed snapshot. The
    // pending rollback row for `task:<uuid>` must be cleared by the requested
    // key after a successful fetch pass, not by the returned snapshot's own
    // entity key.
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

    clientMocks.httpCatchUp.mockResolvedValueOnce({
      ok: true,
      value: {
        invalidations: [{ sequenceId: 1, entityKeys: [`plan:${PLAN_UUID}`] }],
        currentSequenceId: 1,
      },
    });
    clientMocks.httpFetchSnapshots
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          // Mimic real loadCanonicalSnapshot: only the optimistic plan comes
          // back as never_existed; the task-keyed request gets no entry
          // (server treats source-plan deletion as task tombstone, returns null).
          snapshots: [
            {
              type: 'never_existed',
              entityKey: `plan:${newPlanUuid}`,
              targetType: 'plan',
              planUuid: newPlanUuid,
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

    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
    expect(getPendingRollbackKeys(db)).toEqual([]);
  });

  test('runSyncCatchUpOnce bounds recursive never_existed follow-up snapshots', async () => {
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

    expect(clientMocks.httpFetchSnapshots).toHaveBeenCalledTimes(2);
    expect(clientMocks.httpFetchSnapshots.mock.calls[0]?.[3]).toEqual([`task:${addedTaskUuid}`]);
    expect(clientMocks.httpFetchSnapshots.mock.calls[1]?.[3]).toEqual([`plan:${PLAN_UUID}`]);
    expect(operationStatus(db, addTaskOp.operationUuid)).toBe('rejected');
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).not.toContain(
      addedTaskUuid
    );
  });
});
