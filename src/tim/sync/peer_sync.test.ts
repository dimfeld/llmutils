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
import { appendPlanTask, getPlanByUuid, upsertPlan } from '../db/plan.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { getLocalNodeId, registerPeerNode } from './node_identity.js';
import { runPeerSync, type PeerTransport } from './peer_sync.js';
import {
  createHttpPeerTransport,
  createPeerSyncHttpHandler,
  runHttpPeerSync,
} from './peer_transport_http.js';

function directTransport(remoteDb: Database, localNodeId: string): PeerTransport {
  registerPeerNode(remoteDb, { nodeId: localNodeId, nodeType: 'main' });
  return {
    async pullChunk(afterSeq, limit) {
      return getOpLogChunkAfter(remoteDb, afterSeq, limit);
    },
    async pushChunk(ops) {
      const result = applyRemoteOps(remoteDb, ops);
      if (result.errors.length > 0) {
        throw new Error(result.errors[0]?.message ?? 'apply failed');
      }
      const lastPushedOp = ops.reduce<SyncOpRecord | null>((current, op) => {
        if (!Number.isInteger(op.seq) || op.seq < 1) return current;
        if (!current || op.seq > (current.seq ?? 0)) return op;
        return current;
      }, null);
      if (lastPushedOp?.seq) {
        setPeerCursor(remoteDb, localNodeId, 'pull', lastPushedOp.seq.toString(), lastPushedOp);
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
    transport.pullChunk = async (afterSeq, limit) => {
      const chunk = await originalPull(afterSeq, limit);
      pulledChunks.push(chunk);
      return chunk;
    };

    const result = await runPeerSync(dbA, nodeB, transport, { batchSize: 2 });

    expect(result.pullChunks).toBeGreaterThan(1);
    expect(pulledChunks.every((chunk) => chunk.ops.length <= 2)).toBe(true);
    expect(getPlanByUuid(dbA, 'chunked-plan')?.title).toBe('v6');
    expect(getPeerCursor(dbA, nodeB, 'pull')?.last_op_id).toBe(
      getOpLogChunkAfter(dbB, null, 100).nextAfterSeq
    );
  });

  test('seq cursor delivers lower-HLC ops inserted after a peer already pulled a high-HLC op', async () => {
    const dbC = openDatabase(':memory:');
    const projectC = getOrCreateProject(dbC, 'github.com__owner__repo').id;
    try {
      upsertPlan(dbC, projectC, {
        uuid: 'plan-from-c-offline',
        planId: 30,
        title: 'Offline C',
      });
      dbC.prepare(
        "UPDATE sync_op_log SET hlc_physical_ms = 1, hlc_logical = 0 WHERE entity_type = 'plan' AND entity_id = ?"
      ).run('plan-from-c-offline');

      upsertPlan(dbA, projectA, {
        uuid: 'plan-from-a-high',
        planId: 10,
        title: 'High A',
      });

      const nodeA = getLocalNodeId(dbA);
      const nodeB = getLocalNodeId(dbB);
      const nodeC = getLocalNodeId(dbC);

      const firstPull = await runPeerSync(dbB, nodeA, directTransport(dbA, nodeB));
      expect(firstPull.pulledOps).toBeGreaterThan(0);
      expect(getPlanByUuid(dbB, 'plan-from-a-high')?.title).toBe('High A');
      const bCursorAfterHighA = getPeerCursor(dbB, nodeA, 'pull')?.last_op_id;
      expect(bCursorAfterHighA).toBe(getOpLogChunkAfter(dbA, null, 100).nextAfterSeq);

      const aPullsC = await runPeerSync(dbA, nodeC, directTransport(dbC, nodeA));
      expect(aPullsC.pulledOps).toBeGreaterThan(0);
      const cOpOnA = dbA
        .prepare("SELECT seq, hlc_physical_ms FROM sync_op_log WHERE entity_id = ?")
        .get('plan-from-c-offline') as { seq: number; hlc_physical_ms: number } | null;
      expect(cOpOnA?.hlc_physical_ms).toBe(1);
      expect(cOpOnA?.seq).toBeGreaterThan(Number(bCursorAfterHighA));

      const secondPull = await runPeerSync(dbB, nodeA, directTransport(dbA, nodeB));
      expect(secondPull.pulledOps).toBeGreaterThan(0);
      expect(getPlanByUuid(dbB, 'plan-from-c-offline')?.title).toBe('Offline C');
    } finally {
      dbC.close(false);
    }
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
    const planUuid = 'plan-bidir';
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
        "SELECT title FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, uuid"
      )
      .all(planUuid) as Array<{ title: string }>;
    const tasksB = dbB
      .prepare(
        "SELECT title FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, uuid"
      )
      .all(planUuid) as Array<{ title: string }>;

    const titlesA = tasksA.map((t) => t.title).sort();
    const titlesB = tasksB.map((t) => t.title).sort();
    expect(titlesA).toEqual(['Task from A', 'Task from B']);
    expect(titlesA).toEqual(titlesB);

    // Field clocks should exist on both sides for plan fields
    const clocksA = dbA
      .prepare("SELECT field_name FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?")
      .all(planUuid) as Array<{ field_name: string }>;
    const clocksB = dbB
      .prepare("SELECT field_name FROM sync_field_clock WHERE entity_type = 'plan' AND entity_id = ?")
      .all(planUuid) as Array<{ field_name: string }>;
    expect(clocksA.length).toBeGreaterThan(0);
    expect(clocksA.map((c) => c.field_name).sort()).toEqual(
      clocksB.map((c) => c.field_name).sort()
    );
  });

  test('pull cursor does not advance when transport throws on pull chunk', async () => {
    // Write 4 plans on B so we get multiple chunks at batchSize=2
    for (let i = 1; i <= 4; i++) {
      upsertPlan(dbB, projectB, { uuid: `throw-plan-${i}`, planId: i, title: `Plan ${i}` });
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
    };

    await expect(runPeerSync(dbA, nodeB, faultyTransport, { batchSize: 2 })).rejects.toThrow(
      'simulated transport failure'
    );

    // Cursor should reflect first successful chunk but NOT the second
    const pullCursor = getPeerCursor(dbA, nodeB, 'pull');
    expect(pullCursor).not.toBeNull();

    // Should have synced only the first chunk's ops
    const appliedPlans = dbA
      .prepare('SELECT uuid FROM plan ORDER BY rowid')
      .all() as Array<{ uuid: string }>;
    // At batchSize=2, first chunk applied 2 plans. Second chunk threw → not applied.
    expect(appliedPlans.length).toBe(2);

    // Now recover: fix the transport and sync again — cursor should resume from where it left off
    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA), { batchSize: 2 });
    expect(result.pulledOps).toBeGreaterThan(0);
    const finalPlans = dbA
      .prepare('SELECT uuid FROM plan')
      .all() as Array<{ uuid: string }>;
    expect(finalPlans.length).toBe(4);
  });

  test('idempotent re-delivery: second sync with no new ops is a no-op', async () => {
    upsertPlan(dbB, projectB, { uuid: 'idem-plan', planId: 1, title: 'Idempotent' });

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

  test('set_order before task create is skipped but op is recorded for dedup', () => {
    const planUuid = 'plan-ooo';
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 10, title: 'Out-of-order plan' });

    const fakeTaskUuid = 'nonexistent-task-ooo';
    const fakeOp: SyncOpRecord = {
      op_id: 'fake-set-order-before-create-001',
      node_id: 'fake-remote-node-ooo',
      hlc_physical_ms: Date.now() + 5000,
      hlc_logical: 0,
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
    expect(result.skipped[0]?.opId).toBe('fake-set-order-before-create-001');
    expect(result.skipped[0]?.reason).toMatch(/set_order arrived before task/);

    // Op is recorded in op_log for dedup (so it won't loop forever on retry)
    const opLogEntry = dbA
      .prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?')
      .get('fake-set-order-before-create-001') as { op_id: string } | null;
    expect(opLogEntry).not.toBeNull();

    // No phantom field clock for the nonexistent task's order_key
    const fieldClocks = dbA
      .prepare(
        "SELECT * FROM sync_field_clock WHERE entity_type = 'plan_task' AND entity_id = ?"
      )
      .all(fakeTaskUuid) as unknown[];
    expect(fieldClocks).toHaveLength(0);
  });

  test('skipped ops do not block cursor advancement; create arriving later converges', async () => {
    // Set up a plan on both sides
    const planUuid = 'plan-ooo-transport';
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
      upsertPlan(dbB, projectB, { uuid: `chunk-plan-${i}`, planId: i, title: `Chunk Plan ${i}` });
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
    };

    const result = await runPeerSync(dbA, nodeB, trackingTransport, { batchSize: 10 });

    // Should require multiple chunks to deliver 40+ ops with limit=10
    expect(result.pullChunks).toBeGreaterThanOrEqual(4);
    // Each chunk should be at most 10 ops
    expect(pulledChunks.every((count) => count <= 10)).toBe(true);
    // All plans should be on A
    for (let i = 1; i <= 40; i++) {
      expect(getPlanByUuid(dbA, `chunk-plan-${i}`)?.title).toBe(`Chunk Plan ${i}`);
    }
    // Cursor should be at the end
    const finalCursor = getPeerCursor(dbA, nodeB, 'pull')?.last_op_id;
    const expectedCursor = getOpLogChunkAfter(dbB, null, 10_000).nextAfterSeq;
    expect(finalCursor).toBe(expectedCursor);
  });

  test('long-offline reconnect syncs all accumulated ops without wall-clock dependency', async () => {
    // Simulate B accumulating ops while A was offline — write 100 plans
    for (let i = 1; i <= 100; i++) {
      upsertPlan(dbB, projectB, { uuid: `offline-plan-${i}`, planId: i, title: `Offline ${i}` });
    }

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // A has never synced with B (no cursor)
    expect(getPeerCursor(dbA, nodeB, 'pull')).toBeNull();

    const result = await runPeerSync(dbA, nodeB, directTransport(dbB, nodeA));

    expect(result.pulledOps).toBeGreaterThanOrEqual(100);

    // Spot-check a few plans made it over
    expect(getPlanByUuid(dbA, 'offline-plan-1')?.title).toBe('Offline 1');
    expect(getPlanByUuid(dbA, 'offline-plan-50')?.title).toBe('Offline 50');
    expect(getPlanByUuid(dbA, 'offline-plan-100')?.title).toBe('Offline 100');

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
    upsertPlan(dbA, projectA, { uuid: 'real-http-a', planId: 1, title: 'HTTP Server A' });
    upsertPlan(dbB, projectB, { uuid: 'real-http-b', planId: 2, title: 'HTTP Server B' });

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
      expect(getPlanByUuid(dbA, 'real-http-b')?.title).toBe('HTTP Server B');
      expect(getPlanByUuid(dbB, 'real-http-a')?.title).toBe('HTTP Server A');
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
    upsertPlan(dbB, projectB, { uuid: 'auth-check-plan', planId: 99, title: 'Auth check' });

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
