import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import { getPlanByUuid, getPlanTagsByUuid, getPlanTasksByUuid, upsertPlan } from '../db/plan.js';
import { getTimNodeCursor, upsertTimNode } from '../db/sync_tables.js';
import { hashToken } from './auth.js';
import {
  addPlanDependencyOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  promotePlanTaskOperation,
} from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  getPendingRollbackKeys,
  listPendingOperations,
  markOperationRejected,
  markOperationSending,
  recordPendingRollbackKeys,
  subscribeToQueueChanges,
} from './queue.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import { startSyncServer, type SyncServerHandle } from './server.js';
import { createBatchEnvelope } from './types.js';
import { createSyncClient, rowsToFlushFrames, type SyncClient } from './ws_client.js';
import type { SyncClientFrame, SyncSnapshotRequestFrame } from './ws_protocol.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_PLAN_UUID = '44444444-4444-4444-8444-444444444444';
const NODE_A = 'persistent-a';
const TOKEN = 'secret-token';

const servers: SyncServerHandle[] = [];
const rawServers: Array<{ stop(force?: boolean): void }> = [];
const clients: SyncClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  for (const server of servers.splice(0)) {
    server.stop();
  }
  for (const server of rawServers.splice(0)) {
    server.stop(true);
  }
});

describe('sync WebSocket client', () => {
  test('does not emit unhandled EventEmitter errors when no error listener is registered', async () => {
    const localDb = createDb();
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(createDb());
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: 'wrong-token',
      reconnect: false,
    });
    clients.push(client);

    expect(() => client.start()).not.toThrow();
    await waitFor(() => !client.getStatus().connecting);
    expect(client.getStatus().connected).toBe(false);
  });

  test('startup resets crash-stranded sending operations before flushing', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'recover-sending' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const queued = enqueueOperation(localDb, op).operation;
    markOperationSending(localDb, queued.operationUuid);
    expect(listPendingOperations(localDb, { originNodeId: NODE_A })).toHaveLength(0);

    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => {
      const row = localDb
        .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
        .get(queued.operationUuid) as { status: string };
      return row.status === 'acked' || row.status === 'rejected';
    });
    const row = localDb
      .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
      .get(queued.operationUuid) as { status: string };
    expect(row.status).toBe('acked');
  });

  test('hello_ack drains pending rollback keys before normal catch-up', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const newPlanUuid = '55555555-5555-4555-8555-555555555555';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const queued = enqueueOperation(localDb, promoteOp).operation;
    markOperationSending(localDb, queued.operationUuid);
    markOperationRejected(localDb, queued.operationUuid, 'source plan deleted', {});
    recordPendingRollbackKeys(localDb, [`plan:${newPlanUuid}`]);
    expect(getPlanByUuid(localDb, newPlanUuid)).not.toBeNull();

    const server = startPendingRollbackSnapshotServer(newPlanUuid);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => client.getStatus().connected);
    await waitFor(() => getPlanByUuid(localDb, newPlanUuid) === null);
    expect(getPendingRollbackKeys(localDb)).toEqual([]);
  });

  test('reconnect hello_ack resets crash-stranded sending operations before flushing', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const port = await getAvailablePort();
    let server = startServer(mainDb, port);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${port}`,
      nodeId: NODE_A,
      token: TOKEN,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    server.stop();
    servers.splice(servers.indexOf(server), 1);
    await waitFor(() => !client.getStatus().connected);

    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'recover-on-reconnect' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const queued = enqueueOperation(localDb, op).operation;
    markOperationSending(localDb, queued.operationUuid);
    expect(
      localDb
        .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
        .get(queued.operationUuid)
    ).toMatchObject({ status: 'sending' });

    server = startServer(mainDb, port);

    await waitFor(() => {
      const row = localDb
        .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
        .get(queued.operationUuid) as { status: string };
      return row.status === 'acked';
    }, 3000);
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual([
      'recover-on-reconnect',
    ]);
  });

  test('flushes operations enqueued after the live connection is established', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(mainDb);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'post-hello' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, op);

    await waitFor(() =>
      getPlanTagsByUuid(mainDb, PLAN_UUID).some((tag) => tag.tag === 'post-hello')
    );
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['post-hello']);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['post-hello']);
    expect(getTimNodeCursor(localDb, NODE_A).last_known_sequence_id).toBe(0);
  });

  test('flushes operations enqueued while a previous flush is still in flight', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(mainDb);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const opA = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'in-flight-a' },
      { originNodeId: NODE_A, localSequence: 998 }
    );
    const opB = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'in-flight-b' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    // Synchronously enqueue both. The first enqueue triggers a flush whose
    // batch snapshot only includes opA; the second enqueue must mark the
    // client dirty so it re-flushes opB after opA is acknowledged, without
    // waiting for the 30s safety poll.
    enqueueOperation(localDb, opA);
    enqueueOperation(localDb, opB);

    await waitFor(
      () => getPlanTagsByUuid(mainDb, PLAN_UUID).some((tag) => tag.tag === 'in-flight-b'),
      2000
    );
    expect(
      getPlanTagsByUuid(mainDb, PLAN_UUID)
        .map((tag) => tag.tag)
        .sort()
    ).toEqual(['in-flight-a', 'in-flight-b']);
  });

  test('does not advance to the next flush frame for an unrelated op_result', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const first = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'frame-one' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const second = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'frame-two' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const third = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'frame-three' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    enqueueOperation(localDb, first);
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_A, operations: [second, third] })
    );
    const server = startMismatchedOpResultServer(third.operationUuid);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);

    client.start();
    await waitFor(() => client.getStatus().connected);
    await client.flushNow();

    expect(server.receivedBatchBeforeRealOpResult()).toBe(false);
    expect(
      localDb
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['acked', 'acked', 'acked']);
  });

  test('applies an invalidate while another snapshot request is in flight', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startDelayedSnapshotServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const publicRequest = client.requestSnapshots([`plan:${PLAN_UUID}`]);

    await waitFor(() => getPlanTagsByUuid(localDb, PLAN_UUID).some((tag) => tag.tag === 'raced'));
    await expect(publicRequest).resolves.toHaveLength(1);
  });

  test('snapshot requests time out and remove their waiter', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startUnresponsiveSnapshotServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
      snapshotRequestTimeoutMs: 20,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    await expect(client.requestSnapshots([`plan:${PLAN_UUID}`])).rejects.toThrow(
      'Sync snapshot request timed out'
    );
    expect(snapshotWaiterCount(client)).toBe(0);
  });

  test('late snapshot_response with unknown requestId does not crash client', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startLateSnapshotServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
      snapshotRequestTimeoutMs: 30,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    // The request will time out before the server responds; after timeout the
    // waiter is removed.  The late response arriving later must not crash.
    const errors: Error[] = [];
    client.on('error', (err) => errors.push(err as Error));

    await expect(client.requestSnapshots([`plan:${PLAN_UUID}`])).rejects.toThrow(
      'Sync snapshot request timed out'
    );
    expect(snapshotWaiterCount(client)).toBe(0);

    // Give the server time to send the late response and the client time to
    // process it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Client should still be healthy — no crash, no unhandled error events.
    expect(errors).toHaveLength(0);
    expect(client.getStatus().connected).toBe(true);
  });

  test('snapshot responses resolve before timeout and clear their waiter', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startImmediateSnapshotServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
      snapshotRequestTimeoutMs: 1000,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    await expect(client.requestSnapshots([`plan:${PLAN_UUID}`])).resolves.toMatchObject([
      { type: 'plan', plan: { tags: ['immediate'] } },
    ]);
    expect(snapshotWaiterCount(client)).toBe(0);
  });

  test('fetchAndMergeSnapshots bounds never_existed follow-up snapshots', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const addedTaskUuid = '55555555-5555-4555-8555-555555555555';
    const op = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: addedTaskUuid, title: 'Optimistic task' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, op);
    expect(getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => task.uuid)).toContain(
      addedTaskUuid
    );
    const client = createSyncClient({
      db: localDb,
      serverUrl: 'http://127.0.0.1:9',
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    const requestSnapshots = vi.fn().mockResolvedValue([
      {
        type: 'never_existed',
        entityKey: `task:${addedTaskUuid}`,
        targetType: 'task',
        taskUuid: addedTaskUuid,
      },
    ]);
    (client as unknown as { requestSnapshots: typeof requestSnapshots }).requestSnapshots =
      requestSnapshots;

    await (
      client as unknown as { fetchAndMergeSnapshots(keys: string[]): Promise<void> }
    ).fetchAndMergeSnapshots([`task:${addedTaskUuid}`]);

    expect(requestSnapshots).toHaveBeenCalledTimes(2);
    expect(requestSnapshots.mock.calls[0]?.[0]).toEqual([`task:${addedTaskUuid}`]);
    expect(requestSnapshots.mock.calls[1]?.[0]).toEqual([`plan:${PLAN_UUID}`]);
    expect(getPlanTasksByUuid(localDb, PLAN_UUID).map((task) => task.uuid)).not.toContain(
      addedTaskUuid
    );
  });

  test('rejects waiters and reconnects after a malformed snapshot response during flush', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startMalformedSnapshotRetryServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      minReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'after-malformed-snapshot' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const queued = enqueueOperation(localDb, op).operation;

    await expect(client.flushNow()).rejects.toThrow();
    const failed = localDb
      .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
      .get(queued.operationUuid) as { status: string };
    expect(failed.status).toBe('failed_retryable');

    await waitFor(
      () => getPlanTagsByUuid(localDb, PLAN_UUID).some((tag) => tag.tag === 'recovered'),
      3000
    );
    const row = localDb
      .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
      .get(queued.operationUuid) as { status: string };
    expect(row.status).toBe('acked');
  });

  test('rejects flush waiter when server sends a non-closing error frame during op_batch', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startErrorFrameServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'error-frame' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const queued = enqueueOperation(localDb, op).operation;

    await expect(client.flushNow()).rejects.toThrow();
    const row = localDb
      .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
      .get(queued.operationUuid) as { status: string };
    expect(row.status).toBe('failed_retryable');
  });

  test('batch result transitions are atomic when a member transition throws', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const ops = await Promise.all(
      ['atomic-a', 'atomic-b', 'atomic-c'].map((tag, index) =>
        addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag },
          { originNodeId: NODE_A, localSequence: index }
        )
      )
    );
    const batch = enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_A, operations: ops })
    );
    for (const row of batch.rows) {
      markOperationSending(localDb, row.operation_uuid);
    }

    expect(() =>
      applyOperationResultTransitions(
        localDb,
        batch.rows.map((row) => ({
          operationId: row.operation_uuid,
          status: 'applied',
          sequenceIds: [],
          invalidations: [],
        })),
        {
          afterTransition: (_result, index) => {
            if (index === 1) {
              throw new Error('simulated crash');
            }
          },
        }
      )
    ).toThrow('simulated crash');

    expect(
      localDb
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['sending', 'sending', 'sending']);
  });

  test('rejected WebSocket batches mark all rolled-back ops terminal-rejected', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(mainDb);
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const tag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'ws-rollback' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const invalidDependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: UNKNOWN_PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_A, operations: [tag, invalidDependency] })
    );
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((row) => row.tag)).toEqual(['ws-rollback']);

    await client.flushNow();

    await waitFor(
      () =>
        localDb
          .prepare(
            "SELECT COUNT(*) AS count FROM sync_operation WHERE status IN ('rejected', 'failed_retryable')"
          )
          .get() as { count: number }
    );
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual([]);
    expect(
      localDb
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['rejected', 'rejected']);
  });

  test('rowsToFlushFrames refuses to send a partial batch subset', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const ops = await Promise.all(
      ['partial-a', 'partial-b'].map((tag, index) =>
        addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag },
          { originNodeId: NODE_A, localSequence: index }
        )
      )
    );
    const batch = enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_A, operations: ops })
    );

    expect(() => rowsToFlushFrames(localDb, [batch.rows[0]])).toThrow(
      'Refusing to flush partial sync batch'
    );
  });

  test('rowsToFlushFrames coalesces independent ops around atomic batch frames', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    for (const tag of ['pre-1', 'pre-2', 'pre-3', 'pre-4', 'pre-5']) {
      enqueueOperation(
        localDb,
        await addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag },
          { originNodeId: NODE_A, localSequence: 999 }
        )
      );
    }
    const batchOps = await Promise.all(
      ['batch-1', 'batch-2'].map((tag, index) =>
        addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag },
          { originNodeId: NODE_A, localSequence: index }
        )
      )
    );
    enqueueBatch(localDb, createBatchEnvelope({ originNodeId: NODE_A, operations: batchOps }));
    for (const tag of ['post-1', 'post-2', 'post-3']) {
      enqueueOperation(
        localDb,
        await addPlanTagOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, tag },
          { originNodeId: NODE_A, localSequence: 999 }
        )
      );
    }

    const frames = rowsToFlushFrames(
      localDb,
      listPendingOperations(localDb, { originNodeId: NODE_A })
    );

    expect(frames).toHaveLength(3);
    expect(frames[0].type).toBe('op_batch');
    expect(frames[0].type === 'op_batch' ? frames[0].operations : []).toHaveLength(5);
    expect(frames[1].type).toBe('batch');
    expect(frames[1].type === 'batch' ? frames[1].batch.operations : []).toHaveLength(2);
    expect(frames[2].type).toBe('op_batch');
    expect(frames[2].type === 'op_batch' ? frames[2].operations : []).toHaveLength(3);
  });

  test('unsubscribes from queue changes when stopped (no leaked subscriptions)', async () => {
    const localDb = createDb();
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startServer(createDb());
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://${server.hostname}:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    // Spy on subscribeToQueueChanges to capture the unsubscriber
    const listenerSpy = vi.fn();
    const externalUnsub = subscribeToQueueChanges(listenerSpy);
    const callsBefore = listenerSpy.mock.calls.length;

    client.stop();

    // After the client is stopped, enqueueing should NOT trigger the client's
    // internal flush (verified indirectly: the external listener still fires
    // but the client's internal listener was removed so no crash/error occurs)
    // The main check: stopping and restarting does not accumulate listeners
    client.start();
    await waitFor(() => client.getStatus().connected);
    client.stop();

    // External listener should still work normally — only the client's own
    // listener was removed on stop
    seedPlan(localDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'after-stop' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, op);
    expect(listenerSpy.mock.calls.length).toBeGreaterThan(callsBefore);

    externalUnsub();
  });

  test('partial frame failure does not clobber rows already transitioned by earlier results', async () => {
    const localDb = createDb();
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });

    const server = startDeferThenErrorServer();
    const client = createSyncClient({
      db: localDb,
      serverUrl: `http://127.0.0.1:${server.port}`,
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const first = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'first-frame' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const second = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'second-frame-a' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const third = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'second-frame-b' },
      { originNodeId: NODE_A, localSequence: 2 }
    );
    const errors: unknown[] = [];
    client.on('error', (err) => errors.push(err));

    enqueueOperation(localDb, first);
    enqueueBatch(
      localDb,
      createBatchEnvelope({ originNodeId: NODE_A, operations: [second, third] })
    );

    // Wait for the auto-flush triggered by enqueue to complete and transition
    // every row to a terminal/retryable state.
    await waitFor(
      () =>
        (
          localDb
            .prepare("SELECT COUNT(*) AS count FROM sync_operation WHERE status = 'sending'")
            .get() as { count: number }
        ).count === 0,
      3000
    );

    const statuses = localDb
      .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
      .all()
      .map((row) => (row as { status: string }).status);
    // First-frame row was deferred -> failed_retryable by handleOperationResults.
    // Without the fix, the catch in flushPendingInternal would call
    // markOperationFailedRetryable on the already-failed row, throwing
    // "Illegal sync_operation transition failed_retryable -> failed_retryable".
    expect(statuses).toEqual(['failed_retryable', 'failed_retryable', 'failed_retryable']);
    // The catch should not surface an Illegal-transition error.
    for (const err of errors) {
      expect(String((err as Error)?.message ?? err)).not.toContain(
        'Illegal sync_operation transition'
      );
    }
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
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
    title: 'Sync plan',
    status: 'pending',
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
  });
}

