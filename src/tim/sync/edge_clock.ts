import type { Database } from 'bun:sqlite';

import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { SyncOpLogRow } from '../db/sync_schema.js';
import { compareHlc, formatHlc, parseHlc, type Hlc } from './hlc.js';

export type SyncEdgeEntityType = 'plan_dependency' | 'plan_tag';

export interface SyncEdgeClockRow {
  entity_type: SyncEdgeEntityType;
  edge_key: string;
  add_hlc: string | null;
  add_node_id: string | null;
  remove_hlc: string | null;
  remove_node_id: string | null;
  updated_at: string;
}

export interface EdgeClockInput {
  entityType: SyncEdgeEntityType;
  edgeKey: string;
  hlc: Hlc;
  nodeId: string;
}

export function getEdgeClock(
  db: Database,
  entityType: SyncEdgeEntityType,
  edgeKey: string
): SyncEdgeClockRow | null {
  return db
    .prepare('SELECT * FROM sync_edge_clock WHERE entity_type = ? AND edge_key = ?')
    .get(entityType, edgeKey) as SyncEdgeClockRow | null;
}

export function compareClockParts(
  leftHlc: Hlc,
  leftNodeId: string,
  rightHlc: Hlc,
  rightNodeId: string
): number {
  const byHlc = compareHlc(leftHlc, rightHlc);
  if (byHlc !== 0) return byHlc;
  return leftNodeId.localeCompare(rightNodeId);
}

export function edgeClockPartWins(
  incomingHlc: Hlc,
  incomingNodeId: string,
  storedHlc: string | null,
  storedNodeId: string | null
): boolean {
  if (!storedHlc || !storedNodeId) return true;
  return compareClockParts(incomingHlc, incomingNodeId, parseHlc(storedHlc), storedNodeId) > 0;
}

export function writeEdgeAddClock(db: Database, input: EdgeClockInput): boolean {
  const current = getEdgeClock(db, input.entityType, input.edgeKey);
  if (
    !edgeClockPartWins(
      input.hlc,
      input.nodeId,
      current?.add_hlc ?? null,
      current?.add_node_id ?? null
    )
  ) {
    return false;
  }
  db.prepare(
    `
      INSERT INTO sync_edge_clock (
        entity_type,
        edge_key,
        add_hlc,
        add_node_id,
        remove_hlc,
        remove_node_id,
        updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(entity_type, edge_key) DO UPDATE SET
        add_hlc = excluded.add_hlc,
        add_node_id = excluded.add_node_id,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(input.entityType, input.edgeKey, formatHlc(input.hlc), input.nodeId);
  return true;
}

export function writeEdgeRemoveClock(db: Database, input: EdgeClockInput): boolean {
  const current = getEdgeClock(db, input.entityType, input.edgeKey);
  if (
    !edgeClockPartWins(
      input.hlc,
      input.nodeId,
      current?.remove_hlc ?? null,
      current?.remove_node_id ?? null
    )
  ) {
    return false;
  }
  db.prepare(
    `
      INSERT INTO sync_edge_clock (
        entity_type,
        edge_key,
        add_hlc,
        add_node_id,
        remove_hlc,
        remove_node_id,
        updated_at
      ) VALUES (?, ?, NULL, NULL, ?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(entity_type, edge_key) DO UPDATE SET
        remove_hlc = excluded.remove_hlc,
        remove_node_id = excluded.remove_node_id,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(input.entityType, input.edgeKey, formatHlc(input.hlc), input.nodeId);
  return true;
}

export function edgeClockIsPresent(clock: SyncEdgeClockRow | null): boolean {
  if (!clock?.add_hlc || !clock.add_node_id) return false;
  if (!clock.remove_hlc || !clock.remove_node_id) return true;
  return (
    compareClockParts(
      parseHlc(clock.add_hlc),
      clock.add_node_id,
      parseHlc(clock.remove_hlc),
      clock.remove_node_id
    ) > 0
  );
}

export function opLogRowHlc(row: Pick<SyncOpLogRow, 'hlc_physical_ms' | 'hlc_logical'>): Hlc {
  return { physicalMs: row.hlc_physical_ms, logical: row.hlc_logical };
}
