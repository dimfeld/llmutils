import { ApplyOperationToPreconditionError } from '$tim/sync/operation_fold.js';
import {
  SyncConflictError,
  SyncValidationError,
  SyncWriteConflictError,
  SyncWriteRejectedError,
} from '$tim/sync/errors.js';

export type PlanMetadataErrorKind =
  | 'validation_failed'
  | 'not_found'
  | 'project_mismatch'
  | 'invalid_reference'
  | 'cycle_detected'
  | 'sync_conflict'
  | 'persistence_failed';

export interface PlanMetadataErrorPayload {
  kind: PlanMetadataErrorKind;
  message: string;
  field?: string;
}

export interface PlanMetadataRemoteError {
  status: number;
  body: PlanMetadataErrorPayload;
}

export class PlanMetadataValidationError extends Error {
  readonly kind: PlanMetadataErrorKind;
  readonly field?: string;

  constructor(kind: PlanMetadataErrorKind, message: string, field?: string) {
    super(message);
    this.name = 'PlanMetadataValidationError';
    this.kind = kind;
    this.field = field;
  }
}

export function planMetadataHttpStatus(kind: PlanMetadataErrorKind): number {
  switch (kind) {
    case 'validation_failed':
    case 'invalid_reference':
    case 'project_mismatch':
      return 400;
    case 'not_found':
      return 404;
    case 'cycle_detected':
    case 'sync_conflict':
      return 409;
    case 'persistence_failed':
      return 500;
    default:
      return 500;
  }
}

export function toPlanMetadataRemoteError(error: unknown): PlanMetadataRemoteError | null {
  if (error instanceof PlanMetadataValidationError) {
    return buildRemoteError(error.kind, error.message, error.field);
  }

  if (error instanceof SyncWriteConflictError || error instanceof SyncConflictError) {
    return buildRemoteError('sync_conflict', error.message, syncConflictField(error));
  }

  if (error instanceof SyncWriteRejectedError) {
    return mapRejectedSyncWrite(error);
  }

  if (error instanceof SyncValidationError) {
    if (/cycle/i.test(error.message)) {
      return buildRemoteError('cycle_detected', error.message);
    }
    return buildRemoteError('validation_failed', error.message);
  }

  if (error instanceof ApplyOperationToPreconditionError) {
    return mapPreconditionError(error);
  }

  return null;
}

function buildRemoteError(
  kind: PlanMetadataErrorKind,
  message: string,
  field?: string
): PlanMetadataRemoteError {
  return {
    status: planMetadataHttpStatus(kind),
    body: {
      kind,
      message,
      ...(field ? { field } : {}),
    },
  };
}

function mapRejectedSyncWrite(error: SyncWriteRejectedError): PlanMetadataRemoteError {
  const cause = error.cause;
  if (cause instanceof ApplyOperationToPreconditionError) {
    return mapPreconditionError(cause);
  }
  if (cause instanceof SyncWriteConflictError || cause instanceof SyncConflictError) {
    return buildRemoteError('sync_conflict', cause.message, syncConflictField(cause));
  }
  if (cause instanceof SyncValidationError) {
    if (/cycle/i.test(cause.message)) {
      return buildRemoteError('cycle_detected', cause.message);
    }
    return buildRemoteError('validation_failed', cause.message);
  }

  return buildRemoteError('persistence_failed', error.reason);
}

function mapPreconditionError(error: ApplyOperationToPreconditionError): PlanMetadataRemoteError {
  switch (error.code) {
    case 'cycle':
      return buildRemoteError('cycle_detected', error.message);
    case 'stale_revision':
    case 'text_merge_failed':
      return buildRemoteError('sync_conflict', error.message);
    case 'unknown_entity':
      return buildRemoteError('invalid_reference', error.message);
    case 'duplicate_entity':
    case 'invalid_operation':
      return buildRemoteError('validation_failed', error.message);
    default:
      return buildRemoteError('persistence_failed', error.message);
  }
}

function syncConflictField(error: SyncWriteConflictError | SyncConflictError): string | undefined {
  if (error instanceof SyncWriteConflictError) {
    return error.fieldPath;
  }
  return undefined;
}