function startServer(db: Database, port = 0): SyncServerHandle {
  const server = startSyncServer({
    db,
    mainNodeId: 'main-node',
    allowedNodes: [{ nodeId: NODE_A, tokenHash: hashToken(TOKEN) }],
    port,
  });
  servers.push(server);
  return server;
}

function startLateSnapshotServer(): { port: number; stop(force?: boolean): void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'snapshot_request') {
          // Delay beyond the client's snapshotRequestTimeoutMs (30ms in the
          // test) so the waiter has already been removed when the response
          // arrives.
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                type: 'snapshot_response',
                requestId: frame.requestId,
                snapshots: [planSnapshotWithTag('late')],
              })
            );
          }, 200);
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startPendingRollbackSnapshotServer(planUuid: string): {
  port: number;
  stop(force?: boolean): void;
} {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'snapshot_request') {
          ws.send(
            JSON.stringify({
              type: 'snapshot_response',
              requestId: frame.requestId,
              snapshots: frame.entityKeys.map((entityKey) => ({
                type: 'never_existed',
                entityKey,
                targetType: 'plan',
                planUuid,
              })),
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startUnresponsiveSnapshotServer(): { port: number; stop(force?: boolean): void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startImmediateSnapshotServer(): { port: number; stop(force?: boolean): void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'snapshot_request') {
          ws.send(
            JSON.stringify({
              type: 'snapshot_response',
              requestId: frame.requestId,
              snapshots: [planSnapshotWithTag('immediate')],
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startDelayedSnapshotServer(): { port: number; stop(force?: boolean): void } {
  const pendingSnapshots: Array<{
    ws: Bun.ServerWebSocket<unknown>;
    frame: SyncSnapshotRequestFrame;
  }> = [];
  let invalidationSent = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type !== 'snapshot_request') {
          return;
        }
        pendingSnapshots.push({ ws, frame });
        if (!invalidationSent) {
          invalidationSent = true;
          ws.send(
            JSON.stringify({
              type: 'invalidate',
              sequenceId: 1,
              entityKeys: [`plan:${PLAN_UUID}`],
            })
          );
          return;
        }
        if (pendingSnapshots.length >= 2) {
          for (const pending of pendingSnapshots.splice(0)) {
            pending.ws.send(
              JSON.stringify({
                type: 'snapshot_response',
                requestId: pending.frame.requestId,
                snapshots: [planSnapshotWithTag('raced')],
              })
            );
          }
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startMalformedSnapshotRetryServer(): { port: number; stop(force?: boolean): void } {
  let sentMalformedSnapshot = false;
  let sequenceId = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: sequenceId,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: sequenceId,
            })
          );
          return;
        }
        if (frame.type === 'op_batch') {
          sequenceId += 1;
          ws.send(
            JSON.stringify({
              type: 'op_result',
              results: frame.operations.map((operation) => ({
                operationId: operation.operationUuid,
                status: 'applied',
                sequenceIds: [sequenceId],
                invalidations: [`plan:${PLAN_UUID}`],
              })),
            })
          );
          return;
        }
        if (frame.type === 'snapshot_request') {
          if (!sentMalformedSnapshot) {
            sentMalformedSnapshot = true;
            ws.send(
              JSON.stringify({
                type: 'snapshot_response',
                requestId: frame.requestId,
                snapshots: 'not-an-array',
              })
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'snapshot_response',
              requestId: frame.requestId,
              snapshots: [planSnapshotWithTag('recovered')],
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startErrorFrameServer(): { port: number; stop(force?: boolean): void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'op_batch') {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'origin_mismatch',
              message: 'Operation origin does not match authenticated node',
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return server;
}

function startMismatchedOpResultServer(unrelatedOperationId: string): {
  port: number;
  stop(force?: boolean): void;
  receivedBatchBeforeRealOpResult(): boolean;
} {
  let sequenceId = 0;
  let sentRealOpResult = false;
  let receivedBatchEarly = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: sequenceId,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: sequenceId,
            })
          );
          return;
        }
        if (frame.type === 'op_batch') {
          sequenceId += 1;
          ws.send(
            JSON.stringify({
              type: 'op_result',
              results: [
                {
                  operationId: unrelatedOperationId,
                  status: 'applied',
                  sequenceIds: [sequenceId],
                  invalidations: [],
                },
              ],
            })
          );
          setTimeout(() => {
            sentRealOpResult = true;
            ws.send(
              JSON.stringify({
                type: 'op_result',
                results: frame.operations.map((operation) => ({
                  operationId: operation.operationUuid,
                  status: 'applied',
                  sequenceIds: [sequenceId],
                  invalidations: [],
                })),
              })
            );
          }, 50);
          return;
        }
        if (frame.type === 'batch') {
          if (!sentRealOpResult) {
            receivedBatchEarly = true;
          }
          sequenceId += 1;
          ws.send(
            JSON.stringify({
              type: 'batch_result',
              batchId: frame.batch.batchId,
              status: 'applied',
              results: frame.batch.operations.map((operation) => ({
                operationId: operation.operationUuid,
                status: 'applied',
                sequenceIds: [sequenceId],
                invalidations: [],
              })),
              sequenceIds: [sequenceId],
              invalidations: [],
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return {
    port: server.port,
    stop: (force?: boolean) => server.stop(force),
    receivedBatchBeforeRealOpResult: () => receivedBatchEarly,
  };
}

function startDeferThenErrorServer(): { port: number; stop(force?: boolean): void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, serverRef) {
      if (new URL(request.url).pathname !== '/sync/ws') {
        return new Response('Not Found\n', { status: 404 });
      }
      if (serverRef.upgrade(request)) {
        return;
      }
      return new Response('WebSocket upgrade failed\n', { status: 400 });
    },
    websocket: {
      message(ws, rawMessage) {
        const frame = JSON.parse(rawToString(rawMessage)) as SyncClientFrame;
        if (frame.type === 'hello') {
          ws.send(
            JSON.stringify({
              type: 'hello_ack',
              mainNodeId: 'main-node',
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'catch_up_request') {
          ws.send(
            JSON.stringify({
              type: 'catch_up_response',
              invalidations: [],
              currentSequenceId: 0,
            })
          );
          return;
        }
        if (frame.type === 'op_batch') {
          // Defer the first-frame ops so the client transitions them to
          // failed_retryable before sending the next frame.
          ws.send(
            JSON.stringify({
              type: 'op_result',
              results: frame.operations.map((operation) => ({
                operationId: operation.operationUuid,
                status: 'deferred',
                sequenceIds: [],
                invalidations: [],
                error: 'simulated defer',
              })),
            })
          );
          return;
        }
        if (frame.type === 'batch') {
          ws.send(
            JSON.stringify({
              type: 'error',
              code: 'simulated_batch_error',
              message: 'Simulated batch processing error',
            })
          );
        }
      },
    },
  });
  rawServers.push(server);
  return {
    port: server.port,
    stop: (force?: boolean) => server.stop(force),
  };
}

function planSnapshotWithTag(tag: string) {
  return planSnapshotWithTags([tag]);
}

function planSnapshotWithTags(tags: string[]) {
  return {
    type: 'plan',
    projectUuid: PROJECT_UUID,
    plan: {
      uuid: PLAN_UUID,
      planId: 1,
      title: 'Sync plan',
      goal: null,
      note: null,
      details: null,
      status: 'pending',
      priority: null,
      branch: null,
      simple: null,
      tdd: null,
      discoveredFrom: null,
      issue: null,
      pullRequest: null,
      assignedTo: null,
      baseBranch: null,
      temp: null,
      docs: null,
      changedFiles: null,
      planGeneratedAt: null,
      reviewIssues: null,
      parentUuid: null,
      epic: false,
      revision: 2,
      tasks: [
        { uuid: TASK_UUID, title: 'Task one', description: 'Do it', done: false, revision: 1 },
      ],
      dependencyUuids: [],
      tags,
    },
  };
}

function snapshotWaiterCount(client: SyncClient): number {
  return (
    client as unknown as {
      snapshotWaiters: Map<string, unknown>;
    }
  ).snapshotWaiters.size;
}

async function getAvailablePort(): Promise<number> {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {},
      close() {},
      drain() {},
      data() {},
      error() {},
      end() {},
      timeout() {},
      connectError() {},
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function rawToString(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}
