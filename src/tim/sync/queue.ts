import type { Database } from 'bun:sqlite';
import * as z from 'zod/v4';
import { warn } from '../../logging.js';
import { refreshExistingPrimaryMaterializedPlans } from '../materialized_projection_refresh.js';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  upsertCanonicalPlanInTransaction,
  type PlanRow,
} from '../db/plan.js';
import { getProjectByUuid } from '../db/project.js';
import {
  deleteCanonicalProjectSettingRow,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import { planKey, taskKey } from './entity_keys.js';
import {
  assertValidEnvelope,
  assertValidBatchEnvelope,
  assertValidPayload,
  type SyncOperationBatchEnvelope,
  deriveTargetKey,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
} from './types.js';
import { getSyncOperationPayloadIndexes } from './payload_indexes.js';
import { getSyncOperationPlanRefs, PROJECTION_REBUILD_PLAN_REF_ROLES } from './plan_refs.js';
import {
  rebuildPlanProjectionInTransaction,
  rebuildProjectSettingProjection,
  rebuildProjectSettingProjectionForPayload,
} from './projection.js';
import { recordSyncTombstone } from './conflicts.js';

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

const TERMINAL_OPERATION_STATUSES = ['acked', 'conflict', 'rejected'] as const;

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
    discoveredFrom: string | null;
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

const ASSIGNMENT_CLEANUP_STATUSES = new Set(['done', 'needs_review', 'cancelled']);

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
    discoveredFrom: z.string().nullable(),
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
    const affectedPlanUuids = new Set<string>();
    const affectedProjectSettings = new Map<string, ProjectSettingPayload>();
    for (const operation of operations) {
      insertQueuedOperation(db, operation, batch.batchId, batch.atomic === true);
      collectAffectedProjectionPlanUuids(db, affectedPlanUuids, operation.op);
      if (
        operation.op.type === 'project_setting.set' ||
        operation.op.type === 'project_setting.delete'
      ) {
        affectedProjectSettings.set(
          `${operation.op.projectUuid}:${operation.op.setting}`,
          operation.op
        );
      }
    }
    for (const planUuid of affectedPlanUuids) {
      rebuildPlanProjectionInTransaction(db, planUuid);
    }
    for (const payload of affectedProjectSettings.values()) {
      rebuildProjectSettingProjectionForPayload(db, payload);
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
        WHERE status IN (${TERMINAL_OPERATION_STATUSES.map(() => '?').join(', ')})
      )
    `
    )
    .run(...TERMINAL_OPERATION_STATUSES);
  return result.changes;
}

/**
 * Applies one canonical entity snapshot from the main node, then layers this
 * node's still-active optimistic operations back on top. Scope is intentionally
 * narrow for Task 6: a single plan with tasks/dependencies/tags/list fields or
 * a single project setting.
 */
export function mergeCanonicalRefresh(db: Database, snapshot: CanonicalSnapshot): string[] {
  const parsedSnapshot = CanonicalSnapshotSchema.parse(snapshot);
  const merge = db.transaction((nextSnapshot: CanonicalSnapshot): string[] => {
    return writeCanonicalSnapshot(db, nextSnapshot);
  });
  const affectedPlanUuids = merge.immediate(parsedSnapshot);
  // File refresh intentionally runs after the SQLite transaction. A missed or
  // dirty materialization self-heals on the next explicit materialize/sync pass.
  refreshExistingPrimaryMaterializedPlans(db, affectedPlanUuids);
  return affectedPlanUuids;
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'queued', 0, NULL, ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, ?, ?)
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
    indexes.payloadTaskUuid,
    operation.createdAt,
    batchId ?? null,
    batchAtomic ? 1 : 0
  );
  insertOperationPlanRefs(db, operation.operationUuid, operation.projectUuid, operation.op);
}

function insertOperationPlanRefs(
  db: Database,
  operationUuid: string,
  projectUuid: string,
  payload: SyncOperationPayload
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

function rebuildQueuedOperationProjectionInTransaction(
  db: Database,
  operation: SyncOperationEnvelope
): void {
  const op = assertValidPayload(operation.op);
  if (op.type === 'project_setting.set' || op.type === 'project_setting.delete') {
    rebuildProjectSettingProjectionForPayload(db, op);
    return;
  }
  for (const planUuid of getAffectedProjectionPlanUuids(db, op)) {
    rebuildPlanProjectionInTransaction(db, planUuid);
  }
}

function collectAffectedProjectionPlanUuids(
  db: Database,
  target: Set<string>,
  payload: SyncOperationPayload
): void {
  for (const planUuid of getAffectedProjectionPlanUuids(db, payload)) {
    target.add(planUuid);
  }
}

type ProjectSettingPayload = Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
>;

function getAffectedProjectionPlanUuids(db: Database, payload: SyncOperationPayload): string[] {
  if (payload.type === 'project_setting.set' || payload.type === 'project_setting.delete') {
    return [];
  }
  const affected = new Set(
    getSyncOperationPlanRefs(payload)
      .filter((ref) => PROJECTION_REBUILD_PLAN_REF_ROLES.has(ref.role))
      .map((ref) => ref.planUuid)
  );
  if (payload.type === 'plan.delete') {
    for (const ownerPlanUuid of getInboundProjectionOwnerPlanUuids(db, payload.planUuid)) {
      affected.add(ownerPlanUuid);
    }
  }
  return [...affected];
}

export function getInboundProjectionOwnerPlanUuids(
  db: Database,
  deletedPlanUuid: string
): string[] {
  const rows = db
    .prepare(
      `
        SELECT plan_uuid
        FROM plan_dependency
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan
        WHERE parent_uuid = ?
        UNION
        SELECT plan_uuid
        FROM plan_dependency_canonical
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan_canonical
        WHERE parent_uuid = ?
      `
    )
    .all(deletedPlanUuid, deletedPlanUuid, deletedPlanUuid, deletedPlanUuid) as Array<{
    plan_uuid: string;
  }>;
  return rows.map((row) => row.plan_uuid);
}

export function rebuildPlanProjectionAndInboundOwnersInTransaction(
  db: Database,
  planUuid: string
): string[] {
  const rebuildPlanUuids = new Set([planUuid]);
  for (const ownerPlanUuid of getInboundProjectionOwnerPlanUuids(db, planUuid)) {
    rebuildPlanUuids.add(ownerPlanUuid);
  }
  for (const rebuildPlanUuid of rebuildPlanUuids) {
    rebuildPlanProjectionInTransaction(db, rebuildPlanUuid);
  }
  return [...rebuildPlanUuids];
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

function writeCanonicalSnapshot(db: Database, snapshot: CanonicalSnapshot): string[] {
  if (snapshot.type === 'never_existed') {
    return writeNeverExistedSnapshot(db, snapshot);
  }

  if (snapshot.type === 'plan_deleted') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    deleteCanonicalPlanState(db, snapshot.planUuid);
    if (project) {
      recordSyncTombstone(db, {
        entityType: 'plan',
        entityKey: planKey(snapshot.planUuid),
        projectUuid: snapshot.projectUuid,
        deletionOperationUuid:
          snapshot.deletedBySequenceId === undefined
            ? `canonical-delete:${snapshot.planUuid}`
            : `canonical-sequence:${snapshot.deletedBySequenceId}`,
        deletedRevision: null,
        originNodeId: 'main',
      });
      removeAssignment(db, project.id, snapshot.planUuid);
    }
    return rebuildPlanProjectionAndInboundOwnersInTransaction(db, snapshot.planUuid);
  }

  if (snapshot.type === 'project_setting') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    if (!project) {
      return [];
    }
    if (snapshot.deleted) {
      deleteCanonicalProjectSettingRow(db, project.id, snapshot.setting);
      rebuildProjectSettingProjection(db, project.id, snapshot.setting);
      return [];
    }
    writeCanonicalProjectSettingRow(db, project.id, snapshot.setting, snapshot.value, {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt ?? null,
      updatedByNode: snapshot.updatedByNode ?? null,
    });
    rebuildProjectSettingProjection(db, project.id, snapshot.setting);
    return [];
  }

  const project = getProjectByUuid(db, snapshot.projectUuid);
  if (!project) {
    return [];
  }
  upsertCanonicalPlanInTransaction(db, project.id, {
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
    discoveredFrom: resolveCanonicalPlanId(db, project.id, snapshot.plan.discoveredFrom),
    parentUuid: snapshot.plan.parentUuid,
    epic: snapshot.plan.epic,
    revision: snapshot.plan.revision,
    issue: snapshot.plan.issue,
    pullRequest: snapshot.plan.pullRequest,
    assignedTo: snapshot.plan.assignedTo,
    baseBranch: snapshot.plan.baseBranch,
    baseCommit: null,
    baseChangeId: null,
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
  db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
    'plan',
    planKey(snapshot.plan.uuid)
  );
  const clearTaskTombstone = db.prepare(
    'DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?'
  );
  for (const task of snapshot.plan.tasks) {
    clearTaskTombstone.run('task', taskKey(task.uuid));
  }
  rebuildPlanProjectionInTransaction(db, snapshot.plan.uuid);
  if (ASSIGNMENT_CLEANUP_STATUSES.has(snapshot.plan.status)) {
    removeAssignment(db, project.id, snapshot.plan.uuid);
  }
  return [snapshot.plan.uuid];
}

function writeNeverExistedSnapshot(
  db: Database,
  snapshot: CanonicalNeverExistedSnapshot
): string[] {
  if (snapshot.targetType === 'plan') {
    const projectUuid = resolveProjectUuidForPlanTombstone(db, snapshot.planUuid);
    deleteCanonicalPlanState(db, snapshot.planUuid);
    if (projectUuid) {
      recordSyncTombstone(db, {
        entityType: 'plan',
        entityKey: planKey(snapshot.planUuid),
        projectUuid,
        deletionOperationUuid: `canonical-never-existed:${snapshot.planUuid}`,
        deletedRevision: null,
        originNodeId: 'main',
      });
    }
    return rebuildPlanProjectionAndInboundOwnersInTransaction(db, snapshot.planUuid);
  }

  const ownerPlanUuid = resolveOwningPlanUuidForTaskNeverExisted(db, snapshot.taskUuid);
  const projectUuid =
    ownerPlanUuid === null ? resolveProjectUuidForTaskNeverExisted(db, snapshot.taskUuid) : null;
  db.prepare('DELETE FROM task_canonical WHERE uuid = ?').run(snapshot.taskUuid);
  const ownerProjectUuid =
    ownerPlanUuid === null ? projectUuid : resolveProjectUuidForPlanTombstone(db, ownerPlanUuid);
  if (ownerProjectUuid) {
    recordSyncTombstone(db, {
      entityType: 'task',
      entityKey: taskKey(snapshot.taskUuid),
      projectUuid: ownerProjectUuid,
      deletionOperationUuid: `canonical-never-existed:${snapshot.taskUuid}`,
      deletedRevision: null,
      originNodeId: 'main',
    });
  }
  if (ownerPlanUuid) {
    rebuildPlanProjectionInTransaction(db, ownerPlanUuid);
    return [ownerPlanUuid];
  }
  return [];
}

function deleteCanonicalPlanState(db: Database, planUuid: string): void {
  db.prepare(
    'DELETE FROM plan_dependency_canonical WHERE plan_uuid = ? OR depends_on_uuid = ?'
  ).run(planUuid, planUuid);
  db.prepare('DELETE FROM plan_tag_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM task_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan_canonical WHERE uuid = ?').run(planUuid);
}

function resolveCanonicalPlanId(
  db: Database,
  projectId: number | null,
  planUuid: string | null | undefined
): number | null {
  if (!projectId || !planUuid) {
    return null;
  }
  const row = db
    .prepare('SELECT plan_id FROM plan_canonical WHERE project_id = ? AND uuid = ?')
    .get(projectId, planUuid) as { plan_id: number } | null;
  return row?.plan_id ?? null;
}

function resolveProjectUuidForPlanTombstone(db: Database, planUuid: string): string | null {
  const row = db
    .prepare(
      `
        SELECT p.uuid AS project_uuid
        FROM plan_canonical pc
        JOIN project p ON p.id = pc.project_id
        WHERE pc.uuid = ?
        UNION
        SELECT p.uuid AS project_uuid
        FROM plan pl
        JOIN project p ON p.id = pl.project_id
        WHERE pl.uuid = ?
        UNION
        SELECT project_uuid
        FROM sync_operation_plan_ref
        WHERE plan_uuid = ?
        LIMIT 1
      `
    )
    .get(planUuid, planUuid, planUuid) as { project_uuid: string } | null;
  return row?.project_uuid ?? null;
}

function resolveOwningPlanUuidForTaskNeverExisted(db: Database, taskUuid: string): string | null {
  const row = db
    .prepare(
      `
        SELECT plan_uuid
        FROM task_canonical
        WHERE uuid = ?
        UNION
        SELECT plan_uuid
        FROM plan_task
        WHERE uuid = ?
        LIMIT 1
      `
    )
    .get(taskUuid, taskUuid) as { plan_uuid: string } | null;
  if (row?.plan_uuid) {
    return row.plan_uuid;
  }

  for (const op of activeOperationsReferencingTask(db, taskUuid)) {
    const planUuid = planUuidFromTaskPayload(op);
    if (planUuid) {
      return planUuid;
    }
  }
  return null;
}

function resolveProjectUuidForTaskNeverExisted(db: Database, taskUuid: string): string | null {
  for (const op of activeOperationsReferencingTask(db, taskUuid)) {
    if (op.project_uuid) {
      return op.project_uuid;
    }
  }
  return null;
}

function activeOperationsReferencingTask(
  db: Database,
  taskUuid: string
): Array<{ project_uuid: string; payload: string }> {
  return db
    .prepare(
      `
        SELECT project_uuid, payload
        FROM sync_operation
        WHERE payload_task_uuid = ?
          AND status IN ('queued', 'sending', 'failed_retryable')
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(taskUuid) as Array<{ project_uuid: string; payload: string }>;
}

function planUuidFromTaskPayload(row: { payload: string }): string | null {
  const payload = assertValidPayload(JSON.parse(row.payload));
  if (!('taskUuid' in payload)) {
    return null;
  }
  if (payload.type === 'plan.promote_task') {
    return payload.sourcePlanUuid;
  }
  return 'planUuid' in payload ? payload.planUuid : null;
}

function removeAssignmentForPlan(db: Database, projectUuid: string, planUuid: string): void {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return;
  }
  removeAssignment(db, project.id, planUuid);
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

function getPlan(db: Database, planUuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
