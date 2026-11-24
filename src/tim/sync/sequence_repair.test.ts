import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { openDatabase } from '../db/database.js';
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

  function sequences(nodeId: string): number[] {
    return (
      db
        .prepare(
          'SELECT local_sequence FROM sync_operation WHERE origin_node_id = ? ORDER BY local_sequence'
        )
        .all(nodeId) as Array<{ local_sequence: number }>
    ).map((row) => row.local_sequence);
  }

  test('does nothing when no sequence was allocated', () => {
    setNextSequence('node-a', 0);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
    expect(sequences('node-a')).toEqual([]);
  });

  test('adds one marker at the top slot and leaves lower gaps empty', () => {
    setNextSequence('node-a', 1);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(1);
    expect(sequences('node-a')).toEqual([0]);

    setNextSequence('node-a', 5);
    expect(repairClearedRejectedSequenceMarkers(db, { originNodeId: 'node-a' })).toBe(1);
    expect(sequences('node-a')).toEqual([0, 4]);

    const marker = db
      .prepare(
        'SELECT status, operation_type, target_key FROM sync_operation WHERE origin_node_id = ? AND local_sequence = 4'
      )
      .get('node-a');
    expect(marker).toEqual({
      status: 'cleared_rejected',
      operation_type: 'sync.cleared_rejected',
      target_key: 'sync:node-a:4',
    });
  });

  test('is a no-op when the top slot already has a row', () => {
    setNextSequence('node-a', 3);
    repairClearedRejectedSequenceMarkers(db);
    expect(repairClearedRejectedSequenceMarkers(db)).toBe(0);
    expect(sequences('node-a')).toEqual([2]);
  });

  test('only repairs the given origin when originNodeId is set', () => {
    setNextSequence('node-a', 2);
    setNextSequence('node-b', 2);
    expect(repairClearedRejectedSequenceMarkers(db, { originNodeId: 'node-b' })).toBe(1);
    expect(sequences('node-a')).toEqual([]);
    expect(sequences('node-b')).toEqual([1]);
  });
});
