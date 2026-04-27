import type { Database } from 'bun:sqlite';
import { timingSafeEqual } from 'node:crypto';

import { getOpLogChunkAfter, setPeerCursor } from '../db/sync_schema.js';
import type { SyncOpRecord } from './op_apply.js';
import { compareHlc, type Hlc } from './hlc.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import {
  applyPeerOpsWithPending,
  runPeerSync,
  type PeerSyncOptions,
  type PeerSyncResult,
  type PeerTransport,
} from './peer_sync.js';
import { applyWorkerReturn } from './worker_bundle.js';

export interface HttpPeerTransportOptions {
  baseUrl: string;
  token: string;
  localNodeId: string;
  remoteNodeId?: string;
  fetch?: typeof fetch;
}

export interface RunHttpPeerSyncOptions extends PeerSyncOptions {
  peerNodeId: string;
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface PeerSyncHttpHandlerOptions {
  token: string;
  maxPushBatch?: number;
  maxBodyBytes?: number;
}

const DEFAULT_MAX_PUSH_BATCH = 1000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request: Request, token: string): boolean {
  const provided = extractBearerToken(request);
  return provided !== null && constantTimeEquals(provided, token);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { ...init, headers });
}

async function readJson(request: Request, maxBodyBytes: number): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLength) && parsedLength > maxBodyBytes) {
      throw new HttpRequestError('request body too large', 413);
    }
  }
  // Stream the body and abort once accumulated bytes exceed the limit so peers
  // that omit Content-Length or use chunked transfer can't force unbounded buffering.
  const body = request.body;
  if (body === null) {
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBodyBytes) {
          await reader.cancel().catch(() => {});
          throw new HttpRequestError('request body too large', 413);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(merged);
  if (text.trim().length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function asPeerNodeId(url: URL): string {
  const peerNodeId = url.searchParams.get('peer_node_id');
  if (!peerNodeId) {
    throw new Error('Missing peer_node_id');
  }
  if (!UUID_PATTERN.test(peerNodeId)) {
    throw new Error('Invalid peer_node_id');
  }
  return peerNodeId;
}

function asLimit(url: URL): number {
  const rawLimit = url.searchParams.get('limit');
  if (!rawLimit) {
    return 500;
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid limit: ${rawLimit}`);
  }
  return limit;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readOpsBody(value: unknown): SyncOpRecord[] {
  const opsValue = Array.isArray(value) ? value : isObject(value) ? value.ops : null;
  if (!Array.isArray(opsValue)) {
    throw new Error('Expected request body to be an array of sync operations');
  }
  return opsValue as SyncOpRecord[];
}

function opHlc(op: SyncOpRecord): Hlc {
  return { physicalMs: op.hlc_physical_ms, logical: op.hlc_logical };
}

function validatePushOpShape(op: unknown): string | null {
  if (!isObject(op)) return 'invalid_op_shape';
  if (typeof op.op_id !== 'string' || op.op_id.length === 0) return 'invalid_op_id';
  if (typeof op.node_id !== 'string') return 'invalid_node_id';
  if (
    typeof op.hlc_physical_ms !== 'number' ||
    !Number.isSafeInteger(op.hlc_physical_ms) ||
    typeof op.hlc_logical !== 'number' ||
    !Number.isSafeInteger(op.hlc_logical)
  ) {
    return 'invalid_hlc';
  }
  if (
    typeof op.local_counter !== 'number' ||
    !Number.isSafeInteger(op.local_counter) ||
    op.local_counter < 0
  ) {
    return 'invalid_local_counter';
  }
  if (typeof op.entity_type !== 'string') return 'invalid_entity_type';
  if (typeof op.entity_id !== 'string') return 'invalid_entity_id';
  if (typeof op.op_type !== 'string') return 'invalid_op_type';
  if (typeof op.payload !== 'string') return 'invalid_payload';
  return null;
}

function validatePushedOps(
  ops: SyncOpRecord[],
  peerNodeId: string,
  localNodeId: string
): string | null {
  let previousOwnOp: SyncOpRecord | null = null;
  for (const op of ops) {
    const shapeError = validatePushOpShape(op);
    if (shapeError) {
      return shapeError;
    }
    if (op.node_id === localNodeId) {
      return 'forged_local_node';
    }
    if (op.node_id !== peerNodeId) {
      continue;
    }
    if (previousOwnOp) {
      const hlcCompare = compareHlc(opHlc(previousOwnOp), opHlc(op));
      if (hlcCompare > 0 || (hlcCompare === 0 && op.local_counter <= previousOwnOp.local_counter)) {
        return 'non_contiguous_batch';
      }
    }
    previousOwnOp = op;
  }
  return null;
}

function parseCursorSeq(seqText: string | null | undefined): number {
  if (!seqText) return 0;
  const seq = Number.parseInt(seqText, 10);
  return Number.isSafeInteger(seq) && seq >= 0 && String(seq) === seqText ? seq : 0;
}

function snapshotAlreadyKnownOpIds(
  db: Database,
  peerNodeId: string,
  ops: SyncOpRecord[]
): Set<string> {
  const ownOpIds = ops.filter((op) => op.node_id === peerNodeId).map((op) => op.op_id);
  if (ownOpIds.length === 0) {
    return new Set();
  }
  const placeholders = ownOpIds.map(() => '?').join(',');
  const known = new Set<string>();
  const opLogRows = db
    .prepare(`SELECT op_id FROM sync_op_log WHERE op_id IN (${placeholders})`)
    .all(...ownOpIds) as { op_id: string }[];
  for (const row of opLogRows) {
    known.add(row.op_id);
  }
  const pendingRows = db
    .prepare(
      `SELECT op_id FROM sync_pending_op WHERE peer_node_id = ? AND op_id IN (${placeholders})`
    )
    .all(peerNodeId, ...ownOpIds) as { op_id: string }[];
  for (const row of pendingRows) {
    known.add(row.op_id);
  }
  return known;
}

function advancePushCursorByAcceptedOwnOps(
  db: Database,
  peerNodeId: string,
  ops: SyncOpRecord[],
  alreadyKnownOpIds: Set<string>
): void {
  const newlyAcceptedOwnOps = ops.filter(
    (op) => op.node_id === peerNodeId && !alreadyKnownOpIds.has(op.op_id)
  );
  if (newlyAcceptedOwnOps.length === 0) {
    return;
  }
  const existing = db
    .prepare('SELECT last_op_id FROM sync_peer_cursor WHERE peer_node_id = ? AND direction = ?')
    .get(peerNodeId, 'pull') as { last_op_id: string | null } | null;
  const nextSeq = parseCursorSeq(existing?.last_op_id) + newlyAcceptedOwnOps.length;
  setPeerCursor(db, peerNodeId, 'pull', nextSeq.toString(), newlyAcceptedOwnOps.at(-1));
}

function requestUrl(baseUrl: string, pathname: string): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${pathname}`;
  return url;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function httpError(endpoint: string, response: Response, body: unknown): Error {
  const message =
    isObject(body) && typeof body.error === 'string' ? body.error : response.statusText;
  return new Error(`Peer sync ${endpoint} failed with HTTP ${response.status}: ${message}`);
}

export function createHttpPeerTransport(options: HttpPeerTransportOptions): PeerTransport {
  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
  };

  return {
    async pullChunk(afterSeq, limit) {
      const url = requestUrl(options.baseUrl, '/sync/pull');
      url.searchParams.set('peer_node_id', options.localNodeId);
      url.searchParams.set('limit', String(limit));
      if (afterSeq) {
        url.searchParams.set('after_seq', afterSeq);
      }

      const response = await fetchImpl(url, { method: 'POST', headers });
      const body = await parseJsonResponse(response);
      if (!response.ok) {
        throw httpError('/sync/pull', response, body);
      }
      if (!isObject(body) || !Array.isArray(body.ops)) {
        throw new Error('Peer sync /sync/pull returned an invalid response body');
      }
      return {
        ops: body.ops as SyncOpRecord[],
        nextAfterSeq:
          typeof body.nextAfterSeq === 'string' || body.nextAfterSeq === null
            ? body.nextAfterSeq
            : null,
        hasMore: body.hasMore === true,
      };
    },

    async pushChunk(ops, pushOptions) {
      const url = requestUrl(options.baseUrl, '/sync/push');
      url.searchParams.set('peer_node_id', options.localNodeId);
      if (pushOptions?.final === true) {
        url.searchParams.set('final', '1');
      }
      const pushedOps = options.remoteNodeId
        ? ops.filter((op) => op.node_id !== options.remoteNodeId)
        : ops;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ops: pushedOps }),
      });
      const body = await parseJsonResponse(response);
      if (!response.ok) {
        throw httpError('/sync/push', response, body);
      }
      return isObject(body) ? body : {};
    },
  };
}

