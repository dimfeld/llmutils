import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { SyncOperationEnvelope } from './types.js';

export interface CreateSyncConflictInput {
  envelope: SyncOperationEnvelope;
  originalPayload: string;
  normalizedPayload: string;
  fieldPath?: string | null;
  baseValue?: unknown;
  baseHash?: string | null;
  incomingValue?: unknown;
  attemptedPatch?: string | null;
  currentValue?: unknown;
  reason: string;
}

function stringifyConflictValue(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function createSyncConflict(db: Database, input: CreateSyncConflictInput): string {
  const conflictId = randomUUID();
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, NULL)
    `
  ).run(
    conflictId,
    input.envelope.operationUuid,
    input.envelope.projectUuid,
    input.envelope.targetType,
    input.envelope.targetKey,
    input.fieldPath ?? null,
    stringifyConflictValue(input.baseValue),
    input.baseHash ?? null,
    stringifyConflictValue(input.incomingValue),
    input.attemptedPatch ?? null,
    stringifyConflictValue(input.currentValue),
    input.originalPayload,
    input.normalizedPayload,
    input.reason,
    input.envelope.originNodeId
  );
  return conflictId;
}

export function recordSyncTombstone(
  db: Database,
  input: {
    entityType: string;
    entityKey: string;
    projectUuid: string;
    deletionOperationUuid: string;
    deletedRevision: number | null;
    originNodeId: string;
  }
): void {
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
      ) VALUES (?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ?)
      ON CONFLICT(entity_type, entity_key) DO UPDATE SET
        project_uuid = excluded.project_uuid,
        deletion_operation_uuid = excluded.deletion_operation_uuid,
        deleted_revision = excluded.deleted_revision,
        deleted_at = excluded.deleted_at,
        origin_node_id = excluded.origin_node_id
    `
  ).run(
    input.entityType,
    input.entityKey,
    input.projectUuid,
    input.deletionOperationUuid,
    input.deletedRevision,
    input.originNodeId
  );
}
