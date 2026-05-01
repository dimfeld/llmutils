import type { Database } from 'bun:sqlite';
import * as diff from 'diff';
import * as z from 'zod/v4';
import { warn } from '../../logging.js';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { upsertPlanInTransaction, type PlanRow, type PlanTaskRow } from '../db/plan.js';
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
import { shiftTaskIndexesAfterDelete, shiftTaskIndexesForInsert } from './task_indexes.js';
import { getSyncOperationPayloadIndexes } from './payload_indexes.js';

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

export type QueueOperationStatus =
  | 'queued'
  | 'sending'
  | 'acked'
  | 'conflict'
  | 'rejected'
  | 'failed_retryable';

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
  payload_plan_uuid: string | null;
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

export interface CanonicalPlanSnapshot {
  type: 'plan';
  projectUuid: string;
  plan: {
    uuid: string;
    planId: number;
    title: string | null;
    goal: string | null;
    note: string | null;
    details: string | null;
    status: PlanRow['status'];
    priority: PlanRow['priority'];
    branch: string | null;
    simple: boolean | null;
    tdd: boolean | null;
    discoveredFrom: number | null;
    issue: string[] | null;
    pullRequest: string[] | null;
    assignedTo: string | null;
    baseBranch: string | null;
    temp: boolean | null;
    docs: string[] | null;
    changedFiles: string[] | null;
    planGeneratedAt: string | null;
    reviewIssues: unknown[] | null;
    parentUuid: string | null;
    epic: boolean;
    revision: number;
    tasks: Array<{
      uuid: string;
      title: string;
      description: string;
      done: boolean;
      revision: number;
    }>;
    dependencyUuids: string[];
    tags: string[];
  };
}

export interface CanonicalDeletedPlanSnapshot {
  type: 'plan_deleted';
  projectUuid: string;
  planUuid: string;
  deletedAt: string;
  deletedBySequenceId?: number;
}

export type CanonicalNeverExistedSnapshot =
  | {
      type: 'never_existed';
      entityKey: string;
      targetType: 'plan';
      planUuid: string;
    }
  | {
      type: 'never_existed';
      entityKey: string;
      targetType: 'task';
      taskUuid: string;
    };

export type CanonicalProjectSettingSnapshot =
  | {
      type: 'project_setting';
      projectUuid: string;
      setting: string;
      deleted: true;
    }
  | {
      type: 'project_setting';
      projectUuid: string;
      setting: string;
      deleted?: false;
      value: unknown;
      revision: number;
      updatedAt?: string | null;
      updatedByNode?: string | null;
    };

export type CanonicalSnapshot =
  | CanonicalPlanSnapshot
  | CanonicalDeletedPlanSnapshot
  | CanonicalNeverExistedSnapshot
  | CanonicalProjectSettingSnapshot;

const PLAN_TEXT_COLUMNS = {
  title: 'title',
  goal: 'goal',
  note: 'note',
  details: 'details',
} as const;
const TASK_TEXT_COLUMNS = {
  title: 'title',
  description: 'description',
} as const;
const LIST_COLUMNS = {
  issue: 'issue',
  pullRequest: 'pull_request',
  docs: 'docs',
  changedFiles: 'changed_files',
  reviewIssues: 'review_issues',
} as const;
const ASSIGNMENT_CLEANUP_STATUSES = new Set(['done', 'needs_review', 'cancelled']);
let warnedMalformedJsonList = false;

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

