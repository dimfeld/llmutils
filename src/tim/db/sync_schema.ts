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
