import type { Database } from 'bun:sqlite';
import {
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  type SyncOperationQueueRow,
} from './queue.js';
import { rebuildProjectSettingProjectionForPayload } from './projection.js';
import { assertValidPayload } from './types.js';
import type { SyncOperationResult } from './ws_protocol.js';

export interface ApplyOperationResultTransitionsOptions {
  afterTransition?: (result: SyncOperationResult, index: number) => void;
}

export function applyOperationResultTransitions(
  db: Database,
  results: SyncOperationResult[],
  options: ApplyOperationResultTransitionsOptions = {}
): void {
  const transition = db.transaction((nextResults: SyncOperationResult[]): void => {
    for (const [index, result] of nextResults.entries()) {
      const ackMetadata = {
        sequenceIds: result.sequenceIds ?? [],
        invalidations: result.invalidations ?? [],
      };
      switch (result.status) {
        case 'applied':
          rebuildProjectSettingProjectionAfterTerminalTransition(
            db,
            markOperationAcked(db, result.operationId, ackMetadata)
          );
          break;
        case 'conflict':
          rebuildProjectSettingProjectionAfterTerminalTransition(
            db,
            markOperationConflict(
              db,
              result.operationId,
              result.conflictId ?? 'unknown-conflict',
              ackMetadata
            )
          );
          break;
        case 'rejected':
          rebuildProjectSettingProjectionAfterTerminalTransition(
            db,
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
  });
  transition.immediate(results);
}

function rebuildProjectSettingProjectionAfterTerminalTransition(
  db: Database,
  row: SyncOperationQueueRow
): void {
  if (
    row.operation_type !== 'project_setting.set' &&
    row.operation_type !== 'project_setting.delete'
  ) {
    return;
  }
  const payload = assertValidPayload(JSON.parse(row.payload));
  if (payload.type === 'project_setting.set' || payload.type === 'project_setting.delete') {
    rebuildProjectSettingProjectionForPayload(db, payload);
  }
}
