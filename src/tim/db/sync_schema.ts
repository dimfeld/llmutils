import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type NodeType = 'main' | 'worker' | 'transient' | 'retired_worker' | 'retired_main';
export type SyncDirection = 'pull' | 'push';

export interface SyncNodeRow {
  node_id: string;
  node_type: NodeType;
  is_local: number;
  label: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncClockRow {
  id: 1;
  physical_ms: number;
  logical: number;
  local_counter: number;
  updated_at: string;
  bootstrap_completed_at: string | null;
  compacted_through_seq: number;
}

export interface SyncOpLogRow {
  seq: number;
  op_id: string;
  node_id: string;
  hlc_physical_ms: number;
  hlc_logical: number;
  local_counter: number;
  entity_type: string;
  entity_id: string;
  op_type: string;
  payload: string;
  base: string | null;
  created_at: string;
}

export interface SyncPeerCursorRow {
  peer_node_id: string;
  direction: SyncDirection;
  hlc_physical_ms: number;
  hlc_logical: number;
  /**
   * Transport cursor stored as a sync_op_log.seq string, despite the legacy
   * column name. HLC is telemetry only and must not be used for paging.
   */
  last_op_id: string | null;
  updated_at: string;
}

export interface SyncFieldClockRow {
  entity_type: string;
  entity_id: string;
  field_name: string;
  hlc_physical_ms: number;
  hlc_logical: number;
  node_id: string;
  deleted: number;
  updated_at: string;
}

export interface SyncTombstoneRow {
  entity_type: string;
  entity_id: string;
  hlc_physical_ms: number;
  hlc_logical: number;
  node_id: string;
  created_at: string;
}

export interface SyncEdgeClockRow {
  entity_type: 'plan_dependency' | 'plan_tag';
  edge_key: string;
  add_hlc: string | null;
  add_node_id: string | null;
  remove_hlc: string | null;
  remove_node_id: string | null;
  updated_at: string;
}

export interface SyncPendingOpRow {
  peer_node_id: string;
  op_id: string;
  op_json: string;
  first_deferred_at: string;
  retry_count: number;
}

export type WorkerLeaseStatus = 'active' | 'completed' | 'expired';

export interface SyncWorkerLeaseRow {
  worker_node_id: string;
  issuing_node_id: string;
  target_plan_uuid: string | null;
  bundle_high_water_seq: number | null;
  bundle_high_water_hlc: string | null;
  lease_expires_at: string;
  status: WorkerLeaseStatus;
  last_returned_at: string | null;
  completion_requested_at: string | null;
  metadata: string | null;
  created_at: string;
}

export interface CreateWorkerLeaseInput {
  workerNodeId: string;
  issuingNodeId: string;
  targetPlanUuid?: string | null;
  bundleHighWaterSeq?: number | null;
  bundleHighWaterHlc?: string | null;
  leaseExpiresAt: string;
  metadata?: unknown;
}

export interface OpLogChunk {
  ops: SyncOpLogRow[];
  nextAfterSeq: string | null;
  hasMore: boolean;
}

export interface EnsureLocalNodeOptions {
  nodeId?: string;
  nodeType?: NodeType;
  label?: string | null;
  leaseExpiresAt?: string | null;
}

export function getLocalNode(db: Database): SyncNodeRow | null {
  return db.prepare('SELECT * FROM sync_node WHERE is_local = 1').get() as SyncNodeRow | null;
}

export function ensureLocalNode(db: Database, opts: EnsureLocalNodeOptions = {}): SyncNodeRow {
  const ensure = db.transaction((options: EnsureLocalNodeOptions): SyncNodeRow => {
    const existing = getLocalNode(db);
    if (existing) {
      return existing;
    }

    const nodeId = options.nodeId ?? randomUUID();
    db.prepare(
      `
        INSERT INTO sync_node (
          node_id,
          node_type,
          is_local,
          label,
          lease_expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, 1, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      `
    ).run(
      nodeId,
      options.nodeType ?? 'main',
      options.label ?? null,
      options.leaseExpiresAt ?? null
    );

    const created = getLocalNode(db);
    if (!created) {
      throw new Error('Failed to create local sync node');
    }
    return created;
  });

  return ensure.immediate(opts);
}

export function getOrCreateClockRow(db: Database): SyncClockRow {
  db.prepare(
    `
      INSERT OR IGNORE INTO sync_clock (
        id,
        physical_ms,
        logical,
        local_counter,
        updated_at
      ) VALUES (1, 0, 0, 0, ${SQL_NOW_ISO_UTC})
    `
  ).run();

  const row = db.prepare('SELECT * FROM sync_clock WHERE id = 1').get() as SyncClockRow | null;
  if (!row) {
    throw new Error('Failed to create or fetch sync clock row');
  }
  return row;
}

function parseSeqCursor(seqText: string): number {
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isInteger(seq) || seq < 0 || String(seq) !== seqText) {
    throw new Error(`Invalid sync op seq cursor: ${seqText}`);
  }
  return seq;
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid sync op chunk limit: ${limit}`);
  }
  return Math.min(limit, 10_000);
}

export function getOpLogChunkAfter(
  db: Database,
  afterSeq: string | null | undefined,
  limit: number
): OpLogChunk {
  const safeLimit = normalizeLimit(limit);
  const fetchLimit = safeLimit + 1;
  let cursorSeq = 0;
  if (afterSeq) {
    cursorSeq = parseSeqCursor(afterSeq);
  }

  const rows = db
    .prepare(
      `
        SELECT *
        FROM sync_op_log
        WHERE seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `
    )
    .all(cursorSeq, fetchLimit) as SyncOpLogRow[];

  const ops = rows.slice(0, safeLimit);
  return {
    ops,
    nextAfterSeq: ops.at(-1)?.seq?.toString() ?? afterSeq ?? null,
    hasMore: rows.length > safeLimit,
  };
}

export function getPeerCursor(
  db: Database,
  peerNodeId: string,
  direction: SyncDirection
): SyncPeerCursorRow | null {
  return db
    .prepare('SELECT * FROM sync_peer_cursor WHERE peer_node_id = ? AND direction = ?')
    .get(peerNodeId, direction) as SyncPeerCursorRow | null;
}

export function setPeerCursor(
  db: Database,
  peerNodeId: string,
  direction: SyncDirection,
  lastSeq: string | null,
  clockSource?: Pick<SyncOpLogRow, 'hlc_physical_ms' | 'hlc_logical'> | null
): SyncPeerCursorRow {
  const existing = getPeerCursor(db, peerNodeId, direction);
  if (existing) {
    if (lastSeq === null) {
      return existing;
    }
    const existingSeq = existing.last_op_id === null ? 0 : parseSeqCursor(existing.last_op_id);
    const nextSeq = parseSeqCursor(lastSeq);
    if (nextSeq <= existingSeq) {
      // Equal or older seq writes intentionally drop any clockSource update too:
      // the cursor row represents a monotonic transport position, not a clock log.
      return existing;
    }
  }

  const physicalMs = clockSource?.hlc_physical_ms ?? 0;
  const logical = clockSource?.hlc_logical ?? 0;

  db.prepare(
    `
      INSERT INTO sync_peer_cursor (
        peer_node_id,
        direction,
        hlc_physical_ms,
        hlc_logical,
        last_op_id,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(peer_node_id, direction) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        last_op_id = excluded.last_op_id,
        updated_at = ${SQL_NOW_ISO_UTC}
      WHERE CAST(excluded.last_op_id AS INTEGER) >
        COALESCE(CAST(sync_peer_cursor.last_op_id AS INTEGER), 0)
    `
  ).run(peerNodeId, direction, physicalMs, logical, lastSeq);

  const row = getPeerCursor(db, peerNodeId, direction);
  if (!row) {
    throw new Error(`Failed to write ${direction} sync cursor for peer ${peerNodeId}`);
  }
  return row;
}

export function listPendingOps(db: Database, peerNodeId: string): SyncPendingOpRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM sync_pending_op
        WHERE peer_node_id = ?
        ORDER BY first_deferred_at, op_id
      `
    )
    .all(peerNodeId) as SyncPendingOpRow[];
}