export async function runHttpPeerSync(
  db: Database,
  options: RunHttpPeerSyncOptions
): Promise<PeerSyncResult> {
  const localNodeId = getLocalNodeId(db);
  const transport = createHttpPeerTransport({
    baseUrl: options.baseUrl,
    token: options.token,
    localNodeId,
    remoteNodeId: options.peerNodeId,
    fetch: options.fetch,
  });
  return runPeerSync(db, options.peerNodeId, transport, options);
}

export function createPeerSyncHttpHandler(
  db: Database,
  options: PeerSyncHttpHandlerOptions
): (request: Request) => Response | Promise<Response> {
  const maxPushBatch = options.maxPushBatch ?? DEFAULT_MAX_PUSH_BATCH;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request: Request): Promise<Response> => {
    if (!isAuthorized(request, options.token)) {
      return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method Not Allowed' }, { status: 405 });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/sync/pull') {
        const peerNodeId = asPeerNodeId(url);
        registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'transient' });
        // Pull is read-only from the server's perspective. The pulling client
        // advances its local pull-from-server cursor after successful apply.
        const afterSeq = url.searchParams.get('after_seq') ?? url.searchParams.get('after_op_id');
        const chunk = getOpLogChunkAfter(db, afterSeq, asLimit(url));
        return jsonResponse(chunk);
      }

      if (url.pathname === '/sync/push') {
        const peerNodeId = asPeerNodeId(url);
        const peerNode = registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'transient' });
        const ops = readOpsBody(await readJson(request, maxBodyBytes));
        const final = url.searchParams.get('final') === '1';
        if (ops.length > maxPushBatch) {
          return jsonResponse({ error: 'push batch too large' }, { status: 413 });
        }
        const pushedOpsError = validatePushedOps(ops, peerNodeId, getLocalNodeId(db));
        if (pushedOpsError) {
          return jsonResponse({ error: pushedOpsError }, { status: 400 });
        }
        if (peerNode.node_type === 'worker' || peerNode.node_type === 'retired_worker') {
          let workerResult;
          try {
            workerResult = applyWorkerReturn(db, ops, { workerNodeId: peerNodeId, final });
          } catch {
            return jsonResponse({ error: 'apply failed' }, { status: 500 });
          }
          if (workerResult.rejection) {
            return jsonResponse(
              { error: `lease_${workerResult.rejection.reason}` },
              { status: 409 }
            );
          }
          return jsonResponse({
            pendingOpCount: workerResult.pendingOpCount,
            leaseCompleted: workerResult.leaseCompleted,
          });
        }
        if (final) {
          return jsonResponse({ error: 'final_signal_requires_worker_lease' }, { status: 409 });
        }
        // Snapshot which own op_ids are already known (in sync_op_log or
        // sync_pending_op) BEFORE the apply, so replays of already-applied or
        // already-deferred ops cannot drift the push cursor forward.
        const alreadyKnownOpIds = snapshotAlreadyKnownOpIds(db, peerNodeId, ops);
        let applyResult;
        try {
          applyResult = applyPeerOpsWithPending(db, peerNodeId, ops);
        } catch {
          return jsonResponse({ error: 'apply failed' }, { status: 500 });
        }
        const deferredSkips = applyResult.skipped.filter((skip) => skip.kind === 'deferred').length;

        // Push advances the server's pull-from-pusher cursor after deferred
        // skips have been persisted into sync_pending_op for retry. Server-side
        // pull requests never advance any server cursor.
        advancePushCursorByAcceptedOwnOps(db, peerNodeId, ops, alreadyKnownOpIds);
        return jsonResponse({
          applied: applyResult.applied,
          skipped: applyResult.skipped.length,
          deferredSkips,
        });
      }
    } catch (error) {
      if (error instanceof HttpRequestError) {
        return jsonResponse({ error: error.message }, { status: error.status });
      }
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }

    return jsonResponse({ error: 'Not Found' }, { status: 404 });
  };
}
