import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { getSyncOperationPayloadIndexes, getSyncOperationPlanRefs } from './operation_metadata.js';
import type { SyncOperationEnvelope } from './types.js';

export type InsertSyncOperationStatus = 'queued' | 'received';

export interface InsertSyncOperationRowOptions {
  status: InsertSyncOperationStatus;
  batchId?: string | null;
  batchAtomic?: boolean;
}

export function insertSyncOperationRow(
  db: Database,
  operation: SyncOperationEnvelope,
  options: InsertSyncOperationRowOptions
): void {
  const baseRevision =
    'baseRevision' in operation.op && typeof operation.op.baseRevision === 'number'
      ? operation.op.baseRevision
      : null;
  const insert = db.prepare(
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
        ack_metadata,
        batch_id,
        batch_atomic
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 0, NULL, ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, ?, ?)
    `
  );
  const indexes = getSyncOperationPayloadIndexes(operation.op);
  insert.run(
    operation.operationUuid,
    operation.projectUuid,
    operation.originNodeId,
    operation.localSequence,
    operation.targetType,
    operation.targetKey,
    operation.op.type,
    baseRevision,
    JSON.stringify(operation.op),
    indexes.payloadTaskUuid,
    options.status,
    operation.createdAt,
    options.batchId ?? null,
    options.batchAtomic === true ? 1 : 0
  );

  const insertPlanRef = db.prepare(
    `
      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      VALUES (?, ?, ?, ?)
    `
  );
  for (const ref of getSyncOperationPlanRefs(operation.op)) {
    insertPlanRef.run(operation.operationUuid, operation.projectUuid, ref.planUuid, ref.role);
  }
}
