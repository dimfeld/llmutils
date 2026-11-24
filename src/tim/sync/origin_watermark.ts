import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';

/**
 * Statuses that count toward the FIFO floor in `checkFifo`. The watermark of an origin
 * is always at least the highest `local_sequence` of a deleted row with one of these
 * statuses, so pruning old rows never lowers the floor.
 */
export const FIFO_TERMINAL_OPERATION_STATUSES = [
  'applied',
  'conflict',
  'rejected',
  'cleared_rejected',
] as const;

export function getOriginWatermark(db: Database, originNodeId: string): number | null {
  const row = db
    .prepare('SELECT terminal_through_sequence FROM sync_origin_watermark WHERE origin_node_id = ?')
    .get(originNodeId) as { terminal_through_sequence: number } | null;
  return row?.terminal_through_sequence ?? null;
}

/** Raise the watermark of an origin to `sequence`. Never lowers it. */
export function raiseOriginWatermark(db: Database, originNodeId: string, sequence: number): void {
  db.prepare(
    `
      INSERT INTO sync_origin_watermark (origin_node_id, terminal_through_sequence, updated_at)
      VALUES (?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(origin_node_id) DO UPDATE SET
        terminal_through_sequence = MAX(terminal_through_sequence, excluded.terminal_through_sequence),
        updated_at = excluded.updated_at
    `
  ).run(originNodeId, sequence);
}
