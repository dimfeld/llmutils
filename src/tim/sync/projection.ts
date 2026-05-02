/*
 * Persistent-node projection invariant:
 *
 * - User-visible projection rows equal canonical rows plus active local sync operations.
 * - Canonical rows are written only by canonical apply on the main node or by canonical
 *   snapshot/catch-up merge on persistent nodes.
 * - Projection rows are written only by the projector. Local persistent-node writes append
 *   sync_operation rows, then rebuild the affected projection from canonical + active ops.
 *
 * Active operations are queued, sending, and failed_retryable. Terminal operations are acked,
 * conflict, and rejected; changing an operation into a terminal state removes it from future
 * projection rebuilds instead of applying operation-specific rollback logic.
 */

export const ACTIVE_PROJECTION_OPERATION_STATUSES = [
  'queued',
  'sending',
  'failed_retryable',
] as const;

export type ActiveProjectionOperationStatus = (typeof ACTIVE_PROJECTION_OPERATION_STATUSES)[number];