export function upsertPendingOp(
  db: Database,
  peerNodeId: string,
  op: Pick<SyncOpLogRow, 'op_id'>,
  opJson: string
): void {
  db.prepare(
    `
      INSERT INTO sync_pending_op (
        peer_node_id,
        op_id,
        op_json,
        first_deferred_at,
        retry_count
      ) VALUES (?, ?, ?, ${SQL_NOW_ISO_UTC}, 0)
      ON CONFLICT(peer_node_id, op_id) DO UPDATE SET
        op_json = excluded.op_json,
        retry_count = sync_pending_op.retry_count + 1
    `
  ).run(peerNodeId, op.op_id, opJson);
}

export function deletePendingOp(db: Database, peerNodeId: string, opId: string): void {
  db.prepare('DELETE FROM sync_pending_op WHERE peer_node_id = ? AND op_id = ?').run(
    peerNodeId,
    opId
  );
}

export function createWorkerLease(db: Database, input: CreateWorkerLeaseInput): SyncWorkerLeaseRow {
  const metadata =
    input.metadata === undefined || input.metadata === null ? null : JSON.stringify(input.metadata);
  db.prepare(
    `
      INSERT INTO sync_worker_lease (
        worker_node_id,
        issuing_node_id,
        target_plan_uuid,
        bundle_high_water_seq,
        bundle_high_water_hlc,
        lease_expires_at,
        status,
        last_returned_at,
        completion_requested_at,
        metadata,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(worker_node_id) DO UPDATE SET
        issuing_node_id = excluded.issuing_node_id,
        target_plan_uuid = excluded.target_plan_uuid,
        bundle_high_water_seq = excluded.bundle_high_water_seq,
        bundle_high_water_hlc = excluded.bundle_high_water_hlc,
        lease_expires_at = excluded.lease_expires_at,
        status = 'active',
        last_returned_at = NULL,
        completion_requested_at = NULL,
        metadata = excluded.metadata
    `
  ).run(
    input.workerNodeId,
    input.issuingNodeId,
    input.targetPlanUuid ?? null,
    input.bundleHighWaterSeq ?? null,
    input.bundleHighWaterHlc ?? null,
    input.leaseExpiresAt,
    metadata
  );

  const row = getWorkerLease(db, input.workerNodeId);
  if (!row) {
    throw new Error(`Failed to create worker lease for ${input.workerNodeId}`);
  }
  return row;
}

