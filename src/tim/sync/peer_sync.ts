import type { Database } from 'bun:sqlite';

import {
  deletePendingOp,
  getOpLogChunkAfter,
  getPeerCursor,
  listPendingOps,
  setPeerCursor,
  upsertPendingOp,
  type OpLogChunk,
} from '../db/sync_schema.js';
import { registerPeerNode } from './node_identity.js';
import {
  applyRemoteOps,
  type ApplyResult,
  type SkippedSyncOp,
  type SyncOpRecord,
} from './op_apply.js';

export const DEFAULT_PEER_SYNC_BATCH_SIZE = 500;

export interface PullResponse {
  ops: SyncOpRecord[];
  nextAfterSeq: string | null;
  hasMore: boolean;
}

export interface PushResponse {
  applied?: number;
  /**
   * Skips reported by the receiver. This count includes deferred skips;
   * `deferredSkips` is the deferred subset.
   */
  skipped?: number;
  /**
   * Deferred skips reported by the receiver after they have been durably
   * recorded for retry. The sender may still advance its push cursor.
   */
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

function countDurableOps(result: ApplyResult): number {
  return result.applied + result.skipped.filter((skip) => skip.kind === 'permanent').length;
}

function mergeApplyResults(chunkResult: ApplyResult, retryResult: ApplyResult): ApplyResult {
  return {
    applied: chunkResult.applied + retryResult.applied,
    skipped: [
      ...chunkResult.skipped.filter((skip) => skip.kind !== 'deferred'),
      ...retryResult.skipped,
    ],
    errors: [...chunkResult.errors, ...retryResult.errors],
  };
}

function chunkLastSeq(chunk: OpLogChunk): string | null {
  return chunk.ops.at(-1)?.seq?.toString() ?? chunk.nextAfterSeq;
}

function pendingOpJson(op: SyncOpRecord): string {
  return JSON.stringify(op);
}

function persistDeferredOps(
  db: Database,
  peerNodeId: string,
  ops: SyncOpRecord[],
  skipped: SkippedSyncOp[]
): void {
  const deferredIds = new Set(
    skipped.filter((skip) => skip.kind === 'deferred').map((skip) => skip.opId)
  );
  if (deferredIds.size === 0) return;
  const byId = new Map(ops.map((op) => [op.op_id, op]));
  const persist = db.transaction((ids: Set<string>): void => {
    for (const opId of ids) {
      const op = byId.get(opId);
      if (!op) continue;
      upsertPendingOp(db, peerNodeId, op, pendingOpJson(op));
    }
  });
  persist.immediate(deferredIds);
}

export function applyPeerOpsWithPending(
  db: Database,
  peerNodeId: string,
  ops: SyncOpRecord[]
): ApplyResult {
  const result = applyRemoteOps(db, ops);
  assertApplySucceeded(result);
  persistDeferredOps(db, peerNodeId, ops, result.skipped);
  // Receiver-side pending retries run after every pushed chunk. This lets a
  // pure receiver converge when chunk N satisfies a deferred op from chunk N-1.
  const retryResult = retryPendingOps(db, peerNodeId);
  return mergeApplyResults(result, retryResult);
}

function parsePendingOp(row: { op_id: string; op_json: string }): SyncOpRecord | null {
  try {
    const parsed = JSON.parse(row.op_json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as SyncOpRecord;
  } catch {
    return null;
  }
}

function retryPendingOps(db: Database, peerNodeId: string): ApplyResult {
  const rows = listPendingOps(db, peerNodeId);
  const ops: SyncOpRecord[] = [];
  const corruptOpIds: string[] = [];
  for (const row of rows) {
    const op = parsePendingOp(row);
    if (op) {
      ops.push(op);
    } else {
      corruptOpIds.push(row.op_id);
    }
  }
  for (const opId of corruptOpIds) {
    deletePendingOp(db, peerNodeId, opId);
  }
  if (ops.length === 0) {
    return { applied: 0, skipped: [], errors: [] };
  }

  const result = applyRemoteOps(db, ops);
  assertApplySucceeded(result);
  const stillDeferred = new Set(
    result.skipped.filter((skip) => skip.kind === 'deferred').map((skip) => skip.opId)
  );
  const cleanup = db.transaction((appliedOps: SyncOpRecord[]): void => {
    for (const op of appliedOps) {
      if (!stillDeferred.has(op.op_id)) {
        deletePendingOp(db, peerNodeId, op.op_id);
      }
    }
  });
  cleanup.immediate(ops);
  persistDeferredOps(db, peerNodeId, ops, result.skipped);
  return result;
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

  const initialPending = retryPendingOps(db, peerNodeId);
  result.pulledOps += countDurableOps(initialPending);

  // Cursor invariant: transport cursors advance after received chunks have
  // either landed durably, permanently skipped with an op-log dedup row, or
  // been persisted into sync_pending_op for later retry.
  let pullAfter = getPeerCursor(db, peerNodeId, 'pull')?.last_op_id ?? null;
  while (true) {
    const response = await transport.pullChunk(pullAfter, batchSize);
    if (response.ops.length === 0) {
      break;
    }

    const applyResult = applyPeerOpsWithPending(db, peerNodeId, response.ops);
    result.pulledOps += countDurableOps(applyResult);
    result.pullChunks += 1;
    if (!response.nextAfterSeq) {
      throw new Error('Peer pull response included ops but no next cursor');
    }
    setPeerCursor(db, peerNodeId, 'pull', response.nextAfterSeq, response.ops.at(-1));

    pullAfter = response.nextAfterSeq;

    if (!response.hasMore) {
      break;
    }
  }

  const finalPending = retryPendingOps(db, peerNodeId);
  result.pulledOps += countDurableOps(finalPending);

  let pushAfter = getPeerCursor(db, peerNodeId, 'push')?.last_op_id ?? null;
  while (true) {
    const chunk = getOpLogChunkAfter(db, pushAfter, batchSize);
    if (chunk.ops.length === 0) {
      break;
    }

    const pushResponse = await transport.pushChunk(chunk.ops as SyncOpRecord[]);
    const deferredSkips = pushResponse.deferredSkips ?? 0;
    result.pushedOps +=
      pushResponse.applied !== undefined || pushResponse.skipped !== undefined
        ? (pushResponse.applied ?? 0) + (pushResponse.skipped ?? 0) - deferredSkips
        : deferredSkips > 0
          ? 0
          : chunk.ops.length;
    result.pushChunks += 1;
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
