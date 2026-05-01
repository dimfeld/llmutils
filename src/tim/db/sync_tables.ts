import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import { getSyncOperationPayloadIndexes } from '../sync/payload_indexes.js';
import { getSyncOperationPlanRefs } from '../sync/plan_refs.js';

export type TimNodeRole = 'main' | 'persistent' | 'ephemeral';

export interface TimNodeRow {
  node_id: string;
  role: TimNodeRole;
  label: string | null;
  token_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncOperationRow {
  operation_uuid: string;
  project_uuid: string;
  origin_node_id: string;
  local_sequence: number;
  target_type: string;
  target_key: string;
  operation_type: string;
  base_revision: number | null;
  base_hash: string | null;
  payload: string;
  payload_task_uuid: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
  ack_metadata: string | null;
}

export interface SyncConflictRow {
  conflict_id: string;
  operation_uuid: string;
  project_uuid: string;
  target_type: string;
  target_key: string;
  field_path: string | null;
  base_value: string | null;
  base_hash: string | null;
  incoming_value: string | null;
  attempted_patch: string | null;
  current_value: string | null;
  original_payload: string;
  normalized_payload: string;
  reason: string;
  status: string;
  origin_node_id: string;
  created_at: string;
  resolved_at: string | null;
  resolution: string | null;
  resolved_by_node: string | null;
}

export interface SyncTombstoneRow {
  entity_type: string;
  entity_key: string;
  project_uuid: string;
  deletion_operation_uuid: string;
  deleted_revision: number | null;
  deleted_at: string;
  origin_node_id: string;
}

export interface SyncSequenceRow {
  sequence: number;
  project_uuid: string;
  target_type: string;
  target_key: string;
  revision: number | null;
  operation_uuid: string | null;
  origin_node_id: string | null;
  created_at: string;
}

export interface TimNodeCursorRow {
  node_id: string;
  last_known_sequence_id: number;
  updated_at: string;
}

export function upsertTimNode(
  db: Database,
  node: {
    nodeId: string;
    role: TimNodeRole;
    label?: string | null;
    tokenHash?: string | null;
  }
): TimNodeRow {
  const upsert = db.transaction((nextNode: typeof node): TimNodeRow => {
    db.prepare(
      `
        INSERT INTO tim_node (node_id, role, label, token_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(node_id) DO UPDATE SET
          role = excluded.role,
          label = excluded.label,
          token_hash = excluded.token_hash,
          updated_at = ${SQL_NOW_ISO_UTC}
      `
    ).run(nextNode.nodeId, nextNode.role, nextNode.label ?? null, nextNode.tokenHash ?? null);

    const row = getTimNode(db, nextNode.nodeId);
    if (!row) {
      throw new Error(`Failed to upsert tim node ${nextNode.nodeId}`);
    }
    return row;
  });

  return upsert.immediate(node);
}

export function insertTimNodeIfMissing(
  db: Database,
  node: {
    nodeId: string;
    role: TimNodeRole;
    label?: string | null;
    tokenHash?: string | null;
  }
): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO tim_node (node_id, role, label, token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    `
  ).run(node.nodeId, node.role, node.label ?? null, node.tokenHash ?? null);
}

export function getTimNode(db: Database, nodeId: string): TimNodeRow | null {
  return (
    (db.prepare('SELECT * FROM tim_node WHERE node_id = ?').get(nodeId) as TimNodeRow | null) ??
    null
  );
}

export function getTimNodeCursor(db: Database, nodeId: string): TimNodeCursorRow {
  db.prepare(
    `
      INSERT OR IGNORE INTO tim_node_cursor (node_id, last_known_sequence_id, updated_at)
      VALUES (?, 0, ${SQL_NOW_ISO_UTC})
    `
  ).run(nodeId);

  const row = db
    .prepare('SELECT * FROM tim_node_cursor WHERE node_id = ?')
    .get(nodeId) as TimNodeCursorRow | null;
  if (!row) {
    throw new Error(`Failed to read sync cursor for node ${nodeId}`);
  }
  return row;
}

export function updateTimNodeCursor(
  db: Database,
  nodeId: string,
  lastKnownSequenceId: number
): TimNodeCursorRow {
  if (!Number.isInteger(lastKnownSequenceId) || lastKnownSequenceId < 0) {
    throw new Error(`Invalid sync cursor sequence ${lastKnownSequenceId}`);
  }

  db.prepare(
    `
      INSERT INTO tim_node_cursor (node_id, last_known_sequence_id, updated_at)
      VALUES (?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(node_id) DO UPDATE SET
        last_known_sequence_id = MAX(tim_node_cursor.last_known_sequence_id, excluded.last_known_sequence_id),
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(nodeId, lastKnownSequenceId);

  return getTimNodeCursor(db, nodeId);
}

export function insertSyncOperation(
  db: Database,
  operation: Omit<
    SyncOperationRow,
    'created_at' | 'updated_at' | 'attempts' | 'payload_task_uuid'
  > & {
    attempts?: number;
    created_at?: string;
    updated_at?: string;
  }
): SyncOperationRow {
  const insert = db.transaction((nextOperation: typeof operation): SyncOperationRow => {
    const statement = db.prepare(
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
          payload_task_uuid,
          status,
          attempts,
          last_error,
          created_at,
          updated_at,
          acked_at,
          ack_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}), COALESCE(?, ${SQL_NOW_ISO_UTC}), ?, ?)
      `
    );
    const indexes = getSyncOperationPayloadIndexes(nextOperation.payload);
    statement.run(
      nextOperation.operation_uuid,
      nextOperation.project_uuid,
      nextOperation.origin_node_id,
      nextOperation.local_sequence,
      nextOperation.target_type,
      nextOperation.target_key,
      nextOperation.operation_type,
      nextOperation.base_revision,
      nextOperation.base_hash,
      nextOperation.payload,
      indexes.payloadTaskUuid,
      nextOperation.status,
      nextOperation.attempts ?? 0,
      nextOperation.last_error,
      nextOperation.created_at ?? null,
      nextOperation.updated_at ?? null,
      nextOperation.acked_at,
      nextOperation.ack_metadata
    );
    insertSyncOperationPlanRefs(
      db,
      nextOperation.operation_uuid,
      nextOperation.project_uuid,
      nextOperation.payload
    );

    const row = getSyncOperation(db, nextOperation.operation_uuid);
    if (!row) {
      throw new Error(`Failed to insert sync operation ${nextOperation.operation_uuid}`);
    }
    return row;
  });

  return insert.immediate(operation);
}

export function insertSyncOperationPlanRefs(
  db: Database,
  operationUuid: string,
  projectUuid: string,
  payload: string
): void {
  const insertPlanRef = db.prepare(
    `
      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      VALUES (?, ?, ?, ?)
    `
  );
  for (const ref of getSyncOperationPlanRefs(payload)) {
    insertPlanRef.run(operationUuid, projectUuid, ref.planUuid, ref.role);
  }
}

export function getSyncOperation(db: Database, operationUuid: string): SyncOperationRow | null {
  return (
    (db
      .prepare('SELECT * FROM sync_operation WHERE operation_uuid = ?')
      .get(operationUuid) as SyncOperationRow | null) ?? null
  );
}

export function listSyncOperationsByStatus(
  db: Database,
  status: string,
  projectUuid?: string
): SyncOperationRow[] {
  if (projectUuid) {
    return db
      .prepare(
        `
          SELECT * FROM sync_operation
          WHERE status = ? AND project_uuid = ?
          ORDER BY origin_node_id, local_sequence
        `
      )
      .all(status, projectUuid) as SyncOperationRow[];
  }

  return db
    .prepare(
      `
        SELECT * FROM sync_operation
        WHERE status = ?
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(status) as SyncOperationRow[];
}

export function insertSyncConflict(
  db: Database,
  conflict: Omit<SyncConflictRow, 'created_at' | 'status'> & {
    status?: string;
    created_at?: string;
  }
): SyncConflictRow {
  const insert = db.transaction((nextConflict: typeof conflict): SyncConflictRow => {
    db.prepare(
      `
        INSERT INTO sync_conflict (
          conflict_id,
          operation_uuid,
          project_uuid,
          target_type,
          target_key,
          field_path,
          base_value,
          base_hash,
          incoming_value,
          attempted_patch,
          current_value,
          original_payload,
          normalized_payload,
          reason,
          status,
          origin_node_id,
          created_at,
          resolved_at,
          resolution,
          resolved_by_node
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}), ?, ?, ?)
      `
    ).run(
      nextConflict.conflict_id,
      nextConflict.operation_uuid,
      nextConflict.project_uuid,
      nextConflict.target_type,
      nextConflict.target_key,
      nextConflict.field_path,
      nextConflict.base_value,
      nextConflict.base_hash,
      nextConflict.incoming_value,
      nextConflict.attempted_patch,
      nextConflict.current_value,
      nextConflict.original_payload,
      nextConflict.normalized_payload,
      nextConflict.reason,
      nextConflict.status ?? 'open',
      nextConflict.origin_node_id,
      nextConflict.created_at ?? null,
      nextConflict.resolved_at,
      nextConflict.resolution,
      nextConflict.resolved_by_node
    );

    const row = getSyncConflict(db, nextConflict.conflict_id);
    if (!row) {
      throw new Error(`Failed to insert sync conflict ${nextConflict.conflict_id}`);
    }
    return row;
  });

  return insert.immediate(conflict);
}

export function getSyncConflict(db: Database, conflictId: string): SyncConflictRow | null {
  return (
    (db
      .prepare('SELECT * FROM sync_conflict WHERE conflict_id = ?')
      .get(conflictId) as SyncConflictRow | null) ?? null
  );
}

export function listSyncConflictsByStatus(
  db: Database,
  status = 'open',
  projectUuid?: string
): SyncConflictRow[] {
  if (projectUuid) {
    return db
      .prepare(
        `
          SELECT * FROM sync_conflict
          WHERE status = ? AND project_uuid = ?
          ORDER BY created_at, conflict_id
        `
      )
      .all(status, projectUuid) as SyncConflictRow[];
  }

  return db
    .prepare(
      `
        SELECT * FROM sync_conflict
        WHERE status = ?
        ORDER BY created_at, conflict_id
      `
    )
    .all(status) as SyncConflictRow[];
}

export function upsertSyncTombstone(db: Database, tombstone: SyncTombstoneRow): void {
  db.transaction((nextTombstone: SyncTombstoneRow): void => {
    db.prepare(
      `
        INSERT INTO sync_tombstone (
          entity_type,
          entity_key,
          project_uuid,
          deletion_operation_uuid,
          deleted_revision,
          deleted_at,
          origin_node_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_type, entity_key) DO UPDATE SET
          project_uuid = excluded.project_uuid,
          deletion_operation_uuid = excluded.deletion_operation_uuid,
          deleted_revision = excluded.deleted_revision,
          deleted_at = excluded.deleted_at,
          origin_node_id = excluded.origin_node_id
      `
    ).run(
      nextTombstone.entity_type,
      nextTombstone.entity_key,
      nextTombstone.project_uuid,
      nextTombstone.deletion_operation_uuid,
      nextTombstone.deleted_revision,
      nextTombstone.deleted_at,
      nextTombstone.origin_node_id
    );
  }).immediate(tombstone);
}

export function getSyncTombstone(
  db: Database,
  entityType: string,
  entityKey: string
): SyncTombstoneRow | null {
  return (
    (db
      .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
      .get(entityType, entityKey) as SyncTombstoneRow | null) ?? null
  );
}

export function insertSyncSequence(
  db: Database,
  sequence: Omit<SyncSequenceRow, 'sequence' | 'created_at'> & { created_at?: string }
): SyncSequenceRow {
  const insert = db.transaction((nextSequence: typeof sequence): SyncSequenceRow => {
    const result = db
      .prepare(
        `
          INSERT INTO sync_sequence (
            project_uuid,
            target_type,
            target_key,
            revision,
            operation_uuid,
            origin_node_id,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}))
        `
      )
      .run(
        nextSequence.project_uuid,
        nextSequence.target_type,
        nextSequence.target_key,
        nextSequence.revision,
        nextSequence.operation_uuid,
        nextSequence.origin_node_id,
        nextSequence.created_at ?? null
      );

    const row = db
      .prepare('SELECT * FROM sync_sequence WHERE sequence = ?')
      .get(result.lastInsertRowid) as SyncSequenceRow | null;
    if (!row) {
      throw new Error('Failed to insert sync sequence row');
    }
    return row;
  });

  return insert.immediate(sequence);
}

export function listSyncSequenceAfter(
  db: Database,
  projectUuid: string,
  afterSequence: number
): SyncSequenceRow[] {
  return db
    .prepare(
      `
        SELECT * FROM sync_sequence
        WHERE project_uuid = ? AND sequence > ?
        ORDER BY sequence
      `
    )
    .all(projectUuid, afterSequence) as SyncSequenceRow[];
}