export function getWorkerLease(db: Database, workerNodeId: string): SyncWorkerLeaseRow | null {
  return db
    .prepare('SELECT * FROM sync_worker_lease WHERE worker_node_id = ?')
    .get(workerNodeId) as SyncWorkerLeaseRow | null;
}

export function listActiveWorkerLeases(db: Database): SyncWorkerLeaseRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM sync_worker_lease
        WHERE status = 'active'
        ORDER BY lease_expires_at, worker_node_id
      `
    )
    .all() as SyncWorkerLeaseRow[];
}

export function markWorkerLeaseCompleted(
  db: Database,
  workerNodeId: string
): SyncWorkerLeaseRow | null {
  db.prepare(
    `
      UPDATE sync_worker_lease
      SET status = 'completed',
          last_returned_at = ${SQL_NOW_ISO_UTC},
          completion_requested_at = COALESCE(completion_requested_at, ${SQL_NOW_ISO_UTC})
      WHERE worker_node_id = ?
    `
  ).run(workerNodeId);
  return getWorkerLease(db, workerNodeId);
}

export function markWorkerLeaseCompletionRequested(
  db: Database,
  workerNodeId: string
): SyncWorkerLeaseRow | null {
  db.prepare(
    `
      UPDATE sync_worker_lease
      SET completion_requested_at = COALESCE(completion_requested_at, ${SQL_NOW_ISO_UTC}),
          last_returned_at = ${SQL_NOW_ISO_UTC}
      WHERE worker_node_id = ?
        AND status = 'active'
    `
  ).run(workerNodeId);
  return getWorkerLease(db, workerNodeId);
}

export function markWorkerLeaseReturned(
  db: Database,
  workerNodeId: string
): SyncWorkerLeaseRow | null {
  db.prepare(
    `
      UPDATE sync_worker_lease
      SET last_returned_at = ${SQL_NOW_ISO_UTC}
      WHERE worker_node_id = ?
        AND status = 'active'
    `
  ).run(workerNodeId);
  return getWorkerLease(db, workerNodeId);
}

export function countPendingOps(db: Database, peerNodeId: string): number {
  return (
    db
      .prepare('SELECT count(*) AS count FROM sync_pending_op WHERE peer_node_id = ?')
      .get(peerNodeId) as { count: number }
  ).count;
}

export function completeWorkerLeaseIfReady(
  db: Database,
  workerNodeId: string
): SyncWorkerLeaseRow | null {
  const lease = getWorkerLease(db, workerNodeId);
  if (!lease || lease.status !== 'active' || lease.completion_requested_at === null) {
    return lease;
  }
  if (countPendingOps(db, workerNodeId) > 0) {
    return lease;
  }
  return markWorkerLeaseCompleted(db, workerNodeId);
}

export function expireWorkerLease(db: Database, workerNodeId: string): SyncWorkerLeaseRow | null {
  db.prepare(
    `
      UPDATE sync_worker_lease
      SET status = 'expired'
      WHERE worker_node_id = ?
        AND status = 'active'
    `
  ).run(workerNodeId);
  return getWorkerLease(db, workerNodeId);
}

export const createLease = createWorkerLease;
export const getLease = getWorkerLease;
export const listActiveLeases = listActiveWorkerLeases;
export const markLeaseCompleted = markWorkerLeaseCompleted;
export const expireLease = expireWorkerLease;
export const markLeaseCompletionRequested = markWorkerLeaseCompletionRequested;
export const markLeaseReturned = markWorkerLeaseReturned;
