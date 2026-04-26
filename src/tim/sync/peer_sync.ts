import type { Database } from 'bun:sqlite';

import {
  getOpLogChunkAfter,
  getPeerCursor,
  setPeerCursor,
  type OpLogChunk,
} from '../db/sync_schema.js';
import { registerPeerNode } from './node_identity.js';
import { applyRemoteOps, type ApplyResult, type SyncOpRecord } from './op_apply.js';

export const DEFAULT_PEER_SYNC_BATCH_SIZE = 500;

export interface PullResponse {
  ops: SyncOpRecord[];
  nextAfterSeq: string | null;
  hasMore: boolean;
}

export interface PushResponse {
  applied?: number;
  skipped?: number;
  deferredSkips?: number;
}

export interface PeerTransport {
  pullChunk(afterSeq: string | null, limit: number): Promise<PullResponse>;
  pushChunk(ops: SyncOpRecord[]): Promise<PushResponse>;
}

export interface PeerSyncOptions {
  batchSize?: number;
}

export interface PeerSyncResult {
  pulledOps: number;
  pushedOps: number;
  pullChunks: number;
  pushChunks: number;
}

function normalizeBatchSize(batchSize: number | undefined): number {
  const resolved = batchSize ?? DEFAULT_PEER_SYNC_BATCH_SIZE;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`Invalid peer sync batch size: ${resolved}`);
  }
  return resolved;
}

function assertApplySucceeded(result: ApplyResult): void {
  if (result.errors.length === 0) return;
  const first = result.errors[0];
  throw new Error(`Failed to apply sync op ${first?.opId ?? '(unknown)'}: ${first?.message}`);
}

function countDeferredSkips(result: ApplyResult): number {
  return result.skipped.filter((skip) => skip.kind === 'deferred').length;
}

function chunkLastSeq(chunk: OpLogChunk): string | null {
  return chunk.ops.at(-1)?.seq?.toString() ?? chunk.nextAfterSeq;
}

export async function runPeerSync(
  db: Database,
  peerNodeId: string,
  transport: PeerTransport,
  options: PeerSyncOptions = {}
): Promise<PeerSyncResult> {
  const batchSize = normalizeBatchSize(options.batchSize);
  registerPeerNode(db, { nodeId: peerNodeId, nodeType: 'main' });

  const result: PeerSyncResult = {
    pulledOps: 0,
    pushedOps: 0,
    pullChunks: 0,
    pushChunks: 0,
  };

  // Cursor invariant: transport cursors advance only after the received chunk is
  // durably applied. Permanent skipped ops are recorded for dedup and count as
  // durable. Deferred skips intentionally roll back their op-log row, so the
  // cursor stays put and a later sync can redeliver them after dependencies
  // arrive.
  let pullAfter = getPeerCursor(db, peerNodeId, 'pull')?.last_op_id ?? null;
  while (true) {
    const response = await transport.pullChunk(pullAfter, batchSize);
    if (response.ops.length === 0) {
      break;
    }

    const applyResult = applyRemoteOps(db, response.ops);
    assertApplySucceeded(applyResult);
    const deferredSkips = countDeferredSkips(applyResult);
    result.pulledOps += deferredSkips > 0 ? applyResult.applied : response.ops.length;
    result.pullChunks += 1;
    if (deferredSkips > 0) {
      break;
    }
    if (!response.nextAfterSeq) {
      throw new Error('Peer pull response included ops but no next cursor');
    }
    setPeerCursor(db, peerNodeId, 'pull', response.nextAfterSeq, response.ops.at(-1));

    pullAfter = response.nextAfterSeq;

    if (!response.hasMore) {
      break;
    }
  }

  let pushAfter = getPeerCursor(db, peerNodeId, 'push')?.last_op_id ?? null;
  while (true) {
    const chunk = getOpLogChunkAfter(db, pushAfter, batchSize);
    if (chunk.ops.length === 0) {
      break;
    }

    const pushResponse = await transport.pushChunk(chunk.ops as SyncOpRecord[]);
    const deferredSkips = pushResponse.deferredSkips ?? 0;
    result.pushedOps += deferredSkips > 0 ? (pushResponse.applied ?? 0) : chunk.ops.length;
    result.pushChunks += 1;
    if (deferredSkips > 0) {
      break;
    }
    const lastSeq = chunkLastSeq(chunk);
    if (!lastSeq) {
      throw new Error('Local push chunk included ops but no next cursor');
    }
    setPeerCursor(db, peerNodeId, 'push', lastSeq, chunk.ops.at(-1));

    pushAfter = lastSeq;

    if (!chunk.hasMore) {
      break;
    }
  }

  return result;
}
