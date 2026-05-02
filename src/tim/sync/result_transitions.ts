import type { Database } from 'bun:sqlite';
import { refreshExistingPrimaryMaterializedPlans } from '../materialized_projection_refresh.js';
import {
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
} from './queue.js';
import {
  collectProjectionTargetsForOperationRow,
  createProjectionRebuildTargets,
  rebuildProjectionTargetsInTransaction,
} from './projection_targets.js';
import type { SyncOperationResult } from './ws_protocol.js';

export interface ApplyOperationResultTransitionsOptions {
  afterTransition?: (result: SyncOperationResult, index: number) => void;
}

export function applyOperationResultTransitions(
  db: Database,
  results: SyncOperationResult[],
  options: ApplyOperationResultTransitionsOptions = {}
): string[] {
  const transition = db.transaction((nextResults: SyncOperationResult[]): string[] => {
    const rebuildTargets = createProjectionRebuildTargets();
    for (const [index, result] of nextResults.entries()) {
      const ackMetadata = {
        sequenceIds: result.sequenceIds ?? [],
        invalidations: result.invalidations ?? [],
      };
      switch (result.status) {
        case 'applied':
          collectProjectionTargetsForOperationRow(
            db,
            rebuildTargets,
            markOperationAcked(db, result.operationId, ackMetadata)
          );
          break;
        case 'conflict':
          collectProjectionTargetsForOperationRow(
            db,
            rebuildTargets,
            markOperationConflict(
              db,
              result.operationId,
              result.conflictId ?? 'unknown-conflict',
              ackMetadata
            )
          );
          break;
        case 'rejected':
          collectProjectionTargetsForOperationRow(
            db,
            rebuildTargets,
            markOperationRejected(
              db,
              result.operationId,
              result.error ?? 'Operation rejected by main node',
              ackMetadata
            )
          );
          break;
        case 'deferred':
        case 'failed_retryable':
          markOperationFailedRetryable(
            db,
            result.operationId,
            result.error ?? 'Operation not applied; retry later'
          );
          break;
      }
      options.afterTransition?.(result, index);
    }
    return rebuildProjectionTargetsInTransaction(db, rebuildTargets);
  });
  const affectedPlanUuids = transition.immediate(results);
  // File refresh intentionally runs after the SQLite transaction. A missed or
  // dirty materialization self-heals on the next explicit materialize/sync pass.
  refreshExistingPrimaryMaterializedPlans(db, affectedPlanUuids);
  return affectedPlanUuids;
}
