import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  getOpLogChunkAfter,
  getPeerCursor,
  setPeerCursor,
  type OpLogChunk,
} from '../db/sync_schema.js';
import { getOrCreateProject } from '../db/project.js';
import { getPlanByUuid, upsertPlan } from '../db/plan.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import { runPeerSync, type PeerTransport } from './peer_sync.js';
import {
  createHttpPeerTransport,
  createPeerSyncHttpHandler,
  runHttpPeerSync,
} from './peer_transport_http.js';

function sortOps(ops: SyncOpRecord[]): SyncOpRecord[] {
  return [...ops].sort((a, b) => {
    if (a.hlc_physical_ms !== b.hlc_physical_ms) return a.hlc_physical_ms - b.hlc_physical_ms;
    if (a.hlc_logical !== b.hlc_logical) return a.hlc_logical - b.hlc_logical;
    const nodeCompare = a.node_id.localeCompare(b.node_id);
    if (nodeCompare !== 0) return nodeCompare;
    return a.local_counter - b.local_counter;
  });
}

function directTransport(remoteDb: Database, localNodeId: string): PeerTransport {
  registerPeerNode(remoteDb, { nodeId: localNodeId, nodeType: 'main' });
  return {
    async pullChunk(afterOpId, limit) {
      return getOpLogChunkAfter(remoteDb, afterOpId, limit);
    },
    async pushChunk(ops) {
      const result = applyRemoteOps(remoteDb, ops);
      if (result.errors.length > 0) {
        throw new Error(result.errors[0]?.message ?? 'apply failed');
      }
      const lastOp = sortOps(ops).at(-1);
      if (lastOp) {
        setPeerCursor(remoteDb, localNodeId, 'pull', lastOp.op_id);
      }
      return { applied: result.applied, skipped: result.skipped.length };
    },
  };
}

function opCount(db: Database): number {
  return (db.prepare('SELECT count(*) AS count FROM sync_op_log').get() as { count: number }).count;
}

describe('peer sync transport core', () => {
  let tempDir: string;
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-peer-sync-test-'));
    dbA = openDatabase(path.join(tempDir, 'a', DATABASE_FILENAME));
    dbB = openDatabase(path.join(tempDir, 'b', DATABASE_FILENAME));
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(async () => {
    dbA.close(false);
    dbB.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('runs a pull-then-push cycle and converges both peers', async () => {
    upsertPlan(dbA, projectA, {
      uuid: 'plan-from-a',
      planId: 1,
      title: 'From A',
      status: 'in_progress',
    });
    upsertPlan(dbB, projectB, {
      uuid: 'plan-from-b',
      planId: 2,
      title: 'From B',
      status: 'pending',
    });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA), { batchSize: 10 });

    expect(result.pulledOps).toBeGreaterThan(0);
    expect(result.pushedOps).toBeGreaterThan(0);
    expect(getPlanByUuid(dbA, 'plan-from-b')?.title).toBe('From B');
    expect(getPlanByUuid(dbB, 'plan-from-a')?.title).toBe('From A');
    expect(opCount(dbA)).toBe(opCount(dbB));
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(dbA, nodeB, 'push')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).not.toBeNull();
  });

  test('resumes cursor-based sync in bounded chunks without wall-clock freshness', async () => {
    upsertPlan(dbB, projectB, { uuid: 'chunked-plan', planId: 3, title: 'v0' });
    for (let i = 1; i <= 6; i += 1) {
      upsertPlan(dbB, projectB, { uuid: 'chunked-plan', planId: 3, title: `v${i}` });
    }

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const pulledChunks: OpLogChunk[] = [];
    const transport = directTransport(dbB, nodeA);
    const originalPull = transport.pullChunk;
    transport.pullChunk = async (afterOpId, limit) => {
      const chunk = await originalPull(afterOpId, limit);
      pulledChunks.push(chunk);
      return chunk;
    };

    const result = await runPeerSync(dbA, nodeB, transport, { batchSize: 2 });

    expect(result.pullChunks).toBeGreaterThan(1);
    expect(pulledChunks.every((chunk) => chunk.ops.length <= 2)).toBe(true);
    expect(getPlanByUuid(dbA, 'chunked-plan')?.title).toBe('v6');
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe(
      getOpLogChunkAfter(dbB, null, 100).nextAfterOpId
    );
  });
});

describe('HTTP peer sync transport', () => {
  let tempDir: string;
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-peer-sync-http-test-'));
    dbA = openDatabase(path.join(tempDir, 'a', DATABASE_FILENAME));
    dbB = openDatabase(path.join(tempDir, 'b', DATABASE_FILENAME));
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(async () => {
    dbA.close(false);
    dbB.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function handlerFetch(token: string): typeof fetch {
    const handler = createPeerSyncHttpHandler(dbB, { token });
    return async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler(request) as Promise<Response>;
    };
  }

  test('syncs over the HTTP handler without opening a socket', async () => {
    upsertPlan(dbA, projectA, { uuid: 'http-a', planId: 1, title: 'HTTP A' });
    upsertPlan(dbB, projectB, { uuid: 'http-b', planId: 2, title: 'HTTP B' });

    const nodeB = getLocalNodeId(dbB);
    const result = await runHttpPeerSync(dbA, {
      peerNodeId: nodeB,
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      fetch: handlerFetch('secret-token'),
    });

    expect(result.pulledOps).toBeGreaterThan(0);
    expect(result.pushedOps).toBeGreaterThan(0);
    expect(getPlanByUuid(dbA, 'http-b')?.title).toBe('HTTP B');
    expect(getPlanByUuid(dbB, 'http-a')?.title).toBe('HTTP A');
  });

  test('surfaces a clear error when bearer auth fails', async () => {
    const nodeB = getLocalNodeId(dbB);
    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'wrong-token',
      localNodeId: getLocalNodeId(dbA),
      fetch: handlerFetch('secret-token'),
    });

    await expect(runPeerSync(dbA, nodeB, transport)).rejects.toThrow(
      'Peer sync /sync/pull failed with HTTP 401: Unauthorized'
    );
  });
});
