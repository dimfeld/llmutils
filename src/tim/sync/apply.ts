import type { Database } from 'bun:sqlite';
import * as diff from 'diff';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { PlanRow, PlanTaskRow } from '../db/plan.js';
import { SyncFifoGapError, SyncValidationError } from './errors.js';
import { createSyncConflict, recordSyncTombstone } from './conflicts.js';
import {
  assertValidBatchEnvelope,
  assertValidEnvelope,
  assertValidPayload,
  type SyncOperationBatchEnvelope,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
} from './types.js';
import { shiftTaskIndexesAfterDelete, shiftTaskIndexesForInsert } from './task_indexes.js';

export type ApplyOperationStatus =
  | 'applied'
  | 'conflict'
  | 'rejected'
  | 'deferred'
  | 'failed_retryable';
export type TargetKey = `${string}:${string}` | string;

export interface ApplyOperationResult {
  status: ApplyOperationStatus;
  sequenceId?: number;
  sequenceIds: number[];
  invalidations: TargetKey[];
  conflictId?: string;
  acknowledged: boolean;
  resolvedNumericPlanId?: number;
  error?: Error;
}

export interface ApplyOperationOptions {
  localMainNodeId?: string;
  preserveRequestedPlanIds?: boolean;
  cleanupAssignmentsOnStatusChange?: boolean;
  skipUpdatedAt?: boolean;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
}

export interface ApplyBatchResult {
  batchId: string;
  status: 'applied' | 'rejected' | 'deferred';
  results: ApplyOperationResult[];
  invalidations: TargetKey[];
  sequenceIds: number[];
  error?: Error;
}

export interface ResolveSyncConflictOptions {
  mode: 'apply-current' | 'apply-incoming' | 'manual';
  manualValue?: unknown;
  resolvedByNode: string;
}

export interface ResolveSyncConflictResult {
  conflictId: string;
  status: 'resolved_applied' | 'resolved_discarded';
  sequenceIds: number[];
  invalidations: TargetKey[];
}

type ProjectRow = { id: number; uuid: string };

type Mutation = {
  targetType: string;
  targetKey: string;
  revision: number | null;
};

const TERMINAL_OPERATION_STATUSES = new Set(['applied', 'conflict', 'rejected']);
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
const PLAN_UPDATED_AT_ASSIGNMENT = `updated_at = CASE WHEN ? THEN updated_at ELSE COALESCE(?, ${SQL_NOW_ISO_UTC}) END`;

function planUpdatedAtArgs(options: ApplyOperationOptions): [number, string | null] {
  return [options.skipUpdatedAt === true ? 1 : 0, options.sourceUpdatedAt ?? null];
}

export function applyOperation(
  db: Database,
  envelopeInput: SyncOperationEnvelope,
  options: ApplyOperationOptions = {}
): ApplyOperationResult {
  // Synced ops are limited to tim-owned plan/project-setting state. PR caches,
  // webhooks, sessions, workspaces, locks, launch locks, assignments, materialized
  // shadow metadata, and git/source history are excluded; touching them here is a bug.
  const originalPayload = JSON.stringify((envelopeInput as { op: unknown }).op);
  const envelope = assertValidEnvelope(envelopeInput);
  const normalizedPayload = JSON.stringify(envelope.op);

  const apply = db.transaction(
    (nextEnvelope: SyncOperationEnvelope): ApplyOperationResult =>
      applyOperationInTransaction(db, nextEnvelope, originalPayload, normalizedPayload, options)
  );

  const priorRow = getOperationRow(db, envelope.operationUuid);
  const isReplay = !!priorRow && TERMINAL_OPERATION_STATUSES.has(priorRow.status);

  const result = apply.immediate(envelope);
  if (result.error) {
    throw result.error;
  }
  if (!isReplay && result.status === 'applied' && result.resolvedNumericPlanId !== undefined) {
    const op = envelope.op;
    const requested =
      op.type === 'plan.create' || op.type === 'plan.promote_task' ? op.numericPlanId : undefined;
    const newPlanUuid =
      op.type === 'plan.create'
        ? op.planUuid
        : op.type === 'plan.promote_task'
          ? op.newPlanUuid
          : undefined;
    if (requested !== undefined && newPlanUuid && requested !== result.resolvedNumericPlanId) {
      console.log(
        `[sync] ${op.type} renumbered ${newPlanUuid} from ${requested} to ${result.resolvedNumericPlanId}`
      );
    }
  }
  return result;
}

export function applyBatch(
  db: Database,
  batchInput: SyncOperationBatchEnvelope,
  options: ApplyOperationOptions = {}
): ApplyBatchResult {
  const batch = assertValidBatchEnvelope(batchInput);
  assertUniqueBatchOperationUuids(batch);
  const replay = getBatchReplayResult(db, batch);
  if (replay) {
    return replay;
  }

  const originalPayloads = batch.operations.map((operation) =>
    JSON.stringify((operation as { op: unknown }).op)
  );
  const normalizedPayloads = batch.operations.map((operation) =>
    JSON.stringify(assertValidEnvelope(operation).op)
  );

  const apply = db.transaction((): ApplyBatchResult => {
    const results: ApplyOperationResult[] = [];
    for (const [index, operation] of batch.operations.entries()) {
      const result = applyOperationInTransaction(
        db,
        operation,
        originalPayloads[index],
        normalizedPayloads[index],
        options,
        batch.batchId
      );
      results.push(result);
      applyBatchOperationHookForTesting?.(index, operation);
      if (result.status === 'rejected' || result.status === 'deferred') {
        throw new BatchAbort(result, results);
      }
    }
    return aggregateBatchResult(batch.batchId, results);
  });

  try {
    return apply.immediate();
  } catch (error) {
    if (error instanceof BatchAbort) {
      // Rejection rows written by operations inside this transaction roll back with
      // the batch; the returned batch_result is the durable rejection signal.
      const status = error.result.status === 'deferred' ? 'deferred' : 'rejected';
      return {
        batchId: batch.batchId,
        status,
        results: rolledBackBatchResults(batch.operations, error.result),
        invalidations: [],
        sequenceIds: [],
        error: error.result.error,
      };
    }
    if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
      // Rejection rows written by operations inside this transaction roll back with
      // the batch; the returned batch_result is the durable rejection signal.
      const status = error instanceof SyncFifoGapError ? 'deferred' : 'rejected';
      return {
        batchId: batch.batchId,
        status,
        results: rolledBackBatchResults(batch.operations, {
          status,
          sequenceIds: [],
          invalidations: [],
          acknowledged: status === 'rejected',
          error,
        } as ApplyOperationResult),
        invalidations: [],
        sequenceIds: [],
        error,
      };
    }
    throw error;
  }
}

let applyBatchOperationHookForTesting:
  | ((index: number, operation: SyncOperationEnvelope) => void)
  | null = null;

