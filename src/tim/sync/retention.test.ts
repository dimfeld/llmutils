import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { updateTimNodeCursor, upsertTimNode } from '../db/sync_tables.js';
import { pruneSyncSequence } from './retention.js';
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
