export {
  applyBatch,
  applyOperation,
  applyOperationTo,
  applyOperationToPrecondition,
  clonePlanWithBump,
  resolveSyncConflict,
  setApplyBatchOperationHookForTesting,
} from './apply_core.js';

export type {
  ApplyOperationToAdapter,
  ApplyOperationToPlan,
  ApplyOperationToTask,
} from './apply_core.js';

export type {
  ApplyBatchResult,
  ApplyOperationOptions,
  ApplyOperationResult,
  ApplyOperationStatus,
  ResolveSyncConflictOptions,
  ResolveSyncConflictResult,
  TargetKey,
} from './apply_types.js';