export function setApplyBatchOperationHookForTesting(
  hook: ((index: number, operation: SyncOperationEnvelope) => void) | null
): void {
  applyBatchOperationHookForTesting = hook;
}

function assertUniqueBatchOperationUuids(batch: SyncOperationBatchEnvelope): void {
  const seen = new Set<string>();
  for (const operation of batch.operations) {
    if (seen.has(operation.operationUuid)) {
      throw new SyncValidationError('batch contains duplicate operation UUIDs', {
        operationUuid: operation.operationUuid,
        issues: [],
      });
    }
    seen.add(operation.operationUuid);
  }
}

function applyOperationInTransaction(
  db: Database,
  nextEnvelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions = {},
  batchId?: string
): ApplyOperationResult {
  const existing = getOperationRow(db, nextEnvelope.operationUuid);
  if (existing && TERMINAL_OPERATION_STATUSES.has(existing.status)) {
    return resultFromRecordedOperation(db, existing);
  }

  if (!existing) {
    // Check for duplicate localSequence before inserting to avoid SQLiteError from the
    // UNIQUE(origin_node_id, local_sequence) constraint.
    const duplicateSeq = db
      .prepare(
        `SELECT operation_uuid FROM sync_operation
         WHERE origin_node_id = ? AND local_sequence = ? AND operation_uuid <> ? LIMIT 1`
      )
      .get(nextEnvelope.originNodeId, nextEnvelope.localSequence, nextEnvelope.operationUuid) as {
      operation_uuid: string;
    } | null;
    if (duplicateSeq) {
      throw validationError(
        nextEnvelope,
        `localSequence ${nextEnvelope.localSequence} is already used by ${duplicateSeq.operation_uuid}`
      );
    }
    insertReceivedOperation(db, nextEnvelope, normalizedPayload, batchId);
  }

  const project = db
    .prepare('SELECT id, uuid FROM project WHERE uuid = ?')
    .get(nextEnvelope.projectUuid) as ProjectRow | null;
  if (!project) {
    const error = validationError(nextEnvelope, `Unknown project ${nextEnvelope.projectUuid}`);
    rejectOperation(db, nextEnvelope.operationUuid, error.message);
    return rejectedResult(error);
  }

  const fifoError = checkFifo(db, nextEnvelope);
  if (fifoError) {
    return {
      status: 'deferred',
      sequenceIds: [],
      invalidations: [],
      acknowledged: false,
      error: fifoError,
    };
  }

  try {
    const selfTombstone = getTombstone(db, nextEnvelope.targetType, nextEnvelope.targetKey);
    // Task-scoped ops (anything carrying planUuid) must also honor the owning
    // plan's tombstone so a task add/edit against a deleted plan is captured
    // as a recoverable conflict instead of rejected with "Unknown plan".
    const ownerPlanUuid =
      'planUuid' in nextEnvelope.op &&
      nextEnvelope.targetType !== 'plan' &&
      typeof (nextEnvelope.op as { planUuid?: unknown }).planUuid === 'string'
        ? (nextEnvelope.op as { planUuid: string }).planUuid
        : null;
    const ownerTombstone = ownerPlanUuid ? getTombstone(db, 'plan', `plan:${ownerPlanUuid}`) : null;
    const tombstone = selfTombstone ?? ownerTombstone;
    if (tombstone && !targetExists(db, nextEnvelope.op)) {
      if (nextEnvelope.op.type === 'plan.delete' || nextEnvelope.op.type === 'plan.remove_task') {
        markOperationApplied(db, nextEnvelope.operationUuid, [], []);
        return {
          status: 'applied',
          sequenceIds: [],
          invalidations: [],
          acknowledged: true,
        };
      }
      if (isRecoverableTombstonedOperation(nextEnvelope.op)) {
        const conflictId = createSyncConflict(db, {
          envelope: nextEnvelope,
          originalPayload,
          normalizedPayload,
          fieldPath: conflictFieldPath(nextEnvelope.op),
          baseValue: conflictBaseValue(nextEnvelope.op),
          incomingValue: conflictIncomingValue(nextEnvelope.op),
          attemptedPatch: conflictPatch(nextEnvelope.op),
          currentValue: null,
          reason: 'tombstoned_target',
        });
        markOperationConflict(db, nextEnvelope.operationUuid, conflictId);
        return {
          status: 'conflict',
          sequenceIds: [],
          invalidations: [],
          conflictId,
          acknowledged: true,
        };
      }
      const error = validationError(nextEnvelope, 'Operation targets a tombstoned entity');
      rejectOperation(db, nextEnvelope.operationUuid, error.message);
      return rejectedResult(error);
    }

    let mutations: Mutation[];
    try {
      mutations = applyPayload(
        db,
        project,
        nextEnvelope,
        originalPayload,
        normalizedPayload,
        options
      );
    } catch (error) {
      if (error instanceof ConflictAccepted) {
        return {
          status: 'conflict',
          sequenceIds: [],
          invalidations: [],
          conflictId: error.conflictId,
          acknowledged: true,
        };
      }
      throw error;
    }
    const sequenceIds = mutations.map(
      (mutation) => insertSequence(db, nextEnvelope, mutation).sequence
    );
    const invalidations = [...new Set(mutations.map((mutation) => mutation.targetKey))];
    const resolvedNumericPlanId = resolvedNumericPlanIdForOperation(db, nextEnvelope.op);
    markOperationApplied(db, nextEnvelope.operationUuid, sequenceIds, invalidations, {
      resolvedNumericPlanId,
    });
    return {
      status: 'applied',
      sequenceId: sequenceIds.at(-1),
      sequenceIds,
      invalidations,
      resolvedNumericPlanId,
      acknowledged: true,
    };
  } catch (error) {
    if (error instanceof SyncValidationError) {
      rejectOperation(db, nextEnvelope.operationUuid, error.message);
      return rejectedResult(error);
    }
    throw error;
  }
}

class BatchAbort extends Error {
  constructor(
    readonly result: ApplyOperationResult,
    readonly priorResults: ApplyOperationResult[]
  ) {
    super(result.error?.message ?? `Batch aborted by ${result.status} operation`);
    this.name = 'BatchAbort';
  }
}

function aggregateBatchResult(batchId: string, results: ApplyOperationResult[]): ApplyBatchResult {
  return {
    batchId,
    status: 'applied',
    results,
    invalidations: [...new Set(results.flatMap((result) => result.invalidations))],
    sequenceIds: [...new Set(results.flatMap((result) => result.sequenceIds))],
  };
}

