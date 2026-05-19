import type { CanonicalSnapshot } from './snapshots.js';
import type { SyncOperationBatchEnvelope, SyncOperationEnvelope } from './types.js';
import {
  SyncBatchResultFrameSchema,
  SyncCatchUpResponseFrameSchema,
  SyncOpResultFrameSchema,
  SyncSnapshotResponseFrameSchema,
  type SyncCatchUpInvalidation,
  type SyncOperationResult,
} from './ws_protocol.js';
import { assertOk, authHeaders, isConnectionError, syncUrl, toError } from './http_utils.js';

export type HttpSyncResult<T> =
  | { ok: true; value: T }
  | { ok: false; retryable: true; error: Error };

export interface HttpOperationFlushResult {
  results: SyncOperationResult[];
  currentSequenceId: number;
}

export interface HttpSnapshotFetchResult {
  snapshots: CanonicalSnapshot[];
  currentSequenceId: number;
}

export interface HttpCatchUpResult {
  invalidations: SyncCatchUpInvalidation[];
  currentSequenceId: number;
}

export async function httpFlushOperations(
  serverUrl: string,
  token: string,
  nodeId: string,
  ops: SyncOperationEnvelope[]
): Promise<HttpSyncResult<HttpOperationFlushResult>> {
  const url = syncUrl(serverUrl, 'internal/sync/operations');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token, nodeId, { 'content-type': 'application/json' }),
      body: JSON.stringify({ operations: ops }),
    });
    await assertOk(response, url);
    const payload = await response.json();
    const parsed = SyncOpResultFrameSchema.extend({
      currentSequenceId: SyncCatchUpResponseFrameSchema.shape.currentSequenceId,
    }).parse({ type: 'op_result', ...(payload as object) });
    return {
      ok: true,
      value: { results: parsed.results, currentSequenceId: parsed.currentSequenceId },
    };
  } catch (err) {
    if (isConnectionError(err)) {
      return { ok: false, retryable: true, error: toError(err) };
    }
    throw err;
  }
}

export async function httpFlushBatch(
  serverUrl: string,
  token: string,
  nodeId: string,
  batch: SyncOperationBatchEnvelope
): Promise<HttpSyncResult<HttpOperationFlushResult>> {
  const url = syncUrl(serverUrl, 'internal/sync/operations');
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: authHeaders(token, nodeId, { 'content-type': 'application/json' }),
      body: JSON.stringify({ batch }),
    });
    await assertOk(response, url);
    const payload = await response.json();
    const parsed = SyncBatchResultFrameSchema.extend({
      currentSequenceId: SyncCatchUpResponseFrameSchema.shape.currentSequenceId,
    }).parse({ type: 'batch_result', ...(payload as object) });
    return {
      ok: true,
      value: { results: parsed.results, currentSequenceId: parsed.currentSequenceId },
    };
  } catch (err) {
    if (isConnectionError(err)) {
      return { ok: false, retryable: true, error: toError(err) };
    }
    throw err;
  }
}

export async function httpFetchSnapshots(
  serverUrl: string,
  token: string,
  nodeId: string,
  keys: string[]
): Promise<HttpSyncResult<HttpSnapshotFetchResult>> {
  const url = syncUrl(serverUrl, 'internal/sync/snapshots');
  for (const key of keys) {
    url.searchParams.append('keys', key);
  }
  try {
    const response = await fetch(url, { headers: authHeaders(token, nodeId) });
    await assertOk(response, url);
    const payload = await response.json();
    const parsed = SyncSnapshotResponseFrameSchema.extend({
      currentSequenceId: SyncCatchUpResponseFrameSchema.shape.currentSequenceId,
    }).parse({ type: 'snapshot_response', requestId: 'http', ...(payload as object) });
    return {
      ok: true,
      value: { snapshots: parsed.snapshots, currentSequenceId: parsed.currentSequenceId },
    };
  } catch (err) {
    if (isConnectionError(err)) {
      return { ok: false, retryable: true, error: toError(err) };
    }
    throw err;
  }
}

export async function httpCatchUp(
  serverUrl: string,
  token: string,
  nodeId: string,
  sinceSequenceId: number
): Promise<HttpSyncResult<HttpCatchUpResult>> {
  const url = syncUrl(serverUrl, 'internal/sync/catch-up');
  url.searchParams.set('sinceSequenceId', String(sinceSequenceId));
  try {
    const response = await fetch(url, { headers: authHeaders(token, nodeId) });
    await assertOk(response, url);
    const payload = await response.json();
    const parsed = SyncCatchUpResponseFrameSchema.parse({
      type: 'catch_up_response',
      ...(payload as object),
    });
    return {
      ok: true,
      value: {
        invalidations: parsed.invalidations,
        currentSequenceId: parsed.currentSequenceId,
      },
    };
  } catch (err) {
    if (isConnectionError(err)) {
      return { ok: false, retryable: true, error: toError(err) };
    }
    throw err;
  }
}
