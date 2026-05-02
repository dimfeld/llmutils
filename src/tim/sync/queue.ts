import type { Database } from 'bun:sqlite';
import { warn } from '../../logging.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { PlanRow } from '../db/plan.js';
import { getProjectByUuid } from '../db/project.js';
import {
  assertValidEnvelope,
  assertValidBatchEnvelope,
  assertValidPayload,
  type SyncOperationBatchEnvelope,
  deriveTargetKey,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
} from './types.js';
import { insertSyncOperationRow } from './operation_rows.js';
import {
  collectProjectionTargetsForPayload,
  createProjectionRebuildTargets,
  rebuildProjectionTargetsInTransaction,
} from './projection_targets.js';
import {
  isTerminalQueueStatus,
  QUEUE_FLUSHABLE_STATUSES,
  QUEUE_TERMINAL_STATUSES,
  sqlPlaceholders,
  type QueueOperationStatus,
} from './statuses.js';

/**
 * Persistent-node durable queue contract:
 * - Local sequences are allocated from `tim_node_sequence`, a per-origin
 *   high-water mark that survives pruning acknowledged operation rows.
 * - Call `resetSendingOperations()` on process startup before the transport
 *   flushes, so operations stranded in `sending` by a crash become retryable.
 * - Canonical refresh layering only reapplies still-owned queued and
 *   failed_retryable operations. In-flight `sending` rows are handled by the
 *   transport retry/reset path, not by snapshot layering.
 */

export interface SyncOperationQueueRow {
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
  status: QueueOperationStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
  ack_metadata: string | null;
  batch_id: string | null;
  batch_atomic: number;
}

/**
 * Queue callers may pass an envelope created with a placeholder localSequence.
 * The queue replaces it while holding the write transaction so persistent-node
 * operation streams are contiguous and start at 0 for each origin node.
 */
export type QueueableOperation = Omit<SyncOperationEnvelope, 'localSequence'> & {
  localSequence?: number;
};

export interface EnqueueOperationResult {
  row: SyncOperationQueueRow;
  localSequence: number;
  operation: SyncOperationEnvelope;
}

export interface EnqueueBatchResult {
  batch: SyncOperationBatchEnvelope;
  rows: SyncOperationQueueRow[];
  localSequenceStart: number;
}

export interface ListPendingOperationOptions {
  projectUuid?: string;
  originNodeId?: string;
}

export interface PruneAcknowledgedOptions {
  olderThan?: Date;
}

const queueChangeListeners = new Set<() => void>();

export function subscribeToQueueChanges(listener: () => void): () => void {
  queueChangeListeners.add(listener);
  return () => {
    queueChangeListeners.delete(listener);
  };
}

