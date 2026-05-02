import type { Database } from 'bun:sqlite';
import * as diff from 'diff';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import {
  deleteCanonicalProjectSettingRow,
  deleteProjectionProjectSettingRow,
  writeCanonicalProjectSettingRow,
  writeProjectionProjectSettingRow,
} from '../db/project_settings.js';
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
import { getSyncOperationPayloadIndexes } from './payload_indexes.js';
import { shiftTaskIndexesAfterDelete, shiftTaskIndexesForInsert } from './task_indexes.js';
import { getSyncOperationPlanRefs } from './plan_refs.js';

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
  status: 'applied' | 'rejected' | 'deferred' | 'conflict';
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

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
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

/**
 * Applies a sync batch with its own transaction boundary.
 *
 * Important: callers must not wrap this function in an outer SQLite transaction.
 * When a batch rolls back, this function persists terminal rejection rows in a
 * follow-up transaction so replay/FIFO state remains durable. An outer rollback
 * would erase those follow-up rows and break the replay contract.
 */
export function applyBatch(
  db: Database,
  batchInput: SyncOperationBatchEnvelope,
  options: ApplyOperationOptions = {}
): ApplyBatchResult {
  const batch = assertValidBatchEnvelope(batchInput);
  assertUniqueBatchOperationUuids(batch);
  const originalPayloads = batch.operations.map((operation) =>
    JSON.stringify((operation as { op: unknown }).op)
  );
  const normalizedPayloads = batch.operations.map((operation) =>
    JSON.stringify(assertValidEnvelope(operation).op)
  );
  const replay = getBatchReplayResult(db, batch, normalizedPayloads);
  if (replay) {
    return replay;
  }

  const apply = db.transaction((): ApplyBatchResult => {
    const results: ApplyOperationResult[] = [];
    for (const [index, operation] of batch.operations.entries()) {
      const result =
        applyBatchOperationHookForTesting?.(index, operation) ??
        applyOperationInTransaction(
          db,
          operation,
          originalPayloads[index],
          normalizedPayloads[index],
          options,
          batch.batchId,
          batch.atomic === true
        );
      results.push(result);
      if (
        result.status === 'rejected' ||
        result.status === 'deferred' ||
        (batch.atomic === true && result.status === 'conflict')
      ) {
        throw new BatchAbort(result, results, results.length - 1);
      }
    }
    return aggregateBatchResult(batch.batchId, results);
  });

  try {
    return apply.immediate();
  } catch (error) {
    if (error instanceof BatchAbort) {
      const status =
        error.result.status === 'deferred'
          ? 'deferred'
          : error.result.status === 'conflict'
            ? 'conflict'
            : 'rejected';
      const results = rolledBackBatchResults(batch.operations, error.result, error.causeIndex);
      persistRolledBackBatchRejections(db, batch, results, normalizedPayloads);
      return {
        batchId: batch.batchId,
        status,
        results,
        invalidations: [],
        sequenceIds: [],
        error: error.result.error,
      };
    }
    if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
      const status = error instanceof SyncFifoGapError ? 'deferred' : 'rejected';
      const results = rolledBackBatchResults(
        batch.operations,
        {
          status,
          sequenceIds: [],
          invalidations: [],
          acknowledged: status === 'rejected',
          error,
        } as ApplyOperationResult,
        batch.operations.findIndex((operation) => operation.operationUuid === error.operationUuid)
      );
      persistRolledBackBatchRejections(db, batch, results, normalizedPayloads);
      return {
        batchId: batch.batchId,
        status,
        results,
        invalidations: [],
        sequenceIds: [],
        error,
      };
    }
    throw error;
  }
}

let applyBatchOperationHookForTesting:
  | ((index: number, operation: SyncOperationEnvelope) => ApplyOperationResult | void)
  | null = null;

