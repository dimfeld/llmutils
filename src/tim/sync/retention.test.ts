import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { updateTimNodeCursor, upsertTimNode } from '../db/sync_tables.js';
import { getOriginWatermark } from './origin_watermark.js';
import { pruneSyncOperationHistory, pruneSyncSequence } from './retention.js';
import { startSyncSequenceRetentionRunner, type SyncSequenceRetentionRunner } from './runner.js';
import { getCurrentSequenceId } from './server.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-04-27T12:00:00.000Z');
const OLD = new Date('2026-03-01T12:00:00.000Z').toISOString();
const RECENT = new Date('2026-04-26T12:00:00.000Z').toISOString();

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

describe('sync sequence retention', () => {
  test('prunes rows older than one peer cursor and keeps rows at or after the cursor', () => {
    insertSequences(5, RECENT);
    upsertTimNode(db, { nodeId: 'peer-a', role: 'persistent' });
    updateTimNodeCursor(db, 'peer-a', 3);

    expect(pruneSyncSequence(db, { now: NOW })).toBe(2);
    expect(sequenceIds()).toEqual([3, 4, 5]);
  });

  test('uses the minimum cursor across multiple persistent peers', () => {
    insertSequences(6, RECENT);
    upsertTimNode(db, { nodeId: 'peer-a', role: 'persistent' });
    upsertTimNode(db, { nodeId: 'peer-b', role: 'persistent' });
    updateTimNodeCursor(db, 'peer-a', 5);
    updateTimNodeCursor(db, 'peer-b', 3);

    expect(pruneSyncSequence(db, { now: NOW })).toBe(2);
    expect(sequenceIds()).toEqual([3, 4, 5, 6]);
  });

  test('with no peer cursors, only time-based pruning runs', () => {
    insertSequence(OLD);
    insertSequence(OLD);
    insertSequence(RECENT);

    expect(pruneSyncSequence(db, { now: NOW })).toBe(2);
    expect(sequenceIds()).toEqual([3]);
  });

  test('time-based ceiling overrides a peer cursor that is far behind', () => {
    insertSequence(OLD);
    insertSequence(OLD);
    insertSequence(RECENT);
    insertSequence(RECENT);
    upsertTimNode(db, { nodeId: 'peer-a', role: 'persistent' });
    updateTimNodeCursor(db, 'peer-a', 1);

    expect(pruneSyncSequence(db, { now: NOW })).toBe(2);
    expect(sequenceIds()).toEqual([3, 4]);
  });

  test('a known persistent peer with no cursor row protects all sequences from peer-cursor pruning', () => {
    insertSequences(5, RECENT);
    upsertTimNode(db, { nodeId: 'peer-a', role: 'persistent' });
    updateTimNodeCursor(db, 'peer-a', 4);
    // peer-b is configured (seeded into tim_node) but has not connected yet,
    // so it has no tim_node_cursor row. Peer-cursor pruning must treat it as 0.
    upsertTimNode(db, { nodeId: 'peer-b', role: 'persistent' });

    expect(pruneSyncSequence(db, { now: NOW })).toBe(0);
    expect(sequenceIds()).toEqual([1, 2, 3, 4, 5]);
  });

  test('getCurrentSequenceId stays at the last assigned sequence after a full prune', () => {
    insertSequences(5, OLD);
    // No peer cursors; time-based pruning will sweep all rows since they're old.
    expect(pruneSyncSequence(db, { now: NOW })).toBe(5);
    expect(sequenceIds()).toEqual([]);
    // The checkpoint must NOT regress to 0 just because the rows were pruned —
    // peers rely on this advertised value being monotonically non-decreasing.
    expect(getCurrentSequenceId(db)).toBe(5);
  });

  test('is a no-op when no sequence rows are eligible', () => {
    insertSequences(3, RECENT);
    upsertTimNode(db, { nodeId: 'peer-a', role: 'persistent' });
    updateTimNodeCursor(db, 'peer-a', 1);

    expect(pruneSyncSequence(db, { now: NOW })).toBe(0);
    expect(sequenceIds()).toEqual([1, 2, 3]);
  });
});

function insertSequences(count: number, createdAt: string): void {
  for (let i = 0; i < count; i += 1) {
    insertSequence(createdAt);
  }
}

function insertSequence(createdAt: string): void {
  db.prepare(
    `
      INSERT INTO sync_sequence (
        project_uuid,
        target_type,
        target_key,
        revision,
        operation_uuid,
        origin_node_id,
        created_at
      ) VALUES (?, 'plan', ?, 1, ?, 'main-node', ?)
    `
  ).run(PROJECT_UUID, `plan:${crypto.randomUUID()}`, crypto.randomUUID(), createdAt);
}