function rolledBackBatchResults(
  operations: SyncOperationEnvelope[],
  cause: ApplyOperationResult
): ApplyOperationResult[] {
  return operations.map((operation) => {
    if (operation.operationUuid === operationUuidFromError(cause.error)) {
      return cause;
    }
    // V1 trade-off: when the cause is rejected we mark siblings terminal
    // 'rejected' rather than retryable. The naive "retry siblings" approach
    // strands them indefinitely on the main node — applyBatch rolls back the
    // cause's rejection record, so the FIFO floor never advances past the
    // cause's sequence. A detached sibling at sequence N+2 then trips
    // SyncFifoGapError waiting for the never-recorded N+1. The 'deferred'
    // path (SyncFifoGapError on the whole batch) keeps siblings retryable
    // because the entire batch is replayed atomically once the gap fills.
    // Follow-up work (durably persisting rejection across the rollback,
    // or reassigning sequences on the persistent node) is needed before
    // siblings can safely retry independently.
    return {
      status: cause.status === 'deferred' ? 'deferred' : 'rejected',
      sequenceIds: [],
      invalidations: [],
      acknowledged: false,
      error: new SyncValidationError('Operation rolled back because its batch did not commit', {
        operationUuid: operation.operationUuid,
        issues: [],
      }),
    };
  });
}

function operationUuidFromError(error: Error | undefined): string | undefined {
  if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
    return error.operationUuid;
  }
  return undefined;
}

function getBatchReplayResult(
  db: Database,
  batch: SyncOperationBatchEnvelope
): ApplyBatchResult | null {
  const rows = batch.operations.map((operation) => getOperationRow(db, operation.operationUuid));
  const mismatchedBatch = rows.find((row) => row && row.batch_id !== batch.batchId);
  if (mismatchedBatch) {
    const error = new SyncValidationError('operation UUID already belongs to a different batch', {
      operationUuid: mismatchedBatch.operation_uuid,
      issues: [],
    });
    return {
      batchId: batch.batchId,
      status: 'rejected',
      results: rolledBackBatchResults(batch.operations, rejectedResult(error)),
      invalidations: [],
      sequenceIds: [],
      error,
    };
  }
  const terminalRows = rows.filter(
    (row): row is NonNullable<typeof row> => !!row && TERMINAL_OPERATION_STATUSES.has(row.status)
  );
  if (rows.every((row) => row && TERMINAL_OPERATION_STATUSES.has(row.status))) {
    return aggregateBatchResult(
      batch.batchId,
      rows.map((row) => resultFromRecordedOperation(db, row!))
    );
  }
  if (terminalRows.length > 0) {
    const firstExisting = terminalRows[0];
    const error = new SyncValidationError('partial batch replay', {
      operationUuid: firstExisting.operation_uuid,
      issues: [],
    });
    return {
      batchId: batch.batchId,
      status: 'rejected',
      results: rolledBackBatchResults(batch.operations, rejectedResult(error)),
      invalidations: [],
      sequenceIds: [],
      error,
    };
  }
  if (rows.some(Boolean)) {
    const firstExisting = rows.find(Boolean)!;
    const error = new SyncValidationError('partial batch replay', {
      operationUuid: firstExisting.operation_uuid,
      issues: [],
    });
    return {
      batchId: batch.batchId,
      status: 'rejected',
      results: rolledBackBatchResults(batch.operations, rejectedResult(error)),
      invalidations: [],
      sequenceIds: [],
      error,
    };
  }
  return null;
}

export function resolveSyncConflict(
  db: Database,
  conflictId: string,
  options: ResolveSyncConflictOptions
): ResolveSyncConflictResult {
  const resolve = db.transaction(
    (
      nextConflictId: string,
      nextOptions: ResolveSyncConflictOptions
    ): ResolveSyncConflictResult => {
      const conflict = db
        .prepare('SELECT * FROM sync_conflict WHERE conflict_id = ?')
        .get(nextConflictId) as {
        conflict_id: string;
        operation_uuid: string;
        project_uuid: string;
        target_type: string;
        target_key: string;
        normalized_payload: string;
        reason: string;
        status: string;
      } | null;
      if (!conflict) {
        throw new Error(`Unknown sync conflict ${nextConflictId}`);
      }
      if (conflict.status !== 'open') {
        throw new Error(`Sync conflict ${nextConflictId} is already resolved`);
      }

      if (nextOptions.mode === 'apply-current') {
        markConflictResolved(db, nextConflictId, 'resolved_discarded', nextOptions);
        return {
          conflictId: nextConflictId,
          status: 'resolved_discarded',
          sequenceIds: [],
          invalidations: [],
        };
      }

      const op = assertValidPayload(JSON.parse(conflict.normalized_payload));
      const project = db
        .prepare('SELECT id, uuid FROM project WHERE uuid = ?')
        .get(conflict.project_uuid) as ProjectRow | null;
      if (!project) {
        throw new Error(`Unknown project ${conflict.project_uuid}`);
      }
      const envelope = {
        operationUuid: conflict.operation_uuid,
        projectUuid: conflict.project_uuid,
        originNodeId: `resolver:${nextOptions.resolvedByNode}`,
        localSequence: 0,
        createdAt: new Date().toISOString(),
        targetType: conflict.target_type,
        targetKey: conflict.target_key,
        op,
      } as SyncOperationEnvelope;

      const mutations = applyConflictResolutionPayload(
        db,
        project,
        envelope,
        nextOptions,
        conflict.reason
      );
      const sequenceIds = mutations.map(
        (mutation) => insertSequence(db, envelope, mutation).sequence
      );
      const invalidations = [...new Set(mutations.map((mutation) => mutation.targetKey))];
      markConflictResolved(db, nextConflictId, 'resolved_applied', nextOptions);
      return {
        conflictId: nextConflictId,
        status: 'resolved_applied',
        sequenceIds,
        invalidations,
      };
    }
  );

  return resolve.immediate(conflictId, options);
}

function rejectedResult(error: SyncValidationError): ApplyOperationResult {
  return {
    status: 'rejected',
    sequenceIds: [],
    invalidations: [],
    acknowledged: true,
    error,
  };
}

function getOperationRow(db: Database, operationUuid: string) {
  return db.prepare('SELECT * FROM sync_operation WHERE operation_uuid = ?').get(operationUuid) as {
    operation_uuid: string;
    status: string;
    ack_metadata: string | null;
    target_key: string;
    batch_id: string | null;
  } | null;
}

function resultFromRecordedOperation(
  db: Database,
  row: { operation_uuid: string; status: string; ack_metadata: string | null; target_key: string }
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
  };
}

