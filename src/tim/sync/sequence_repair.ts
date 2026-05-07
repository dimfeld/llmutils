import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';

export function repairClearedRejectedSequenceMarkers(
  db: Database,
  options: { originNodeId?: string } = {}
): number {
  const nodeRows = options.originNodeId
    ? (db
        .prepare('SELECT node_id, next_sequence FROM tim_node_sequence WHERE node_id = ?')
        .all(options.originNodeId) as Array<{ node_id: string; next_sequence: number }>)
    : (db
        .prepare('SELECT node_id, next_sequence FROM tim_node_sequence ORDER BY node_id')
        .all() as Array<{ node_id: string; next_sequence: number }>);
  const hasSequence = db.prepare(
    'SELECT 1 FROM sync_operation WHERE origin_node_id = ? AND local_sequence = ? LIMIT 1'
  );
  const insertMarker = db.prepare(
    `
      INSERT INTO sync_operation (
        operation_uuid,
        project_uuid,
        origin_node_id,
        local_sequence,
        target_type,
        target_key,
        operation_type,
        base_revision,
        base_hash,
        payload,
        status,
        attempts,
        last_error,
        created_at,
        updated_at,
        acked_at,
        ack_metadata,
        batch_atomic
      ) VALUES (?, '', ?, ?, 'sync', ?, 'sync.cleared_rejected', NULL, NULL, '{}',
        'cleared_rejected', 0, 'Rejected operation record was cleared', ${SQL_NOW_ISO_UTC},
        ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC}, '{"cleared":true}', 0)
    `
  );
  let repaired = 0;
  for (const row of nodeRows) {
    for (let localSequence = 0; localSequence < row.next_sequence; localSequence++) {
      const existing = hasSequence.get(row.node_id, localSequence);
      if (existing) {
        continue;
      }
      insertMarker.run(
        randomUUID(),
        row.node_id,
        localSequence,
        `sync:${row.node_id}:${localSequence}`
      );
      repaired += 1;
    }
  }
  return repaired;
}
