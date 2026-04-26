import type { Database } from 'bun:sqlite';

interface CursorFloorRow {
  peer_count: number;
  missing_cursor_count: number;
  min_cursor_seq: number | null;
}

interface WorkerLeaseFloorRow {
  active_lease_count: number;
  missing_high_water_count: number;
  min_high_water_seq: number | null;
}

/**
 * Return the highest sync_op_log.seq that future compaction may trim through,
 * or 0 when no compaction floor is established.
 *
 * The floor is constrained by:
 * - durable main peers: every non-local main peer must have a push cursor,
 *   because that cursor tracks the local op-log sequence last sent to that peer.
 * - active worker leases: every active lease must have a bundle high-water seq,
 *   because workers may still return operations causally based on that slice.
 *
 * Callers can use the returned value as `WHERE seq <= ?` for trimming once plan
 * 334 implements actual compaction. A return value of 0 means compact nothing.
 */
export function getCompactionFloorSeq(db: Database): number {
  const cursorFloor = db
    .prepare(
      `
        SELECT
          count(sn.node_id) AS peer_count,
          sum(CASE WHEN spc.last_op_id IS NULL THEN 1 ELSE 0 END) AS missing_cursor_count,
          min(CAST(spc.last_op_id AS INTEGER)) AS min_cursor_seq
        FROM sync_node sn
        LEFT JOIN sync_peer_cursor spc
          ON spc.peer_node_id = sn.node_id
         AND spc.direction = 'push'
        WHERE sn.node_type = 'main'
          AND sn.is_local = 0
      `
    )
    .get() as CursorFloorRow;

  const leaseFloor = db
    .prepare(
      `
        SELECT
          count(*) AS active_lease_count,
          sum(CASE WHEN bundle_high_water_seq IS NULL THEN 1 ELSE 0 END) AS missing_high_water_count,
          min(bundle_high_water_seq) AS min_high_water_seq
        FROM sync_worker_lease
        WHERE status = 'active'
      `
    )
    .get() as WorkerLeaseFloorRow;

  if (
    cursorFloor.missing_cursor_count > 0 ||
    leaseFloor.missing_high_water_count > 0
  ) {
    return 0;
  }

  // direction='push' is the local seq last confirmed received by the remote peer.
  // CAST(...AS INTEGER) coerces non-numeric values to 0; migration v28 already
  // resets unmappable legacy cursors to NULL so this should not happen in practice.
  const candidates: number[] = [];
  if (cursorFloor.peer_count > 0 && cursorFloor.min_cursor_seq !== null) {
    candidates.push(cursorFloor.min_cursor_seq);
  }
  // If no durable main peers are registered, an active worker lease alone
  // can establish a floor — workers are the only sync participants in that case.
  if (leaseFloor.active_lease_count > 0 && leaseFloor.min_high_water_seq !== null) {
    candidates.push(leaseFloor.min_high_water_seq);
  }

  if (candidates.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(...candidates));
}