function insertReceivedOperation(
  db: Database,
  envelope: SyncOperationEnvelope,
  payload: string,
  batchId?: string
): void {
  const baseRevision =
    'baseRevision' in envelope.op && typeof envelope.op.baseRevision === 'number'
      ? envelope.op.baseRevision
      : null;
  db.prepare(
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
        status,
        attempts,
        last_error,
        created_at,
        updated_at,
        acked_at,
        ack_metadata,
        batch_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'received', 0, NULL, ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, ?)
    `
  ).run(
    envelope.operationUuid,
    envelope.projectUuid,
    envelope.originNodeId,
    envelope.localSequence,
    envelope.targetType,
    envelope.targetKey,
    envelope.op.type,
    baseRevision,
    payload,
    envelope.createdAt,
    batchId ?? null
  );
}

function checkFifo(db: Database, envelope: SyncOperationEnvelope): SyncFifoGapError | null {
  const duplicateSequence = db
    .prepare(
      `
        SELECT operation_uuid
        FROM sync_operation
        WHERE origin_node_id = ? AND local_sequence = ? AND operation_uuid <> ?
        LIMIT 1
      `
    )
    .get(envelope.originNodeId, envelope.localSequence, envelope.operationUuid) as {
    operation_uuid: string;
  } | null;
  if (duplicateSequence) {
    throw validationError(
      envelope,
      `localSequence ${envelope.localSequence} is already used by ${duplicateSequence.operation_uuid}`
    );
  }

  const row = db
    .prepare(
      `
        SELECT MAX(local_sequence) AS max_sequence
        FROM sync_operation
        WHERE origin_node_id = ?
          AND status IN ('applied', 'conflict', 'rejected')
          AND operation_uuid <> ?
      `
    )
    .get(envelope.originNodeId, envelope.operationUuid) as { max_sequence: number | null };
  const maxSequence = row.max_sequence;
  if (maxSequence === null) {
    // Existing operation constructors/tests have historically started at either
    // 0 or 1. Once a terminal operation exists, the floor is strict max(seq)+1.
    if (envelope.localSequence <= 1) {
      return null;
    }
    return new SyncFifoGapError('Sync operation is waiting for earlier localSequence values', {
      operationUuid: envelope.operationUuid,
      originNodeId: envelope.originNodeId,
      localSequence: envelope.localSequence,
      expectedSequence: 1,
    });
  }
  const expected = maxSequence + 1;
  if (envelope.localSequence < expected) {
    throw validationError(
      envelope,
      `localSequence ${envelope.localSequence} is below next expected sequence ${expected}`
    );
  }
  if (envelope.localSequence > expected) {
    return new SyncFifoGapError('Sync operation is waiting for earlier localSequence values', {
      operationUuid: envelope.operationUuid,
      originNodeId: envelope.originNodeId,
      localSequence: envelope.localSequence,
      expectedSequence: expected,
    });
  }
  return null;
}

function applyPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  switch (op.type) {
    case 'plan.create':
      return applyPlanCreate(db, project, { ...envelope, op }, options);
    case 'plan.set_scalar':
      return applyPlanScalar(db, project, { ...envelope, op }, options);
    case 'plan.patch_text':
      return applyPlanText(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload,
        options
      );
    case 'plan.add_task':
      return applyAddTask(db, project, { ...envelope, op }, options);
    case 'plan.update_task_text':
      return applyTaskText(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload,
        options
      );
    case 'plan.mark_task_done':
      return applyMarkTaskDone(db, project, { ...envelope, op }, options);
    case 'plan.remove_task':
      return applyRemoveTask(db, project, { ...envelope, op }, options);
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
      return applyDependency(db, project, { ...envelope, op }, options);
    case 'plan.add_tag':
    case 'plan.remove_tag':
      return applyTag(db, project, { ...envelope, op }, options);
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
      return applyListItem(db, project, { ...envelope, op }, options);
    case 'plan.delete':
      return applyPlanDelete(db, project, { ...envelope, op });
    case 'project_setting.set':
    case 'project_setting.delete':
      return applyProjectSetting(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload
      );
    case 'plan.set_parent':
      return applySetParent(db, project, { ...envelope, op }, options);
    case 'plan.promote_task':
      return applyPromoteTask(db, project, { ...envelope, op }, options);
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function applyPlanCreate(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.create' }> },
  options: ApplyOperationOptions = {}
): Mutation[] {
  const op = envelope.op;
  const existing = getPlan(db, op.planUuid);
  if (existing) {
    return [];
  }
  if (op.parentUuid) {
    requirePlan(db, project, op.parentUuid, envelope);
  }
  for (const dependencyUuid of new Set(op.dependencies)) {
    requirePlan(db, project, dependencyUuid, envelope);
    if (dependencyUuid === op.planUuid || dependencyReaches(db, dependencyUuid, op.planUuid)) {
      throw validationError(envelope, 'Adding dependency would create a cycle');
    }
    if (
      op.parentUuid &&
      (dependencyUuid === op.parentUuid || dependencyReaches(db, dependencyUuid, op.parentUuid))
    ) {
      throw validationError(envelope, 'Setting parent would create a dependency cycle');
    }
  }
  if (op.parentUuid) {
    validateParentEdge(db, envelope, op.parentUuid, op.planUuid);
  }
  const taskUuids = new Set<string>();
  for (const task of op.tasks) {
    if (taskUuids.has(task.taskUuid)) {
      throw validationError(envelope, 'Duplicate task UUIDs in plan.create');
    }
    taskUuids.add(task.taskUuid);
  }
  const resolved = resolvePlanCreateNumericPlanId(
    db,
    project.id,
    op.numericPlanId,
    options.preserveRequestedPlanIds === true
  );
  const numericPlanId = resolved.numericPlanId;
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
        COALESCE(?, ${SQL_NOW_ISO_UTC}), COALESCE(?, ${SQL_NOW_ISO_UTC}))
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
    op.epic ? 1 : 0,
    options.sourceCreatedAt ?? null,
    options.sourceUpdatedAt ?? null
  );
  op.tasks.forEach((task, index) => {
    db.prepare(
      `
        INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `
    ).run(task.taskUuid, op.planUuid, index, task.title, task.description, task.done ? 1 : 0);
  });
  for (const tag of new Set(op.tags)) {
    db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(
      op.planUuid,
      tag
    );
  }
  for (const dependencyUuid of new Set(op.dependencies)) {
    db.prepare(
      'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
    ).run(op.planUuid, dependencyUuid);
  }
  const mutations: Mutation[] = [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: 1 },
  ];
  if (op.parentUuid) {
    const result = db
      .prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)')
      .run(op.parentUuid, op.planUuid);
    if (result.changes > 0) {
      bumpPlan(db, op.parentUuid);
      mutations.push(planMutation(db, op.parentUuid));
    }
  }
  setProjectHighestPlanId(db, project.id, numericPlanId);
  return mutations;
}

function applyPlanScalar(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  const column = envelope.op.field;
  const value = envelope.op.field === 'epic' ? (envelope.op.value ? 1 : 0) : envelope.op.value;
  if ((plan as unknown as Record<string, unknown>)[column] === value) {
    return [];
  }
  db.prepare(
    `UPDATE plan SET ${column} = ?, revision = revision + 1, ${PLAN_UPDATED_AT_ASSIGNMENT} WHERE uuid = ?`
  ).run(value, ...planUpdatedAtArgs(options), envelope.op.planUuid);
  if (
    column === 'status' &&
    typeof value === 'string' &&
    plan.status !== value &&
    ASSIGNMENT_CLEANUP_STATUSES.has(value) &&
    options.cleanupAssignmentsOnStatusChange !== false
  ) {
    removeAssignment(db, project.id, envelope.op.planUuid);
  }
  return [planMutation(db, envelope.op.planUuid)];
}

function applyPlanText(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions = {}
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    const conflictId = createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: envelope.op.field,
      baseValue: envelope.op.base,
      incomingValue: envelope.op.new,
      attemptedPatch: envelope.op.patch ?? null,
      currentValue: current,
      reason: 'text_merge_failed',
    });
    markOperationConflict(db, envelope.operationUuid, conflictId);
    throw new ConflictAccepted(conflictId);
  }
  if (merged === current) {
    return [];
  }
  db.prepare(
    `UPDATE plan SET ${column} = ?, revision = revision + 1, ${PLAN_UPDATED_AT_ASSIGNMENT} WHERE uuid = ?`
  ).run(merged, ...planUpdatedAtArgs(options), envelope.op.planUuid);
  return [planMutation(db, envelope.op.planUuid)];
}

function applyAddTask(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_task' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const existing = getTask(db, envelope.op.taskUuid);
  if (existing) {
    return [];
  }
  const index =
    envelope.op.taskIndex ??
    (
      db
        .prepare(
          'SELECT COALESCE(MAX(task_index), -1) + 1 AS next_index FROM plan_task WHERE plan_uuid = ?'
        )
        .get(envelope.op.planUuid) as { next_index: number }
    ).next_index;
  shiftTaskIndexesForInsert(db, envelope.op.planUuid, index);
  db.prepare(
    'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).run(
    envelope.op.taskUuid,
    envelope.op.planUuid,
    index,
    envelope.op.title,
    envelope.op.description ?? '',
    envelope.op.done ? 1 : 0
  );
  bumpPlan(db, envelope.op.planUuid, options);
  return [planMutation(db, envelope.op.planUuid), taskMutation(db, envelope.op.taskUuid)];
}

function applyTaskText(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const task = requireTask(db, envelope.op.taskUuid, envelope.op.planUuid, envelope);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  const current = task[column] ?? '';
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    const conflictId = createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: envelope.op.field,
      baseValue: envelope.op.base,
      incomingValue: envelope.op.new,
      attemptedPatch: envelope.op.patch ?? null,
      currentValue: current,
      reason: 'text_merge_failed',
    });
    markOperationConflict(db, envelope.operationUuid, conflictId);
    throw new ConflictAccepted(conflictId);
  }
  if (merged === current) {
    return [];
  }
  db.prepare(`UPDATE plan_task SET ${column} = ?, revision = revision + 1 WHERE uuid = ?`).run(
    merged,
    envelope.op.taskUuid
  );
  bumpPlan(db, envelope.op.planUuid, options);
  return [taskMutation(db, envelope.op.taskUuid), planMutation(db, envelope.op.planUuid)];
}

function applyMarkTaskDone(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.mark_task_done' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const task = requireTask(db, envelope.op.taskUuid, envelope.op.planUuid, envelope);
  const done = envelope.op.done ? 1 : 0;
  if (task.done === done) {
    return [];
  }
  db.prepare('UPDATE plan_task SET done = ?, revision = revision + 1 WHERE uuid = ?').run(
    done,
    envelope.op.taskUuid
  );
  bumpPlan(db, envelope.op.planUuid, options);
  return [taskMutation(db, envelope.op.taskUuid), planMutation(db, envelope.op.planUuid)];
}

function applyRemoveTask(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.remove_task' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const task = getTask(db, envelope.op.taskUuid);
  if (!task) {
    return [];
  }
  if (task.plan_uuid !== envelope.op.planUuid) {
    throw validationError(
      envelope,
      `Task ${envelope.op.taskUuid} is not in plan ${envelope.op.planUuid}`
    );
  }
  recordSyncTombstone(db, {
    entityType: 'task',
    entityKey: envelope.targetKey,
    projectUuid: envelope.projectUuid,
    deletionOperationUuid: envelope.operationUuid,
    deletedRevision: task.revision,
    originNodeId: envelope.originNodeId,
  });
  db.prepare('DELETE FROM plan_task WHERE uuid = ?').run(envelope.op.taskUuid);
  shiftTaskIndexesAfterDelete(db, envelope.op.planUuid, task.task_index);
  bumpPlan(db, envelope.op.planUuid, options);
  return [
    { targetType: 'task', targetKey: envelope.targetKey, revision: task.revision + 1 },
    planMutation(db, envelope.op.planUuid),
  ];
}

function applyDependency(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_dependency' | 'plan.remove_dependency' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  requirePlan(db, project, envelope.op.dependsOnPlanUuid, envelope);
  if (envelope.op.type === 'plan.add_dependency') {
    if (
      envelope.op.planUuid === envelope.op.dependsOnPlanUuid ||
      dependencyReaches(db, envelope.op.dependsOnPlanUuid, envelope.op.planUuid)
    ) {
      throw validationError(envelope, 'Adding dependency would create a cycle');
    }
    const result = db
      .prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)')
      .run(envelope.op.planUuid, envelope.op.dependsOnPlanUuid);
    if (result.changes === 0) {
      return [];
    }
  } else {
    const result = db
      .prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .run(envelope.op.planUuid, envelope.op.dependsOnPlanUuid);
    if (result.changes === 0) {
      return [];
    }
  }
  bumpPlan(db, envelope.op.planUuid, options);
  return [planMutation(db, envelope.op.planUuid)];
}

function applyTag(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_tag' | 'plan.remove_tag' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const result =
    envelope.op.type === 'plan.add_tag'
      ? db
          .prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)')
          .run(envelope.op.planUuid, envelope.op.tag)
      : db
          .prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?')
          .run(envelope.op.planUuid, envelope.op.tag);
  if (result.changes === 0) {
    return [];
  }
  bumpPlan(db, envelope.op.planUuid, options);
  return [planMutation(db, envelope.op.planUuid)];
}

function applyListItem(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_list_item' | 'plan.remove_list_item' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  const column = LIST_COLUMNS[envelope.op.list];
  const current = parseJsonArray(plan[column]);
  const valueText = JSON.stringify(envelope.op.value);
  const index = current.findIndex((item) => JSON.stringify(item) === valueText);
  const next =
    envelope.op.type === 'plan.add_list_item'
      ? index === -1
        ? [...current, envelope.op.value]
        : current
      : index === -1
        ? current
        : current.filter((_, itemIndex) => itemIndex !== index);
  if (next === current) {
    return [];
  }
  db.prepare(
    `UPDATE plan SET ${column} = ?, revision = revision + 1, ${PLAN_UPDATED_AT_ASSIGNMENT} WHERE uuid = ?`
  ).run(
    next.length === 0 ? null : JSON.stringify(next),
    ...planUpdatedAtArgs(options),
    envelope.op.planUuid
  );
  return [planMutation(db, envelope.op.planUuid)];
}

function applyPlanDelete(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.delete' }> }
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  const tasks = db
    .prepare('SELECT uuid, revision FROM plan_task WHERE plan_uuid = ?')
    .all(envelope.op.planUuid) as Array<{ uuid: string; revision: number }>;
  const dependents = db
    .prepare(
      `
        SELECT DISTINCT plan_uuid
        FROM plan_dependency
        WHERE depends_on_uuid = ?
          AND plan_uuid <> ?
      `
    )
    .all(envelope.op.planUuid, envelope.op.planUuid) as Array<{ plan_uuid: string }>;
  recordSyncTombstone(db, {
    entityType: 'plan',
    entityKey: envelope.targetKey,
    projectUuid: envelope.projectUuid,
    deletionOperationUuid: envelope.operationUuid,
    deletedRevision: plan.revision + 1,
    originNodeId: envelope.originNodeId,
  });
  for (const task of tasks) {
    recordSyncTombstone(db, {
      entityType: 'task',
      entityKey: `task:${task.uuid}`,
      projectUuid: envelope.projectUuid,
      deletionOperationUuid: envelope.operationUuid,
      deletedRevision: task.revision + 1,
      originNodeId: envelope.originNodeId,
    });
  }
  const mutations: Mutation[] = [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 },
    ...tasks.map((task) => ({
      targetType: 'task',
      targetKey: `task:${task.uuid}`,
      revision: task.revision + 1,
    })),
  ];
  for (const dependent of dependents) {
    bumpPlan(db, dependent.plan_uuid);
    mutations.push(planMutation(db, dependent.plan_uuid));
  }
  db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? OR depends_on_uuid = ?').run(
    envelope.op.planUuid,
    envelope.op.planUuid
  );
  db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(envelope.op.planUuid);
  db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(envelope.op.planUuid);
  removeAssignment(db, project.id, envelope.op.planUuid);
  db.prepare('DELETE FROM plan WHERE uuid = ?').run(envelope.op.planUuid);
  return mutations;
}

function applyProjectSetting(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>;
  },
  originalPayload: string,
  normalizedPayload: string
): Mutation[] {
  const row = db
    .prepare(
      'SELECT setting, value, revision FROM project_setting WHERE project_id = ? AND setting = ?'
    )
    .get(project.id, envelope.op.setting) as { value: string; revision: number } | null;
  if (envelope.op.type === 'project_setting.delete') {
    if (!row) {
      return [];
    }
    if (envelope.op.baseRevision !== undefined && envelope.op.baseRevision !== row.revision) {
      return staleSettingConflict(db, envelope, originalPayload, normalizedPayload, row.value);
    }
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      envelope.op.setting
    );
    return [
      {
        targetType: envelope.targetType,
        targetKey: envelope.targetKey,
        revision: row.revision + 1,
      },
    ];
  }
  const nextValue = JSON.stringify(envelope.op.value);
  if (row && envelope.op.baseRevision !== undefined && envelope.op.baseRevision !== row.revision) {
    return staleSettingConflict(db, envelope, originalPayload, normalizedPayload, row.value);
  }
  if (row?.value === nextValue) {
    return [];
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
  ).run(project.id, envelope.op.setting, nextValue, envelope.originNodeId);
  const updated = db
    .prepare('SELECT revision FROM project_setting WHERE project_id = ? AND setting = ?')
    .get(project.id, envelope.op.setting) as { revision: number };
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: updated.revision },
  ];
}

function staleSettingConflict(
  db: Database,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  currentValue: string
): never {
  const op = envelope.op as Extract<
    SyncOperationPayload,
    { type: 'project_setting.set' | 'project_setting.delete' }
  >;
  const conflictId = createSyncConflict(db, {
    envelope,
    originalPayload,
    normalizedPayload,
    fieldPath: op.setting,
    baseValue: op.baseRevision,
    incomingValue: op.type === 'project_setting.set' ? op.value : null,
    currentValue,
    reason: 'stale_revision',
  });
  markOperationConflict(db, envelope.operationUuid, conflictId);
  throw new ConflictAccepted(conflictId);
}

function applyConflictResolutionPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  options: ResolveSyncConflictOptions,
  conflictReason: string
): Mutation[] {
  if (conflictReason === 'tombstoned_target') {
    throw new Error(
      'Tombstoned-target conflicts can only be resolved with --apply-current (discard); the target plan or task no longer exists. To recover the deleted entity, recreate it first via the appropriate command.'
    );
  }
  const op = envelope.op;
  switch (op.type) {
    case 'plan.patch_text':
      return applyResolvedPlanText(
        db,
        project,
        { ...envelope, op },
        resolvedTextValue(op.new, options)
      );
    case 'plan.update_task_text':
      return applyResolvedTaskText(
        db,
        project,
        { ...envelope, op },
        resolvedTextValue(op.new, options)
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      return applyResolvedProjectSetting(db, project, { ...envelope, op }, options);
    case 'plan.add_task':
      rejectManualResolution(options, op.type);
      return applyAddTask(db, project, { ...envelope, op });
    case 'plan.mark_task_done':
      rejectManualResolution(options, op.type);
      return applyMarkTaskDone(db, project, { ...envelope, op });
    case 'plan.add_tag':
      rejectManualResolution(options, op.type);
      return applyTag(db, project, { ...envelope, op });
    case 'plan.add_list_item':
      rejectManualResolution(options, op.type);
      return applyListItem(db, project, { ...envelope, op });
    default:
      throw new Error(`Sync conflict resolution does not support ${op.type}`);
  }
}

function rejectManualResolution(options: ResolveSyncConflictOptions, operationType: string): void {
  if (options.mode === 'manual') {
    throw new Error(
      `--manual is not compatible with ${operationType}; use --apply-incoming or --apply-current`
    );
  }
}

function resolvedTextValue(incomingValue: string, options: ResolveSyncConflictOptions): string {
  if (options.mode === 'apply-incoming') {
    return incomingValue;
  }
  if (typeof options.manualValue !== 'string') {
    throw new Error('--manual must be a JSON string for text conflict resolution');
  }
  return options.manualValue;
}

function applyResolvedPlanText(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  value: string
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  if (current === value) {
    return [];
  }
  db.prepare(
    `UPDATE plan SET ${column} = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(value, envelope.op.planUuid);
  return [planMutation(db, envelope.op.planUuid)];
}