const CanonicalPlanSnapshotSchema = z.object({
  type: z.literal('plan'),
  projectUuid: z.string(),
  plan: z.object({
    uuid: z.string(),
    planId: z.number(),
    title: z.string().nullable(),
    goal: z.string().nullable(),
    note: z.string().nullable(),
    details: z.string().nullable(),
    status: z.custom<PlanRow['status']>((value) => typeof value === 'string'),
    priority: z.custom<PlanRow['priority']>((value) => value === null || typeof value === 'string'),
    branch: z.string().nullable(),
    simple: z.boolean().nullable(),
    tdd: z.boolean().nullable(),
    discoveredFrom: z.number().nullable(),
    issue: z.array(z.string()).nullable(),
    pullRequest: z.array(z.string()).nullable(),
    assignedTo: z.string().nullable(),
    baseBranch: z.string().nullable(),
    temp: z.boolean().nullable(),
    docs: z.array(z.string()).nullable(),
    changedFiles: z.array(z.string()).nullable(),
    planGeneratedAt: z.string().nullable(),
    reviewIssues: z.array(z.unknown()).nullable(),
    parentUuid: z.string().nullable(),
    epic: z.boolean(),
    revision: z.number(),
    tasks: z.array(
      z.object({
        uuid: z.string(),
        title: z.string(),
        description: z.string(),
        done: z.boolean(),
        revision: z.number(),
      })
    ),
    dependencyUuids: z.array(z.string()),
    tags: z.array(z.string()),
  }),
}) satisfies z.ZodType<CanonicalPlanSnapshot>;