function sequenceIds(): number[] {
  return (
    db.prepare('SELECT sequence FROM sync_sequence ORDER BY sequence').all() as Array<{
      sequence: number;
    }>
  ).map((row) => row.sequence);
}

describe('sync operation history retention', () => {
  const LOCAL_NODE = 'local-node';
  const REMOTE_NODE = 'remote-node';
  // RECENT is 1 day before NOW; OLD is about 2 months before NOW.
  const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const TEN_DAYS_AGO = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.prepare(
      `INSERT INTO tim_node_sequence (node_id, next_sequence, updated_at) VALUES (?, 100, ?)`
    ).run(LOCAL_NODE, RECENT);
  });

  function insertOperation(input: {
    origin: string;
    sequence: number;
    status: string;
    updatedAt: string;
    batchId?: string;
  }): string {
    const operationUuid = crypto.randomUUID();
    db.prepare(
      `
        INSERT INTO sync_operation (
          operation_uuid, project_uuid, origin_node_id, batch_id, local_sequence, target_type,
          target_key, operation_type, payload, status, attempts, created_at, updated_at,
          batch_atomic
        ) VALUES (?, ?, ?, ?, ?, 'plan', ?, 'plan.add_tag', '{}', ?, 0, ?, ?, 0)
      `
    ).run(
      operationUuid,
      PROJECT_UUID,
      input.origin,
      input.batchId ?? null,
      input.sequence,
      `plan:${operationUuid}`,
      input.status,
      input.updatedAt,
      input.updatedAt
    );
    return operationUuid;
  }

  function remaining(): Array<[string, number]> {
    return (
      db
        .prepare(
          'SELECT origin_node_id, local_sequence FROM sync_operation ORDER BY origin_node_id, local_sequence'
        )
        .all() as Array<{ origin_node_id: string; local_sequence: number }>
    ).map((row) => [row.origin_node_id, row.local_sequence]);
  }

  test('uses a short retention for local operations and a long one for remote operations', () => {
    insertOperation({
      origin: LOCAL_NODE,
      sequence: 1,
      status: 'applied',
      updatedAt: TWO_DAYS_AGO,
    });
    insertOperation({ origin: LOCAL_NODE, sequence: 2, status: 'applied', updatedAt: RECENT });
    insertOperation({ origin: REMOTE_NODE, sequence: 1, status: 'applied', updatedAt: OLD });
    insertOperation({
      origin: REMOTE_NODE,
      sequence: 2,
      status: 'applied',
      updatedAt: TEN_DAYS_AGO,
    });

    expect(pruneSyncOperationHistory(db, { now: NOW })).toEqual({ deleted: 2, complete: true });
    expect(remaining()).toEqual([
      [LOCAL_NODE, 2],
      [REMOTE_NODE, 2],
    ]);
    expect(getOriginWatermark(db, LOCAL_NODE)).toBe(1);
    expect(getOriginWatermark(db, REMOTE_NODE)).toBe(1);
  });

  test('keeps rejected, conflict, and active rows, and acked rows do not move the watermark', () => {
    insertOperation({ origin: LOCAL_NODE, sequence: 1, status: 'acked', updatedAt: OLD });
    insertOperation({
      origin: LOCAL_NODE,
      sequence: 2,
      status: 'cleared_rejected',
      updatedAt: OLD,
    });
    insertOperation({ origin: LOCAL_NODE, sequence: 3, status: 'rejected', updatedAt: OLD });
    insertOperation({ origin: LOCAL_NODE, sequence: 4, status: 'conflict', updatedAt: OLD });
    insertOperation({ origin: LOCAL_NODE, sequence: 5, status: 'queued', updatedAt: OLD });
    insertOperation({
      origin: LOCAL_NODE,
      sequence: 6,
      status: 'failed_retryable',
      updatedAt: OLD,
    });
    insertOperation({ origin: LOCAL_NODE, sequence: 7, status: 'acked', updatedAt: OLD });

    expect(pruneSyncOperationHistory(db, { now: NOW })).toEqual({ deleted: 3, complete: true });
    expect(remaining().map(([, sequence]) => sequence)).toEqual([3, 4, 5, 6]);
    // Only cleared_rejected counts toward checkFifo; acked rows do not.
    expect(getOriginWatermark(db, LOCAL_NODE)).toBe(2);
  });

  test('keeps every row of a batch that still has a row to keep', () => {
    insertOperation({
      origin: REMOTE_NODE,
      sequence: 1,
      status: 'applied',
      updatedAt: OLD,
      batchId: 'batch-keep',
    });
    insertOperation({
      origin: REMOTE_NODE,
      sequence: 2,
      status: 'conflict',
      updatedAt: OLD,
      batchId: 'batch-keep',
    });
    insertOperation({
      origin: REMOTE_NODE,
      sequence: 3,
      status: 'applied',
      updatedAt: OLD,
      batchId: 'batch-done',
    });
    insertOperation({
      origin: REMOTE_NODE,
      sequence: 4,
      status: 'applied',
      updatedAt: OLD,
      batchId: 'batch-done',
    });

    expect(pruneSyncOperationHistory(db, { now: NOW })).toEqual({ deleted: 2, complete: true });
    expect(remaining()).toEqual([
      [REMOTE_NODE, 1],
      [REMOTE_NODE, 2],
    ]);
    expect(getOriginWatermark(db, REMOTE_NODE)).toBe(4);
  });

  test('deletes plan refs with their operations', () => {
    const operationUuid = insertOperation({
      origin: LOCAL_NODE,
      sequence: 1,
      status: 'applied',
      updatedAt: OLD,
    });
    db.prepare(
      `INSERT INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
       VALUES (?, ?, ?, 'target')`
    ).run(operationUuid, PROJECT_UUID, crypto.randomUUID());

    pruneSyncOperationHistory(db, { now: NOW });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_operation_plan_ref').get()).toEqual({ n: 0 });
  });

  test('stops at maxBatches and reports that more rows are left', () => {
    for (let sequence = 1; sequence <= 5; sequence++) {
      insertOperation({ origin: LOCAL_NODE, sequence, status: 'applied', updatedAt: OLD });
    }

    expect(pruneSyncOperationHistory(db, { now: NOW, batchSize: 2, maxBatches: 2 })).toEqual({
      deleted: 4,
      complete: false,
    });
    expect(pruneSyncOperationHistory(db, { now: NOW, batchSize: 2, maxBatches: 2 })).toEqual({
      deleted: 1,
      complete: true,
    });
    expect(remaining()).toEqual([]);
    expect(getOriginWatermark(db, LOCAL_NODE)).toBe(5);
  });

  test('never lowers an existing watermark', () => {
    db.prepare(
      `INSERT INTO sync_origin_watermark (origin_node_id, terminal_through_sequence, updated_at)
       VALUES (?, 50, ?)`
    ).run(REMOTE_NODE, RECENT);
    insertOperation({ origin: REMOTE_NODE, sequence: 3, status: 'applied', updatedAt: OLD });

    pruneSyncOperationHistory(db, { now: NOW });
    expect(getOriginWatermark(db, REMOTE_NODE)).toBe(50);
  });
});

