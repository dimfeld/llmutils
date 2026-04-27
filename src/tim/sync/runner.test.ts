import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import { insertSyncOperation, upsertTimNode } from '../db/sync_tables.js';
import { addPlanTagOperation } from './operations.js';
import { markOperationAcked, markOperationSending } from './queue.js';
import { createSyncRunner, flushPendingOperationsOnce } from './runner.js';

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
            sequenceIds: [],
            invalidations: [],
          },
        ],
        currentSequenceId: 0,
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
});
