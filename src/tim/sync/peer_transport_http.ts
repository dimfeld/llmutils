import type { Database } from 'bun:sqlite';
import { timingSafeEqual } from 'node:crypto';

import { getOpLogChunkAfter, setPeerCursor } from '../db/sync_schema.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import {
  runPeerSync,
  type PeerSyncOptions,
  type PeerSyncResult,
  type PeerTransport,
} from './peer_sync.js';

export interface HttpPeerTransportOptions {
  baseUrl: string;
  token: string;
  localNodeId: string;
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

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
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

function sortOps(ops: SyncOpRecord[]): SyncOpRecord[] {
  return [...ops].sort((a, b) => {
    if (a.hlc_physical_ms !== b.hlc_physical_ms) return a.hlc_physical_ms - b.hlc_physical_ms;
    if (a.hlc_logical !== b.hlc_logical) return a.hlc_logical - b.hlc_logical;
    const nodeCompare = a.node_id.localeCompare(b.node_id);
    if (nodeCompare !== 0) return nodeCompare;
    return a.local_counter - b.local_counter;
  });
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
    async pullChunk(afterOpId, limit) {
      const url = requestUrl(options.baseUrl, '/sync/pull');
      url.searchParams.set('peer_node_id', options.localNodeId);
      url.searchParams.set('limit', String(limit));
      if (afterOpId) {
        url.searchParams.set('after_op_id', afterOpId);
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
        nextAfterOpId:
          typeof body.nextAfterOpId === 'string' || body.nextAfterOpId === null
            ? body.nextAfterOpId
            : null,
        hasMore: body.hasMore === true,
      };
    },

    async pushChunk(ops) {
      const url = requestUrl(options.baseUrl, '/sync/push');
      url.searchParams.set('peer_node_id', options.localNodeId);
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ops }),
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
    fetch: options.fetch,
  });
  return runPeerSync(db, options.peerNodeId, transport, options);
}

export function createPeerSyncHttpHandler(
  db: Database,
  options: PeerSyncHttpHandlerOptions
): (request: Request) => Response | Promise<Response> {
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
        registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'main' });
        const chunk = getOpLogChunkAfter(db, url.searchParams.get('after_op_id'), asLimit(url));
        return jsonResponse(chunk);
      }

      if (url.pathname === '/sync/push') {
        const peerNodeId = asPeerNodeId(url);
        registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'main' });
        const ops = readOpsBody(await readJson(request));
        const applyResult = applyRemoteOps(db, ops);
        if (applyResult.errors.length > 0) {
          return jsonResponse(
            { error: applyResult.errors[0]?.message, result: applyResult },
            { status: 500 }
          );
        }

        const lastOp = sortOps(ops).at(-1);
        if (lastOp) {
          setPeerCursor(db, peerNodeId, 'pull', lastOp.op_id);
        }
        return jsonResponse({
          applied: applyResult.applied,
          skipped: applyResult.skipped.length,
        });
      }
    } catch (error) {
      return jsonResponse(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      );
    }

    return jsonResponse({ error: 'Not Found' }, { status: 404 });
  };
}
