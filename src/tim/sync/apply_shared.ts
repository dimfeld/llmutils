import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { PlanRow, PlanTaskRow } from '../db/plan.js';
import { SyncValidationError } from './errors.js';
import { insertSyncOperationRow } from './operation_rows.js';
import type { SyncOperationEnvelope, SyncOperationPayload } from './types.js';
import type {
  ApplyOperationResult,
  ApplyOperationStatus,
  ResolveSyncConflictOptions,
} from './apply_types.js';

export type ProjectRow = { id: number; uuid: string };

export type Mutation = {
  targetType: string;
  targetKey: string;
  revision: number | null;
};

export const TERMINAL_OPERATION_STATUSES = new Set(['applied', 'conflict', 'rejected']);

export function rejectedResult(error: SyncValidationError): ApplyOperationResult {
  return {
    status: 'rejected',
    sequenceIds: [],
    invalidations: [],
    acknowledged: true,
    error,
  };
}

export function getOperationRow(db: Database, operationUuid: string) {
  return db.prepare('SELECT * FROM sync_operation WHERE operation_uuid = ?').get(operationUuid) as {
    operation_uuid: string;
    status: string;
    last_error: string | null;
    ack_metadata: string | null;
    target_key: string;
    batch_id: string | null;
  } | null;
}

export function resultFromRecordedOperation(
  db: Database,
  row: {
    operation_uuid: string;
    status: string;
    ack_metadata: string | null;
    target_key: string;
    last_error?: string | null;
  }
): ApplyOperationResult {
  const metadata = row.ack_metadata
    ? (JSON.parse(row.ack_metadata) as Record<string, unknown>)
    : {};
  const sequenceIds = Array.isArray(metadata.sequenceIds)
    ? metadata.sequenceIds.filter((id): id is number => typeof id === 'number')
    : [];
  const resolvedNumericPlanId =
    typeof metadata.resolvedNumericPlanId === 'number' ? metadata.resolvedNumericPlanId : undefined;
  let conflictId = typeof metadata.conflictId === 'string' ? metadata.conflictId : undefined;
  if (row.status === 'conflict' && !conflictId) {
    const conflict = db
      .prepare(
        'SELECT conflict_id FROM sync_conflict WHERE operation_uuid = ? ORDER BY created_at LIMIT 1'
      )
      .get(row.operation_uuid) as { conflict_id: string } | null;
    conflictId = conflict?.conflict_id;
  }
  const errorMessage =
    typeof metadata.error === 'string'
      ? metadata.error
      : row.last_error
        ? row.last_error
        : undefined;
  const error =
    row.status === 'rejected' && errorMessage
      ? new SyncValidationError(errorMessage, {
          operationUuid: row.operation_uuid,
          issues: [],
        })
      : undefined;
  return {
    status: row.status as ApplyOperationStatus,
    sequenceId: sequenceIds.at(-1),
    sequenceIds,
    invalidations: Array.isArray(metadata.invalidations)
      ? metadata.invalidations.filter((key): key is string => typeof key === 'string')
      : [],
    conflictId,
    resolvedNumericPlanId,
    acknowledged:
      row.status === 'applied' || row.status === 'conflict' || row.status === 'rejected',
    error,
  };
}

export function insertReceivedOperation(
  db: Database,
  envelope: SyncOperationEnvelope,
  payload: string,
  batchId?: string,
  batchAtomic = false
): void {
  if (payload !== JSON.stringify(envelope.op)) {
    throw new Error('insertReceivedOperation payload does not match normalized envelope payload');
  }
  insertSyncOperationRow(db, envelope, { status: 'received', batchId, batchAtomic });
}

export function getOperationByOriginSequence(
  db: Database,
  originNodeId: string,
  localSequence: number,
  excludingOperationUuid: string
): { operation_uuid: string; status: string } | null {
  return db
    .prepare(
      `SELECT operation_uuid, status
       FROM sync_operation
       WHERE origin_node_id = ? AND local_sequence = ? AND operation_uuid <> ?
       LIMIT 1`
    )
    .get(originNodeId, localSequence, excludingOperationUuid) as {
    operation_uuid: string;
    status: string;
  } | null;
}

export class ConflictAccepted extends Error {
  constructor(readonly conflictId: string) {
    super('Sync operation accepted as conflict');
  }
}