describe('startSyncSequenceRetentionRunner', () => {
  const ANCIENT = '2000-01-01T00:00:00.000Z';
  let runner: SyncSequenceRetentionRunner | null = null;

  afterEach(() => {
    runner?.stop();
    runner = null;
  });

  function insertAncientOperations(count: number): void {
    for (let sequence = 1; sequence <= count; sequence++) {
      db.prepare(
        `
          INSERT INTO sync_operation (
            operation_uuid, project_uuid, origin_node_id, local_sequence, target_type,
            target_key, operation_type, payload, status, attempts, created_at, updated_at,
            batch_atomic
          ) VALUES (?, ?, 'remote-node', ?, 'plan', ?, 'plan.add_tag', '{}', 'applied', 0, ?, ?, 0)
        `
      ).run(crypto.randomUUID(), PROJECT_UUID, sequence, `plan:${sequence}`, ANCIENT, ANCIENT);
    }
  }

  function operationCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM sync_operation').get() as { n: number }).n;
  }

  test('continues pruning operations after a run stops at its batch limit', async () => {
    insertAncientOperations(3);

    runner = startSyncSequenceRetentionRunner({
      db,
      operationRetention: { batchSize: 1, maxBatches: 1 },
      operationFollowUpDelayMs: 1,
    });

    // The first run at start deletes one row; follow-up runs delete the rest.
    expect(operationCount()).toBe(2);
    await vi.waitFor(() => expect(operationCount()).toBe(0));
    expect(getOriginWatermark(db, 'remote-node')).toBe(3);
  });

  test('with pruneSequences false, prunes operations but not sync_sequence', () => {
    insertSequences(3, ANCIENT);
    insertAncientOperations(2);

    runner = startSyncSequenceRetentionRunner({ db, pruneSequences: false });

    expect(sequenceIds()).toHaveLength(3);
    expect(operationCount()).toBe(0);
  });

  test('stop cancels a pending follow-up run', async () => {
    insertAncientOperations(3);

    runner = startSyncSequenceRetentionRunner({
      db,
      operationRetention: { batchSize: 1, maxBatches: 1 },
      operationFollowUpDelayMs: 20,
    });
    runner.stop();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(operationCount()).toBe(2);
  });
});
