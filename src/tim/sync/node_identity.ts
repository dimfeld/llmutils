import type { Database } from 'bun:sqlite';

import type { NodeType, SyncNodeRow } from '../db/sync_schema.js';
import { ensureLocalNode as ensureLocalNodeRow, getLocalNode } from '../db/sync_schema.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';

export interface EnsureLocalNodeApiOptions {
  nodeType?: NodeType;
  label?: string;
}

export interface RegisterPeerNodeOptions {
  nodeId: string;
  nodeType: NodeType;
  label?: string | null;
  leaseExpiresAt?: string | null;
}

export function getLocalNodeId(db: Database): string {
  const node = getLocalNode(db);
  if (!node) {
    throw new Error('Local sync node is not initialized');
  }
  return node.node_id;
}

export function ensureLocalNode(
  db: Database,
  { nodeType = 'main', label }: EnsureLocalNodeApiOptions = {}
): SyncNodeRow {
  return ensureLocalNodeRow(db, {
    nodeType,
    label: label ?? null,
  });
}

export function registerPeerNode(
  db: Database,
  { nodeId, nodeType, label, leaseExpiresAt }: RegisterPeerNodeOptions
): SyncNodeRow {
  const upsert = db.transaction((): SyncNodeRow => {
    const existing = db
      .prepare('SELECT * FROM sync_node WHERE node_id = ?')
      .get(nodeId) as SyncNodeRow | null;

    if (existing) {
      if (existing.is_local === 1) {
        throw new Error(
          `Cannot register peer node ${nodeId}: that node id belongs to the local node`
        );
      }
      const resolvedNodeType =
        existing.node_type === 'transient' && nodeType !== 'transient'
          ? nodeType
          : existing.node_type;
      if (
        existing.node_type !== nodeType &&
        resolvedNodeType === existing.node_type &&
        nodeType !== 'transient'
      ) {
        throw new Error(
          `Cannot change sync node ${nodeId} type from '${existing.node_type}' to '${nodeType}'`
        );
      }

      db.prepare(
        `
          UPDATE sync_node
          SET node_type = ?,
              label = ?,
              lease_expires_at = ?,
              updated_at = ${SQL_NOW_ISO_UTC}
          WHERE node_id = ? AND is_local = 0
        `
      ).run(
        resolvedNodeType,
        label === undefined ? existing.label : label,
        leaseExpiresAt === undefined ? existing.lease_expires_at : leaseExpiresAt,
        nodeId
      );
    } else {
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
          ) VALUES (?, ?, 0, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        `
      ).run(nodeId, nodeType, label ?? null, leaseExpiresAt ?? null);
    }

    const row = db
      .prepare('SELECT * FROM sync_node WHERE node_id = ?')
      .get(nodeId) as SyncNodeRow | null;
    if (!row) {
      throw new Error(`Failed to register sync peer node ${nodeId}`);
    }
    return row;
  });

  return upsert.immediate();
}

export function listPeerNodes(db: Database): SyncNodeRow[] {
  return db
    .prepare('SELECT * FROM sync_node WHERE is_local = 0 ORDER BY node_id')
    .all() as SyncNodeRow[];
}

export function setWorkerLeaseExpiry(
  db: Database,
  nodeId: string,
  expiresAt: string | null
): SyncNodeRow | null {
  db.prepare(
    `
      UPDATE sync_node
      SET lease_expires_at = ?, updated_at = ${SQL_NOW_ISO_UTC}
      WHERE node_id = ? AND node_type = 'worker'
    `
  ).run(expiresAt, nodeId);

  return db.prepare('SELECT * FROM sync_node WHERE node_id = ?').get(nodeId) as SyncNodeRow | null;
}