export function markOperationApplied(
  db: Database,
  operationUuid: string,
  sequenceIds: number[],
  invalidations: string[],
  metadata: { resolvedNumericPlanId?: number } = {}
): void {
  const sequenceId = sequenceIds.at(-1) ?? null;
  const ackMetadata = {
    sequenceId,
    sequenceIds,
    invalidations,
    ...(metadata.resolvedNumericPlanId === undefined
      ? {}
      : { resolvedNumericPlanId: metadata.resolvedNumericPlanId }),
  };
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'applied',
          updated_at = ${SQL_NOW_ISO_UTC},
          acked_at = ${SQL_NOW_ISO_UTC},
          ack_metadata = ?
      WHERE operation_uuid = ?
    `
  ).run(JSON.stringify(ackMetadata), operationUuid);
}

export function markOperationConflict(
  db: Database,
  operationUuid: string,
  conflictId: string
): void {
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'conflict',
          updated_at = ${SQL_NOW_ISO_UTC},
          acked_at = ${SQL_NOW_ISO_UTC},
          ack_metadata = ?
      WHERE operation_uuid = ?
    `
  ).run(JSON.stringify({ conflictId, acknowledged: true }), operationUuid);
}

export function markConflictResolved(
  db: Database,
  conflictId: string,
  status: 'resolved_applied' | 'resolved_discarded',
  options: ResolveSyncConflictOptions
): void {
  db.prepare(
    `
      UPDATE sync_conflict
      SET status = ?,
          resolved_at = ${SQL_NOW_ISO_UTC},
          resolution = ?,
          resolved_by_node = ?
      WHERE conflict_id = ?
    `
  ).run(
    status,
    JSON.stringify({
      mode: options.mode,
      manualValue: options.mode === 'manual' ? options.manualValue : undefined,
    }),
    options.resolvedByNode,
    conflictId
  );
}

export function rejectOperation(db: Database, operationUuid: string, message: string): void {
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'rejected',
          attempts = attempts + 1,
          last_error = ?,
          updated_at = ${SQL_NOW_ISO_UTC},
          acked_at = ${SQL_NOW_ISO_UTC},
          ack_metadata = ?
      WHERE operation_uuid = ?
    `
  ).run(message, JSON.stringify({ error: message, acknowledged: true }), operationUuid);
}

export function insertSequence(db: Database, envelope: SyncOperationEnvelope, mutation: Mutation) {
  return db
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
        ) VALUES (?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
        RETURNING sequence
      `
    )
    .get(
      envelope.projectUuid,
      mutation.targetType,
      mutation.targetKey,
      mutation.revision,
      envelope.operationUuid,
      envelope.originNodeId
    ) as { sequence: number };
}

export function getPlan(db: Database, planUuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null) ?? null;
}

export function getTask(db: Database, taskUuid: string): PlanTaskRow | null {
  return (
    (db.prepare('SELECT * FROM plan_task WHERE uuid = ?').get(taskUuid) as PlanTaskRow | null) ??
    null
  );
}

export function targetExists(db: Database, op: SyncOperationPayload): boolean {
  switch (op.type) {
    case 'project_setting.set':
    case 'project_setting.delete':
      return true;
    case 'plan.add_task':
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
      return getTask(db, op.taskUuid) !== null;
    case 'plan.promote_task':
      return getPlan(db, op.newPlanUuid) !== null;
    default:
      return 'planUuid' in op ? getPlan(db, op.planUuid) !== null : false;
  }
}

export function getTombstone(db: Database, entityType: string, entityKey: string): unknown | null {
  return (
    db
      .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
      .get(entityType, entityKey) ?? null
  );
}

export function isRecoverableTombstonedOperation(op: SyncOperationPayload): boolean {
  return (
    op.type === 'plan.patch_text' ||
    op.type === 'plan.update_task_text' ||
    op.type === 'plan.add_list_item' ||
    op.type === 'plan.add_tag' ||
    op.type === 'plan.add_task' ||
    op.type === 'plan.mark_task_done'
  );
}

export function conflictFieldPath(op: SyncOperationPayload): string | null {
  if ('field' in op) {
    return op.field;
  }
  if ('list' in op) {
    return op.list;
  }
  return null;
}

export function conflictBaseValue(op: SyncOperationPayload): unknown {
  return 'base' in op ? op.base : undefined;
}

export function conflictIncomingValue(op: SyncOperationPayload): unknown {
  if ('new' in op) {
    return op.new;
  }
  if ('value' in op) {
    return op.value;
  }
  return undefined;
}

export function conflictPatch(op: SyncOperationPayload): string | null {
  return 'patch' in op ? (op.patch ?? null) : null;
}

export function validationError(
  envelope: SyncOperationEnvelope,
  message: string
): SyncValidationError {
  return new SyncValidationError(message, {
    operationUuid: envelope.operationUuid,
    issues: [],
  });
}
