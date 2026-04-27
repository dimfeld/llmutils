import type { ZodIssue } from 'zod/v4';

export class SyncValidationError extends Error {
  override readonly name = 'SyncValidationError';
  readonly operationUuid?: string;
  readonly issues: ZodIssue[];

  constructor(message: string, options: { operationUuid?: string; issues: ZodIssue[] }) {
    super(message);
    this.operationUuid = options.operationUuid;
    this.issues = options.issues;
  }
}

export class SyncConflictError extends Error {
  override readonly name = 'SyncConflictError';
  readonly operationUuid: string;
  readonly targetKey: string;
  readonly baseRevision?: number;
  readonly currentRevision?: number;
  readonly currentValueSnippet?: string;

  constructor(
    message: string,
    options: {
      operationUuid: string;
      targetKey: string;
      baseRevision?: number;
      currentRevision?: number;
      currentValueSnippet?: string;
    }
  ) {
    super(message);
    this.operationUuid = options.operationUuid;
    this.targetKey = options.targetKey;
    this.baseRevision = options.baseRevision;
    this.currentRevision = options.currentRevision;
    this.currentValueSnippet = options.currentValueSnippet;
  }
}

export class SyncRetryableNetworkError extends Error {
  override readonly name = 'SyncRetryableNetworkError';
  readonly httpStatus?: number;

  constructor(message: string, options: { cause?: unknown; httpStatus?: number } = {}) {
    super(message, { cause: options.cause });
    this.httpStatus = options.httpStatus;
  }
}

export class SyncWriteRejectedError extends Error {
  override readonly name = 'SyncWriteRejectedError';
  readonly operationUuid: string;
  readonly targetKey: string;
  readonly reason: string;

  constructor(
    message: string,
    options: {
      operationUuid: string;
      targetKey: string;
      reason: string;
      cause?: unknown;
    }
  ) {
    super(message, { cause: options.cause });
    this.operationUuid = options.operationUuid;
    this.targetKey = options.targetKey;
    this.reason = options.reason;
  }
}

export class SyncWriteConflictError extends Error {
  override readonly name = 'SyncWriteConflictError';
  readonly operationUuid: string;
  readonly targetKey: string;
  readonly conflictId?: string;

  constructor(
    message: string,
    options: {
      operationUuid: string;
      targetKey: string;
      conflictId?: string;
    }
  ) {
    super(message);
    this.operationUuid = options.operationUuid;
    this.targetKey = options.targetKey;
    this.conflictId = options.conflictId;
  }
}

export class SyncFifoGapError extends Error {
  override readonly name = 'SyncFifoGapError';
  readonly operationUuid: string;
  readonly originNodeId: string;
  readonly localSequence: number;
  readonly expectedSequence: number;

  constructor(
    message: string,
    options: {
      operationUuid: string;
      originNodeId: string;
      localSequence: number;
      expectedSequence: number;
    }
  ) {
    super(message);
    this.operationUuid = options.operationUuid;
    this.originNodeId = options.originNodeId;
    this.localSequence = options.localSequence;
    this.expectedSequence = options.expectedSequence;
  }
}
