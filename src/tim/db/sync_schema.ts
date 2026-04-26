import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type NodeType = 'main' | 'worker';
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
}

export interface SyncOpLogRow {
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

export interface OpLogChunk {
  ops: SyncOpLogRow[];
  nextAfterOpId: string | null;
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

function cursorPartsForOpId(db: Database, opId: string): SyncOpLogRow {
  const row = db
    .prepare('SELECT * FROM sync_op_log WHERE op_id = ?')
    .get(opId) as SyncOpLogRow | null;
  if (!row) {
    throw new Error(`Unknown sync op cursor: ${opId}`);
  }
  return row;
}

function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid sync op chunk limit: ${limit}`);
  }
  return Math.min(limit, 10_000);
}

export function getOpLogChunkAfter(
  db: Database,
  afterOpId: string | null | undefined,
  limit: number
): OpLogChunk {
  const safeLimit = normalizeLimit(limit);
  const fetchLimit = safeLimit + 1;
  let rows: SyncOpLogRow[];

  if (afterOpId) {
    const cursor = cursorPartsForOpId(db, afterOpId);
    rows = db
      .prepare(
        `
          SELECT *
          FROM sync_op_log
          WHERE
            hlc_physical_ms > ?
            OR (hlc_physical_ms = ? AND hlc_logical > ?)
            OR (hlc_physical_ms = ? AND hlc_logical = ? AND node_id > ?)
            OR (
              hlc_physical_ms = ?
              AND hlc_logical = ?
              AND node_id = ?
              AND local_counter > ?
            )
          ORDER BY hlc_physical_ms, hlc_logical, node_id, local_counter
          LIMIT ?
        `
      )
      .all(
        cursor.hlc_physical_ms,
        cursor.hlc_physical_ms,
        cursor.hlc_logical,
        cursor.hlc_physical_ms,
        cursor.hlc_logical,
        cursor.node_id,
        cursor.hlc_physical_ms,
        cursor.hlc_logical,
        cursor.node_id,
        cursor.local_counter,
        fetchLimit
      ) as SyncOpLogRow[];
  } else {
    rows = db
      .prepare(
        `
          SELECT *
          FROM sync_op_log
          ORDER BY hlc_physical_ms, hlc_logical, node_id, local_counter
          LIMIT ?
        `
      )
      .all(fetchLimit) as SyncOpLogRow[];
  }

  const ops = rows.slice(0, safeLimit);
  return {
    ops,
    nextAfterOpId: ops.at(-1)?.op_id ?? afterOpId ?? null,
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
  lastOpId: string | null
): SyncPeerCursorRow {
  let physicalMs = 0;
  let logical = 0;
  if (lastOpId) {
    const op = cursorPartsForOpId(db, lastOpId);
    physicalMs = op.hlc_physical_ms;
    logical = op.hlc_logical;
  }

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
    `
  ).run(peerNodeId, direction, physicalMs, logical, lastOpId);

  const row = getPeerCursor(db, peerNodeId, direction);
  if (!row) {
    throw new Error(`Failed to write ${direction} sync cursor for peer ${peerNodeId}`);
  }
  return row;
}
