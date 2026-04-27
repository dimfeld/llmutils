import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  getOpLogChunkAfter,
  getPeerCursor,
  getWorkerLease,
  setPeerCursor,
  type OpLogChunk,
} from '../db/sync_schema.js';
import { getOrCreateProject } from '../db/project.js';
import { appendPlanTask, getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '../db/plan.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { formatOpId } from './hlc.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import { HLC_MIN_PHYSICAL_MS } from './op_validation.js';
import {
  applyPeerOpsWithPending,
  PeerRetiredError,
  ResyncRequiredError,
  runPeerSync,
  SnapshotResyncLimitError,
  type PeerTransport,
} from './peer_sync.js';
import { setCompactedThroughSeq } from './compaction.js';
import {
  createHttpPeerTransport,
  createPeerSyncHttpHandler,
  runHttpPeerSync,
} from './peer_transport_http.js';
import { exportWorkerBundle, exportWorkerOps, importWorkerBundle } from './worker_bundle.js';
import { pruneEphemeralNodes, retireMainPeer } from './node_lifecycle.js';
import { buildPeerSnapshot } from './snapshot.js';

const fixtureIds = new Map<string, string>();

function id(label: string): string {
  let existing = fixtureIds.get(label);
  if (!existing) {
    existing = randomUUID();
    fixtureIds.set(label, existing);
  }
  return existing;
}

function directTransport(remoteDb: Database, localNodeId: string): PeerTransport {
  registerPeerNode(remoteDb, { nodeId: localNodeId, nodeType: 'main' });
  return {
    async pullChunk(afterSeq, limit) {
      return getOpLogChunkAfter(remoteDb, afterSeq, limit);
    },
    async pushChunk(ops) {
      const result = applyPeerOpsWithPending(remoteDb, localNodeId, ops);
      const deferredSkips = result.skipped.filter((skip) => skip.kind === 'deferred').length;
      const lastPushedOp = ops.reduce<SyncOpRecord | null>((current, op) => {
        if (!Number.isInteger(op.seq) || op.seq < 1) return current;
        if (!current || op.seq > (current.seq ?? 0)) return op;
        return current;
      }, null);
      if (lastPushedOp?.seq) {
        setPeerCursor(remoteDb, localNodeId, 'pull', lastPushedOp.seq.toString(), lastPushedOp);
      }
      return { applied: result.applied, skipped: result.skipped.length, deferredSkips };
    },
    async snapshot() {
      return buildPeerSnapshot(remoteDb);
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
      uuid: id('plan-from-a'),
      planId: 1,
      title: 'From A',
      status: 'in_progress',
    });
    upsertPlan(dbB, projectB, {
      uuid: id('plan-from-b'),
      planId: 2,
      title: 'From B',
      status: 'pending',
    });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA), { batchSize: 10 });

    expect(result.pulledOps).toBeGreaterThan(0);
    expect(result.pushedOps).toBeGreaterThan(0);
    expect(getPlanByUuid(dbA, id('plan-from-b'))?.title).toBe('From B');
    expect(getPlanByUuid(dbB, id('plan-from-a'))?.title).toBe('From A');
    expect(opCount(dbA)).toBe(opCount(dbB));
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(dbA, nodeB, 'push')?.last_op_id).not.toBeNull();
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).not.toBeNull();
  });

  test('resumes cursor-based sync in bounded chunks without wall-clock freshness', async () => {
    upsertPlan(dbB, projectB, { uuid: id('chunked-plan'), planId: 3, title: 'v0' });
    for (let i = 1; i <= 6; i += 1) {
      upsertPlan(dbB, projectB, { uuid: id('chunked-plan'), planId: 3, title: `v${i}` });
    }

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const pulledChunks: OpLogChunk[] = [];
    const transport = directTransport(dbB, nodeA);
    const originalPull = transport.pullChunk;
    transport.pullChunk = async (afterSeq, limit) => {
      const chunk = await originalPull(afterSeq, limit);
      pulledChunks.push(chunk);
      return chunk;
    };

    const result = await runPeerSync(dbA, nodeB, transport, { batchSize: 2 });

    expect(result.pullChunks).toBeGreaterThan(1);
    expect(pulledChunks.every((chunk) => chunk.ops.length <= 2)).toBe(true);
    expect(getPlanByUuid(dbA, id('chunked-plan'))?.title).toBe('v6');
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe(
      getOpLogChunkAfter(dbB, null, 100).nextAfterSeq
    );
  });

  test('seq cursor delivers lower-HLC ops inserted after a peer already pulled a high-HLC op', async () => {
    const dbC = openDatabase(':memory:');
    const projectC = getOrCreateProject(dbC, 'github.com__owner__repo').id;
    try {
      upsertPlan(dbC, projectC, {
        uuid: id('plan-from-c-offline'),
        planId: 30,
        title: 'Offline C',
      });
      upsertPlan(dbA, projectA, {
        uuid: id('plan-from-a-high'),
        planId: 10,
        title: 'High A',
      });

      const nodeA = getLocalNodeId(dbA);
      const nodeB = getLocalNodeId(dbB);
      const nodeC = getLocalNodeId(dbC);
      const oldButValidHlc = { physicalMs: HLC_MIN_PHYSICAL_MS + 1, logical: 0 };
      dbC
        .prepare(
          "UPDATE sync_op_log SET op_id = ?, hlc_physical_ms = ?, hlc_logical = ? WHERE entity_type = 'plan' AND entity_id = ?"
        )
        .run(
          formatOpId(oldButValidHlc, nodeC, 1),
          oldButValidHlc.physicalMs,
          oldButValidHlc.logical,
          id('plan-from-c-offline')
        );

      const firstPull = await runPeerSync(dbB, nodeA, directTransport(dbA, nodeB));
      expect(firstPull.pulledOps).toBeGreaterThan(0);
      expect(getPlanByUuid(dbB, id('plan-from-a-high'))?.title).toBe('High A');
      const bCursorAfterHighA = getPeerCursor(dbB, nodeA, 'pull')?.last_op_id;
      expect(bCursorAfterHighA).toBe(getOpLogChunkAfter(dbA, null, 100).nextAfterSeq);

      const aPullsC = await runPeerSync(dbA, nodeC, directTransport(dbC, nodeA));
      expect(aPullsC.pulledOps).toBeGreaterThan(0);
      const cOpOnA = dbA
        .prepare('SELECT seq, hlc_physical_ms FROM sync_op_log WHERE entity_id = ?')
        .get(id('plan-from-c-offline')) as { seq: number; hlc_physical_ms: number } | null;
      expect(cOpOnA?.hlc_physical_ms).toBe(oldButValidHlc.physicalMs);
      expect(cOpOnA?.seq).toBeGreaterThan(Number(bCursorAfterHighA));

      const secondPull = await runPeerSync(dbB, nodeA, directTransport(dbA, nodeB));
      expect(secondPull.pulledOps).toBeGreaterThan(0);
      expect(getPlanByUuid(dbB, id('plan-from-c-offline'))?.title).toBe('Offline C');
    } finally {
      dbC.close(false);
    }
  });

  test('bounds repeated snapshot resync attempts in one sync run', async () => {
    const nodeB = getLocalNodeId(dbB);
    upsertPlan(dbB, projectB, { uuid: id('snapshot-loop-plan'), planId: 31, title: 'Loop' });
    const snapshot = buildPeerSnapshot(dbB);
    snapshot.highWaterSeq = 10;
    const transport: PeerTransport = {
      async pullChunk() {
        throw new ResyncRequiredError(5, 10);
      },
      async pushChunk() {
        return {};
      },
      async snapshot() {
        return snapshot;
      },
    };

    await expect(runPeerSync(dbA, nodeB, transport)).rejects.toThrow(SnapshotResyncLimitError);
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

  function pushRequest(
    handler: (request: Request) => Response | Promise<Response>,
    peerNodeId: string,
    ops: SyncOpRecord[],
    options: { final?: boolean } = {}
  ): Promise<Response> | Response {
    const url = new URL('http://peer.test/sync/push');
    url.searchParams.set('peer_node_id', peerNodeId);
    if (options.final === true) {
      url.searchParams.set('final', '1');
    } else if (options.final === false) {
      url.searchParams.set('final', '0');
    }
    return handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
        body: JSON.stringify({ ops }),
      })
    );
  }

  function makeWorkerOps(options: { leaseExpiresAt?: string } = {}): {
    workerNodeId: string;
    ops: SyncOpRecord[];
  } {
    upsertPlan(dbB, projectB, {
      uuid: id('worker-target-plan'),
      planId: 50,
      title: 'Worker target',
    });
    const bundle = exportWorkerBundle(dbB, {
      targetPlanUuid: id('worker-target-plan'),
      leaseExpiresAt: options.leaseExpiresAt ?? '2030-01-01T00:00:00.000Z',
    });
    importWorkerBundle(dbA, bundle);
    appendPlanTask(dbA, id('worker-target-plan'), {
      uuid: id('worker-return-task'),
      title: 'Returned task',
      description: 'From worker',
    });
    return { workerNodeId: bundle.worker.nodeId, ops: exportWorkerOps(dbA).ops };
  }

  test('syncs over the HTTP handler without opening a socket', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-a'), planId: 1, title: 'HTTP A' });
    upsertPlan(dbB, projectB, { uuid: id('http-b'), planId: 2, title: 'HTTP B' });

    const nodeB = getLocalNodeId(dbB);
    const result = await runHttpPeerSync(dbA, {
      peerNodeId: nodeB,
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      fetch: handlerFetch('secret-token'),
    });

    expect(result.pulledOps).toBeGreaterThan(0);
    expect(result.pushedOps).toBeGreaterThan(0);
    expect(getPlanByUuid(dbA, id('http-b'))?.title).toBe('HTTP B');
    expect(getPlanByUuid(dbB, id('http-a'))?.title).toBe('HTTP A');
    expect(
      dbB.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(getLocalNodeId(dbA))
    ).toEqual({ node_type: 'transient' });
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

  test('rejects oversized push batches before applying them', async () => {
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token', maxPushBatch: 1 });
    const url = new URL('http://peer.test/sync/push');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ops: [{}, {}] }),
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'push batch too large' });
  });

  test('rejects streamed bodies that exceed maxBodyBytes without Content-Length', async () => {
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token', maxBodyBytes: 256 });
    const url = new URL('http://peer.test/sync/push');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));

    const oversizedPayload = new TextEncoder().encode(
      JSON.stringify({ ops: [{ filler: 'x'.repeat(1024) }] })
    );
    let pushed = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!pushed) {
          controller.enqueue(oversizedPayload);
          pushed = true;
        } else {
          controller.close();
        }
      },
    });

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-token',
          'content-type': 'application/json',
        },
        body: stream,
        // @ts-expect-error duplex is required for streaming bodies in undici/Bun
        duplex: 'half',
      })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'request body too large' });
  });

  test('rejects invalid peer_node_id before registration', async () => {
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const response = await handler(
      new Request('http://peer.test/sync/pull?peer_node_id=not-a-uuid', {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid peer_node_id' });
  });

  test('HTTP pull reports resync_required when cursor is behind compacted history', async () => {
    upsertPlan(dbB, projectB, { uuid: id('compacted-plan'), planId: 80, title: 'Compacted' });
    setCompactedThroughSeq(dbB, 2);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const url = new URL('http://peer.test/sync/pull');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));
    url.searchParams.set('after_seq', '1');

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'resync_required',
      compactedThroughSeq: 2,
      currentHighWaterSeq: expect.any(Number),
    });
  });

  test('HTTP pull reports resync_required for fresh peer after compaction', async () => {
    upsertPlan(dbB, projectB, { uuid: id('compacted-fresh-plan'), planId: 81, title: 'Fresh' });
    setCompactedThroughSeq(dbB, 1);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const url = new URL('http://peer.test/sync/pull');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'resync_required',
      compactedThroughSeq: 1,
    });
  });

  test('HTTP pull accepts a cursor exactly at compacted history', async () => {
    upsertPlan(dbB, projectB, { uuid: id('compacted-equal-plan'), planId: 82, title: 'Equal' });
    setCompactedThroughSeq(dbB, 1);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const url = new URL('http://peer.test/sync/pull');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));
    url.searchParams.set('after_seq', '1');

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ops: expect.any(Array),
      hasMore: expect.any(Boolean),
    });
  });

  test('HTTP pull pages from numeric cursor above compacted history even when cursor row is gone', async () => {
    for (let i = 1; i <= 4; i++) {
      upsertPlan(dbB, projectB, {
        uuid: id(`compacted-gap-plan-${i}`),
        planId: 90 + i,
        title: `Gap ${i}`,
      });
    }
    setCompactedThroughSeq(dbB, 2);
    dbB.prepare('DELETE FROM sync_op_log WHERE seq = 3').run();

    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const url = new URL('http://peer.test/sync/pull');
    url.searchParams.set('peer_node_id', getLocalNodeId(dbA));
    url.searchParams.set('after_seq', '3');

    const response = await handler(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret-token' },
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as OpLogChunk;
    expect(body.ops.every((op) => Number(op.seq) > 3)).toBe(true);
    expect(body.ops.length).toBeGreaterThan(0);
  });

  test('HTTP transport fetches and applies a snapshot when cursor is behind compacted history', async () => {
    upsertPlan(dbB, projectB, { uuid: id('resync-plan'), planId: 90, title: 'Resync' });
    // Advance the cursor for A so it looks like A already pulled seq=1
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    registerPeerNode(dbA, { nodeId: nodeB, nodeType: 'main' });
    setPeerCursor(dbA, nodeB, 'pull', '1', null);
    // Mark seq 2 as compacted on B — anything at or before seq 2 is gone
    setCompactedThroughSeq(dbB, 2);

    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: nodeA,
      fetch: handlerFetch('secret-token'),
    });

    const result = await runPeerSync(dbA, nodeB, transport);

    expect(result.pullChunks).toBe(0);
    expect(getPlanByUuid(dbA, id('resync-plan'))?.title).toBe('Resync');
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe('2');
  });

  test('snapshot resync exits compacted loop when all op rows through the watermark are gone', async () => {
    upsertPlan(dbB, projectB, {
      uuid: id('resync-deleted-ops-plan'),
      planId: 93,
      title: 'Gone ops',
    });
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    registerPeerNode(dbA, { nodeId: nodeB, nodeType: 'main' });
    setPeerCursor(dbA, nodeB, 'pull', '0', null);
    setCompactedThroughSeq(dbB, 1);
    dbB.prepare('DELETE FROM sync_op_log WHERE seq <= 1').run();

    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    let snapshotRequests = 0;
    const fetchFn: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === '/sync/snapshot') {
        snapshotRequests += 1;
      }
      return handler(request) as Promise<Response>;
    };
    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: nodeA,
      remoteNodeId: nodeB,
      fetch: fetchFn,
    });

    await runPeerSync(dbA, nodeB, transport);
    await runPeerSync(dbA, nodeB, transport);

    expect(getPlanByUuid(dbA, id('resync-deleted-ops-plan'))?.title).toBe('Gone ops');
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe('1');
    expect(snapshotRequests).toBe(1);
  });

  test('snapshot resync preserves local fields with newer clocks and pushes them back', async () => {
    const planUuid = id('snapshot-local-wins');
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 91, title: 'remote old' });
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));

    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 91, title: 'local new' });
    setPeerCursor(dbA, nodeB, 'pull', '1', null);
    setCompactedThroughSeq(dbB, 1);

    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: nodeA,
      remoteNodeId: nodeB,
      fetch: handlerFetch('secret-token'),
    });

    await runPeerSync(dbA, nodeB, transport);

    expect(getPlanByUuid(dbA, planUuid)?.title).toBe('local new');
    expect(getPlanByUuid(dbB, planUuid)?.title).toBe('local new');
  });

  test('HTTP push from an unregistered caller registers as transient, not main', async () => {
    const handlerA = createPeerSyncHttpHandler(dbA, { token: 'secret' });
    const nodeB = getLocalNodeId(dbB);
    const url = new URL('http://peer.test/sync/push');
    url.searchParams.set('peer_node_id', nodeB);

    const response = await handlerA(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [] }),
      })
    );

    expect(response.status).toBe(200);
    expect(dbA.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(nodeB)).toEqual({
      node_type: 'transient',
    });
  });

  test('HTTP push does not promote an already-main peer to transient', async () => {
    const nodeB = getLocalNodeId(dbB);
    // Pre-register nodeB as main on dbA (as happens via runPeerSync).
    registerPeerNode(dbA, { nodeId: nodeB, nodeType: 'main' });

    const handlerA = createPeerSyncHttpHandler(dbA, { token: 'secret' });
    const url = new URL('http://peer.test/sync/push');
    url.searchParams.set('peer_node_id', nodeB);

    const response = await handlerA(
      new Request(url, {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify({ ops: [] }),
      })
    );

    expect(response.status).toBe(200);
    // registerPeerNode with transient must not downgrade an existing main.
    expect(dbA.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(nodeB)).toEqual({
      node_type: 'main',
    });
  });

  test('HTTP endpoints reject retired main peers with 410', async () => {
    const nodeA = getLocalNodeId(dbA);
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });
    expect(retireMainPeer(dbB, nodeA)).toEqual({ retired: true, peerNodeId: nodeA });
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    for (const pathname of ['/sync/pull', '/sync/snapshot']) {
      const url = new URL(`http://peer.test${pathname}`);
      url.searchParams.set('peer_node_id', nodeA);
      const response = await handler(
        new Request(url, {
          method: pathname === '/sync/snapshot' ? 'GET' : 'POST',
          headers: { authorization: 'Bearer secret-token' },
        })
      );
      expect(response.status).toBe(410);
      await expect(response.json()).resolves.toEqual({ error: 'peer_retired' });
    }

    const pushResponse = await pushRequest(handler, nodeA, []);
    expect(pushResponse.status).toBe(410);
    await expect(pushResponse.json()).resolves.toEqual({ error: 'peer_retired' });
  });

  test('HTTP transport surfaces retired peers as a typed error', async () => {
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });
    retireMainPeer(dbB, nodeA);

    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'secret-token',
      localNodeId: nodeA,
      fetch: handlerFetch('secret-token'),
    });

    await expect(runPeerSync(dbA, nodeB, transport)).rejects.toThrow(PeerRetiredError);
  });

  test('HTTP worker push with an expired lease returns 409 without applying ops', async () => {
    const { workerNodeId, ops } = makeWorkerOps({
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, workerNodeId, ops);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'lease_expired' });
    expect(getWorkerLease(dbB, workerNodeId)?.status).toBe('expired');
    expect(
      getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)
    ).not.toContain(id('worker-return-task'));
  });

  test('HTTP worker push with a completed lease returns 409 without applying ops', async () => {
    const { workerNodeId, ops } = makeWorkerOps();
    dbB
      .prepare("UPDATE sync_worker_lease SET status = 'completed' WHERE worker_node_id = ?")
      .run(workerNodeId);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, workerNodeId, ops);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'lease_completed' });
    expect(
      getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)
    ).not.toContain(id('worker-return-task'));
  });

  test('late HTTP worker heartbeat after completed lease pruning is rejected', async () => {
    const { workerNodeId, ops } = makeWorkerOps();
    dbB
      .prepare("UPDATE sync_worker_lease SET status = 'completed' WHERE worker_node_id = ?")
      .run(workerNodeId);

    const pruneResult = pruneEphemeralNodes(dbB, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(pruneResult.prunedWorkerNodes).toBe(1);
    expect(
      dbB.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(workerNodeId)
    ).toEqual({ node_type: 'retired_worker' });

    const promoted = registerPeerNode(dbB, { nodeId: workerNodeId, nodeType: 'main' });
    expect(promoted.node_type).toBe('retired_worker');

    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const response = await pushRequest(handler, workerNodeId, ops, { final: false });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'lease_completed' });
    expect(
      dbB.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(workerNodeId)
    ).toEqual({ node_type: 'retired_worker' });
    expect(
      getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)
    ).not.toContain(id('worker-return-task'));
  });

  test('late HTTP worker heartbeat after expired lease pruning is rejected', async () => {
    const { workerNodeId, ops } = makeWorkerOps({
      leaseExpiresAt: '2000-01-01T00:00:00.000Z',
    });

    const pruneResult = pruneEphemeralNodes(dbB, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(pruneResult.expiredLeases).toBe(1);
    expect(pruneResult.prunedWorkerNodes).toBe(1);
    expect(
      dbB.prepare('SELECT node_type FROM sync_node WHERE node_id = ?').get(workerNodeId)
    ).toEqual({ node_type: 'retired_worker' });

    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });
    const response = await pushRequest(handler, workerNodeId, ops, { final: false });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'lease_expired' });
    expect(
      getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)
    ).not.toContain(id('worker-return-task'));
  });

  test("HTTP worker push rejects ops whose node_id doesn't match the worker peer", async () => {
    const { workerNodeId, ops } = makeWorkerOps();
    const spoofedOps = ops.map((op, index) =>
      index === 0 ? { ...op, node_id: '11111111-1111-4111-8111-111111111111' } : op
    );
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, workerNodeId, spoofedOps);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: 'lease_mismatched_node_id' });
    expect(
      getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)
    ).not.toContain(id('worker-return-task'));
  });

  test('HTTP worker heartbeat records return time without completing the lease', async () => {
    const { workerNodeId, ops } = makeWorkerOps();
    dbB
      .prepare('UPDATE sync_worker_lease SET last_returned_at = ? WHERE worker_node_id = ?')
      .run('2000-01-01T00:00:00.000Z', workerNodeId);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, workerNodeId, ops, { final: false });
    const body = (await response.json()) as { pendingOpCount: number; leaseCompleted: boolean };

    expect(response.status).toBe(200);
    expect(body).toEqual({ pendingOpCount: 0, leaseCompleted: false });
    const lease = getWorkerLease(dbB, workerNodeId);
    expect(lease?.status).toBe('active');
    expect(lease?.last_returned_at > '2000-01-01T00:00:00.000Z').toBe(true);
    expect(getPlanTasksByUuid(dbB, id('worker-target-plan')).map((task) => task.uuid)).toContain(
      id('worker-return-task')
    );
  });

  test('HTTP final signal from a non-worker peer returns 409', async () => {
    const nodeA = getLocalNodeId(dbA);
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [], { final: true });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'final_signal_requires_worker_lease',
    });
  });

  test('HTTP push rejects non-contiguous own-node batches without applying them', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-out-of-order'), planId: 20, title: 'v1' });
    upsertPlan(dbA, projectA, { uuid: id('http-out-of-order'), planId: 20, title: 'v2' });
    const nodeA = getLocalNodeId(dbA);
    const ownOps = (getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[]).filter(
      (op) => op.node_id === nodeA
    );
    expect(ownOps.length).toBeGreaterThanOrEqual(2);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [
      { ...ownOps[1]!, seq: 1 },
      { ...ownOps[0]!, seq: 2 },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'non_contiguous_batch' });
    expect(getPlanByUuid(dbB, id('http-out-of-order'))).toBeNull();
    expect(getPeerCursor(dbB, nodeA, 'pull')).toBeNull();
  });

  test('HTTP push accepts strictly increasing own-node batches with local counter gaps', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-gap-a'), planId: 30, title: 'Gap A' });
    upsertPlan(dbA, projectA, { uuid: id('http-gap-b'), planId: 31, title: 'Gap B' });
    const nodeA = getLocalNodeId(dbA);
    const ownOps = (getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[]).filter(
      (op) =>
        op.node_id === nodeA &&
        (op.entity_id === id('http-gap-a') || op.entity_id === id('http-gap-b'))
    );
    expect(ownOps).toHaveLength(2);
    const second = {
      ...ownOps[1]!,
      local_counter: ownOps[0]!.local_counter + 10,
    };
    second.op_id = formatOpId(
      { physicalMs: second.hlc_physical_ms, logical: second.hlc_logical },
      second.node_id,
      second.local_counter
    );
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [ownOps[0]!, second]);

    expect(response.status).toBe(200);
    expect(getPlanByUuid(dbB, id('http-gap-a'))?.title).toBe('Gap A');
    expect(getPlanByUuid(dbB, id('http-gap-b'))?.title).toBe('Gap B');
  });

  test('HTTP push rejects malformed operation shapes with 400', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-malformed'), planId: 32, title: 'Malformed' });
    const nodeA = getLocalNodeId(dbA);
    const op = (getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[]).find(
      (nextOp) => nextOp.entity_id === id('http-malformed')
    );
    expect(op).toBeDefined();
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const objectPayload = await pushRequest(handler, nodeA, [
      { ...op!, payload: { fields: { title: 'Bad' } } } as unknown as SyncOpRecord,
    ]);
    expect(objectPayload.status).toBe(400);
    await expect(objectPayload.json()).resolves.toEqual({ error: 'invalid_payload' });

    const missingOpId = await pushRequest(handler, nodeA, [
      { ...op!, op_id: undefined } as unknown as SyncOpRecord,
    ]);
    expect(missingOpId.status).toBe(400);
    await expect(missingOpId.json()).resolves.toEqual({ error: 'invalid_op_id' });

    const nullNodeId = await pushRequest(handler, nodeA, [
      { ...op!, node_id: null } as unknown as SyncOpRecord,
    ]);
    expect(nullNodeId.status).toBe(400);
    await expect(nullNodeId.json()).resolves.toEqual({ error: 'invalid_node_id' });
  });

  test('HTTP push rejects ops forged as the server local node without applying them', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-forged-local'), planId: 21, title: 'Forged' });
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const op = (getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[]).find(
      (nextOp) => nextOp.entity_id === id('http-forged-local')
    );
    expect(op).toBeDefined();
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [{ ...op!, node_id: nodeB }]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'forged_local_node' });
    expect(getPlanByUuid(dbB, id('http-forged-local'))).toBeNull();
    expect(getPeerCursor(dbB, nodeA, 'pull')).toBeNull();
  });

  test('HTTP push accepts sender-local source seq gaps', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-cursor-gap-1'), planId: 22, title: 'Gap 1' });
    upsertPlan(dbA, projectA, { uuid: id('http-cursor-gap-2'), planId: 23, title: 'Gap 2' });
    const nodeA = getLocalNodeId(dbA);
    const ops = getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[];
    const firstOp = ops.find((op) => op.entity_id === id('http-cursor-gap-1'));
    const secondOp = ops.find((op) => op.entity_id === id('http-cursor-gap-2'));
    expect(firstOp).toBeDefined();
    expect(secondOp).toBeDefined();
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [firstOp!, { ...secondOp!, seq: 99 }]);

    expect(response.status).toBe(200);
    expect(getPlanByUuid(dbB, id('http-cursor-gap-1'))?.title).toBe('Gap 1');
    expect(getPlanByUuid(dbB, id('http-cursor-gap-2'))?.title).toBe('Gap 2');
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('99');
  });

  test('HTTP push rejects non-monotonic sender-local source seq values', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-cursor-monotonic-1'), planId: 24, title: 'One' });
    upsertPlan(dbA, projectA, { uuid: id('http-cursor-monotonic-2'), planId: 25, title: 'Two' });
    const nodeA = getLocalNodeId(dbA);
    const ops = getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[];
    const firstOp = ops.find((op) => op.entity_id === id('http-cursor-monotonic-1'));
    const secondOp = ops.find((op) => op.entity_id === id('http-cursor-monotonic-2'));
    expect(firstOp).toBeDefined();
    expect(secondOp).toBeDefined();
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [
      { ...secondOp!, seq: 99 },
      { ...firstOp!, seq: 1 },
    ]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'non_contiguous_source_seq' });
    expect(getPlanByUuid(dbB, id('http-cursor-monotonic-1'))).toBeNull();
    expect(getPlanByUuid(dbB, id('http-cursor-monotonic-2'))).toBeNull();
    expect(getPeerCursor(dbB, nodeA, 'pull')).toBeNull();
  });

  test('HTTP push applies forwarded ops and advances the sender-local cursor', async () => {
    upsertPlan(dbA, projectA, {
      uuid: id('http-cursor-forwarded-own-1'),
      planId: 26,
      title: 'Own 1',
    });
    upsertPlan(dbA, projectA, {
      uuid: id('http-cursor-forwarded-own-2'),
      planId: 27,
      title: 'Own 2',
    });
    const nodeA = getLocalNodeId(dbA);
    const nodeC = randomUUID();
    const ops = getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[];
    const firstOwnOp = ops.find((op) => op.entity_id === id('http-cursor-forwarded-own-1'));
    const secondOwnOp = ops.find((op) => op.entity_id === id('http-cursor-forwarded-own-2'));
    expect(firstOwnOp).toBeDefined();
    expect(secondOwnOp).toBeDefined();
    const forwardedHlc = { physicalMs: Date.now(), logical: 0 };
    const forwardedOp: SyncOpRecord = {
      op_id: formatOpId(forwardedHlc, nodeC, 1),
      node_id: nodeC,
      hlc_physical_ms: forwardedHlc.physicalMs,
      hlc_logical: forwardedHlc.logical,
      local_counter: 1,
      entity_type: 'plan',
      entity_id: id('http-cursor-forwarded-c'),
      op_type: 'create',
      payload: JSON.stringify({
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 28,
        fields: { title: 'Forwarded C' },
      }),
      base: null,
      seq: 2,
    };
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [
      { ...firstOwnOp!, seq: 1 },
      forwardedOp,
      { ...secondOwnOp!, seq: 3 },
    ]);

    expect(response.status).toBe(200);
    expect(getPlanByUuid(dbB, id('http-cursor-forwarded-own-1'))?.title).toBe('Own 1');
    expect(getPlanByUuid(dbB, id('http-cursor-forwarded-c'))?.title).toBe('Forwarded C');
    expect(getPlanByUuid(dbB, id('http-cursor-forwarded-own-2'))?.title).toBe('Own 2');
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('3');
  });

  test('HTTP push advances cursor for already-known forwarded-only chunks', async () => {
    const nodeA = getLocalNodeId(dbA);
    const nodeC = randomUUID();
    const forwardedHlc = { physicalMs: Date.now(), logical: 0 };
    const forwardedOp: SyncOpRecord = {
      op_id: formatOpId(forwardedHlc, nodeC, 1),
      node_id: nodeC,
      hlc_physical_ms: forwardedHlc.physicalMs,
      hlc_logical: forwardedHlc.logical,
      local_counter: 1,
      entity_type: 'plan',
      entity_id: id('http-cursor-known-forwarded-c'),
      op_type: 'create',
      payload: JSON.stringify({
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 29,
        fields: { title: 'Known forwarded C' },
      }),
      base: null,
      seq: 7,
    };
    applyRemoteOps(dbB, [forwardedOp]);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const response = await pushRequest(handler, nodeA, [forwardedOp]);

    expect(response.status).toBe(200);
    expect(getPlanByUuid(dbB, id('http-cursor-known-forwarded-c'))?.title).toBe(
      'Known forwarded C'
    );
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('7');
  });

  test('setPeerCursor does not regress stored seq cursors', () => {
    const nodeA = getLocalNodeId(dbA);
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });

    setPeerCursor(dbB, nodeA, 'pull', '5', null);
    setPeerCursor(dbB, nodeA, 'pull', '3', null);
    setPeerCursor(dbB, nodeA, 'pull', null, null);

    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('5');
  });

  test('HTTP push cursor does not advance for replayed (already-applied) own ops', async () => {
    upsertPlan(dbA, projectA, { uuid: id('http-cursor-replay'), planId: 24, title: 'Replay' });
    const nodeA = getLocalNodeId(dbA);
    const ownOp = (getOpLogChunkAfter(dbA, null, 100).ops as SyncOpRecord[]).find(
      (op) => op.entity_id === id('http-cursor-replay')
    );
    expect(ownOp).toBeDefined();
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const firstResponse = await pushRequest(handler, nodeA, [ownOp!]);
    expect(firstResponse.status).toBe(200);
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('1');

    // Replay the same op — must not advance the cursor.
    const replayResponse = await pushRequest(handler, nodeA, [ownOp!]);
    expect(replayResponse.status).toBe(200);
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('1');
  });

  test('HTTP push cursor does not advance for replayed deferred own ops', async () => {
    const nodeA = getLocalNodeId(dbA);
    upsertPlan(dbB, projectB, { uuid: id('http-cursor-deferred-plan'), planId: 25, title: 'Plan' });
    const fakeTaskUuid = id('http-cursor-deferred-task');
    const hlc = { physicalMs: Date.now(), logical: 0 };
    const deferredOp: SyncOpRecord = {
      op_id: formatOpId(hlc, nodeA, 1),
      node_id: nodeA,
      hlc_physical_ms: hlc.physicalMs,
      hlc_logical: hlc.logical,
      local_counter: 1,
      entity_type: 'plan_task',
      entity_id: fakeTaskUuid,
      op_type: 'set_order',
      payload: JSON.stringify({
        planUuid: id('http-cursor-deferred-plan'),
        orderKey: '0000000002',
      }),
      base: null,
      seq: 1,
    };
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const firstResponse = await pushRequest(handler, nodeA, [deferredOp]);
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({ deferredSkips: 1 });
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('1');

    // Replay the same deferred op — must not advance the cursor again.
    const replayResponse = await pushRequest(handler, nodeA, [deferredOp]);
    expect(replayResponse.status).toBe(200);
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe('1');
  });

  test('HTTP worker multi-chunk return finalizes only on the final chunk', async () => {
    const { workerNodeId, ops } = makeWorkerOps();
    appendPlanTask(dbA, id('worker-target-plan'), {
      uuid: id('worker-return-task-2'),
      title: 'Returned task 2',
      description: 'Second chunk',
    });
    const allOps = exportWorkerOps(dbA).ops;
    const firstChunk = allOps.slice(0, Math.ceil(allOps.length / 2));
    const secondChunk = allOps.slice(Math.ceil(allOps.length / 2));
    expect(firstChunk.length).toBeGreaterThan(0);
    expect(secondChunk.length).toBeGreaterThan(0);
    const handler = createPeerSyncHttpHandler(dbB, { token: 'secret-token' });

    const firstResponse = await pushRequest(handler, workerNodeId, firstChunk, { final: false });
    expect(firstResponse.status).toBe(200);
    expect(getWorkerLease(dbB, workerNodeId)?.status).toBe('active');

    const finalResponse = await pushRequest(handler, workerNodeId, secondChunk, { final: true });
    expect(finalResponse.status).toBe(200);
    await expect(finalResponse.json()).resolves.toEqual({
      pendingOpCount: 0,
      leaseCompleted: true,
    });
    expect(getWorkerLease(dbB, workerNodeId)?.status).toBe('completed');
    const returnedTaskUuids = getPlanTasksByUuid(dbB, id('worker-target-plan')).map(
      (task) => task.uuid
    );
    expect(returnedTaskUuids).toContain(id('worker-return-task'));
    expect(returnedTaskUuids).toContain(id('worker-return-task-2'));
    expect(ops.length).toBeGreaterThan(0);
  });
});

