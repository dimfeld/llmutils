import type { Database } from 'bun:sqlite';
import { SyncFifoGapError, SyncValidationError } from './errors.js';
import {
  assertValidBatchEnvelope,
  assertValidEnvelope,
  type SyncOperationBatchEnvelope,
  type SyncOperationEnvelope,
} from './types.js';
import type {
  ApplyBatchOptions,
  ApplyBatchResult,
  ApplyOperationOptions,
  ApplyOperationResult,
} from './apply_types.js';
import { getBaseRevisionPlanUuid, getBaseRevisionTaskUuid } from './operation_metadata.js';
import { applyOperationInTransaction } from './apply_operation.js';
import { allocateLocalSequenceRange } from './queue.js';
import {
  TERMINAL_OPERATION_STATUSES,
  getOperationByOriginSequence,
  getOperationRow,
  insertReceivedOperation,
  rejectOperation,
  rejectedResult,
  resultFromRecordedOperation,
} from './apply_shared.js';

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
  options: ApplyBatchOptions = {}
): ApplyBatchResult {
  const { precondition, allocateLocalSequencesForOrigin, ...operationOptions } = options;
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

  let effectiveBatch = batch;
  let localSequenceStart: number | undefined;
  let preconditionPassed = false;

  const apply = db.transaction((): ApplyBatchResult => {
    precondition?.();
    preconditionPassed = true;
    if (allocateLocalSequencesForOrigin) {
      localSequenceStart = allocateLocalSequenceRange(
        db,
        allocateLocalSequencesForOrigin,
        batch.operations.length
      );
      effectiveBatch = assertValidBatchEnvelope({
        ...batch,
        operations: batch.operations.map((operation, index) => ({
          ...operation,
          originNodeId: allocateLocalSequencesForOrigin,
          localSequence: localSequenceStart! + index,
        })),
      });
    }
    const results: ApplyOperationResult[] = [];
    const effectiveOptions: ApplyOperationOptions =
      effectiveBatch.atomic === true
        ? {
            ...operationOptions,
            atomicBatchPlanBaseRevisions: captureAtomicBatchPlanBaseRevisions(db, effectiveBatch),
            atomicBatchTaskBaseRevisions: captureAtomicBatchTaskBaseRevisions(db, effectiveBatch),
          }
        : operationOptions;
    for (const [index, operation] of effectiveBatch.operations.entries()) {
      const result =
        applyBatchOperationHookForTesting?.(index, operation) ??
        applyOperationInTransaction(
          db,
          operation,
          originalPayloads[index],
          normalizedPayloads[index],
          effectiveOptions,
          effectiveBatch.batchId,
          effectiveBatch.atomic === true
        );
      results.push(result);
      if (
        result.status === 'rejected' ||
        result.status === 'deferred' ||
        (effectiveBatch.atomic === true && result.status === 'conflict')
      ) {
        throw new BatchAbort(result, results, results.length - 1);
      }
    }
    return aggregateBatchResult(effectiveBatch.batchId, results);
  });

  try {
    const result = apply.immediate();
    return localSequenceStart === undefined ? result : { ...result, localSequenceStart };
  } catch (error) {
    if (error instanceof BatchAbort) {
      const status =
        error.result.status === 'deferred'
          ? 'deferred'
          : error.result.status === 'conflict'
            ? 'conflict'
            : 'rejected';
      const results = rolledBackBatchResults(
        effectiveBatch.operations,
        error.result,
        error.causeIndex
      );
      const persisted = persistRolledBackBatchRejections(
        db,
        effectiveBatch,
        results,
        normalizedPayloads,
        status === 'deferred' ? undefined : allocateLocalSequencesForOrigin
      );
      if (persisted.replay) {
        return persisted.replay;
      }
      return {
        batchId: effectiveBatch.batchId,
        status,
        results,
        invalidations: [],
        sequenceIds: [],
        ...(persisted.localSequenceStart === undefined
          ? {}
          : { localSequenceStart: persisted.localSequenceStart }),
        error: error.result.error,
      };
    }
    if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
      if (allocateLocalSequencesForOrigin && !preconditionPassed) {
        throw error;
      }
      const status = error instanceof SyncFifoGapError ? 'deferred' : 'rejected';
      const results = rolledBackBatchResults(
        effectiveBatch.operations,
        {
          status,
          sequenceIds: [],
          invalidations: [],
          acknowledged: status === 'rejected',
          error,
        } as ApplyOperationResult,
        effectiveBatch.operations.findIndex(
          (operation) => operation.operationUuid === error.operationUuid
        )
      );
      const persisted = persistRolledBackBatchRejections(
        db,
        effectiveBatch,
        results,
        normalizedPayloads,
        status === 'deferred' ? undefined : allocateLocalSequencesForOrigin
      );
      if (persisted.replay) {
        return persisted.replay;
      }
      return {
        batchId: effectiveBatch.batchId,
        status,
        results,
        invalidations: [],
        sequenceIds: [],
        ...(persisted.localSequenceStart === undefined
          ? {}
          : { localSequenceStart: persisted.localSequenceStart }),
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

function captureAtomicBatchPlanBaseRevisions(
  db: Database,
  batch: SyncOperationBatchEnvelope
): Map<string, number> {
  const planUuids = new Set<string>();
  for (const operation of batch.operations) {
    const planUuid = getBaseRevisionPlanUuid(operation.op);
    if (planUuid) {
      planUuids.add(planUuid);
    }
  }
  const baseline = new Map<string, number>();
  if (planUuids.size === 0) {
    return baseline;
  }
  const stmt = db.prepare('SELECT revision FROM plan_canonical WHERE uuid = ?');
  for (const planUuid of planUuids) {
    const row = stmt.get(planUuid) as { revision: number } | null;
    if (row) {
      baseline.set(planUuid, row.revision);
    }
  }
  return baseline;
}

function captureAtomicBatchTaskBaseRevisions(
  db: Database,
  batch: SyncOperationBatchEnvelope
): Map<string, number> {
  const taskUuids = new Set<string>();
  for (const operation of batch.operations) {
    const taskUuid = getBaseRevisionTaskUuid(operation.op);
    if (taskUuid) {
      taskUuids.add(taskUuid);
    }
  }
  const baseline = new Map<string, number>();
  if (taskUuids.size === 0) {
    return baseline;
  }
  const stmt = db.prepare('SELECT revision FROM task_canonical WHERE uuid = ?');
  for (const taskUuid of taskUuids) {
    const row = stmt.get(taskUuid) as { revision: number } | null;
    if (row) {
      baseline.set(taskUuid, row.revision);
    }
  }
  return baseline;
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
  normalizedPayloads: string[],
  allocateLocalSequencesForOrigin?: string
): {
  batch: SyncOperationBatchEnvelope;
  localSequenceStart?: number;
  replay?: ApplyBatchResult;
} {
  if (results.every((result) => result.status === 'deferred')) {
    return { batch };
  }
  return persistBatchRejections(db, batch, results, normalizedPayloads, {
    fallbackMessage: 'Operation rejected because its atomic batch rolled back',
    allocateLocalSequencesForOrigin,
  });
}

function persistMissingBatchReplayRejections(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  rows: Array<ReturnType<typeof getOperationRow>>,
  results: ApplyOperationResult[],
  normalizedPayloads: string[]
): void {
  persistBatchRejections(db, batch, results, normalizedPayloads, {
    skipExistingRows: rows,
    fallbackMessage: 'Operation rejected because its batch replay was partial',
  });
}

function persistBatchRejections(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  results: ApplyOperationResult[],
  normalizedPayloads: string[],
  options: {
    skipExistingRows?: Array<ReturnType<typeof getOperationRow>>;
    fallbackMessage: string;
    allocateLocalSequencesForOrigin?: string;
  }
): {
  batch: SyncOperationBatchEnvelope;
  localSequenceStart?: number;
  replay?: ApplyBatchResult;
} {
  const persist = db.transaction(
    (): {
      batch: SyncOperationBatchEnvelope;
      localSequenceStart?: number;
      replay?: ApplyBatchResult;
    } => {
      let persistedBatch = batch;
      let persistedLocalSequenceStart: number | undefined;
      if (options.allocateLocalSequencesForOrigin) {
        const replay = getBatchReplayResult(db, batch, normalizedPayloads, {
          repairMissingRows: false,
        });
        if (replay) {
          return { batch, replay };
        }
        persistedLocalSequenceStart = allocateLocalSequenceRange(
          db,
          options.allocateLocalSequencesForOrigin,
          batch.operations.length
        );
        persistedBatch = assertValidBatchEnvelope({
          ...batch,
          operations: batch.operations.map((operation, index) => ({
            ...operation,
            originNodeId: options.allocateLocalSequencesForOrigin!,
            localSequence: persistedLocalSequenceStart! + index,
          })),
        });
      }
      for (const [index, operation] of persistedBatch.operations.entries()) {
        if (options.skipExistingRows?.[index]) {
          continue;
        }
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
            // We cannot persist this operation UUID without violating FIFO identity.
            continue;
          }
          insertReceivedOperation(
            db,
            operation,
            normalizedPayloads[index],
            persistedBatch.batchId,
            persistedBatch.atomic === true
          );
        } else if (existing.batch_id !== persistedBatch.batchId) {
          continue;
        }
        // Atomic conflict aborts roll back the sync_conflict row, so the durable
        // operation record is a rejection rather than status='conflict'.
        const message =
          result.status === 'conflict'
            ? atomicConflictAbortMessage(result.error)
            : (result.error?.message ?? options.fallbackMessage);
        rejectOperation(db, operation.operationUuid, message);
      }
      return {
        batch: persistedBatch,
        ...(persistedLocalSequenceStart === undefined
          ? {}
          : { localSequenceStart: persistedLocalSequenceStart }),
      };
    }
  );
  return persist.immediate();
}

function atomicConflictAbortMessage(cause: Error | undefined): string {
  return cause
    ? `Atomic batch aborted: conflict diagnosed but not persisted: ${cause.message}`
    : 'Atomic batch aborted: conflict diagnosed but not persisted';
}

function getBatchReplayResult(
  db: Database,
  batch: SyncOperationBatchEnvelope,
  normalizedPayloads: string[],
  options: { repairMissingRows?: boolean } = {}
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
    if (options.repairMissingRows !== false) {
      persistMissingBatchReplayRejections(db, batch, rows, results, normalizedPayloads);
    }
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
    if (options.repairMissingRows !== false) {
      persistMissingBatchReplayRejections(db, batch, rows, results, normalizedPayloads);
    }
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