function applyResolvedTaskText(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  value: string
): Mutation[] {
  requirePlan(db, project, envelope.op.planUuid, envelope);
  const task = requireTask(db, envelope.op.taskUuid, envelope.op.planUuid, envelope);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  if ((task[column] ?? '') === value) {
    return [];
  }
  db.prepare(`UPDATE plan_task SET ${column} = ?, revision = revision + 1 WHERE uuid = ?`).run(
    value,
    envelope.op.taskUuid
  );
  bumpPlan(db, envelope.op.planUuid);
  return [taskMutation(db, envelope.op.taskUuid), planMutation(db, envelope.op.planUuid)];
}

function applyResolvedProjectSetting(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>;
  },
  options: ResolveSyncConflictOptions
): Mutation[] {
  const row = db
    .prepare(
      'SELECT setting, value, revision FROM project_setting WHERE project_id = ? AND setting = ?'
    )
    .get(project.id, envelope.op.setting) as { value: string; revision: number } | null;

  if (options.mode === 'manual' && envelope.op.type === 'project_setting.delete') {
    throw new Error(
      'manual value is not compatible with delete operations; use --apply-incoming or --apply-current'
    );
  }

  if (options.mode === 'apply-incoming' && envelope.op.type === 'project_setting.delete') {
    if (!row) {
      return [];
    }
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      envelope.op.setting
    );
    return [
      {
        targetType: envelope.targetType,
        targetKey: envelope.targetKey,
        revision: row.revision + 1,
      },
    ];
  }

  const value =
    options.mode === 'manual'
      ? options.manualValue
      : envelope.op.type === 'project_setting.set'
        ? envelope.op.value
        : null;
  if (value === undefined) {
    throw new Error('--manual must be valid JSON for project setting conflict resolution');
  }
  const nextValue = JSON.stringify(value);
  if (row?.value === nextValue) {
    return [];
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
  ).run(project.id, envelope.op.setting, nextValue, envelope.originNodeId);
  const updated = db
    .prepare('SELECT revision FROM project_setting WHERE project_id = ? AND setting = ?')
    .get(project.id, envelope.op.setting) as { revision: number };
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: updated.revision },
  ];
}