describe('peer sync advanced scenarios', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('bidirectional convergence includes tasks and field clocks', async () => {
    const planUuid = id('plan-bidir');
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'Shared Plan' });
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 1, title: 'Shared Plan' });

    appendPlanTask(dbA, planUuid, { title: 'Task from A', description: 'desc-a' });
    appendPlanTask(dbB, planUuid, { title: 'Task from B', description: 'desc-b' });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // Sync A → B first, then B → A via a second call
    await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));
    await runPeerSync(dbB, nodeA, directTransport(dbA, nodeB));

    const tasksA = dbA
      .prepare(
        'SELECT title FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, created_hlc, created_node_id, uuid'
      )
      .all(planUuid) as Array<{ title: string }>;
    const tasksB = dbB
      .prepare(
        'SELECT title FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, created_hlc, created_node_id, uuid'
      )
      .all(planUuid) as Array<{ title: string }>;

    const titlesA = tasksA.map((t) => t.title).sort();
    const titlesB = tasksB.map((t) => t.title).sort();
    expect(titlesA).toEqual(['Task from A', 'Task from B']);
    expect(titlesA).toEqual(titlesB);

    // Field clocks should exist on both sides for plan fields
    const clocksA = dbA
      .prepare(
        "SELECT field_name FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?"
      )
      .all(planUuid) as Array<{ field_name: string }>;
    const clocksB = dbB
      .prepare(
        "SELECT field_name FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?"
      )
      .all(planUuid) as Array<{ field_name: string }>;
    expect(clocksA.length).toBeGreaterThan(0);
    expect(clocksA.map((c) => c.field_name).sort()).toEqual(
      clocksB.map((c) => c.field_name).sort()
    );
  });

  test('pull cursor does not advance when transport throws on pull chunk', async () => {
    // Write 4 plans on B so we get multiple chunks at batchSize=2
    for (let i = 1; i <= 4; i++) {
      upsertPlan(dbB, projectB, { uuid: id(`throw-plan-${i}`), planId: i, title: `Plan ${i}` });
    }

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });

    let pullCallCount = 0;
    const faultyTransport: PeerTransport = {
      async pullChunk(afterSeq, limit) {
        pullCallCount++;
        if (pullCallCount >= 2) {
          throw new Error('simulated transport failure');
        }
        return getOpLogChunkAfter(dbB, afterSeq, limit);
      },
      async pushChunk() {
        return {};
      },
      async snapshot() {
        return buildPeerSnapshot(dbB);
      },
    };

    await expect(runPeerSync(dbA, nodeB, faultyTransport, { batchSize: 2 })).rejects.toThrow(
      'simulated transport failure'
    );

    // Cursor should reflect first successful chunk but NOT the second
    const pullCursor = getPeerCursor(dbA, nodeB, 'pull');
    expect(pullCursor).not.toBeNull();

    // Should have synced only the first chunk's ops
    const appliedPlans = dbA.prepare('SELECT uuid FROM plan ORDER BY rowid').all() as Array<{
      uuid: string;
    }>;
    // At batchSize=2, first chunk applied 2 plans. Second chunk threw → not applied.
    expect(appliedPlans.length).toBe(2);

    // Now recover: fix the transport and sync again — cursor should resume from where it left off
    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA), { batchSize: 2 });
    expect(result.pulledOps).toBeGreaterThan(0);
    const finalPlans = dbA.prepare('SELECT uuid FROM plan').all() as Array<{ uuid: string }>;
    expect(finalPlans.length).toBe(4);
  });

  test('idempotent re-delivery: second sync with no new ops is a no-op', async () => {
    upsertPlan(dbB, projectB, { uuid: id('idem-plan'), planId: 1, title: 'Idempotent' });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    const first = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));
    expect(first.pulledOps).toBeGreaterThan(0);

    const cursorAfterFirst = getPeerCursor(dbA, nodeB, 'pull')?.last_op_id;

    const second = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));
    expect(second.pulledOps).toBe(0);
    expect(second.pullChunks).toBe(0);

    // Cursor unchanged
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe(cursorAfterFirst);

    // Op count on dbA should be stable
    expect(opCount(dbA)).toBe(opCount(dbB));
  });

  test('set_order before task create is deferred and left retryable', () => {
    const planUuid = id('plan-ooo');
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 10, title: 'Out-of-order plan' });

    const fakeTaskUuid = id('nonexistent-task-ooo');
    const remoteNodeId = randomUUID();
    const remoteHlc = { physicalMs: Date.now() + 5000, logical: 0 };
    const fakeOp: SyncOpRecord = {
      op_id: formatOpId(remoteHlc, remoteNodeId, 1),
      node_id: remoteNodeId,
      hlc_physical_ms: remoteHlc.physicalMs,
      hlc_logical: remoteHlc.logical,
      local_counter: 1,
      entity_type: 'plan_task',
      entity_id: fakeTaskUuid,
      op_type: 'set_order',
      payload: JSON.stringify({ planUuid, orderKey: '0000000002' }),
      base: null,
    };

    const result = applyRemoteOps(dbA, [fakeOp]);

    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.opId).toBe(fakeOp.op_id);
    expect(result.skipped[0]?.reason).toMatch(/set_order arrived before task/);
    expect(result.skipped[0]?.kind).toBe('deferred');

    // Deferred ops are not recorded in op_log so the same op_id can be retried.
    const opLogEntry = dbA
      .prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?')
      .get(fakeOp.op_id) as { op_id: string } | null;
    expect(opLogEntry).toBeNull();

    // No phantom field clock for the nonexistent task's order_key
    const fieldClocks = dbA
      .prepare("SELECT * FROM sync_field_clock WHERE entity_type = 'plan_task' AND entity_id = ?")
      .all(fakeTaskUuid) as unknown[];
    expect(fieldClocks).toHaveLength(0);
  });

  test('skipped ops do not block cursor advancement; create arriving later converges', async () => {
    // Set up a plan on both sides
    const planUuid = id('plan-ooo-transport');
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 11, title: 'OOO Transport Plan' });
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 11, title: 'OOO Transport Plan' });

    // On B, add a task. This emits a 'create' op.
    const taskUuid = appendPlanTask(dbB, planUuid, {
      title: 'OOO task',
      description: 'should arrive',
    });

    // Get all ops from B
    const allOpsFromB = getOpLogChunkAfter(dbB, null, 1000).ops as SyncOpRecord[];
    const taskCreateOp = allOpsFromB.find(
      (op) => op.entity_type === 'plan_task' && op.entity_id === taskUuid && op.op_type === 'create'
    );
    expect(taskCreateOp).toBeDefined();

    // Build a synthetic set_order op for the same task with a higher HLC
    const fakeSetOrderOp: SyncOpRecord = {
      op_id: 'ooo-set-order-synthetic',
      node_id: 'ooo-node',
      hlc_physical_ms: taskCreateOp!.hlc_physical_ms + 1000,
      hlc_logical: 0,
      local_counter: 1,
      entity_type: 'plan_task',
      entity_id: taskUuid,
      op_type: 'set_order',
      payload: JSON.stringify({ planUuid, orderKey: '0000000005' }),
      base: null,
    };

    // Apply only the set_order to A (task doesn't exist on A yet)
    const skipResult = applyRemoteOps(dbA, [fakeSetOrderOp]);
    expect(skipResult.skipped).toHaveLength(1);
    expect(skipResult.errors).toHaveLength(0);

    // Now sync the full op set from B → A (includes the task create)
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);
    const syncResult = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));

    // Sync should succeed and pull ops
    expect(syncResult.pulledOps).toBeGreaterThan(0);
    expect(syncResult.pullChunks).toBeGreaterThan(0);

    // Task should now exist on A
    const task = dbA
      .prepare('SELECT title FROM plan_task WHERE uuid = ? AND deleted_hlc IS NULL')
      .get(taskUuid) as { title: string } | null;
    expect(task?.title).toBe('OOO task');
  });

  test('chunked sync delivers all ops when count exceeds chunk limit', async () => {
    // Create 40 plans on B (each upsertPlan emits at least one op)
    for (let i = 1; i <= 40; i++) {
      upsertPlan(dbB, projectB, {
        uuid: id(`chunk-plan-${i}`),
        planId: i,
        title: `Chunk Plan ${i}`,
      });
    }

    const totalOpsOnB = opCount(dbB);
    expect(totalOpsOnB).toBeGreaterThanOrEqual(40);

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    const pulledChunks: number[] = [];
    const baseTransport = directTransport(dbB, nodeA);
    const trackingTransport: PeerTransport = {
      async pullChunk(afterSeq, limit) {
        const chunk = await baseTransport.pullChunk(afterSeq, limit);
        pulledChunks.push(chunk.ops.length);
        return chunk;
      },
      pushChunk: baseTransport.pushChunk,
      snapshot: baseTransport.snapshot,
    };

    const result = await runPeerSync(dbA, nodeB, trackingTransport, { batchSize: 10 });

    // Should require multiple chunks to deliver 40+ ops with limit=10
    expect(result.pullChunks).toBeGreaterThanOrEqual(4);
    // Each chunk should be at most 10 ops
    expect(pulledChunks.every((count) => count <= 10)).toBe(true);
    // All plans should be on A
    for (let i = 1; i <= 40; i++) {
      expect(getPlanByUuid(dbA, id(`chunk-plan-${i}`))?.title).toBe(`Chunk Plan ${i}`);
    }
    // Cursor should be at the end
    const finalCursor = getPeerCursor(dbA, nodeB, 'pull')?.last_op_id;
    const expectedCursor = getOpLogChunkAfter(dbB, null, 10_000).nextAfterSeq;
    expect(finalCursor).toBe(expectedCursor);
  });

  test('long-offline reconnect syncs all accumulated ops without wall-clock dependency', async () => {
    // Simulate B accumulating ops while A was offline — write 100 plans
    for (let i = 1; i <= 100; i++) {
      upsertPlan(dbB, projectB, {
        uuid: id(`offline-plan-${i}`),
        planId: i,
        title: `Offline ${i}`,
      });
    }

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // A has never synced with B (no cursor)
    expect(getPeerCursor(dbA, nodeB, 'pull')).toBeNull();

    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));

    expect(result.pulledOps).toBeGreaterThanOrEqual(100);

    // Spot-check a few plans made it over
    expect(getPlanByUuid(dbA, id('offline-plan-1'))?.title).toBe('Offline 1');
    expect(getPlanByUuid(dbA, id('offline-plan-50'))?.title).toBe('Offline 50');
    expect(getPlanByUuid(dbA, id('offline-plan-100'))?.title).toBe('Offline 100');

    // Cursor reflects the last op delivered
    const cursor = getPeerCursor(dbA, nodeB, 'pull');
    expect(cursor?.last_op_id).not.toBeNull();
    const highWaterMark = getOpLogChunkAfter(dbB, null, 10_000).nextAfterSeq;
    expect(cursor?.last_op_id).toBe(highWaterMark);
  });
});

