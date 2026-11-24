import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';

/**
 * Make sure that the highest allocated local sequence of each origin has a sync_operation
 * row. `checkFifo` takes the next expected sequence from MAX(local_sequence), so only a
 * gap at the top of the sequence can block new operations. Gaps lower down (for example,
 * from rejected rows that an older version deleted) have no effect and are not filled.
 *
 * When the top slot is missing, one `cleared_rejected` marker row is added at
 * `next_sequence - 1`. Returns the number of marker rows added.
 */
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
  // Uses the UNIQUE(origin_node_id, local_sequence) index.
  const maxSequence = db.prepare(
    'SELECT MAX(local_sequence) AS max_sequence FROM sync_operation WHERE origin_node_id = ?'
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
    const topSequence = row.next_sequence - 1;
    if (topSequence < 0) {
      continue;
    }
    const { max_sequence } = maxSequence.get(row.node_id) as { max_sequence: number | null };
    if (max_sequence !== null && max_sequence >= topSequence) {
      continue;
    }
    insertMarker.run(randomUUID(), row.node_id, topSequence, `sync:${row.node_id}:${topSequence}`);
    repaired += 1;
  }
  return repaired;
}
