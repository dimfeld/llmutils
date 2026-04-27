import { describe, expect, test } from 'vitest';
import { SyncConflictError, SyncRetryableNetworkError, SyncValidationError } from './errors.js';
import { SyncOperationPayloadSchema } from './types.js';

describe('sync error classes', () => {
  test('SyncValidationError is instanceof Error with correct name', () => {
    const err = new SyncValidationError('bad payload', { issues: [] });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SyncValidationError');
    expect(err.message).toBe('bad payload');
    expect(err.issues).toEqual([]);
    expect(err.operationUuid).toBeUndefined();
  });

  test('SyncValidationError carries Zod issues from a real parse failure', () => {
    let issues: import('zod/v4').ZodIssue[] = [];
    const result = SyncOperationPayloadSchema.safeParse({
      type: 'plan.add_tag',
      planUuid: 'not-a-uuid',
      tag: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      issues = result.error.issues;
    }
    expect(issues.length).toBeGreaterThan(0);

    const err = new SyncValidationError('failed', { operationUuid: 'op-1', issues });
    expect(err.issues).toHaveLength(issues.length);
    expect(err.operationUuid).toBe('op-1');
    expect(err.issues[0]).toHaveProperty('message');
  });

  test('SyncConflictError is instanceof Error with correct name and fields', () => {
    const err = new SyncConflictError('conflict on title', {
      operationUuid: 'op-uuid-1',
      targetKey: 'plan:22222222-2222-4222-8222-222222222222',
      baseRevision: 3,
      currentRevision: 5,
      currentValueSnippet: 'current title',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SyncConflictError');
    expect(err.message).toBe('conflict on title');
    expect(err.operationUuid).toBe('op-uuid-1');
    expect(err.targetKey).toBe('plan:22222222-2222-4222-8222-222222222222');
    expect(err.baseRevision).toBe(3);
    expect(err.currentRevision).toBe(5);
    expect(err.currentValueSnippet).toBe('current title');
  });

  test('SyncConflictError works with only required fields', () => {
    const err = new SyncConflictError('conflict', {
      operationUuid: 'op-2',
      targetKey: 'plan:22222222-2222-4222-8222-222222222222',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.baseRevision).toBeUndefined();
    expect(err.currentRevision).toBeUndefined();
    expect(err.currentValueSnippet).toBeUndefined();
  });

  test('SyncRetryableNetworkError is instanceof Error with correct name', () => {
    const err = new SyncRetryableNetworkError('connection refused', { httpStatus: 503 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SyncRetryableNetworkError');
    expect(err.message).toBe('connection refused');
    expect(err.httpStatus).toBe(503);
  });

  test('SyncRetryableNetworkError works with no options', () => {
    const err = new SyncRetryableNetworkError('timeout');
    expect(err).toBeInstanceOf(Error);
    expect(err.httpStatus).toBeUndefined();
  });

  test('SyncRetryableNetworkError preserves cause', () => {
    const cause = new TypeError('socket hung up');
    const err = new SyncRetryableNetworkError('network failure', { cause });
    expect(err.cause).toBe(cause);
  });
});