export function setApplyBatchOperationHookForTesting(
  hook: ((index: number, operation: SyncOperationEnvelope) => ApplyOperationResult | void) | null
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
  batchId?: string,
  batchAtomic = false
): ApplyOperationResult {
  const existing = getOperationRow(db, nextEnvelope.operationUuid);
  if (existing && TERMINAL_OPERATION_STATUSES.has(existing.status)) {
    return resultFromRecordedOperation(db, existing);
  }

  if (!existing) {
    // Check for duplicate localSequence before inserting to avoid SQLiteError from the
    // UNIQUE(origin_node_id, local_sequence) constraint.
    const duplicateSeq = getOperationByOriginSequence(
      db,
      nextEnvelope.originNodeId,
      nextEnvelope.localSequence,
      nextEnvelope.operationUuid
    );
    if (duplicateSeq) {
      throw validationError(
        nextEnvelope,
        `localSequence ${nextEnvelope.localSequence} is already used by ${duplicateSeq.operation_uuid}`
      );
    }
    insertReceivedOperation(db, nextEnvelope, normalizedPayload, batchId, batchAtomic);
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
    if (tombstone && nextEnvelope.op.type !== 'plan.create' && !targetExists(db, nextEnvelope.op)) {
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
    readonly priorResults: ApplyOperationResult[],
    readonly causeIndex: number
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

function aggregateRecordedBatchResult(
  batchId: string,
  results: ApplyOperationResult[]
): ApplyBatchResult {
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) {
    return {
      batchId,
      status: 'rejected',
      results,
      invalidations: [],
      sequenceIds: [],
      error: rejected.error,
    };
  }
  return aggregateBatchResult(batchId, results);
}

function rolledBackBatchResults(
  operations: SyncOperationEnvelope[],
  cause: ApplyOperationResult,
  causeIndex = operations.findIndex(
    (operation) => operation.operationUuid === operationUuidFromError(cause.error)
  )
): ApplyOperationResult[] {
  return operations.map((operation, index) => {
    if (index === causeIndex) {
      if (cause.status === 'conflict') {
        const message = atomicConflictAbortMessage(cause.error);
        const error = new SyncValidationError(message, {
          operationUuid: operation.operationUuid,
          issues: [],
        });
        if (cause.error) {
          error.cause = cause.error;
        }
        return {
          ...cause,
          conflictId: undefined,
          error,
        };
      }
      return cause;
    }
    // V1 trade-off: when the cause is rejected or an atomic conflict aborts,
    // we mark siblings terminal 'rejected' rather than retryable. applyBatch
    // durably persists those rejection rows after rollback so the per-origin
    // FIFO floor advances past the whole aborted batch.
    const error = new SyncValidationError(
      'Operation rolled back because its batch did not commit',
      {
        operationUuid: operation.operationUuid,
        issues: [],
      }
    );
    if (cause.error) {
      error.cause = cause.error;
    }
    return {
      status: cause.status === 'deferred' ? 'deferred' : 'rejected',
      sequenceIds: [],
      invalidations: [],
      acknowledged: false,
      error,
    };
  });
}

function operationUuidFromError(error: Error | undefined): string | undefined {
  if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
    return error.operationUuid;
  }
  return undefined;
}

function persistRolledBackBatchRejections(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  results: ApplyOperationResult[],
  normalizedPayloads: string[]
): void {
  if (results.every((result) => result.status === 'deferred')) {
    return;
  }

  const persist = db.transaction((): void => {
    for (const [index, operation] of batch.operations.entries()) {
      const result = results[index];
      if (!result || result.status === 'deferred') {
        continue;
      }
      const existing = getOperationRow(db, operation.operationUuid);
      if (!existing) {
        const duplicateSequence = getOperationByOriginSequence(
          db,
          operation.originNodeId,
          operation.localSequence,
          operation.operationUuid
        );
        if (duplicateSequence) {
          // The per-origin sequence slot already belongs to another operation.
          // We cannot persist this operation UUID without violating FIFO identity;
          // the colliding row is the durable record for that sequence. Siblings
          // with distinct sequence slots are still recorded so the aborted batch
          // is replay-safe where storage is possible.
          continue;
        }
        insertReceivedOperation(
          db,
          operation,
          normalizedPayloads[index]!,
          batch.batchId,
          batch.atomic === true
        );
      } else if (existing.batch_id !== batch.batchId) {
        continue;
      }
      const message =
        result.status === 'conflict'
          ? atomicConflictAbortMessage(result.error)
          : (result.error?.message ?? 'Operation rejected because its atomic batch rolled back');
      // Atomic conflict aborts roll back the sync_conflict row, so the durable
      // operation record is a rejection rather than status='conflict'.
      rejectOperation(db, operation.operationUuid, message);
    }
  });

  persist.immediate();
}

function persistMissingBatchReplayRejections(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  rows: Array<ReturnType<typeof getOperationRow>>,
  results: ApplyOperationResult[],
  normalizedPayloads: string[]
): void {
  const persist = db.transaction((): void => {
    for (const [index, operation] of batch.operations.entries()) {
      if (rows[index]) {
        continue;
      }
      const result = results[index];
      if (!result || result.status === 'deferred') {
        continue;
      }
      const duplicateSequence = getOperationByOriginSequence(
        db,
        operation.originNodeId,
        operation.localSequence,
        operation.operationUuid
      );
      if (duplicateSequence) {
        continue;
      }
      insertReceivedOperation(
        db,
        operation,
        normalizedPayloads[index]!,
        batch.batchId,
        batch.atomic === true
      );
      rejectOperation(
        db,
        operation.operationUuid,
        result.error?.message ?? 'Operation rejected because its batch replay was partial'
      );
    }
  });

  persist.immediate();
}

function atomicConflictAbortMessage(cause: Error | undefined): string {
  return cause
    ? `Atomic batch aborted: conflict diagnosed but not persisted: ${cause.message}`
    : 'Atomic batch aborted: conflict diagnosed but not persisted';
}

function getOperationByOriginSequence(
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

function getBatchReplayResult(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  normalizedPayloads: string[]
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
    return aggregateRecordedBatchResult(
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
    const results = rolledBackBatchResults(batch.operations, rejectedResult(error));
    persistMissingBatchReplayRejections(db, batch, rows, results, normalizedPayloads);
    return {
      batchId: batch.batchId,
      status: 'rejected',
      results,
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
    const results = rolledBackBatchResults(batch.operations, rejectedResult(error));
    persistMissingBatchReplayRejections(db, batch, rows, results, normalizedPayloads);
    return {
      batchId: batch.batchId,
      status: 'rejected',
      results,
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
    last_error: string | null;
    ack_metadata: string | null;
    target_key: string;
    batch_id: string | null;
  } | null;
}

function resultFromRecordedOperation(
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

function insertReceivedOperation(
  db: Database,
  envelope: SyncOperationEnvelope,
  payload: string,
  batchId?: string,
  batchAtomic = false
): void {
  const baseRevision =
    'baseRevision' in envelope.op && typeof envelope.op.baseRevision === 'number'
      ? envelope.op.baseRevision
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'received', 0, NULL, ?, ${SQL_NOW_ISO_UTC}, NULL, NULL, ?, ?)
    `
  );
  const indexes = getSyncOperationPayloadIndexes(envelope.op);
  insert.run(
    envelope.operationUuid,
    envelope.projectUuid,
    envelope.originNodeId,
    envelope.localSequence,
    envelope.targetType,
    envelope.targetKey,
    envelope.op.type,
    baseRevision,
    payload,
    indexes.payloadTaskUuid,
    envelope.createdAt,
    batchId ?? null,
    batchAtomic ? 1 : 0
  );
  const insertPlanRef = db.prepare(
    `
      INSERT OR IGNORE INTO sync_operation_plan_ref (operation_uuid, project_uuid, plan_uuid, role)
      VALUES (?, ?, ?, ?)
    `
  );
  for (const ref of getSyncOperationPlanRefs(envelope.op)) {
    insertPlanRef.run(envelope.operationUuid, envelope.projectUuid, ref.planUuid, ref.role);
  }
}

function checkFifo(db: Database, envelope: SyncOperationEnvelope): SyncFifoGapError | null {
  const duplicateSequence = getOperationByOriginSequence(
    db,
    envelope.originNodeId,
    envelope.localSequence,
    envelope.operationUuid
  );
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
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.add_task':
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
    case 'plan.add_tag':
    case 'plan.remove_tag':
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
    case 'plan.delete':
    case 'plan.set_parent':
    case 'plan.promote_task':
      return applyCanonicalPlanPayload(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload,
        options
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      return applyProjectSetting(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload
      );
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function applyCanonicalPlanPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions
): Mutation[] {
  validateCanonicalPlanOperation(db, project, envelope);
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const priorStatus =
    envelope.op.type === 'plan.set_scalar' && envelope.op.field === 'status'
      ? adapter.getPlan(envelope.op.planUuid)?.status
      : null;
  try {
    const mutations = applyOperationTo(adapter, envelope, options);
    if (
      envelope.op.type === 'plan.set_scalar' &&
      envelope.op.field === 'status' &&
      typeof envelope.op.value === 'string' &&
      priorStatus !== envelope.op.value &&
      ASSIGNMENT_CLEANUP_STATUSES.has(envelope.op.value) &&
      options.cleanupAssignmentsOnStatusChange !== false
    ) {
      removeAssignment(db, project.id, envelope.op.planUuid);
    }
    adapter.flush();
    return [...mutations, ...adapter.extraMutations()];
  } catch (error) {
    if (error instanceof ApplyOperationToPreconditionError) {
      if (error.message === 'text merge failed') {
        const conflictId = createTextMergeConflict(
          db,
          adapter,
          envelope,
          originalPayload,
          normalizedPayload
        );
        markOperationConflict(db, envelope.operationUuid, conflictId);
        throw new ConflictAccepted(conflictId);
      }
      throw validationError(envelope, error.message);
    }
    throw error;
  }
}

function validateCanonicalPlanOperation(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope
): void {
  const op = envelope.op;
  if ('baseRevision' in op && typeof op.baseRevision === 'number') {
    const planUuid =
      op.type === 'plan.promote_task' ? op.sourcePlanUuid : 'planUuid' in op ? op.planUuid : null;
    if (planUuid) {
      const plan = getCanonicalPlan(db, planUuid);
      if (!plan || plan.project_id !== project.id) {
        throw validationError(envelope, `Unknown plan ${planUuid}`);
      }
      if (plan.revision !== op.baseRevision) {
        const conflictId = createSyncConflict(db, {
          envelope,
          originalPayload: JSON.stringify(op),
          normalizedPayload: JSON.stringify(op),
          fieldPath: conflictFieldPath(op),
          baseValue: op.baseRevision,
          incomingValue: conflictIncomingValue(op),
          attemptedPatch: conflictPatch(op),
          currentValue: plan?.revision ?? null,
          reason: 'stale_revision',
        });
        markOperationConflict(db, envelope.operationUuid, conflictId);
        throw new ConflictAccepted(conflictId);
      }
    }
  }
  switch (op.type) {
    case 'plan.create': {
      if (op.dependencies.some((dependencyUuid) => dependencyUuid === op.planUuid)) {
        throw validationError(envelope, 'Adding dependency would create a cycle');
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireCanonicalPlan(db, project, dependencyUuid, envelope);
        if (
          dependencyReachesInTable(
            db,
            'plan_dependency_canonical',
            dependencyUuid,
            op.planUuid
          )
        ) {
          throw validationError(envelope, 'Adding dependency would create a cycle');
        }
        if (
          op.parentUuid &&
          (dependencyUuid === op.parentUuid ||
            dependencyReachesInTable(
              db,
              'plan_dependency_canonical',
              dependencyUuid,
              op.parentUuid
            ))
        ) {
          throw validationError(envelope, 'Setting parent would create a dependency cycle');
        }
      }
      if (op.parentUuid) {
        requireCanonicalPlan(db, project, op.parentUuid, envelope);
        validateParentEdgeInTables(
          db,
          envelope,
          'plan_canonical',
          'plan_dependency_canonical',
          op.parentUuid,
          op.planUuid
        );
      }
      if (op.discoveredFrom) {
        requireCanonicalPlan(db, project, op.discoveredFrom, envelope);
      }
      const taskUuids = new Set<string>();
      for (const task of op.tasks) {
        if (taskUuids.has(task.taskUuid)) {
          throw validationError(envelope, 'Duplicate task UUIDs in plan.create');
        }
        const existingTask = db
          .prepare('SELECT uuid FROM task_canonical WHERE uuid = ?')
          .get(task.taskUuid);
        if (existingTask) {
          throw validationError(envelope, 'Duplicate task UUIDs in plan.create');
        }
        taskUuids.add(task.taskUuid);
      }
      return;
    }
    case 'plan.set_scalar':
      if (op.field === 'discovered_from' && typeof op.value === 'string') {
        requireCanonicalPlan(db, project, op.value, envelope);
      }
      return;
    case 'plan.add_dependency':
      if (
        op.planUuid === op.dependsOnPlanUuid ||
        dependencyReachesInTable(
          db,
          'plan_dependency_canonical',
          op.dependsOnPlanUuid,
          op.planUuid
        )
      ) {
        throw validationError(envelope, 'Adding dependency would create a cycle');
      }
      return;
    case 'plan.set_parent':
      if (op.newParentUuid) {
        requireCanonicalPlan(db, project, op.newParentUuid, envelope);
        validateParentEdgeInTables(
          db,
          envelope,
          'plan_canonical',
          'plan_dependency_canonical',
          op.newParentUuid,
          op.planUuid
        );
      }
      return;
    case 'plan.promote_task':
      if (op.parentUuid) {
        requireCanonicalPlan(db, project, op.parentUuid, envelope);
        validateParentEdgeInTables(
          db,
          envelope,
          'plan_canonical',
          'plan_dependency_canonical',
          op.parentUuid,
          op.newPlanUuid
        );
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireCanonicalPlan(db, project, dependencyUuid, envelope);
        if (
          dependencyUuid === op.newPlanUuid ||
          dependencyReachesInTable(
            db,
            'plan_dependency_canonical',
            dependencyUuid,
            op.newPlanUuid
          )
        ) {
          throw validationError(envelope, 'Adding dependency would create a cycle');
        }
      }
      return;
    default:
      return;
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
  if (op.discoveredFrom) {
    requirePlan(db, project, op.discoveredFrom, envelope);
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
    resolveLocalPlanId(db, project.id, op.discoveredFrom),
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
  db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
    'plan',
    `plan:${op.planUuid}`
  );
  // Task tombstones do not store the owning plan UUID, so only the resurrected plan tombstone can
  // be cleared without scanning operation payloads.
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
  if (envelope.op.field === 'discovered_from' && typeof envelope.op.value === 'string') {
    requirePlan(db, project, envelope.op.value, envelope);
  }
  const value =
    envelope.op.field === 'epic'
      ? envelope.op.value
        ? 1
        : 0
      : envelope.op.field === 'discovered_from'
        ? resolveLocalPlanId(db, project.id, envelope.op.value as string | null)
        : envelope.op.value;
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

function resolveLocalPlanId(
  db: Database,
  projectId: number,
  planUuid: string | null | undefined
): number | null {
  if (!planUuid) {
    return null;
  }
  const row = db
    .prepare('SELECT plan_id FROM plan WHERE project_id = ? AND uuid = ?')
    .get(projectId, planUuid) as { plan_id: number } | null;
  return row?.plan_id ?? null;
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
  const valueText = canonicalJsonStringify(envelope.op.value);
  const index = current.findIndex((item) => canonicalJsonStringify(item) === valueText);
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
    deleteCanonicalProjectSettingRow(db, project.id, envelope.op.setting);
    deleteProjectionProjectSettingRow(db, project.id, envelope.op.setting);
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
  const nextRevision = (row?.revision ?? 0) + 1;
  writeCanonicalProjectSettingRow(db, project.id, envelope.op.setting, envelope.op.value, {
    revision: nextRevision,
    updatedByNode: envelope.originNodeId,
  });
  writeProjectionProjectSettingRow(db, project.id, envelope.op.setting, envelope.op.value, {
    updatedByNode: envelope.originNodeId,
  });
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: nextRevision },
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
  // Conflict resolution is a new local decision on the main node. It
  // intentionally uses wall-clock updated_at values and does not accept
  // ApplyOperationOptions/source timestamps from the original operation.
  if (conflictReason === 'tombstoned_target') {
    throw new Error(
      'Tombstoned-target conflicts can only be resolved with --apply-current (discard); the target plan or task no longer exists. To recover the deleted entity, recreate it first via the appropriate command.'
    );
  }
  const op = envelope.op;
  switch (op.type) {
    case 'plan.patch_text':
      return applyResolvedPlanTextWithCanonicalAdapter(
        db,
        project,
        { ...envelope, op },
        resolvedTextValue(op.new, options)
      );
    case 'plan.update_task_text':
      return applyResolvedTaskTextWithCanonicalAdapter(
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
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.mark_task_done':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.add_tag':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.add_list_item':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
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

function applyResolvedPlanTextWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  value: string
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  if (current === value) {
    return [];
  }
  const mutations = applyOperationTo(adapter, {
    ...envelope,
    op: {
      ...envelope.op,
      base: current,
      new: value,
      patch: undefined,
      baseRevision: plan.revision,
    },
  });
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
}

function applyResolvedTaskTextWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  value: string
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  const current = task[column] ?? '';
  if (current === value) {
    return [];
  }
  const mutations = applyOperationTo(adapter, {
    ...envelope,
    op: {
      ...envelope.op,
      base: current,
      new: value,
      patch: undefined,
      baseRevision: plan.revision,
    },
  });
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
}

function applyResolvedPlanOperationWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const mutations = applyOperationTo(adapter, envelope);
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
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
  // Resolution time is the authoritative update time for conflict resolution.
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
  // Resolution time is the authoritative owning-plan update time.
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
    deleteCanonicalProjectSettingRow(db, project.id, envelope.op.setting);
    deleteProjectionProjectSettingRow(db, project.id, envelope.op.setting);
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
  const nextRevision = (row?.revision ?? 0) + 1;
  writeCanonicalProjectSettingRow(db, project.id, envelope.op.setting, value, {
    revision: nextRevision,
    updatedByNode: envelope.originNodeId,
  });
  writeProjectionProjectSettingRow(db, project.id, envelope.op.setting, value, {
    updatedByNode: envelope.originNodeId,
  });
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: nextRevision },
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

export type ApplyOperationToPlan = PlanRow;
export type ApplyOperationToTask = Omit<PlanTaskRow, 'id'> & { id?: number };

export interface ApplyOperationToAdapter {
  readonly project: ProjectRow;
  readonly skipPreconditionFailures?: boolean;
  readonly baseRevisionMode?: 'strict' | 'projection';
  getPlan(planUuid: string): ApplyOperationToPlan | null;
  getTaskByUuid(taskUuid: string): ApplyOperationToTask | null;
  setPlan(plan: ApplyOperationToPlan): void;
  deletePlan(planUuid: string): void;
  getTasks(planUuid: string): ApplyOperationToTask[];
  setTasks(planUuid: string, tasks: ApplyOperationToTask[]): void;
  getDependencies(planUuid: string): PlanDependencyRow[];
  setDependencies(planUuid: string, dependencies: PlanDependencyRow[]): void;
  getTags(planUuid: string): PlanTagRow[];
  setTags(planUuid: string, tags: PlanTagRow[]): void;
  resolveLocalPlanId(planUuid: string | null | undefined): number | null;
  resolvePlanCreateNumericPlanId(
    requestedPlanId: number | undefined,
    preserveRequestedPlanIds?: boolean
  ): number;
  onPlanDeleted?(planUuid: string): void;
  onTaskDeleted?(taskUuid: string, revision: number): void;
}

class CanonicalPlanAdapter implements ApplyOperationToAdapter {
  readonly baseRevisionMode = 'strict';
  readonly project: ProjectRow;

  private plans = new Map<string, ApplyOperationToPlan | null>();
  private tasks = new Map<string, ApplyOperationToTask[]>();
  private dependencies = new Map<string, PlanDependencyRow[]>();
  private tags = new Map<string, PlanTagRow[]>();
  private touchedPlans = new Set<string>();
  private additionalMutations: Mutation[] = [];
  private maxResolvedPlanId = 0;

  constructor(
    private readonly db: Database,
    project: ProjectRow,
    private readonly envelope: SyncOperationEnvelope
  ) {
    this.project = project;
  }

  getPlan(planUuid: string): ApplyOperationToPlan | null {
    if (!this.plans.has(planUuid)) {
      this.loadPlan(planUuid);
    }
    const plan = this.plans.get(planUuid) ?? null;
    return plan ? { ...plan } : null;
  }

  getTaskByUuid(taskUuid: string): ApplyOperationToTask | null {
    for (const tasks of this.tasks.values()) {
      const task = tasks.find((item) => item.uuid === taskUuid);
      if (task) {
        return { ...task };
      }
    }
    const task =
      (this.db.prepare('SELECT * FROM task_canonical WHERE uuid = ?').get(taskUuid) as
        | ApplyOperationToTask
        | null) ?? null;
    return task ? { ...task } : null;
  }

  setPlan(plan: ApplyOperationToPlan): void {
    this.plans.set(plan.uuid, { ...plan });
    this.touchedPlans.add(plan.uuid);
    if (!this.tasks.has(plan.uuid)) {
      this.tasks.set(plan.uuid, []);
    }
    if (!this.dependencies.has(plan.uuid)) {
      this.dependencies.set(plan.uuid, []);
    }
    if (!this.tags.has(plan.uuid)) {
      this.tags.set(plan.uuid, []);
    }
  }

  deletePlan(planUuid: string): void {
    this.plans.set(planUuid, null);
    this.tasks.set(planUuid, []);
    this.dependencies.set(planUuid, []);
    this.tags.set(planUuid, []);
    this.touchedPlans.add(planUuid);
  }

  getTasks(planUuid: string): ApplyOperationToTask[] {
    this.ensureLoaded(planUuid);
    return (this.tasks.get(planUuid) ?? []).map((task) => ({ ...task }));
  }

  setTasks(planUuid: string, tasks: ApplyOperationToTask[]): void {
    this.tasks.set(
      planUuid,
      tasks.map((task) => ({ ...task }))
    );
    this.touchedPlans.add(planUuid);
  }

  getDependencies(planUuid: string): PlanDependencyRow[] {
    this.ensureLoaded(planUuid);
    return (this.dependencies.get(planUuid) ?? []).map((dependency) => ({ ...dependency }));
  }

  setDependencies(planUuid: string, dependencies: PlanDependencyRow[]): void {
    this.dependencies.set(
      planUuid,
      dependencies.map((dependency) => ({ ...dependency }))
    );
    this.touchedPlans.add(planUuid);
  }

  getTags(planUuid: string): PlanTagRow[] {
    this.ensureLoaded(planUuid);
    return (this.tags.get(planUuid) ?? []).map((tag) => ({ ...tag }));
  }

  setTags(planUuid: string, tags: PlanTagRow[]): void {
    this.tags.set(
      planUuid,
      tags.map((tag) => ({ ...tag }))
    );
    this.touchedPlans.add(planUuid);
  }

  resolveLocalPlanId(planUuid: string | null | undefined): number | null {
    if (!planUuid) {
      return null;
    }
    return this.getPlan(planUuid)?.plan_id ?? null;
  }

  resolvePlanCreateNumericPlanId(
    requestedPlanId: number | undefined,
    preserveRequestedPlanIds?: boolean
  ): number {
    const resolved = resolvePlanCreateNumericPlanId(
      this.db,
      this.project.id,
      requestedPlanId,
      preserveRequestedPlanIds === true
    );
    this.maxResolvedPlanId = Math.max(this.maxResolvedPlanId, resolved.numericPlanId);
    return resolved.numericPlanId;
  }

  onPlanDeleted(planUuid: string): void {
    const plan = this.plans.get(planUuid);
    const revision = plan ? plan.revision + 1 : 1;
    recordSyncTombstone(this.db, {
      entityType: 'plan',
      entityKey: `plan:${planUuid}`,
      projectUuid: this.envelope.projectUuid,
      deletionOperationUuid: this.envelope.operationUuid,
      deletedRevision: revision,
      originNodeId: this.envelope.originNodeId,
    });
    for (const task of this.getTasks(planUuid)) {
      if (!task.uuid) {
        continue;
      }
      recordSyncTombstone(this.db, {
        entityType: 'task',
        entityKey: `task:${task.uuid}`,
        projectUuid: this.envelope.projectUuid,
        deletionOperationUuid: this.envelope.operationUuid,
        deletedRevision: task.revision + 1,
        originNodeId: this.envelope.originNodeId,
      });
    }
    const dependents = this.db
      .prepare(
        `
          SELECT DISTINCT plan_uuid
          FROM plan_dependency_canonical
          WHERE depends_on_uuid = ?
            AND plan_uuid <> ?
        `
      )
      .all(planUuid, planUuid) as Array<{ plan_uuid: string }>;
    for (const dependent of dependents) {
      const dependencies = this.getDependencies(dependent.plan_uuid);
      const next = dependencies.filter((dependency) => dependency.depends_on_uuid !== planUuid);
      if (next.length !== dependencies.length) {
        this.setDependencies(dependent.plan_uuid, next);
        const dependentPlan = this.getPlan(dependent.plan_uuid);
        if (dependentPlan) {
          this.setPlan(clonePlanWithBump(dependentPlan, {}));
          this.additionalMutations.push({
            targetType: 'plan',
            targetKey: `plan:${dependent.plan_uuid}`,
            revision: dependentPlan.revision + 1,
          });
        }
      }
    }
    removeAssignment(this.db, this.project.id, planUuid);
  }

  onTaskDeleted(taskUuid: string, revision: number): void {
    recordSyncTombstone(this.db, {
      entityType: 'task',
      entityKey: `task:${taskUuid}`,
      projectUuid: this.envelope.projectUuid,
      deletionOperationUuid: this.envelope.operationUuid,
      deletedRevision: revision + 1,
      originNodeId: this.envelope.originNodeId,
    });
  }

  flush(): void {
    for (const planUuid of this.touchedPlans) {
      const plan = this.plans.get(planUuid) ?? null;
      if (!plan) {
        deletePlanFromTableSet(this.db, 'plan_canonical', 'task_canonical', planUuid);
        deletePlanFromTableSet(this.db, 'plan', 'plan_task', planUuid);
        continue;
      }
      writePlanToTableSet(this.db, 'plan_canonical', 'task_canonical', plan);
      writePlanToTableSet(this.db, 'plan', 'plan_task', plan);
      replacePlanCollectionsInTableSet(
        this.db,
        'plan_dependency_canonical',
        'plan_tag_canonical',
        planUuid,
        this.dependencies.get(planUuid) ?? [],
        this.tags.get(planUuid) ?? []
      );
      replacePlanCollectionsInTableSet(
        this.db,
        'plan_dependency',
        'plan_tag',
        planUuid,
        this.dependencies.get(planUuid) ?? [],
        this.tags.get(planUuid) ?? []
      );
      replaceTasksInTable(this.db, 'task_canonical', planUuid, this.tasks.get(planUuid) ?? []);
      replaceTasksInTable(this.db, 'plan_task', planUuid, this.tasks.get(planUuid) ?? []);
      this.db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
        'plan',
        `plan:${planUuid}`
      );
    }
    if (this.maxResolvedPlanId > 0) {
      setProjectHighestPlanId(this.db, this.project.id, this.maxResolvedPlanId);
    }
  }

  extraMutations(): Mutation[] {
    return this.additionalMutations;
  }

  private ensureLoaded(planUuid: string): void {
    if (!this.plans.has(planUuid)) {
      this.loadPlan(planUuid);
    }
  }

  private loadPlan(planUuid: string): void {
    const plan = getCanonicalPlanOnly(this.db, planUuid);
    this.plans.set(planUuid, plan ? { ...plan } : null);
    this.tasks.set(planUuid, readTasksFromTable(this.db, 'task_canonical', planUuid));
    this.dependencies.set(
      planUuid,
      readDependenciesFromTable(this.db, 'plan_dependency_canonical', planUuid)
    );
    this.tags.set(planUuid, readTagsFromTable(this.db, 'plan_tag_canonical', planUuid));
  }
}

class ApplyOperationToPreconditionError extends Error {}

export function applyOperationToPrecondition(message: string): never {
  throw new ApplyOperationToPreconditionError(message);
}

/**
 * Adapter-based operation fold used by both canonical apply and projection
 * rebuilds. Canonical apply uses strict CAS against the entity revision.
 * Projection replay is more permissive for plan-scoped ops: an op is skipped
 * only when its base revision is from the future relative to the replay state.
 * That keeps unrelated canonical updates from erasing still-active local edits.
 *
 * The v1 plan operation payloads do not carry old scalar/list values, so the
 * projection adapter cannot reliably diagnose same-field stale conflicts during
 * replay. The main node remains the rejection authority through strict CAS.
 */
export function applyOperationTo(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  options: ApplyOperationOptions = {}
): Mutation[] {
  try {
    return applyOperationToUnchecked(adapter, envelope, options);
  } catch (error) {
    if (adapter.skipPreconditionFailures && error instanceof ApplyOperationToPreconditionError) {
      return [];
    }
    throw error;
  }
}

function applyOperationToUnchecked(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  if ('baseRevision' in op && typeof op.baseRevision === 'number') {
    const planUuid =
      op.type === 'plan.promote_task' ? op.sourcePlanUuid : 'planUuid' in op ? op.planUuid : null;
    if (planUuid) {
      const plan = adapter.getPlan(planUuid);
      const isStale =
        adapter.baseRevisionMode === 'projection'
          ? op.baseRevision > (plan?.revision ?? -1)
          : !plan || plan.revision !== op.baseRevision;
      if (isStale) {
        applyOperationToPrecondition(`Stale base revision for plan ${planUuid}`);
      }
    }
  }
  validateAdapterPlanOperation(adapter, envelope);

  switch (op.type) {
    case 'plan.create':
      return applyOperationToPlanCreate(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.create' }>;
        },
        options
      );
    case 'plan.set_scalar':
      return applyOperationToPlanScalar(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>;
        },
        options
      );
    case 'plan.patch_text':
      return applyOperationToPlanText(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
        },
        options
      );
    case 'plan.add_task':
      return applyOperationToAddTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.add_task' }>;
        },
        options
      );
    case 'plan.update_task_text':
      return applyOperationToTaskText(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
        },
        options
      );
    case 'plan.mark_task_done':
      return applyOperationToMarkTaskDone(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.mark_task_done' }>;
        },
        options
      );
    case 'plan.remove_task':
      return applyOperationToRemoveTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.remove_task' }>;
        },
        options
      );
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
      return applyOperationToDependency(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<
            SyncOperationPayload,
            { type: 'plan.add_dependency' | 'plan.remove_dependency' }
          >;
        },
        options
      );
    case 'plan.add_tag':
    case 'plan.remove_tag':
      return applyOperationToTag(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.add_tag' | 'plan.remove_tag' }>;
        },
        options
      );
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
      return applyOperationToListItem(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<
            SyncOperationPayload,
            { type: 'plan.add_list_item' | 'plan.remove_list_item' }
          >;
        },
        options
      );
    case 'plan.delete':
      return applyOperationToPlanDelete(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.delete' }>;
        }
      );
    case 'plan.set_parent':
      return applyOperationToSetParent(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>;
        },
        options
      );
    case 'plan.promote_task':
      return applyOperationToPromoteTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.promote_task' }>;
        },
        options
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      throw new Error(
        'applyOperationTo does not handle project_setting.*; use rebuildProjectSettingProjection instead'
      );
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function clonePlanWithBump(
  plan: ApplyOperationToPlan,
  patch: Partial<ApplyOperationToPlan>,
  options: ApplyOperationOptions = {}
): ApplyOperationToPlan {
  return {
    ...plan,
    ...patch,
    revision: (patch.revision as number | undefined) ?? plan.revision + 1,
    updated_at: options.sourceUpdatedAt ?? new Date().toISOString(),
  };
}

function requireAdapterPlan(
  adapter: ApplyOperationToAdapter,
  planUuid: string
): ApplyOperationToPlan {
  const plan = adapter.getPlan(planUuid);
  if (!plan || plan.project_id !== adapter.project.id) {
    applyOperationToPrecondition(`Unknown plan ${planUuid}`);
  }
  return plan;
}

function requireAdapterTask(
  adapter: ApplyOperationToAdapter,
  taskUuid: string,
  planUuid: string
): ApplyOperationToTask {
  const task = adapter.getTasks(planUuid).find((item) => item.uuid === taskUuid);
  if (!task) {
    applyOperationToPrecondition(`Unknown task ${taskUuid}`);
  }
  return task;
}

function validateAdapterPlanOperation(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope
): void {
  const op = envelope.op;
  switch (op.type) {
    case 'plan.create': {
      if (adapter.getPlan(op.planUuid)) {
        return;
      }
      const taskUuids = new Set<string>();
      for (const task of op.tasks) {
        if (taskUuids.has(task.taskUuid) || adapter.getTaskByUuid(task.taskUuid)) {
          applyOperationToPrecondition('Duplicate task UUIDs in plan.create');
        }
        taskUuids.add(task.taskUuid);
      }
      if (op.parentUuid) {
        requireAdapterPlan(adapter, op.parentUuid);
        validateAdapterParentEdge(adapter, op.parentUuid, op.planUuid);
      }
      if (op.discoveredFrom) {
        requireAdapterPlan(adapter, op.discoveredFrom);
      }
      if (op.dependencies.some((dependencyUuid) => dependencyUuid === op.planUuid)) {
        applyOperationToPrecondition('Adding dependency would create a cycle');
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireAdapterPlan(adapter, dependencyUuid);
        if (dependencyReachesAdapter(adapter, dependencyUuid, op.planUuid)) {
          applyOperationToPrecondition('Adding dependency would create a cycle');
        }
        if (
          op.parentUuid &&
          (dependencyUuid === op.parentUuid ||
            dependencyReachesAdapter(adapter, dependencyUuid, op.parentUuid))
        ) {
          applyOperationToPrecondition('Setting parent would create a dependency cycle');
        }
      }
      return;
    }
    case 'plan.set_scalar':
      if (op.field === 'discovered_from' && typeof op.value === 'string') {
        requireAdapterPlan(adapter, op.value);
      }
      return;
    case 'plan.add_task': {
      requireAdapterPlan(adapter, op.planUuid);
      const existing = adapter.getTaskByUuid(op.taskUuid);
      if (existing) {
        applyOperationToPrecondition(`Duplicate task UUID ${op.taskUuid}`);
      }
      return;
    }
    case 'plan.add_dependency':
      requireAdapterPlan(adapter, op.planUuid);
      requireAdapterPlan(adapter, op.dependsOnPlanUuid);
      if (
        op.planUuid === op.dependsOnPlanUuid ||
        dependencyReachesAdapter(adapter, op.dependsOnPlanUuid, op.planUuid)
      ) {
        applyOperationToPrecondition('Adding dependency would create a cycle');
      }
      return;
    case 'plan.remove_dependency':
      requireAdapterPlan(adapter, op.planUuid);
      requireAdapterPlan(adapter, op.dependsOnPlanUuid);
      return;
    case 'plan.set_parent':
      requireAdapterPlan(adapter, op.planUuid);
      if (op.newParentUuid) {
        requireAdapterPlan(adapter, op.newParentUuid);
        validateAdapterParentEdge(adapter, op.newParentUuid, op.planUuid);
      }
      return;
    case 'plan.promote_task':
      requireAdapterPlan(adapter, op.sourcePlanUuid);
      requireAdapterTask(adapter, op.taskUuid, op.sourcePlanUuid);
      if (adapter.getPlan(op.newPlanUuid)) {
        return;
      }
      if (op.parentUuid) {
        requireAdapterPlan(adapter, op.parentUuid);
        validateAdapterParentEdge(adapter, op.parentUuid, op.newPlanUuid);
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireAdapterPlan(adapter, dependencyUuid);
        if (
          dependencyUuid === op.newPlanUuid ||
          dependencyReachesAdapter(adapter, dependencyUuid, op.newPlanUuid)
        ) {
          applyOperationToPrecondition('Adding dependency would create a cycle');
        }
      }
      return;
    default:
      return;
  }
}

function dependencyReachesAdapter(
  adapter: ApplyOperationToAdapter,
  startPlanUuid: string,
  targetPlanUuid: string
): boolean {
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
    stack.push(...adapter.getDependencies(current).map((row) => row.depends_on_uuid));
  }
  return false;
}

function parentChainReachesAdapter(
  adapter: ApplyOperationToAdapter,
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
    current = adapter.getPlan(current)?.parent_uuid ?? null;
  }
  return false;
}

function validateAdapterParentEdge(
  adapter: ApplyOperationToAdapter,
  parentUuid: string,
  childUuid: string
): void {
  if (
    parentUuid === childUuid ||
    parentChainReachesAdapter(adapter, parentUuid, childUuid) ||
    dependencyReachesAdapter(adapter, childUuid, parentUuid)
  ) {
    applyOperationToPrecondition('Setting parent would create a cycle');
  }
}

function applyOperationToPlanCreate(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.create' }> },
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  if (adapter.getPlan(op.planUuid)) {
    return [];
  }
  if (op.parentUuid) {
    requireAdapterPlan(adapter, op.parentUuid);
  }
  if (op.discoveredFrom) {
    requireAdapterPlan(adapter, op.discoveredFrom);
  }
  for (const dependencyUuid of new Set(op.dependencies)) {
    requireAdapterPlan(adapter, dependencyUuid);
  }
  const plan: ApplyOperationToPlan = {
    uuid: op.planUuid,
    project_id: adapter.project.id,
    plan_id: adapter.resolvePlanCreateNumericPlanId(
      op.numericPlanId,
      options.preserveRequestedPlanIds
    ),
    title: op.title,
    goal: op.goal ?? null,
    note: op.note ?? null,
    details: op.details ?? null,
    status: op.status ?? 'pending',
    priority: op.priority ?? null,
    branch: op.branch ?? null,
    simple: typeof op.simple === 'boolean' ? (op.simple ? 1 : 0) : null,
    tdd: typeof op.tdd === 'boolean' ? (op.tdd ? 1 : 0) : null,
    discovered_from: adapter.resolveLocalPlanId(op.discoveredFrom),
    issue: JSON.stringify(op.issue),
    pull_request: JSON.stringify(op.pullRequest),
    assigned_to: op.assignedTo ?? null,
    base_branch: op.baseBranch ?? null,
    base_commit: null,
    base_change_id: null,
    temp: typeof op.temp === 'boolean' ? (op.temp ? 1 : 0) : null,
    docs: JSON.stringify(op.docs),
    changed_files: JSON.stringify(op.changedFiles),
    plan_generated_at: op.planGeneratedAt ?? null,
    review_issues: JSON.stringify(op.reviewIssues),
    docs_updated_at: op.docsUpdatedAt ?? null,
    lessons_applied_at: op.lessonsAppliedAt ?? null,
    parent_uuid: op.parentUuid ?? null,
    epic: op.epic ? 1 : 0,
    revision: 1,
    created_at: options.sourceCreatedAt ?? new Date().toISOString(),
    updated_at: options.sourceUpdatedAt ?? new Date().toISOString(),
  };
  adapter.setPlan(plan);
  adapter.setTasks(
    op.planUuid,
    op.tasks.map((task, index) => ({
      uuid: task.taskUuid,
      plan_uuid: op.planUuid,
      task_index: index,
      title: task.title,
      description: task.description,
      done: task.done ? 1 : 0,
      revision: 1,
    }))
  );
  adapter.setTags(
    op.planUuid,
    [...new Set(op.tags)].map((tag) => ({ plan_uuid: op.planUuid, tag }))
  );
  adapter.setDependencies(
    op.planUuid,
    [...new Set(op.dependencies)].map((dependsOnUuid) => ({
      plan_uuid: op.planUuid,
      depends_on_uuid: dependsOnUuid,
    }))
  );
  const mutations: Mutation[] = [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: 1 },
  ];
  if (op.parentUuid) {
    const deps = adapter.getDependencies(op.parentUuid);
    if (!deps.some((dep) => dep.depends_on_uuid === op.planUuid)) {
      adapter.setDependencies(op.parentUuid, [
        ...deps,
        { plan_uuid: op.parentUuid, depends_on_uuid: op.planUuid },
      ]);
      const parent = requireAdapterPlan(adapter, op.parentUuid);
      adapter.setPlan(clonePlanWithBump(parent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${op.parentUuid}`,
        revision: parent.revision + 1,
      });
    }
  }
  return mutations;
}