function applySetParent(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  const plan = requirePlan(db, project, envelope.op.planUuid, envelope);
  if (envelope.op.newParentUuid) {
    requirePlan(db, project, envelope.op.newParentUuid, envelope);
    validateParentEdge(db, envelope, envelope.op.newParentUuid, envelope.op.planUuid);
  }
  if (plan.parent_uuid === envelope.op.newParentUuid) {
    return [];
  }
  const mutations: Mutation[] = [];
  const oldParentUuid = plan.parent_uuid;
  db.prepare(
    `UPDATE plan SET parent_uuid = ?, revision = revision + 1, ${PLAN_UPDATED_AT_ASSIGNMENT} WHERE uuid = ?`
  ).run(envelope.op.newParentUuid, ...planUpdatedAtArgs(options), envelope.op.planUuid);
  mutations.push(planMutation(db, envelope.op.planUuid));
  if (oldParentUuid) {
    const result = db
      .prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?')
      .run(oldParentUuid, envelope.op.planUuid);
    if (result.changes > 0) {
      bumpPlan(db, oldParentUuid);
      mutations.push(planMutation(db, oldParentUuid));
    }
  }
  if (envelope.op.newParentUuid) {
    const result = db
      .prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)')
      .run(envelope.op.newParentUuid, envelope.op.planUuid);
    if (result.changes > 0) {
      bumpPlan(db, envelope.op.newParentUuid);
      mutations.push(planMutation(db, envelope.op.newParentUuid));
    }
  }
  return mutations;
}