const CanonicalDeletedPlanSnapshotSchema = z.object({
  type: z.literal('plan_deleted'),
  projectUuid: z.string(),
  planUuid: z.string(),
  deletedAt: z.string(),
  deletedBySequenceId: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<CanonicalDeletedPlanSnapshot>;

const CanonicalNeverExistedSnapshotSchema = z.union([
  z.object({
    type: z.literal('never_existed'),
    entityKey: z.string(),
    targetType: z.literal('plan'),
    planUuid: z.string(),
  }),
  z.object({
    type: z.literal('never_existed'),
    entityKey: z.string(),
    targetType: z.literal('task'),
    taskUuid: z.string(),
  }),
]) satisfies z.ZodType<CanonicalNeverExistedSnapshot>;

const CanonicalProjectSettingDeleteSnapshotSchema = z.object({
  type: z.literal('project_setting'),
  projectUuid: z.string(),
  setting: z.string(),
  deleted: z.literal(true),
});

const CanonicalProjectSettingSetSnapshotSchema = z.object({
  type: z.literal('project_setting'),
  projectUuid: z.string(),
  setting: z.string(),
  deleted: z.literal(false).optional(),
  value: z.unknown().refine((v) => v !== undefined, { message: 'value is required' }),
  revision: z.number(),
  updatedAt: z.string().nullable().optional(),
  updatedByNode: z.string().nullable().optional(),
});

const CanonicalProjectSettingSnapshotSchema = z.union([
  CanonicalProjectSettingDeleteSnapshotSchema,
  CanonicalProjectSettingSetSnapshotSchema,
]) satisfies z.ZodType<CanonicalProjectSettingSnapshot>;

export const CanonicalSnapshotSchema = z.union([
  CanonicalPlanSnapshotSchema,
  CanonicalDeletedPlanSnapshotSchema,
  CanonicalNeverExistedSnapshotSchema,
  CanonicalProjectSettingSnapshotSchema,
]) satisfies z.ZodType<CanonicalSnapshot>;

export function enqueueOperation(
  db: Database,
  operationInput: QueueableOperation
): EnqueueOperationResult {
  const enqueue = db.transaction((nextInput: QueueableOperation): EnqueueOperationResult => {
    const localSequence = allocateLocalSequence(db, nextInput.originNodeId);
    const operation = assertValidEnvelope(addQueueMetadata(db, { ...nextInput, localSequence }));
    insertQueuedOperation(db, operation);
    applyLocalOptimisticInTransaction(db, operation);
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
    for (const operation of operations) {
      insertQueuedOperation(db, operation, batch.batchId, batch.atomic === true);
      applyLocalOptimisticInTransaction(db, operation);
    }
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

export function applyLocalOptimistic(db: Database, operationInput: SyncOperationEnvelope): void {
  const operation = assertValidEnvelope(operationInput);
  const apply = db.transaction((nextOperation: SyncOperationEnvelope): void => {
    applyLocalOptimisticInTransaction(db, nextOperation);
  });
  apply.immediate(operation);
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
  const clauses = [`status IN ('queued', 'failed_retryable')`];
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
    .all(...params) as SyncOperationQueueRow[];
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
  const result = db
    .prepare(`DELETE FROM sync_operation WHERE status = 'acked' AND acked_at < ?`)
    .run(olderThan.toISOString());
  return result.changes;
}

/**
 * Applies one canonical entity snapshot from the main node, then layers this
 * node's still-active optimistic operations back on top. Scope is intentionally
 * narrow for Task 6: a single plan with tasks/dependencies/tags/list fields or
 * a single project setting.
 */
export function mergeCanonicalRefresh(db: Database, snapshot: CanonicalSnapshot): void {
  const parsedSnapshot = CanonicalSnapshotSchema.parse(snapshot);
  const merge = db.transaction((nextSnapshot: CanonicalSnapshot): void => {
    writeCanonicalSnapshot(db, nextSnapshot);
    for (const operation of pendingOperationsForSnapshot(db, nextSnapshot)) {
      applyLocalOptimisticInTransaction(db, operation);
    }
  });
  merge.immediate(parsedSnapshot);
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
        payload_plan_uuid,
        payload_secondary_plan_uuid,
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'queued', 0, NULL, ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, ?, ?)
    `
  );
  const payload = JSON.stringify(operation.op);
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
    payload,
    indexes.payloadPlanUuid,
    indexes.payloadSecondaryPlanUuid,
    indexes.payloadTaskUuid,
    operation.createdAt,
    batchId ?? null,
    batchAtomic ? 1 : 0
  );
}

function applyLocalOptimisticInTransaction(db: Database, operation: SyncOperationEnvelope): void {
  const op = assertValidPayload(operation.op);
  switch (op.type) {
    case 'plan.create':
      applyOptimisticPlanCreate(db, operation.projectUuid, op);
      break;
    case 'plan.set_scalar':
      updatePlanIfExists(db, op.planUuid, (plan) => {
        const value = op.field === 'epic' ? (op.value ? 1 : 0) : op.value;
        db.prepare(
          `UPDATE plan SET ${op.field} = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
        ).run(value, op.planUuid);
        if (
          op.field === 'status' &&
          typeof value === 'string' &&
          plan.status !== value &&
          ASSIGNMENT_CLEANUP_STATUSES.has(value)
        ) {
          removeAssignmentForPlan(db, operation.projectUuid, op.planUuid);
        }
      });
      break;
    case 'plan.patch_text':
      updatePlanIfExists(db, op.planUuid, (plan) => {
        const column = PLAN_TEXT_COLUMNS[op.field];
        const current = ((plan[column] ?? '') as string).toString();
        const next = mergeText(current, op.base, op.new);
        if (next === null) {
          return;
        }
        if (next !== current) {
          db.prepare(
            `UPDATE plan SET ${column} = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
          ).run(next, op.planUuid);
        }
      });
      break;
    case 'plan.add_task':
      updatePlanIfExists(db, op.planUuid, () => {
        if (getTask(db, op.taskUuid)) {
          return;
        }
        const index =
          op.taskIndex ??
          (
            db
              .prepare(
                'SELECT COALESCE(MAX(task_index), -1) + 1 AS next_index FROM plan_task WHERE plan_uuid = ?'
              )
              .get(op.planUuid) as { next_index: number }
          ).next_index;
        shiftTaskIndexesForInsert(db, op.planUuid, index);
        db.prepare(
          'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, ?, 1)'
        ).run(op.taskUuid, op.planUuid, index, op.title, op.description ?? '', op.done ? 1 : 0);
        bumpPlan(db, op.planUuid);
      });
      break;
    case 'plan.update_task_text':
      updateTaskIfExists(db, op.planUuid, op.taskUuid, (task) => {
        const column = TASK_TEXT_COLUMNS[op.field];
        const current = (task[column] ?? '').toString();
        const next = mergeText(current, op.base, op.new);
        if (next === null) {
          return;
        }
        if (next !== current) {
          db.prepare(
            `UPDATE plan_task SET ${column} = ?, revision = revision + 1 WHERE uuid = ?`
          ).run(next, op.taskUuid);
          bumpPlan(db, op.planUuid);
        }
      });
      break;
    case 'plan.mark_task_done':
      updateTaskIfExists(db, op.planUuid, op.taskUuid, (task) => {
        const done = op.done ? 1 : 0;
        if (task.done !== done) {
          db.prepare('UPDATE plan_task SET done = ?, revision = revision + 1 WHERE uuid = ?').run(
            done,
            op.taskUuid
          );
          bumpPlan(db, op.planUuid);
        }
      });
      break;
    case 'plan.remove_task':
      updateTaskIfExists(db, op.planUuid, op.taskUuid, (task) => {
        db.prepare('DELETE FROM plan_task WHERE uuid = ?').run(op.taskUuid);
        shiftTaskIndexesAfterDelete(db, op.planUuid, task.task_index);
        bumpPlan(db, op.planUuid);
      });
      break;
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
      updatePlanIfExists(db, op.planUuid, () => {
        if (!getPlan(db, op.dependsOnPlanUuid)) {
          return;
        }
        const result =
          op.type === 'plan.add_dependency'
            ? db
                .prepare(
                  'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
                )
                .run(op.planUuid, op.dependsOnPlanUuid)
            : db
                .prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
                .run(op.planUuid, op.dependsOnPlanUuid);
        if (result.changes > 0) {
          bumpPlan(db, op.planUuid);
        }
      });
      break;
    case 'plan.add_tag':
    case 'plan.remove_tag':
      updatePlanIfExists(db, op.planUuid, () => {
        const result =
          op.type === 'plan.add_tag'
            ? db
                .prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)')
                .run(op.planUuid, op.tag)
            : db
                .prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?')
                .run(op.planUuid, op.tag);
        if (result.changes > 0) {
          bumpPlan(db, op.planUuid);
        }
      });
      break;
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
      updatePlanIfExists(db, op.planUuid, (plan) => {
        const column = LIST_COLUMNS[op.list];
        const current = parseJsonArray(plan[column]);
        const valueText = JSON.stringify(op.value);
        const index = current.findIndex((item) => JSON.stringify(item) === valueText);
        const next =
          op.type === 'plan.add_list_item'
            ? [...current, op.value]
            : index === -1
              ? current
              : current.filter((_, itemIndex) => itemIndex !== index);
        if (next !== current) {
          db.prepare(
            `UPDATE plan SET ${column} = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
          ).run(next.length === 0 ? null : JSON.stringify(next), op.planUuid);
        }
      });
      break;
    case 'plan.delete':
      db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? OR depends_on_uuid = ?').run(
        op.planUuid,
        op.planUuid
      );
      db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(op.planUuid);
      db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(op.planUuid);
      db.prepare('DELETE FROM plan WHERE uuid = ?').run(op.planUuid);
      break;
    case 'project_setting.set':
    case 'project_setting.delete':
      applyOptimisticProjectSetting(db, operation.originNodeId, op);
      break;
    case 'plan.set_parent':
      updatePlanIfExists(db, op.planUuid, (plan) => {
        if (op.newParentUuid && !getPlan(db, op.newParentUuid)) {
          return;
        }
        if (plan.parent_uuid !== op.newParentUuid) {
          db.prepare(
            `UPDATE plan SET parent_uuid = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
          ).run(op.newParentUuid, op.planUuid);
        }
        removeOtherParentDependencyEdges(db, op.newParentUuid, op.planUuid);
        if (op.newParentUuid) {
          ensureParentDependencyEdge(db, op.newParentUuid, op.planUuid);
        }
      });
      break;
    case 'plan.promote_task':
      updateTaskIfExists(db, op.sourcePlanUuid, op.taskUuid, () => {
        if (!getPlan(db, op.newPlanUuid)) {
          applyOptimisticPlanCreate(db, operation.projectUuid, {
            type: 'plan.create',
            planUuid: op.newPlanUuid,
            numericPlanId: op.numericPlanId,
            title: op.title,
            details: op.description,
            parentUuid: op.parentUuid,
            issue: [],
            pullRequest: [],
            docs: [],
            changedFiles: [],
            reviewIssues: [],
            tags: op.tags,
            dependencies: op.dependencies,
            tasks: [],
          });
        }
        db.prepare('UPDATE plan_task SET done = 1, revision = revision + 1 WHERE uuid = ?').run(
          op.taskUuid
        );
        bumpPlan(db, op.sourcePlanUuid);
      });
      break;
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function applyOptimisticPlanCreate(
  db: Database,
  projectUuid: string,
  op: Extract<SyncOperationPayload, { type: 'plan.create' }>
): void {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return;
  }
  if (getPlan(db, op.planUuid)) {
    if (op.parentUuid && getPlan(db, op.parentUuid)) {
      ensureParentDependencyEdge(db, op.parentUuid, op.planUuid);
    }
    return;
  }
  const numericPlanId =
    op.numericPlanId ??
    (
      db
        .prepare(
          `
            SELECT max(
              COALESCE((SELECT MAX(plan_id) FROM plan WHERE project_id = ?), 0),
              COALESCE((SELECT highest_plan_id FROM project WHERE id = ?), 0)
            ) + 1 AS next_id
          `
        )
        .get(project.id, project.id) as { next_id: number }
    ).next_id;
  db.prepare(
    `
      INSERT INTO plan (
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1,
        ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
    `
  ).run(
    op.planUuid,
    project.id,
    numericPlanId,
    op.title,
    op.goal ?? null,
    op.note ?? null,
    op.details ?? null,
    op.status ?? 'pending',
    op.priority ?? null,
    op.branch ?? null,
    typeof op.simple === 'boolean' ? (op.simple ? 1 : 0) : null,
    typeof op.tdd === 'boolean' ? (op.tdd ? 1 : 0) : null,
    op.discoveredFrom ?? null,
    JSON.stringify(op.issue),
    JSON.stringify(op.pullRequest),
    op.assignedTo ?? null,
    op.baseBranch ?? null,
    typeof op.temp === 'boolean' ? (op.temp ? 1 : 0) : null,
    JSON.stringify(op.docs),
    JSON.stringify(op.changedFiles),
    op.planGeneratedAt ?? null,
    JSON.stringify(op.reviewIssues),
    op.docsUpdatedAt ?? null,
    op.lessonsAppliedAt ?? null,
    op.parentUuid ?? null,
    op.epic ? 1 : 0
  );
  op.tasks.forEach((task, index) => {
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).run(task.taskUuid, op.planUuid, index, task.title, task.description, task.done ? 1 : 0);
  });
  for (const tag of new Set(op.tags)) {
    db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(
      op.planUuid,
      tag
    );
  }
  for (const dependencyUuid of new Set(op.dependencies)) {
    if (getPlan(db, dependencyUuid)) {
      db.prepare(
        'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
      ).run(op.planUuid, dependencyUuid);
    }
  }
  if (op.parentUuid && getPlan(db, op.parentUuid)) {
    ensureParentDependencyEdge(db, op.parentUuid, op.planUuid);
  }
}

function applyOptimisticProjectSetting(
  db: Database,
  originNodeId: string,
  op: Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>
): void {
  const project = getProjectByUuid(db, op.projectUuid);
  if (!project) {
    return;
  }
  if (op.type === 'project_setting.delete') {
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      op.setting
    );
    return;
  }
  db.prepare(
    `
      INSERT INTO project_setting (project_id, setting, value, revision, updated_at, updated_by_node)
      VALUES (?, ?, ?, 1, ${SQL_NOW_ISO_UTC}, ?)
      ON CONFLICT(project_id, setting) DO UPDATE SET
        value = excluded.value,
        revision = project_setting.revision + 1,
        updated_at = ${SQL_NOW_ISO_UTC},
        updated_by_node = excluded.updated_by_node
    `
  ).run(project.id, op.setting, JSON.stringify(op.value), originNodeId);
}

function writeCanonicalSnapshot(db: Database, snapshot: CanonicalSnapshot): void {
  if (snapshot.type === 'never_existed') {
    writeNeverExistedSnapshot(db, snapshot);
    return;
  }

  if (snapshot.type === 'plan_deleted') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? OR depends_on_uuid = ?').run(
      snapshot.planUuid,
      snapshot.planUuid
    );
    db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(snapshot.planUuid);
    db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(snapshot.planUuid);
    if (project) {
      removeAssignment(db, project.id, snapshot.planUuid);
    }
    db.prepare('DELETE FROM plan WHERE uuid = ?').run(snapshot.planUuid);
    // All three branches of the OR hit indexes (idx_sync_operation_target_key,
    // idx_sync_operation_payload_plan_uuid, idx_sync_operation_payload_secondary_plan_uuid),
    // so SQLite can satisfy this with OR-via-UNION lookups instead of scanning.
    // The secondary branch covers multi-plan ops like `plan.promote_task` whose
    // sourcePlanUuid is the deleted plan; the primary branch covers their
    // newPlanUuid; target_key covers any future op kinds whose target is the
    // deleted plan but whose payload doesn't carry the UUID under either column.
    db.prepare(
      `
        UPDATE sync_operation
        SET status = 'rejected',
            last_error = ?,
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE project_uuid = ?
          AND status IN ('queued', 'failed_retryable')
          AND (
            target_key = ?
            OR payload_plan_uuid = ?
            OR payload_secondary_plan_uuid = ?
          )
      `
    ).run(
      `Target plan ${snapshot.planUuid} was deleted on the main node`,
      snapshot.projectUuid,
      `plan:${snapshot.planUuid}`,
      snapshot.planUuid,
      snapshot.planUuid
    );
    return;
  }

  if (snapshot.type === 'project_setting') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    if (!project) {
      return;
    }
    if (snapshot.deleted) {
      db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
        project.id,
        snapshot.setting
      );
      return;
    }
    db.prepare(
      `
        INSERT INTO project_setting (project_id, setting, value, revision, updated_at, updated_by_node)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, setting) DO UPDATE SET
          value = excluded.value,
          revision = excluded.revision,
          updated_at = excluded.updated_at,
          updated_by_node = excluded.updated_by_node
      `
    ).run(
      project.id,
      snapshot.setting,
      JSON.stringify(snapshot.value),
      snapshot.revision,
      snapshot.updatedAt ?? null,
      snapshot.updatedByNode ?? null
    );
    return;
  }

  const project = getProjectByUuid(db, snapshot.projectUuid);
  if (!project) {
    return;
  }
  const localPlan = db
    .prepare('SELECT base_commit, base_change_id FROM plan WHERE uuid = ?')
    .get(snapshot.plan.uuid) as {
    base_commit: string | null;
    base_change_id: string | null;
  } | null;
  upsertPlanInTransaction(db, project.id, {
    uuid: snapshot.plan.uuid,
    planId: snapshot.plan.planId,
    title: snapshot.plan.title,
    goal: snapshot.plan.goal,
    note: snapshot.plan.note,
    details: snapshot.plan.details,
    status: snapshot.plan.status,
    priority: snapshot.plan.priority,
    branch: snapshot.plan.branch,
    simple: snapshot.plan.simple,
    tdd: snapshot.plan.tdd,
    discoveredFrom: snapshot.plan.discoveredFrom,
    parentUuid: snapshot.plan.parentUuid,
    epic: snapshot.plan.epic,
    revision: snapshot.plan.revision,
    issue: snapshot.plan.issue,
    pullRequest: snapshot.plan.pullRequest,
    assignedTo: snapshot.plan.assignedTo,
    baseBranch: snapshot.plan.baseBranch,
    baseCommit: localPlan?.base_commit ?? null,
    baseChangeId: localPlan?.base_change_id ?? null,
    temp: snapshot.plan.temp,
    docs: snapshot.plan.docs,
    changedFiles: snapshot.plan.changedFiles,
    planGeneratedAt: snapshot.plan.planGeneratedAt,
    reviewIssues: snapshot.plan.reviewIssues as never,
    tasks: snapshot.plan.tasks.map((task) => ({
      uuid: task.uuid,
      title: task.title,
      description: task.description,
      done: task.done,
      revision: task.revision,
    })),
    dependencyUuids: snapshot.plan.dependencyUuids,
    tags: snapshot.plan.tags,
    forceOverwrite: true,
  });
  db.prepare('UPDATE plan SET revision = ? WHERE uuid = ?').run(
    snapshot.plan.revision,
    snapshot.plan.uuid
  );
  for (const task of snapshot.plan.tasks) {
    db.prepare('UPDATE plan_task SET revision = ? WHERE uuid = ?').run(task.revision, task.uuid);
  }
  if (ASSIGNMENT_CLEANUP_STATUSES.has(snapshot.plan.status)) {
    removeAssignment(db, project.id, snapshot.plan.uuid);
  }
}

function writeNeverExistedSnapshot(db: Database, snapshot: CanonicalNeverExistedSnapshot): void {
  if (snapshot.targetType === 'plan') {
    db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? OR depends_on_uuid = ?').run(
      snapshot.planUuid,
      snapshot.planUuid
    );
    db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(snapshot.planUuid);
    db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(snapshot.planUuid);
    db.prepare('DELETE FROM plan WHERE uuid = ?').run(snapshot.planUuid);
    rejectPendingOperationsForNeverExistedPlan(
      db,
      snapshot.entityKey,
      snapshot.planUuid,
      `Target plan ${snapshot.planUuid} never existed on the main node`
    );
    return;
  }

  const task = getTask(db, snapshot.taskUuid);
  if (task) {
    db.prepare('DELETE FROM plan_task WHERE uuid = ?').run(snapshot.taskUuid);
    shiftTaskIndexesAfterDelete(db, task.plan_uuid, task.task_index);
  }
  rejectPendingOperationsForNeverExistedTask(
    db,
    snapshot.entityKey,
    snapshot.taskUuid,
    `Target task ${snapshot.taskUuid} never existed on the main node`
  );
}

function rejectPendingOperationsForNeverExistedPlan(
  db: Database,
  entityKey: string,
  planUuid: string,
  message: string
): void {
  // All three branches hit indexes; SQLite uses OR-via-UNION. The secondary
  // branch covers `plan.promote_task` ops whose sourcePlanUuid is the
  // never-existed plan.
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'rejected',
          last_error = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE status IN ('queued', 'failed_retryable')
        AND (
          target_key = ?
          OR payload_plan_uuid = ?
          OR payload_secondary_plan_uuid = ?
        )
    `
  ).run(message, entityKey, planUuid, planUuid);
}

function rejectPendingOperationsForNeverExistedTask(
  db: Database,
  entityKey: string,
  taskUuid: string,
  message: string
): void {
  // Both branches hit indexes (idx_sync_operation_target_key and
  // idx_sync_operation_payload_task_uuid), so SQLite uses OR-via-UNION.
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'rejected',
          last_error = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE status IN ('queued', 'failed_retryable')
        AND (
          target_key = ?
          OR payload_task_uuid = ?
        )
    `
  ).run(message, entityKey, taskUuid);
}

function removeAssignmentForPlan(db: Database, projectUuid: string, planUuid: string): void {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return;
  }
  removeAssignment(db, project.id, planUuid);
}

function pendingOperationsForSnapshot(
  db: Database,
  snapshot: CanonicalSnapshot
): SyncOperationEnvelope[] {
  if (snapshot.type === 'plan_deleted' || snapshot.type === 'never_existed') {
    return [];
  }
  const rows = db
    .prepare(
      `
        SELECT *
        FROM sync_operation
        WHERE project_uuid = ?
          AND status IN ('queued', 'failed_retryable')
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(snapshot.projectUuid) as SyncOperationQueueRow[];
  return rows
    .map(rowToEnvelope)
    .filter((operation) => operationAffectsSnapshot(operation, snapshot));
}

function operationAffectsSnapshot(
  operation: SyncOperationEnvelope,
  snapshot: CanonicalSnapshot
): boolean {
  if (snapshot.type === 'project_setting') {
    return operation.targetKey === `project_setting:${snapshot.projectUuid}:${snapshot.setting}`;
  }
  if (snapshot.type === 'plan_deleted' || snapshot.type === 'never_existed') {
    return false;
  }
  const planUuid = snapshot.plan.uuid;
  const op = operation.op;
  if (affectedPlanUuids(op).has(planUuid)) {
    return true;
  }
  if (op.type === 'plan.set_parent' && snapshot.plan.dependencyUuids?.includes(op.planUuid)) {
    return true;
  }
  if (op.type === 'plan.delete' && snapshot.plan.dependencyUuids.includes(op.planUuid)) {
    return true;
  }
  if (operation.targetType === 'task') {
    const task = getTaskByUuidFromSnapshot(snapshot, op);
    return task !== null;
  }
  return false;
}

function affectedPlanUuids(op: SyncOperationPayload): Set<string> {
  const uuids = new Set<string>();
  if ('planUuid' in op) {
    uuids.add(op.planUuid);
  }
  switch (op.type) {
    case 'plan.create':
      if (op.parentUuid) {
        uuids.add(op.parentUuid);
      }
      break;
    case 'plan.set_parent':
      if (op.newParentUuid) {
        uuids.add(op.newParentUuid);
      }
      if (op.previousParentUuid) {
        uuids.add(op.previousParentUuid);
      }
      break;
    case 'plan.promote_task':
      uuids.add(op.sourcePlanUuid);
      uuids.add(op.newPlanUuid);
      if (op.parentUuid) {
        uuids.add(op.parentUuid);
      }
      break;
  }
  return uuids;
}

function getTaskByUuidFromSnapshot(
  snapshot: CanonicalPlanSnapshot,
  op: SyncOperationPayload
): string | null {
  if (!('taskUuid' in op)) {
    return null;
  }
  return snapshot.plan.tasks?.some((task) => task.uuid === op.taskUuid) ? op.taskUuid : null;
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
      if (transition.tolerateTerminal && isTerminalOperationStatus(row.status)) {
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

function isTerminalOperationStatus(status: QueueOperationStatus): boolean {
  return status === 'acked' || status === 'conflict' || status === 'rejected';
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

function updatePlanIfExists(db: Database, planUuid: string, fn: (plan: PlanRow) => void): void {
  const plan = getPlan(db, planUuid);
  if (!plan) {
    return;
  }
  fn(plan);
}

function updateTaskIfExists(
  db: Database,
  planUuid: string,
  taskUuid: string,
  fn: (task: PlanTaskRow) => void
): void {
  const task = getTask(db, taskUuid);
  if (!task || task.plan_uuid !== planUuid) {
    return;
  }
  fn(task);
}

function getPlan(db: Database, planUuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null) ?? null;
}

function getTask(db: Database, taskUuid: string): PlanTaskRow | null {
  return (
    (db.prepare('SELECT * FROM plan_task WHERE uuid = ?').get(taskUuid) as PlanTaskRow | null) ??
    null
  );
}

function bumpPlan(db: Database, planUuid: string): void {
  db.prepare(
    `UPDATE plan SET revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(planUuid);
}

function ensureParentDependencyEdge(db: Database, parentUuid: string, childUuid: string): void {
  const result = db
    .prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)')
    .run(parentUuid, childUuid);
  if (result.changes > 0) {
    bumpPlan(db, parentUuid);
  }
}

function removeParentDependencyEdge(db: Database, parentUuid: string, childUuid: string): void {
  const result = db
    .prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
    .run(parentUuid, childUuid);
  if (result.changes > 0) {
    bumpPlan(db, parentUuid);
  }
}

function removeOtherParentDependencyEdges(
  db: Database,
  desiredParentUuid: string | null,
  childUuid: string
): void {
  // V1 stores parent edges and explicit dependency edges in the same table, so
  // optimistic parent replay cannot distinguish them. A future schema can add
  // an edge-kind column, or refresh layering can replay queued add_dependency
  // ops after this reset, to preserve explicit incoming edges locally.
  const rows = db
    .prepare(
      `SELECT plan_uuid
       FROM plan_dependency
       WHERE depends_on_uuid = ?
         AND (? IS NULL OR plan_uuid <> ?)`
    )
    .all(childUuid, desiredParentUuid, desiredParentUuid) as Array<{ plan_uuid: string }>;
  for (const row of rows) {
    removeParentDependencyEdge(db, row.plan_uuid, childUuid);
  }
}

function mergeText(current: string, base: string, incoming: string): string | null {
  if (base === incoming || current === incoming) {
    return current;
  }
  if (current === base) {
    return incoming;
  }
  const patch = diff.createPatch('field', base, incoming, '', '', { context: 3 });
  const merged = diff.applyPatch(current, patch, { fuzzFactor: 0 });
  return merged === false ? null : merged;
}

function parseJsonArray(value: unknown): unknown[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (!warnedMalformedJsonList) {
      warnedMalformedJsonList = true;
      console.warn(
        `Ignoring malformed plan JSON list value during optimistic sync apply: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
