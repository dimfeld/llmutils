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
  /**
   * Per-batch baseline plan revisions captured before the batch's first op runs.
   * Within an atomic batch, multiple operations on the same plan share a single
   * pre-batch baseRevision; the canonical revision advances as earlier ops apply,
   * so the per-op CAS check must validate against this baseline rather than the
   * live canonical revision.
   */
  atomicBatchPlanBaseRevisions?: Map<string, number>;
  /**
   * Per-batch baseline task revisions captured before the batch's first op runs.
   * Task text/removal operations carry task revisions in baseRevision, so they
   * need the same atomic-batch baseline treatment as plan-level operations.
   */
  atomicBatchTaskBaseRevisions?: Map<string, number>;
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