function applyPromoteTask(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.promote_task' }>;
  },
  options: ApplyOperationOptions = {}
): Mutation[] {
  requirePlan(db, project, envelope.op.sourcePlanUuid, envelope);
  requireTask(db, envelope.op.taskUuid, envelope.op.sourcePlanUuid, envelope);
  if (getPlan(db, envelope.op.newPlanUuid)) {
    return [];
  }
  const createEnvelope = {
    ...envelope,
    targetKey: `plan:${envelope.op.newPlanUuid}`,
    op: {
      type: 'plan.create' as const,
      planUuid: envelope.op.newPlanUuid,
      numericPlanId: envelope.op.numericPlanId,
      title: envelope.op.title,
      details: envelope.op.description,
      parentUuid: envelope.op.parentUuid,
      issue: [],
      pullRequest: [],
      docs: [],
      changedFiles: [],
      reviewIssues: [],
      tags: envelope.op.tags,
      dependencies: envelope.op.dependencies,
      tasks: [],
    },
  };
  const mutations = applyPlanCreate(db, project, createEnvelope, options);
  db.prepare(
    'UPDATE plan_task SET done = 1, revision = revision + 1 WHERE uuid = ? AND done <> 1'
  ).run(envelope.op.taskUuid);
  bumpPlan(db, envelope.op.sourcePlanUuid, options);
  mutations.push(
    taskMutation(db, envelope.op.taskUuid),
    planMutation(db, envelope.op.sourcePlanUuid)
  );
  return mutations;
}

function resolvedNumericPlanIdForOperation(
  db: Database,
  op: SyncOperationPayload
): number | undefined {
  if (op.type === 'plan.create') {
    return getPlan(db, op.planUuid)?.plan_id;
  }
  if (op.type === 'plan.promote_task') {
    return getPlan(db, op.newPlanUuid)?.plan_id;
  }
  return undefined;
}

class ConflictAccepted extends Error {
  constructor(readonly conflictId: string) {
    super('Sync operation accepted as conflict');
  }
}