describe('HTTP peer sync real Bun.serve() server', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('pull and push both work over a real HTTP server', async () => {
    upsertPlan(dbA, projectA, { uuid: id('real-http-a'), planId: 1, title: 'HTTP Server A' });
    upsertPlan(dbB, projectB, { uuid: id('real-http-b'), planId: 2, title: 'HTTP Server B' });

    const token = 'real-server-token';
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createPeerSyncHttpHandler(dbB, { token }),
    });

    try {
      const nodeB = getLocalNodeId(dbB);
      const result = await runHttpPeerSync(dbA, {
        peerNodeId: nodeB,
        baseUrl: `http://127.0.0.1:${server.port}`,
        token,
      });

      expect(result.pulledOps).toBeGreaterThan(0);
      expect(result.pushedOps).toBeGreaterThan(0);
      expect(getPlanByUuid(dbA, id('real-http-b'))?.title).toBe('HTTP Server B');
      expect(getPlanByUuid(dbB, id('real-http-a'))?.title).toBe('HTTP Server A');
    } finally {
      server.stop(true);
    }
  });

  test('real server returns 401 when Authorization header is missing', async () => {
    const token = 'required-token';
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createPeerSyncHttpHandler(dbB, { token }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/sync/pull`, {
        method: 'POST',
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe('Unauthorized');
    } finally {
      server.stop(true);
    }
  });

  test('real server returns 401 for wrong bearer token', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createPeerSyncHttpHandler(dbB, { token: 'correct-token' }),
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/sync/pull`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test('real server returns 200 for correct bearer token on pull', async () => {
    upsertPlan(dbB, projectB, { uuid: id('auth-check-plan'), planId: 99, title: 'Auth check' });

    const token = 'valid-token-here';
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: createPeerSyncHttpHandler(dbB, { token }),
    });

    try {
      const nodeA = getLocalNodeId(dbA);
      const url = new URL(`http://127.0.0.1:${server.port}/sync/pull`);
      url.searchParams.set('peer_node_id', nodeA);
      url.searchParams.set('limit', '100');

      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ops: unknown[]; hasMore: boolean };
      expect(Array.isArray(body.ops)).toBe(true);
      expect(body.ops.length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });
});
