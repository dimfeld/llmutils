import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from '../db/database.js';
import { getOriginWatermark, raiseOriginWatermark } from './origin_watermark.js';
import { repairClearedRejectedSequenceMarkers } from './sequence_repair.js';

describe('repairClearedRejectedSequenceMarkers', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  function setNextSequence(nodeId: string, nextSequence: number): void {
    db.prepare(
      `INSERT INTO tim_node_sequence (node_id, next_sequence, updated_at)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z')
       ON CONFLICT(node_id) DO UPDATE SET next_sequence = excluded.next_sequence`
    ).run(nodeId, nextSequence);
  }

  function insertOperationRow(nodeId: string, localSequence: number, status: string): void {
    db.prepare(
      `INSERT INTO sync_operation (
         operation_uuid, project_uuid, origin_node_id, local_sequence, target_type, target_key,
         operation_type, payload, status, attempts, created_at, updated_at, batch_atomic
       ) VALUES (?, '', ?, ?, 'sync', ?, 'test.op', '{}', ?, 0,
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 0)`
    ).run(`${nodeId}-${localSequence}`, nodeId, localSequence, `k:${localSequence}`, status);
  }

  test('does nothing when no sequence was allocated', () => {
    setNextSequence('node-a', 0);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
    expect(getOriginWatermark(db, 'node-a')).toBeNull();
  });

  test('raises the watermark to the top slot and adds no rows', () => {
    insertOperationRow('node-a', 0, 'applied');
    setNextSequence('node-a', 5);

    expect(repairClearedRejectedSequenceMarkers(db, { originNodeId: 'node-a' })).toBe(1);
    expect(getOriginWatermark(db, 'node-a')).toBe(4);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_operation').get()).toEqual({ n: 1 });

    // A second call finds the floor already at the top.
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
  });

  test('is a no-op when the top slot has a row', () => {
    insertOperationRow('node-a', 2, 'applied');
    setNextSequence('node-a', 3);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
    expect(getOriginWatermark(db, 'node-a')).toBeNull();
  });

  test('is a no-op when the watermark already covers the top slot', () => {
    raiseOriginWatermark(db, 'node-a', 7);
    setNextSequence('node-a', 5);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
    expect(getOriginWatermark(db, 'node-a')).toBe(7);
  });

  test('only repairs the given origin when originNodeId is set', () => {
    setNextSequence('node-a', 2);
    setNextSequence('node-b', 2);
    expect(repairClearedRejectedSequenceMarkers(db, { originNodeId: 'node-b' })).toBe(1);
    expect(getOriginWatermark(db, 'node-a')).toBeNull();
    expect(getOriginWatermark(db, 'node-b')).toBe(1);
  });
});

describe('raiseOriginWatermark', () => {
  test('never lowers the watermark', () => {
    const db = openDatabase(':memory:');
    try {
      raiseOriginWatermark(db, 'node-a', 10);
      raiseOriginWatermark(db, 'node-a', 3);
      expect(getOriginWatermark(db, 'node-a')).toBe(10);
      raiseOriginWatermark(db, 'node-a', 12);
      expect(getOriginWatermark(db, 'node-a')).toBe(12);
    } finally {
      db.close(false);
    }
  });
});