function markOperationApplied(
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

function markOperationConflict(db: Database, operationUuid: string, conflictId: string): void {
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

function markConflictResolved(
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

function rejectOperation(db: Database, operationUuid: string, message: string): void {
  db.prepare(
    `
      UPDATE sync_operation
      SET status = 'rejected',
          last_error = ?,
          updated_at = ${SQL_NOW_ISO_UTC},
          acked_at = ${SQL_NOW_ISO_UTC},
          ack_metadata = ?
      WHERE operation_uuid = ?
    `
  ).run(message, JSON.stringify({ error: message, acknowledged: true }), operationUuid);
}

function insertSequence(db: Database, envelope: SyncOperationEnvelope, mutation: Mutation) {
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

function getPlan(db: Database, planUuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(planUuid) as PlanRow | null) ?? null;
}

function requirePlan(
  db: Database,
  project: ProjectRow,
  planUuid: string,
  envelope: SyncOperationEnvelope
): PlanRow {
  const plan = getPlan(db, planUuid);
  if (!plan || plan.project_id !== project.id) {
    throw validationError(envelope, `Unknown plan ${planUuid}`);
  }
  return plan;
}

function getTask(db: Database, taskUuid: string): PlanTaskRow | null {
  return (
    (db.prepare('SELECT * FROM plan_task WHERE uuid = ?').get(taskUuid) as PlanTaskRow | null) ??
    null
  );
}

function requireTask(
  db: Database,
  taskUuid: string,
  planUuid: string,
  envelope: SyncOperationEnvelope
): PlanTaskRow {
  const task = getTask(db, taskUuid);
  if (!task || task.plan_uuid !== planUuid) {
    throw validationError(envelope, `Unknown task ${taskUuid}`);
  }
  return task;
}

function targetExists(db: Database, op: SyncOperationPayload): boolean {
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

function getTombstone(db: Database, entityType: string, entityKey: string): unknown | null {
  return (
    db
      .prepare('SELECT entity_key FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
      .get(entityType, entityKey) ?? null
  );
}

function isRecoverableTombstonedOperation(op: SyncOperationPayload): boolean {
  return (
    op.type === 'plan.patch_text' ||
    op.type === 'plan.update_task_text' ||
    op.type === 'plan.add_list_item' ||
    op.type === 'plan.add_tag' ||
    op.type === 'plan.add_task' ||
    op.type === 'plan.mark_task_done'
  );
}

function conflictFieldPath(op: SyncOperationPayload): string | null {
  if ('field' in op) {
    return op.field;
  }
  if ('list' in op) {
    return op.list;
  }
  return null;
}

function conflictBaseValue(op: SyncOperationPayload): unknown {
  return 'base' in op ? op.base : undefined;
}

function conflictIncomingValue(op: SyncOperationPayload): unknown {
  if ('new' in op) {
    return op.new;
  }
  if ('value' in op) {
    return op.value;
  }
  return undefined;
}

function conflictPatch(op: SyncOperationPayload): string | null {
  return 'patch' in op ? (op.patch ?? null) : null;
}

function mergeText(current: string, base: string, incoming: string): string | null {
  // Contract: no-op patches keep the current value, clean patches from base to
  // incoming are applied to current, and failed patch application means conflict.
  if (base === incoming) {
    return current;
  }
  if (current === incoming) {
    return current;
  }
  if (current === base) {
    return incoming;
  }
  const patch = diff.createPatch('field', base, incoming, '', '', { context: 3 });
  const merged = diff.applyPatch(current, patch, { fuzzFactor: 0 });
  return merged === false ? null : merged;
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function bumpPlan(db: Database, planUuid: string, options: ApplyOperationOptions = {}): void {
  db.prepare(
    `UPDATE plan SET revision = revision + 1, ${PLAN_UPDATED_AT_ASSIGNMENT} WHERE uuid = ?`
  ).run(...planUpdatedAtArgs(options), planUuid);
}

function planMutation(db: Database, planUuid: string): Mutation {
  const row = db.prepare('SELECT revision FROM plan WHERE uuid = ?').get(planUuid) as {
    revision: number;
  };
  return { targetType: 'plan', targetKey: `plan:${planUuid}`, revision: row.revision };
}

function taskMutation(db: Database, taskUuid: string): Mutation {
  const row = db.prepare('SELECT revision FROM plan_task WHERE uuid = ?').get(taskUuid) as {
    revision: number;
  };
  return { targetType: 'task', targetKey: `task:${taskUuid}`, revision: row.revision };
}

function reserveMainNodePlanId(db: Database, projectId: number): number {
  // Use max(highest_plan_id, MAX(plan_id)) + 1 so we never reuse an ID already
  // reserved by `reserveNextPlanId` (which bumps highest_plan_id ahead of any
  // actual plan row insert). MAX(plan_id) is still folded in to defend against
  // backfills/imports that bypass the project counter.
  const row = db
    .prepare(
      `SELECT
         max(
           COALESCE((SELECT MAX(plan_id) FROM plan WHERE project_id = ?), 0),
           COALESCE((SELECT highest_plan_id FROM project WHERE id = ?), 0)
         ) + 1 AS next_id`
    )
    .get(projectId, projectId) as { next_id: number };
  return row.next_id;
}

interface ResolvedNumericPlanId {
  numericPlanId: number;
  renumberedFrom?: number;
}

function resolvePlanCreateNumericPlanId(
  db: Database,
  projectId: number,
  requestedPlanId: number | undefined,
  preserveRequestedPlanIds = false
): ResolvedNumericPlanId {
  if (requestedPlanId === undefined) {
    return { numericPlanId: reserveMainNodePlanId(db, projectId) };
  }
  // The offline-requested ID is only safe to preserve when it has not been
  // claimed by either an existing plan row OR a prior `reserveNextPlanId()`
  // call that advanced project.highest_plan_id ahead of any insert. Treat
  // both as collisions; otherwise a concurrent local create can produce a
  // duplicate (project_id, plan_id).
  const conflictingPlan = db
    .prepare('SELECT uuid FROM plan WHERE project_id = ? AND plan_id = ? LIMIT 1')
    .get(projectId, requestedPlanId) as { uuid: string } | null;
  const highest = db.prepare('SELECT highest_plan_id FROM project WHERE id = ?').get(projectId) as {
    highest_plan_id: number;
  } | null;
  const reservedAhead =
    !preserveRequestedPlanIds && !!highest && requestedPlanId <= highest.highest_plan_id;
  if (!conflictingPlan && !reservedAhead) {
    return { numericPlanId: requestedPlanId };
  }
  const numericPlanId = reserveMainNodePlanId(db, projectId);
  return { numericPlanId, renumberedFrom: requestedPlanId };
}

function setProjectHighestPlanId(db: Database, projectId: number, planId: number): void {
  db.prepare(
    `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
  ).run(planId, projectId);
}

function dependencyReaches(db: Database, startPlanUuid: string, targetPlanUuid: string): boolean {
  const visited = new Set<string>();
  const stack = [startPlanUuid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const rows = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all(current) as Array<{ depends_on_uuid: string }>;
    stack.push(...rows.map((row) => row.depends_on_uuid));
  }
  return false;
}

function validateParentEdge(
  db: Database,
  envelope: SyncOperationEnvelope,
  parentUuid: string,
  childUuid: string
): void {
  if (
    parentUuid === childUuid ||
    parentChainReaches(db, parentUuid, childUuid) ||
    dependencyReaches(db, childUuid, parentUuid)
  ) {
    throw validationError(envelope, 'Setting parent would create a cycle');
  }
}

function parentChainReaches(
  db: Database,
  startParentUuid: string,
  targetPlanUuid: string
): boolean {
  let current: string | null = startParentUuid;
  const visited = new Set<string>();
  while (current) {
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    const row = db.prepare('SELECT parent_uuid FROM plan WHERE uuid = ?').get(current) as {
      parent_uuid: string | null;
    } | null;
    current = row?.parent_uuid ?? null;
  }
  return false;
}

function validationError(envelope: SyncOperationEnvelope, message: string): SyncValidationError {
  return new SyncValidationError(message, {
    operationUuid: envelope.operationUuid,
    issues: [],
  });
}
