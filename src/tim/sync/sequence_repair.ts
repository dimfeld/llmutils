import type { Database } from 'bun:sqlite';
import { getOriginWatermark, raiseOriginWatermark } from './origin_watermark.js';

/**
 * Make sure that the FIFO floor of each origin reaches its highest allocated local
 * sequence. `checkFifo` takes the next expected sequence from the max of
 * MAX(local_sequence) and the origin watermark, so only a gap at the top of the
 * sequence can block new operations. Gaps lower down (for example, from rejected rows
 * that an older version deleted) have no effect and are not filled.
 *
 * When the top slot has no row and the watermark is below it, the watermark is raised
 * to `next_sequence - 1`. Returns the number of origins that were repaired.
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
  let repaired = 0;
  for (const row of nodeRows) {
    const topSequence = row.next_sequence - 1;
    if (topSequence < 0) {
      continue;
    }
    const { max_sequence } = maxSequence.get(row.node_id) as { max_sequence: number | null };
    const floor = Math.max(max_sequence ?? -1, getOriginWatermark(db, row.node_id) ?? -1);
    if (floor >= topSequence) {
      continue;
    }
    raiseOriginWatermark(db, row.node_id, topSequence);
    repaired += 1;
  }
  return repaired;
}