function notifyQueueChanged(): void {
  for (const listener of queueChangeListeners) {
    try {
      listener();
    } catch (error) {
      warn(
        `Sync queue change listener failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export function enqueueOperation(
  db: Database,
  operationInput: QueueableOperation
): EnqueueOperationResult {
  const enqueue = db.transaction((nextInput: QueueableOperation): EnqueueOperationResult => {
    const localSequence = allocateLocalSequence(db, nextInput.originNodeId);
    const operation = assertValidEnvelope(addQueueMetadata(db, { ...nextInput, localSequence }));
    insertQueuedOperation(db, operation);
    rebuildQueuedOperationProjectionInTransaction(db, operation);
    const row = requireOperationRow(db, operation.operationUuid);
    return { row, localSequence, operation };
  });

  const result = enqueue.immediate(operationInput);
  notifyQueueChanged();
  return result;
}

export function enqueueBatch(
  db: Database,
  batchInput: SyncOperationBatchEnvelope,
  options: { precondition?: () => void } = {}
): EnqueueBatchResult {
  const enqueue = db.transaction((nextInput: SyncOperationBatchEnvelope): EnqueueBatchResult => {
    options.precondition?.();
    const input = assertValidBatchEnvelope(nextInput);
    const localSequenceStart = allocateLocalSequenceRange(
      db,
      input.originNodeId,
      input.operations.length
    );
    const operations = input.operations.map((operation, index) =>
      assertValidEnvelope(
        addQueueMetadata(db, {
          ...operation,
          localSequence: localSequenceStart + index,
        })
      )
    );
    const batch = assertValidBatchEnvelope({ ...input, operations });
    const rebuildTargets = createProjectionRebuildTargets();
    for (const operation of operations) {
      insertQueuedOperation(db, operation, batch.batchId, batch.atomic === true);
      collectProjectionTargetsForPayload(db, rebuildTargets, operation.op);
    }
    rebuildProjectionTargetsInTransaction(db, rebuildTargets);
    return {
      batch,
      rows: operations.map((operation) => requireOperationRow(db, operation.operationUuid)),
      localSequenceStart,
    };
  });

  const result = enqueue.immediate(batchInput);
  notifyQueueChanged();
  return result;
}

export function markOperationSending(db: Database, operationUuid: string): SyncOperationQueueRow {
  return transitionOperation(db, operationUuid, {
    from: ['queued', 'failed_retryable'],
    to: 'sending',
    clearError: true,
  });
}

export function markOperationAcked(
  db: Database,
  operationUuid: string,
  ackMetadata: unknown
): SyncOperationQueueRow {
  return transitionOperation(db, operationUuid, {
    from: ['sending', 'failed_retryable'],
    to: 'acked',
    ackMetadata,
    acked: true,
    tolerateTerminal: true,
  });
}

export function markOperationConflict(
  db: Database,
  operationUuid: string,
  conflictId: string,
  ackMetadata: unknown
): SyncOperationQueueRow {
  return transitionOperation(db, operationUuid, {
    from: ['sending', 'failed_retryable'],
    to: 'conflict',
    ackMetadata: { ...(isRecord(ackMetadata) ? ackMetadata : {}), conflictId },
    acked: true,
    tolerateTerminal: true,
  });
}

export function markOperationRejected(
  db: Database,
  operationUuid: string,
  reason: string,
  ackMetadata: unknown
): SyncOperationQueueRow {
  return transitionOperation(db, operationUuid, {
    from: ['sending', 'failed_retryable'],
    to: 'rejected',
    lastError: reason,
    ackMetadata: { ...(isRecord(ackMetadata) ? ackMetadata : {}), error: reason },
    acked: true,
    tolerateTerminal: true,
  });
}

export function markOperationFailedRetryable(
  db: Database,
  operationUuid: string,
  error: unknown
): SyncOperationQueueRow {
  const message = error instanceof Error ? error.message : String(error);
  const row = transitionOperation(db, operationUuid, {
    from: ['sending'],
    to: 'failed_retryable',
    lastError: message,
    incrementAttempts: true,
    tolerateTerminal: true,
  });
  notifyQueueChanged();
  return row;
}

export function resetSendingOperations(
  db: Database,
  options: ListPendingOperationOptions = {}
): SyncOperationQueueRow[] {
  const reset = db.transaction((): SyncOperationQueueRow[] => {
    const clauses = [`status = 'sending'`];
    const params: string[] = [];
    const originNodeId = options.originNodeId ?? inferSingleLocalNodeId(db);
    if (options.projectUuid) {
      clauses.push('project_uuid = ?');
      params.push(options.projectUuid);
    }
    if (originNodeId) {
      clauses.push('origin_node_id = ?');
      params.push(originNodeId);
    }
    const rows = db
      .prepare(
        `
          SELECT *
          FROM sync_operation
          WHERE ${clauses.join(' AND ')}
          ORDER BY origin_node_id, local_sequence
        `
      )
      .all(...params) as SyncOperationQueueRow[];
    if (rows.length === 0) {
      return [];
    }
    const update = db.prepare(
      `UPDATE sync_operation SET status = 'failed_retryable', updated_at = ${SQL_NOW_ISO_UTC} WHERE operation_uuid = ?`
    );
    for (const row of rows) {
      update.run(row.operation_uuid);
    }
    return rows.map((row) => requireOperationRow(db, row.operation_uuid));
  });
  const rows = reset.immediate();
  if (rows.length > 0) {
    notifyQueueChanged();
  }
  return rows;
}

export interface SyncQueueSummary {
  pending: number;
  sending: number;
  failedRetryable: number;
  conflict: number;
  rejected: number;
  oldestPendingAt: string | null;
}

export interface SyncQueueSummaryOptions extends ListPendingOperationOptions {
  targetKey?: string;
  targetKeyPrefix?: string;
  /**
   * Aggregate every operation that affects a plan, including task-scoped ops
   * (`plan.add_task`, `plan.update_task_text`, `plan.mark_task_done`) whose
   * target_key is `task:<uuid>`. Matches `target_key = 'plan:<uuid>'` OR a
   * payload-level `planUuid` of the same value.
   */
  planUuid?: string;
  /**
   * When true, do NOT filter by origin node and do NOT fall back to inferring
   * a single local node ID. Used by main-node UI indicators that must surface
   * peer-origin operations (notably terminal `rejected` rows from peers). When
   * unset, an unspecified `originNodeId` falls back to inference.
   */
  allOrigins?: boolean;
}

/**
 * Aggregate sync_operation counts for a node/project/target. Pending excludes
 * terminal acked rows. Used by the web UI sync indicators.
 */
export function getSyncQueueSummary(
  db: Database,
  options: SyncQueueSummaryOptions = {}
): SyncQueueSummary {
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  const originNodeId = options.allOrigins
    ? null
    : (options.originNodeId ?? inferSingleLocalNodeId(db));
  if (options.projectUuid) {
    clauses.push('project_uuid = ?');
    params.push(options.projectUuid);
  }
  if (originNodeId) {
    clauses.push('origin_node_id = ?');
    params.push(originNodeId);
  }
  if (options.targetKey) {
    clauses.push('target_key = ?');
    params.push(options.targetKey);
  }
  if (options.targetKeyPrefix) {
    clauses.push(`target_key LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLikePattern(options.targetKeyPrefix)}%`);
  }
  if (options.planUuid) {
    clauses.push(`(target_key = ? OR JSON_EXTRACT(payload, '$.planUuid') = ?)`);
    params.push(`plan:${options.planUuid}`);
    params.push(options.planUuid);
  }
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const counts = db
    .prepare(
      `
        SELECT
          SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
          SUM(CASE WHEN status = 'failed_retryable' THEN 1 ELSE 0 END) AS failed_retryable,
          SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflict,
          SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
          MIN(CASE WHEN status IN ('queued', 'failed_retryable', 'sending') THEN created_at END)
            AS oldest_pending_at
        FROM sync_operation
        ${whereClause}
      `
    )
    .get(...params) as {
    pending: number | null;
    sending: number | null;
    failed_retryable: number | null;
    conflict: number | null;
    rejected: number | null;
    oldest_pending_at: string | null;
  };
  return {
    pending: counts.pending ?? 0,
    sending: counts.sending ?? 0,
    failedRetryable: counts.failed_retryable ?? 0,
    conflict: counts.conflict ?? 0,
    rejected: counts.rejected ?? 0,
    oldestPendingAt: counts.oldest_pending_at,
  };
}

export interface SyncConflictSummary {
  open: number;
}

export interface SyncConflictSummaryOptions {
  projectUuid?: string;
  targetKey?: string;
  targetKeyPrefix?: string;
  /**
   * Match `target_key = 'plan:<uuid>'` OR a normalized-payload `planUuid` of
   * the same value, so task-scoped conflicts roll up under their owning plan.
   */
  planUuid?: string;
}

export function getSyncConflictSummary(
  db: Database,
  options: SyncConflictSummaryOptions = {}
): SyncConflictSummary {
  const clauses: string[] = [`status = 'open'`];
  const params: (string | number | null)[] = [];
  if (options.projectUuid) {
    clauses.push('project_uuid = ?');
    params.push(options.projectUuid);
  }
  if (options.targetKey) {
    clauses.push('target_key = ?');
    params.push(options.targetKey);
  }
  if (options.targetKeyPrefix) {
    clauses.push(`target_key LIKE ? ESCAPE '\\'`);
    params.push(`${escapeLikePattern(options.targetKeyPrefix)}%`);
  }
  if (options.planUuid) {
    clauses.push(`(target_key = ? OR JSON_EXTRACT(normalized_payload, '$.planUuid') = ?)`);
    params.push(`plan:${options.planUuid}`);
    params.push(options.planUuid);
  }
  const row = db
    .prepare(`SELECT COUNT(*) AS open FROM sync_conflict WHERE ${clauses.join(' AND ')}`)
    .get(...params) as { open: number };
  return { open: row.open ?? 0 };
}

/**
 * Escape `_`, `%`, and `\` in a string used as the prefix part of a SQL `LIKE`
 * pattern. Callers must pair the resulting string with `ESCAPE '\\'` in SQL.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\_%]/g, '\\$&');
}

export function listPendingOperations(
  db: Database,
  options: ListPendingOperationOptions = {}
): SyncOperationQueueRow[] {
  const clauses = [`status IN (${sqlPlaceholders(QUEUE_FLUSHABLE_STATUSES)})`];
  const params: string[] = [];
  const originNodeId = options.originNodeId ?? inferSingleLocalNodeId(db);
  if (options.projectUuid) {
    clauses.push('project_uuid = ?');
    params.push(options.projectUuid);
  }
  if (originNodeId) {
    clauses.push('origin_node_id = ?');
    params.push(originNodeId);
  }
  return db
    .prepare(
      `
        SELECT *
        FROM sync_operation
        WHERE ${clauses.join(' AND ')}
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(...QUEUE_FLUSHABLE_STATUSES, ...params) as SyncOperationQueueRow[];
}

function inferSingleLocalNodeId(db: Database): string | null {
  const rows = db
    .prepare('SELECT node_id FROM tim_node ORDER BY created_at, node_id')
    .all() as Array<{
    node_id: string;
  }>;
  return rows.length === 1 ? rows[0].node_id : null;
}

export function pruneAcknowledgedOperations(
  db: Database,
  options: PruneAcknowledgedOptions = {}
): number {
  const olderThan = options.olderThan ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM sync_operation WHERE status = 'acked' AND acked_at < ?`)
    .get(olderThan.toISOString()) as { count: number };
  db.prepare(`DELETE FROM sync_operation WHERE status = 'acked' AND acked_at < ?`).run(
    olderThan.toISOString()
  );
  return row.count;
}

export function prunePlanRefsForTerminalOps(db: Database): number {
  const result = db
    .prepare(
      `
      DELETE FROM sync_operation_plan_ref
      WHERE operation_uuid IN (
        SELECT operation_uuid
        FROM sync_operation
        WHERE status IN (${sqlPlaceholders(QUEUE_TERMINAL_STATUSES)})
      )
    `
    )
    .run(...QUEUE_TERMINAL_STATUSES);
  return result.changes;
}

export function allocateLocalSequence(db: Database, originNodeId: string): number {
  return allocateLocalSequenceRange(db, originNodeId, 1);
}

export function allocateLocalSequenceRange(
  db: Database,
  originNodeId: string,
  count: number
): number {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`Cannot allocate ${count} sync local sequence values`);
  }
  db.prepare(
    `INSERT OR IGNORE INTO tim_node_sequence (node_id, next_sequence, updated_at)
     VALUES (?, 0, ${SQL_NOW_ISO_UTC})`
  ).run(originNodeId);
  const row = db
    .prepare('SELECT next_sequence FROM tim_node_sequence WHERE node_id = ?')
    .get(originNodeId) as { next_sequence: number };
  db.prepare(
    `UPDATE tim_node_sequence SET next_sequence = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE node_id = ?`
  ).run(row.next_sequence + count, originNodeId);
  return row.next_sequence;
}

function addQueueMetadata(db: Database, operationInput: QueueableOperation): QueueableOperation {
  if (
    (operationInput.op.type === 'plan.create' || operationInput.op.type === 'plan.promote_task') &&
    operationInput.op.numericPlanId === undefined
  ) {
    const project = getProjectByUuid(db, operationInput.projectUuid);
    if (!project) {
      return operationInput;
    }
    return {
      ...operationInput,
      op: {
        ...operationInput.op,
        numericPlanId: reserveOptimisticPlanId(db, project.id),
      },
    };
  }
  if (
    operationInput.op.type !== 'plan.set_parent' ||
    operationInput.op.previousParentUuid !== undefined
  ) {
    return operationInput;
  }
  const plan = getPlan(db, operationInput.op.planUuid);
  return {
    ...operationInput,
    op: {
      ...operationInput.op,
      previousParentUuid: plan?.parent_uuid ?? null,
    },
  };
}

function insertQueuedOperation(
  db: Database,
  operation: SyncOperationEnvelope,
  batchId?: string,
  batchAtomic = false
): void {
  insertSyncOperationRow(db, operation, { status: 'queued', batchId, batchAtomic });
}

function rebuildQueuedOperationProjectionInTransaction(
  db: Database,
  operation: SyncOperationEnvelope
): void {
  const op = assertValidPayload(operation.op);
  const rebuildTargets = createProjectionRebuildTargets();
  collectProjectionTargetsForPayload(db, rebuildTargets, op);
  rebuildProjectionTargetsInTransaction(db, rebuildTargets);
}

function reserveOptimisticPlanId(db: Database, projectId: number): number {
  const row = db
    .prepare(
      `
        SELECT max(
          COALESCE((SELECT MAX(plan_id) FROM plan WHERE project_id = ?), 0),
          COALESCE((SELECT highest_plan_id FROM project WHERE id = ?), 0)
        ) + 1 AS next_id
      `
    )
    .get(projectId, projectId) as { next_id: number };
  setProjectHighestPlanId(db, projectId, row.next_id);
  return row.next_id;
}

function setProjectHighestPlanId(db: Database, projectId: number, planId: number): void {
  db.prepare(
    `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
  ).run(planId, projectId);
}

function rowToEnvelope(row: SyncOperationQueueRow): SyncOperationEnvelope {
  const op = assertValidPayload(JSON.parse(row.payload) as unknown);
  const target = deriveTargetKey(op);
  return assertValidEnvelope({
    operationUuid: row.operation_uuid,
    projectUuid: row.project_uuid,
    originNodeId: row.origin_node_id,
    localSequence: row.local_sequence,
    createdAt: row.created_at,
    targetType: target.targetType,
    targetKey: target.targetKey,
    op,
  });
}

function transitionOperation(
  db: Database,
  operationUuid: string,
  transition: {
    from: QueueOperationStatus[];
    to: QueueOperationStatus;
    ackMetadata?: unknown;
    acked?: boolean;
    lastError?: string;
    incrementAttempts?: boolean;
    clearError?: boolean;
    tolerateTerminal?: boolean;
  }
): SyncOperationQueueRow {
  const change = db.transaction((nextOperationUuid: string): SyncOperationQueueRow => {
    const row = requireOperationRow(db, nextOperationUuid);
    if (!transition.from.includes(row.status)) {
      if (transition.tolerateTerminal && isTerminalQueueStatus(row.status)) {
        warn(
          `Ignoring sync_operation transition ${row.status} -> ${transition.to} for ${nextOperationUuid}; operation is already terminal`
        );
        return row;
      }
      throw new Error(
        `Illegal sync_operation transition ${row.status} -> ${transition.to} for ${nextOperationUuid}`
      );
    }
    db.prepare(
      `
        UPDATE sync_operation
        SET status = ?,
            updated_at = ${SQL_NOW_ISO_UTC},
            acked_at = CASE WHEN ? THEN ${SQL_NOW_ISO_UTC} ELSE acked_at END,
            ack_metadata = COALESCE(?, ack_metadata),
            last_error = CASE WHEN ? THEN NULL WHEN ? IS NOT NULL THEN ? ELSE last_error END,
            attempts = attempts + ?
        WHERE operation_uuid = ?
      `
    ).run(
      transition.to,
      transition.acked ? 1 : 0,
      transition.ackMetadata === undefined ? null : JSON.stringify(transition.ackMetadata),
      transition.clearError ? 1 : 0,
      transition.lastError ?? null,
      transition.lastError ?? null,
      transition.incrementAttempts ? 1 : 0,
      nextOperationUuid
    );
    return requireOperationRow(db, nextOperationUuid);
  });
  return change.immediate(operationUuid);
}

function requireOperationRow(db: Database, operationUuid: string): SyncOperationQueueRow {
  const row = db
    .prepare('SELECT * FROM sync_operation WHERE operation_uuid = ?')
    .get(operationUuid) as SyncOperationQueueRow | null;
  if (!row) {
    throw new Error(`Unknown sync operation ${operationUuid}`);
  }
  return row;
}

function getPlan(db: Database, planUuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
