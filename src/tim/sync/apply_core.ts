export type {
  ApplyBatchResult,
  ApplyOperationOptions,
  ApplyOperationResult,
  ApplyOperationStatus,
  ResolveSyncConflictOptions,
  ResolveSyncConflictResult,
  TargetKey,
} from './apply_types.js';

export { applyBatch, setApplyBatchOperationHookForTesting } from './apply_batch.js';
export { resolveSyncConflict } from './apply_conflicts.js';
export { applyOperation } from './apply_operation.js';

export {
  applyOperationTo,
  applyOperationToPrecondition,
  clonePlanWithBump,
  type ApplyOperationToAdapter,
  type ApplyOperationToPlan,
  type ApplyOperationToTask,
} from './operation_fold.js';