function applyOperationToPlanScalar(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const value =
    envelope.op.field === 'epic'
      ? envelope.op.value
        ? 1
        : 0
      : envelope.op.field === 'discovered_from'
        ? adapter.resolveLocalPlanId(envelope.op.value as string | null)
        : envelope.op.value;
  if ((plan as unknown as Record<string, unknown>)[envelope.op.field] === value) {
    return [];
  }
  adapter.setPlan(clonePlanWithBump(plan, { [envelope.op.field]: value }, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToPlanText(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    applyOperationToPrecondition('text merge failed');
  }
  if (merged === current) {
    return [];
  }
  adapter.setPlan(clonePlanWithBump(plan, { [column]: merged }, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToAddTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  if (tasks.some((task) => task.uuid === envelope.op.taskUuid)) {
    return [];
  }
  const index = envelope.op.taskIndex ?? tasks.length;
  const shifted = tasks.map((task) =>
    task.task_index >= index ? { ...task, task_index: task.task_index + 1 } : task
  );
  adapter.setTasks(
    envelope.op.planUuid,
    [
      ...shifted,
      {
        uuid: envelope.op.taskUuid,
        plan_uuid: envelope.op.planUuid,
        task_index: index,
        title: envelope.op.title,
        description: envelope.op.description ?? '',
        done: envelope.op.done ? 1 : 0,
        revision: 1,
      },
    ].sort((a, b) => a.task_index - b.task_index)
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: 1 },
  ];
}

function applyOperationToTaskText(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  const current = task[column] ?? '';
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    applyOperationToPrecondition('text merge failed');
  }
  if (merged === current) {
    return [];
  }
  adapter.setTasks(
    envelope.op.planUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid
        ? { ...item, [column]: merged, revision: item.revision + 1 }
        : item
    )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToMarkTaskDone(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.mark_task_done' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const done = envelope.op.done ? 1 : 0;
  if (task.done === done) {
    return [];
  }
  adapter.setTasks(
    envelope.op.planUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid ? { ...item, done, revision: item.revision + 1 } : item
    )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToRemoveTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.remove_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = tasks.find((item) => item.uuid === envelope.op.taskUuid);
  if (!task) {
    return [];
  }
  adapter.onTaskDeleted?.(envelope.op.taskUuid, task.revision);
  adapter.setTasks(
    envelope.op.planUuid,
    tasks
      .filter((item) => item.uuid !== envelope.op.taskUuid)
      .map((item) =>
        item.task_index > task.task_index ? { ...item, task_index: item.task_index - 1 } : item
      )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToDependency(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_dependency' | 'plan.remove_dependency' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  requireAdapterPlan(adapter, envelope.op.dependsOnPlanUuid);
  const deps = adapter.getDependencies(envelope.op.planUuid);
  const exists = deps.some((dep) => dep.depends_on_uuid === envelope.op.dependsOnPlanUuid);
  const next =
    envelope.op.type === 'plan.add_dependency'
      ? exists
        ? deps
        : [
            ...deps,
            { plan_uuid: envelope.op.planUuid, depends_on_uuid: envelope.op.dependsOnPlanUuid },
          ]
      : deps.filter((dep) => dep.depends_on_uuid !== envelope.op.dependsOnPlanUuid);
  if (next === deps || next.length === deps.length) {
    return [];
  }
  adapter.setDependencies(envelope.op.planUuid, next);
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToTag(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_tag' | 'plan.remove_tag' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tags = adapter.getTags(envelope.op.planUuid);
  const exists = tags.some((tag) => tag.tag === envelope.op.tag);
  const next =
    envelope.op.type === 'plan.add_tag'
      ? exists
        ? tags
        : [...tags, { plan_uuid: envelope.op.planUuid, tag: envelope.op.tag }]
      : tags.filter((tag) => tag.tag !== envelope.op.tag);
  if (next === tags || next.length === tags.length) {
    return [];
  }
  adapter.setTags(envelope.op.planUuid, next);
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToListItem(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_list_item' | 'plan.remove_list_item' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = LIST_COLUMNS[envelope.op.list];
  const current = parseJsonArray(plan[column]);
  const valueText = canonicalJsonStringify(envelope.op.value);
  const index = current.findIndex((item) => canonicalJsonStringify(item) === valueText);
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
  adapter.setPlan(
    clonePlanWithBump(plan, { [column]: next.length === 0 ? null : JSON.stringify(next) }, options)
  );
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToPlanDelete(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.delete' }> }
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  adapter.onPlanDeleted?.(envelope.op.planUuid);
  adapter.deletePlan(envelope.op.planUuid);
  return [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 },
    ...tasks
      .filter(
        (task): task is ApplyOperationToTask & { uuid: string } => typeof task.uuid === 'string'
      )
      .map((task) => ({
        targetType: 'task',
        targetKey: `task:${task.uuid}`,
        revision: task.revision + 1,
      })),
  ];
}

function applyOperationToSetParent(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  if (envelope.op.newParentUuid) {
    requireAdapterPlan(adapter, envelope.op.newParentUuid);
  }
  if (plan.parent_uuid === envelope.op.newParentUuid) {
    return [];
  }
  const mutations: Mutation[] = [];
  const oldParentUuid = plan.parent_uuid;
  adapter.setPlan(clonePlanWithBump(plan, { parent_uuid: envelope.op.newParentUuid }, options));
  mutations.push({
    targetType: 'plan',
    targetKey: envelope.targetKey,
    revision: plan.revision + 1,
  });
  if (oldParentUuid) {
    const oldDeps = adapter.getDependencies(oldParentUuid);
    const nextOldDeps = oldDeps.filter((dep) => dep.depends_on_uuid !== envelope.op.planUuid);
    if (nextOldDeps.length !== oldDeps.length) {
      adapter.setDependencies(oldParentUuid, nextOldDeps);
      const oldParent = requireAdapterPlan(adapter, oldParentUuid);
      adapter.setPlan(clonePlanWithBump(oldParent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${oldParentUuid}`,
        revision: oldParent.revision + 1,
      });
    }
  }
  if (envelope.op.newParentUuid) {
    const newDeps = adapter.getDependencies(envelope.op.newParentUuid);
    if (!newDeps.some((dep) => dep.depends_on_uuid === envelope.op.planUuid)) {
      adapter.setDependencies(envelope.op.newParentUuid, [
        ...newDeps,
        { plan_uuid: envelope.op.newParentUuid, depends_on_uuid: envelope.op.planUuid },
      ]);
      const newParent = requireAdapterPlan(adapter, envelope.op.newParentUuid);
      adapter.setPlan(clonePlanWithBump(newParent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${envelope.op.newParentUuid}`,
        revision: newParent.revision + 1,
      });
    }
  }
  return mutations;
}

function applyOperationToPromoteTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.promote_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const sourcePlan = requireAdapterPlan(adapter, envelope.op.sourcePlanUuid);
  const tasks = adapter.getTasks(envelope.op.sourcePlanUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.sourcePlanUuid);
  if (adapter.getPlan(envelope.op.newPlanUuid)) {
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
  const mutations = applyOperationToPlanCreate(adapter, createEnvelope, options);
  adapter.setTasks(
    envelope.op.sourcePlanUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid && item.done !== 1
        ? { ...item, done: 1, revision: item.revision + 1 }
        : item
    )
  );
  adapter.setPlan(clonePlanWithBump(sourcePlan, {}, options));
  mutations.push(
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    {
      targetType: 'plan',
      targetKey: `plan:${envelope.op.sourcePlanUuid}`,
      revision: sourcePlan.revision + 1,
    }
  );
  return mutations;
}

type PlanTableName = 'plan' | 'plan_canonical';
type TaskTableName = 'plan_task' | 'task_canonical';
type DependencyTableName = 'plan_dependency' | 'plan_dependency_canonical';
type TagTableName = 'plan_tag' | 'plan_tag_canonical';

function getCanonicalPlan(db: Database, planUuid: string): PlanRow | null {
  return getCanonicalPlanOnly(db, planUuid);
}

function getCanonicalPlanOnly(db: Database, planUuid: string): PlanRow | null {
  return (
    (db.prepare('SELECT * FROM plan_canonical WHERE uuid = ?').get(planUuid) as PlanRow | null) ??
    null
  );
}

function requireCanonicalPlan(
  db: Database,
  project: ProjectRow,
  planUuid: string,
  envelope: SyncOperationEnvelope
): PlanRow {
  const plan = getCanonicalPlan(db, planUuid);
  if (!plan || plan.project_id !== project.id) {
    throw validationError(envelope, `Unknown plan ${planUuid}`);
  }
  return plan;
}

function readTasksFromTable(
  db: Database,
  table: TaskTableName,
  planUuid: string
): ApplyOperationToTask[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE plan_uuid = ? ORDER BY task_index, id`)
    .all(planUuid) as ApplyOperationToTask[];
}

function readDependenciesFromTable(
  db: Database,
  table: DependencyTableName,
  planUuid: string
): PlanDependencyRow[] {
  return db
    .prepare(`SELECT plan_uuid, depends_on_uuid FROM ${table} WHERE plan_uuid = ?`)
    .all(planUuid) as PlanDependencyRow[];
}

function readTagsFromTable(db: Database, table: TagTableName, planUuid: string): PlanTagRow[] {
  return db.prepare(`SELECT plan_uuid, tag FROM ${table} WHERE plan_uuid = ?`).all(planUuid) as
    | PlanTagRow[]
    | [];
}

function deletePlanFromTableSet(
  db: Database,
  planTable: PlanTableName,
  taskTable: TaskTableName,
  planUuid: string
): void {
  const dependencyTable = planTable === 'plan' ? 'plan_dependency' : 'plan_dependency_canonical';
  const tagTable = planTable === 'plan' ? 'plan_tag' : 'plan_tag_canonical';
  db.prepare(`DELETE FROM ${dependencyTable} WHERE plan_uuid = ? OR depends_on_uuid = ?`).run(
    planUuid,
    planUuid
  );
  db.prepare(`DELETE FROM ${tagTable} WHERE plan_uuid = ?`).run(planUuid);
  db.prepare(`DELETE FROM ${taskTable} WHERE plan_uuid = ?`).run(planUuid);
  db.prepare(`DELETE FROM ${planTable} WHERE uuid = ?`).run(planUuid);
}

function writePlanToTableSet(
  db: Database,
  table: PlanTableName,
  taskTable: TaskTableName,
  plan: ApplyOperationToPlan
): void {
  void taskTable;
  db.prepare(
    `
      INSERT INTO ${table} (
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(uuid) DO UPDATE SET
        project_id = excluded.project_id,
        plan_id = excluded.plan_id,
        title = excluded.title,
        goal = excluded.goal,
        note = excluded.note,
        details = excluded.details,
        status = excluded.status,
        priority = excluded.priority,
        branch = excluded.branch,
        simple = excluded.simple,
        tdd = excluded.tdd,
        discovered_from = excluded.discovered_from,
        issue = excluded.issue,
        pull_request = excluded.pull_request,
        assigned_to = excluded.assigned_to,
        base_branch = excluded.base_branch,
        base_commit = excluded.base_commit,
        base_change_id = excluded.base_change_id,
        temp = excluded.temp,
        docs = excluded.docs,
        changed_files = excluded.changed_files,
        plan_generated_at = excluded.plan_generated_at,
        review_issues = excluded.review_issues,
        docs_updated_at = excluded.docs_updated_at,
        lessons_applied_at = excluded.lessons_applied_at,
        parent_uuid = excluded.parent_uuid,
        epic = excluded.epic,
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `
  ).run(
    plan.uuid,
    plan.project_id,
    plan.plan_id,
    plan.title,
    plan.goal,
    plan.note,
    plan.details,
    plan.status,
    plan.priority,
    plan.branch,
    plan.simple,
    plan.tdd,
    plan.discovered_from,
    plan.issue,
    plan.pull_request,
    plan.assigned_to,
    plan.base_branch,
    plan.base_commit,
    plan.base_change_id,
    plan.temp,
    plan.docs,
    plan.changed_files,
    plan.plan_generated_at,
    plan.review_issues,
    plan.docs_updated_at,
    plan.lessons_applied_at,
    plan.parent_uuid,
    plan.epic,
    plan.revision,
    plan.created_at,
    plan.updated_at
  );
}

function replaceTasksInTable(
  db: Database,
  table: TaskTableName,
  planUuid: string,
  tasks: ApplyOperationToTask[]
): void {
  db.prepare(`DELETE FROM ${table} WHERE plan_uuid = ?`).run(planUuid);
  const insert = db.prepare(
    `INSERT INTO ${table} (uuid, plan_uuid, task_index, title, description, done, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const task of tasks.sort((a, b) => a.task_index - b.task_index)) {
    if (!task.uuid) {
      throw new Error('task missing uuid in canonical apply write');
    }
    insert.run(
      task.uuid,
      planUuid,
      task.task_index,
      task.title,
      task.description,
      task.done,
      task.revision
    );
  }
}

function replacePlanCollectionsInTableSet(
  db: Database,
  dependencyTable: DependencyTableName,
  tagTable: TagTableName,
  planUuid: string,
  dependencies: PlanDependencyRow[],
  tags: PlanTagRow[]
): void {
  db.prepare(`DELETE FROM ${dependencyTable} WHERE plan_uuid = ?`).run(planUuid);
  const insertDependency = db.prepare(
    `INSERT OR IGNORE INTO ${dependencyTable} (plan_uuid, depends_on_uuid) VALUES (?, ?)`
  );
  for (const dependency of dependencies) {
    insertDependency.run(dependency.plan_uuid, dependency.depends_on_uuid);
  }
  db.prepare(`DELETE FROM ${tagTable} WHERE plan_uuid = ?`).run(planUuid);
  const insertTag = db.prepare(`INSERT OR IGNORE INTO ${tagTable} (plan_uuid, tag) VALUES (?, ?)`);
  for (const tag of tags) {
    insertTag.run(tag.plan_uuid, tag.tag);
  }
}

function dependencyReachesInTable(
  db: Database,
  table: DependencyTableName,
  startPlanUuid: string,
  targetPlanUuid: string
): boolean {
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
      .prepare(`SELECT depends_on_uuid FROM ${table} WHERE plan_uuid = ?`)
      .all(current) as Array<{ depends_on_uuid: string }>;
    stack.push(...rows.map((row) => row.depends_on_uuid));
  }
  return false;
}

function validateParentEdgeInTables(
  db: Database,
  envelope: SyncOperationEnvelope,
  planTable: PlanTableName,
  dependencyTable: DependencyTableName,
  parentUuid: string,
  childUuid: string
): void {
  if (
    parentUuid === childUuid ||
    parentChainReachesInTable(db, planTable, parentUuid, childUuid) ||
    dependencyReachesInTable(db, dependencyTable, childUuid, parentUuid)
  ) {
    throw validationError(envelope, 'Setting parent would create a cycle');
  }
}

function parentChainReachesInTable(
  db: Database,
  table: PlanTableName,
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
    const row = db.prepare(`SELECT parent_uuid FROM ${table} WHERE uuid = ?`).get(current) as {
      parent_uuid: string | null;
    } | null;
    current = row?.parent_uuid ?? null;
  }
  return false;
}

function createTextMergeConflict(
  db: Database,
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string
): string {
  const op = envelope.op;
  if (op.type === 'plan.patch_text') {
    const plan = adapter.getPlan(op.planUuid);
    const column = PLAN_TEXT_COLUMNS[op.field];
    return createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: op.field,
      baseValue: op.base,
      incomingValue: op.new,
      attemptedPatch: op.patch ?? null,
      currentValue: plan ? ((plan[column] ?? '') as string).toString() : null,
      reason: 'text_merge_failed',
    });
  }
  if (op.type === 'plan.update_task_text') {
    const task = adapter.getTasks(op.planUuid).find((item) => item.uuid === op.taskUuid);
    const column = TASK_TEXT_COLUMNS[op.field];
    return createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: op.field,
      baseValue: op.base,
      incomingValue: op.new,
      attemptedPatch: op.patch ?? null,
      currentValue: task ? (task[column] ?? '') : null,
      reason: 'text_merge_failed',
    });
  }
  throw validationError(envelope, 'text merge failed');
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
          attempts = attempts + 1,
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
