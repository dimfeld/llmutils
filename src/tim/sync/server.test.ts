import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertPlan,
} from '../db/plan.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import { getTimNode, getTimNodeCursor, upsertTimNode } from '../db/sync_tables.js';
import { hashToken } from './auth.js';
import { httpCatchUp, httpFetchSnapshots, httpFlushOperations } from './client.js';
import { CanonicalSnapshotSchema } from './queue.js';
import {
  addPlanTagOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  setProjectSettingOperation,
} from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  listPendingOperations,
  mergeCanonicalRefresh,
} from './queue.js';
import { createBatchEnvelope } from './types.js';
import { pruneSyncSequence } from './retention.js';
import { createSyncRunner } from './runner.js';
import {
  getCurrentSequenceId,
  loadCanonicalSnapshot,
  startSyncServer,
  SYNC_MAX_PAYLOAD_BYTES,
  type SyncServerHandle,
} from './server.js';
import { createSyncClient, type SyncClient } from './ws_client.js';
import type { SyncFrame } from './ws_protocol.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const SECOND_PROJECT_UUID = '11111111-1111-4111-8111-111111111112';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const SECOND_PLAN_UUID = '22222222-2222-4222-8222-222222222223';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const SECOND_TASK_UUID = '33333333-3333-4333-8333-333333333334';
const NODE_A = 'persistent-a';
const NODE_B = 'persistent-b';
const TOKEN = 'secret-token';

const servers: SyncServerHandle[] = [];
const clients: SyncClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.stop();
  }
  for (const server of servers.splice(0)) {
    server.stop();
  }
  vi.useRealTimers();
});

describe('sync transport server and clients', () => {
  test('accepts hello with valid credentials and rejects invalid credentials', async () => {
    const mainDb = createDb();
    const server = startTestServer(mainDb);

    const ok = await openWebSocket(server);
    ok.send(JSON.stringify({ type: 'hello', nodeId: NODE_A, token: TOKEN }));
    expect(await waitForMessage(ok)).toMatchObject({ type: 'hello_ack', mainNodeId: 'main-node' });
    ok.close();

    const bad = await openWebSocket(server);
    bad.send(JSON.stringify({ type: 'hello', nodeId: NODE_A, token: 'wrong' }));
    expect(await waitForMessage(bad)).toMatchObject({ type: 'error', code: 'unauthorized' });
    bad.close();
  });

  test('seeds known peers and records WebSocket-reported cursors for retention pruning', async () => {
    const mainDb = createDb();
    insertSequences(mainDb, 5);
    // Only NODE_A is allowed here so retention pruning is gated by NODE_A's
    // cursor alone. With NODE_B also configured and never connected, its
    // missing cursor row would (correctly) protect all sequences from
    // peer-based pruning.
    const server = startSyncServer({
      db: mainDb,
      mainNodeId: 'main-node',
      port: 0,
      allowedNodes: [{ nodeId: NODE_A, tokenHash: hashToken(TOKEN) }],
    });
    servers.push(server);

    expect(getTimNode(mainDb, NODE_A)).toMatchObject({
      node_id: NODE_A,
      role: 'persistent',
    });

    const ws = await openWebSocket(server);
    ws.send(
      JSON.stringify({
        type: 'hello',
        nodeId: NODE_A,
        token: TOKEN,
        lastKnownSequenceId: 3,
      })
    );

    expect(await waitForMessage(ws)).toMatchObject({ type: 'hello_ack' });
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(3);
    expect(pruneSyncSequence(mainDb, { retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000 })).toBe(2);
    expect(sequenceIds(mainDb)).toEqual([3, 4, 5]);
    ws.close();
  });

  test('rejects WebSocket hello with cursor past current server sequence and preserves history', async () => {
    const mainDb = createDb();
    insertSequences(mainDb, 5);
    const server = startTestServer(mainDb);
    const ws = await openWebSocket(server);

    ws.send(
      JSON.stringify({
        type: 'hello',
        nodeId: NODE_A,
        token: TOKEN,
        lastKnownSequenceId: 999,
      })
    );

    expect(await waitForMessage(ws)).toMatchObject({ type: 'error', code: 'invalid_cursor' });
    // No tim_node_cursor row was ever written for NODE_A, so its missing cursor
    // protects all five sequences from peer-based pruning.
    expect(pruneSyncSequence(mainDb, { retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000 })).toBe(0);
    expect(sequenceIds(mainDb)).toEqual([1, 2, 3, 4, 5]);
    ws.close();
  });

  test('rejects WebSocket catch_up_request with cursor past current server sequence and preserves history', async () => {
    const mainDb = createDb();
    insertSequences(mainDb, 5);
    const server = startTestServer(mainDb);
    const ws = await authenticatedWebSocket(server, NODE_A);

    // Authenticated hello with no lastKnownSequenceId leaves cursor at 0.
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(0);

    ws.send(JSON.stringify({ type: 'catch_up_request', sinceSequenceId: 999 }));

    expect(await waitForMessage(ws)).toMatchObject({ type: 'error', code: 'invalid_cursor' });
    // Cursor untouched; retention still protected by NODE_A's cursor=0.
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(0);
    expect(pruneSyncSequence(mainDb, { retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000 })).toBe(0);
    expect(sequenceIds(mainDb)).toEqual([1, 2, 3, 4, 5]);
    ws.close();
  });

  test('rejects HTTP catch-up sinceSequenceId past current server sequence and preserves history', async () => {
    const mainDb = createDb();
    insertSequences(mainDb, 5);
    const server = startTestServer(mainDb);

    const url = new URL('/internal/sync/catch-up', serverUrl(server));
    url.searchParams.set('sinceSequenceId', '999');
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-tim-node-id': NODE_A,
      },
    });

    expect(response.status).toBe(400);
    // No cursor row ever written; retention still protected.
    expect(pruneSyncSequence(mainDb, { retentionMaxAgeMs: 365 * 24 * 60 * 60 * 1000 })).toBe(0);
    expect(sequenceIds(mainDb)).toEqual([1, 2, 3, 4, 5]);
  });

  test('rejects protocol frames before hello', async () => {
    const server = startTestServer(createDb());
    const ws = await openWebSocket(server);

    ws.send(JSON.stringify({ type: 'ping' }));

    expect(await waitForMessage(ws)).toMatchObject({ type: 'error', code: 'missing_hello' });
    ws.close();
  });

  test('rejects connections that do not send hello within the timeout', async () => {
    vi.useFakeTimers();
    const server = startTestServer(createDb());
    const ws = await openWebSocket(server);
    const message = waitForMessage(ws);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await message).toMatchObject({ type: 'error', code: 'missing_hello' });
    ws.close();
  });

  test('rejects invalid frame schemas without crashing the server', async () => {
    const server = startTestServer(createDb());
    const ws = await authenticatedWebSocket(server, NODE_A);

    ws.send(JSON.stringify({ type: 'snapshot_request', entityKeys: [123] }));

    expect(await waitForMessage(ws)).toMatchObject({ type: 'error', code: 'bad_frame' });
    ws.close();

    const next = await authenticatedWebSocket(server, NODE_A);
    next.send(JSON.stringify({ type: 'ping' }));
    expect(await waitForMessage(next)).toEqual({ type: 'pong' });
    next.close();
  });

  test('rejects oversized WebSocket frames before parsing', async () => {
    const server = startTestServer(createDb());
    const ws = await openWebSocket(server);
    const closePromise = waitForClose(ws);

    ws.send('x'.repeat(SYNC_MAX_PAYLOAD_BYTES + 1));

    const result = await Promise.race([
      waitForMessage(ws).then((frame) => ({ type: 'message' as const, frame })),
      closePromise.then(() => ({ type: 'close' as const })),
    ]);
    if (result.type === 'message') {
      expect(result.frame).toMatchObject({ type: 'error', code: 'payload_too_large' });
    }
    ws.close();
  });

  test('rejects oversized HTTP operation bodies before parsing', async () => {
    const server = startTestServer(createDb());
    const url = new URL('/internal/sync/operations', serverUrl(server));
    const body = JSON.stringify({ operations: [], padding: 'x'.repeat(SYNC_MAX_PAYLOAD_BYTES) });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-tim-node-id': NODE_A,
      },
      body,
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Sync request body exceeds maximum payload size',
    });
  });

  test('responds to ping with pong', async () => {
    const server = startTestServer(createDb());
    const ws = await authenticatedWebSocket(server, NODE_A);

    ws.send(JSON.stringify({ type: 'ping' }));

    expect(await waitForMessage(ws)).toEqual({ type: 'pong' });
    ws.close();
  });

  test('HTTP fallback applies operations idempotently and exposes snapshots/catch-up', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'offline' },
      { originNodeId: NODE_A, localSequence: 0 }
    );

    const first = await httpFlushOperations(serverUrl(server), TOKEN, NODE_A, [op]);
    expect(first.ok).toBe(true);
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(0);
    const second = await httpFlushOperations(serverUrl(server), TOKEN, NODE_A, [op]);
    expect(second.ok).toBe(true);
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(0);
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['offline']);

    const catchUp = await httpCatchUp(serverUrl(server), TOKEN, NODE_A, 0);
    expect(catchUp.ok && catchUp.value.invalidations[0]?.entityKeys).toEqual([`plan:${PLAN_UUID}`]);

    const snapshots = await httpFetchSnapshots(serverUrl(server), TOKEN, NODE_A, [
      `plan:${PLAN_UUID}`,
    ]);
    expect(snapshots.ok && snapshots.value.snapshots[0]).toMatchObject({
      type: 'plan',
      plan: { uuid: PLAN_UUID, tags: ['offline'] },
    });
  });

  test('startup bootstraps existing plans so catch-up from zero can discover them', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);

    const catchUp = await httpCatchUp(serverUrl(server), TOKEN, NODE_A, 0);

    expect(catchUp.ok).toBe(true);
    expect(catchUp.ok && catchUp.value.invalidations.flatMap((item) => item.entityKeys)).toContain(
      `plan:${PLAN_UUID}`
    );
  });

  test('HTTP fallback rejects operation batches from spoofed origin nodes', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'spoofed-http' },
      { originNodeId: NODE_B, localSequence: 0 }
    );
    const url = new URL('/internal/sync/operations', serverUrl(server));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'x-tim-node-id': NODE_A,
      },
      body: JSON.stringify({ operations: [op] }),
    });

    expect(response.status).toBe(400);
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID)).toEqual([]);
    expect(countSyncOperations(mainDb)).toBe(0);
  });

  test('HTTP fallback requires both node ID and token for authentication', async () => {
    const server = startTestServer(createDb());
    const url = new URL('/internal/sync/catch-up', serverUrl(server));
    url.searchParams.set('sinceSequenceId', '0');

    const missingNode = await fetch(url, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missingNode.status).toBe(401);

    const wrongNode = await fetch(url, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-tim-node-id': 'unknown-node',
      },
    });
    expect(wrongNode.status).toBe(401);
  });

  test('HTTP fallback rejects query-string credentials and honors secure transport setting', async () => {
    const server = startTestServer(createDb());
    const queryAuthUrl = new URL('/internal/sync/catch-up', serverUrl(server));
    queryAuthUrl.searchParams.set('sinceSequenceId', '0');
    queryAuthUrl.searchParams.set('nodeId', NODE_A);
    queryAuthUrl.searchParams.set('token', TOKEN);

    const queryAuth = await fetch(queryAuthUrl);
    expect(queryAuth.status).toBe(401);

    const secureOnly = startSyncServer({
      db: createDb(),
      mainNodeId: 'main-node',
      port: 0,
      hostname: '0.0.0.0',
      requireSecureTransport: true,
      allowedNodes: [{ nodeId: NODE_A, tokenHash: hashToken(TOKEN) }],
    });
    servers.push(secureOnly);
    const secureUrl = new URL(`/internal/sync/catch-up`, `http://0.0.0.0:${secureOnly.port}`);
    secureUrl.searchParams.set('sinceSequenceId', '0');
    const insecureFallback = await fetch(secureUrl, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-tim-node-id': NODE_A,
      },
    });
    expect(insecureFallback.status).toBe(400);
  });

  test('snapshot requests return full schema-valid plan and project-setting payloads', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const setSetting = await setProjectSettingOperation(
      {
        projectUuid: PROJECT_UUID,
        setting: 'color',
        value: 'blue',
      },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const deleteMissingSetting = await deleteProjectSettingOperation(
      {
        projectUuid: PROJECT_UUID,
        setting: 'missingSetting',
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );

    const flush = await httpFlushOperations(serverUrl(server), TOKEN, NODE_A, [
      setSetting,
      deleteMissingSetting,
    ]);
    expect(flush.ok).toBe(true);
    expect(getProjectSettingWithMetadata(mainDb, 1, 'color')).toMatchObject({
      value: 'blue',
      revision: 1,
      updatedByNode: NODE_A,
    });

    const snapshots = await httpFetchSnapshots(serverUrl(server), TOKEN, NODE_A, [
      `plan:${PLAN_UUID}`,
      `project_setting:${PROJECT_UUID}:color`,
      `project_setting:${PROJECT_UUID}:missingSetting`,
    ]);
    expect(snapshots.ok).toBe(true);
    if (!snapshots.ok) {
      return;
    }

    expect(() =>
      snapshots.value.snapshots.map((snapshot) => CanonicalSnapshotSchema.parse(snapshot))
    ).not.toThrow();
    expect(snapshots.value.snapshots).toHaveLength(3);
    const planSnapshot = snapshots.value.snapshots.find((snapshot) => snapshot.type === 'plan');
    expect(planSnapshot).toMatchObject({
      type: 'plan',
      projectUuid: PROJECT_UUID,
      plan: {
        uuid: PLAN_UUID,
        planId: 1,
        title: 'Sync plan',
        details: 'details',
        tasks: [{ uuid: TASK_UUID, revision: 1 }],
        dependencyUuids: [],
        tags: [],
        revision: 1,
      },
    });
    expect(snapshots.value.snapshots).toContainEqual(
      expect.objectContaining({
        type: 'project_setting',
        projectUuid: PROJECT_UUID,
        setting: 'color',
        value: 'blue',
        revision: 1,
      })
    );
    expect(snapshots.value.snapshots).toContainEqual({
      type: 'project_setting',
      projectUuid: PROJECT_UUID,
      setting: 'missingSetting',
      deleted: true,
    });
  });

  test('loadCanonicalSnapshot returns never_existed for a plan key without row or tombstone', () => {
    const mainDb = createDb();

    expect(loadCanonicalSnapshot(mainDb, `plan:${SECOND_PLAN_UUID}`)).toEqual({
      type: 'never_existed',
      entityKey: `plan:${SECOND_PLAN_UUID}`,
      targetType: 'plan',
      planUuid: SECOND_PLAN_UUID,
    });
  });

  test('broadcasts invalidations to connected peers except the sender', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const sender = await authenticatedWebSocket(server, NODE_A);
    const peer = await authenticatedWebSocket(server, NODE_B);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'peer-visible' },
      { originNodeId: NODE_A, localSequence: 0 }
    );

    const peerInvalidation = waitForMessage(peer);
    sender.send(JSON.stringify({ type: 'op_batch', operations: [op] }));

    expect(await waitForMessage(sender)).toMatchObject({
      type: 'op_result',
      results: [{ operationId: op.operationUuid, status: 'applied' }],
    });
    expect(await peerInvalidation).toMatchObject({
      type: 'invalidate',
      entityKeys: [`plan:${PLAN_UUID}`],
    });
    await expectNoMessage(sender);
    sender.close();
    peer.close();
  });

  test('broadcasts invalidations for operations applied through HTTP fallback', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const peer = await authenticatedWebSocket(server, NODE_B);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'http-visible' },
      { originNodeId: NODE_A, localSequence: 0 }
    );

    const peerInvalidation = waitForMessage(peer);
    const flush = await httpFlushOperations(serverUrl(server), TOKEN, NODE_A, [op]);

    expect(flush.ok).toBe(true);
    expect(await peerInvalidation).toMatchObject({
      type: 'invalidate',
      entityKeys: [`plan:${PLAN_UUID}`],
    });
    peer.close();
  });

  test('WebSocket operation batches reject spoofed origin nodes without mutating canonical state', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const sender = await authenticatedWebSocket(server, NODE_A);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'spoofed-ws' },
      { originNodeId: NODE_B, localSequence: 0 }
    );

    sender.send(JSON.stringify({ type: 'op_batch', operations: [op] }));

    expect(await waitForMessage(sender)).toMatchObject({
      type: 'error',
      code: 'origin_mismatch',
    });
    expect(getPlanTagsByUuid(mainDb, PLAN_UUID)).toEqual([]);
    expect(countSyncOperations(mainDb)).toBe(0);
    sender.close();
  });

  test('WebSocket client flushes pending operations and merges canonical snapshots', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const bootstrappedSequenceId = getCurrentSequenceId(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'client-flush' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, op);
    expect(listPendingOperations(localDb, { originNodeId: NODE_A })).toHaveLength(1);

    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => listPendingOperations(localDb, { originNodeId: NODE_A }).length === 0);

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['client-flush']);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['client-flush']);
    expect(getTimNodeCursor(localDb, NODE_A).last_known_sequence_id).toBe(bootstrappedSequenceId);
  });

  test('connected peers apply deleted-plan invalidations from WebSocket broadcasts', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    const sender = await authenticatedWebSocket(server, NODE_B);
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_B, localSequence: 0 }
    );
    sender.send(JSON.stringify({ type: 'op_batch', operations: [op] }));
    expect(await waitForMessage(sender)).toMatchObject({
      type: 'op_result',
      results: [{ operationId: op.operationUuid, status: 'applied' }],
    });

    await waitFor(() => getPlanByUuid(localDb, PLAN_UUID) === null);
    expectPlanGone(localDb, PLAN_UUID);
    sender.close();
  });

  test('catch-up after reconnect fetches missed canonical changes', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'missed' },
      { originNodeId: NODE_B, localSequence: 0 }
    );
    const flush = await httpFlushOperations(serverUrl(server), TOKEN, NODE_B, [op]);
    expect(flush.ok).toBe(true);

    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => getPlanTagsByUuid(localDb, PLAN_UUID).some((tag) => tag.tag === 'missed'));
    expect(getTimNodeCursor(localDb, NODE_A).last_known_sequence_id).toBeGreaterThan(0);
  });

  test('catch-up after reconnect applies missed plan deletions', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const op = await deletePlanOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID },
      { originNodeId: NODE_B, localSequence: 0 }
    );
    const flush = await httpFlushOperations(serverUrl(server), TOKEN, NODE_B, [op]);
    expect(flush.ok).toBe(true);
    expectPlanGone(mainDb, PLAN_UUID);

    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => getPlanByUuid(localDb, PLAN_UUID) === null);
    expectPlanGone(localDb, PLAN_UUID);
  });

  test('runner runOnce flushes and catches up over HTTP', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const op = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'runner' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, op);

    const runner = createSyncRunner({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
    });
    await runner.runOnce();

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['runner']);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['runner']);
  });

  test('WebSocket client reconnects after server restart', async () => {
    const db = createDb();
    seedPlan(db);
    upsertTimNode(db, { nodeId: NODE_A, role: 'persistent' });
    const port = await getAvailablePort();
    let server = startTestServer(createDb(), port);
    const client = createSyncClient({
      db,
      serverUrl: `http://127.0.0.1:${port}`,
      nodeId: NODE_A,
      token: TOKEN,
      minReconnectDelayMs: 20,
      maxReconnectDelayMs: 50,
    });
    clients.push(client);
    client.start();
    await waitFor(() => client.getStatus().connected);

    server.stop();
    servers.splice(servers.indexOf(server), 1);
    await waitFor(() => !client.getStatus().connected);

    server = startTestServer(createDb(), port);
    await waitFor(() => client.getStatus().connected, 3000);
  });

  test('WebSocket batch frame is applied and returns a single batch_result with all per-op results', async () => {
    const mainDb = createDb();
    seedPlan(mainDb);
    const server = startTestServer(mainDb);
    const sender = await authenticatedWebSocket(server, NODE_A);

    const tag1 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'batch-tag-one' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const tag2 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'batch-tag-two' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const batchId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
    const batch = createBatchEnvelope({ batchId, originNodeId: NODE_A, operations: [tag1, tag2] });

    sender.send(JSON.stringify({ type: 'batch', batch }));

    const result = await waitForMessage(sender);
    expect(result).toMatchObject({
      type: 'batch_result',
      batchId,
      status: 'applied',
      results: [
        { operationId: tag1.operationUuid, status: 'applied' },
        { operationId: tag2.operationUuid, status: 'applied' },
      ],
    });
    expect(
      getPlanTagsByUuid(mainDb, PLAN_UUID)
        .map((t) => t.tag)
        .sort()
    ).toEqual(['batch-tag-one', 'batch-tag-two']);
    expect(getTimNodeCursor(mainDb, NODE_A).last_known_sequence_id).toBe(0);
    sender.close();
  });

  test('WebSocket client sends batch frame for enqueued batch and merges canonical state', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);

    const tag1 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'ws-batch-one' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const tag2 = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'ws-batch-two' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    const batchId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    enqueueBatch(
      localDb,
      createBatchEnvelope({ batchId, originNodeId: NODE_A, operations: [tag1, tag2] })
    );
    expect(listPendingOperations(localDb, { originNodeId: NODE_A })).toHaveLength(2);

    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => listPendingOperations(localDb, { originNodeId: NODE_A }).length === 0);

    expect(
      getPlanTagsByUuid(mainDb, PLAN_UUID)
        .map((t) => t.tag)
        .sort()
    ).toEqual(['ws-batch-one', 'ws-batch-two']);
    expect(
      getPlanTagsByUuid(localDb, PLAN_UUID)
        .map((t) => t.tag)
        .sort()
    ).toEqual(['ws-batch-one', 'ws-batch-two']);
  });

  test('WebSocket client syncs operations for multiple projects over one connection', async () => {
    const mainDb = createDb();
    const localDb = createDb();
    seedPlan(mainDb);
    seedPlan(localDb);
    seedSecondPlan(mainDb);
    seedSecondPlan(localDb);
    upsertTimNode(localDb, { nodeId: NODE_A, role: 'persistent' });
    const server = startTestServer(mainDb);
    const firstOp = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'first-project' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    const secondOp = await addPlanTagOperation(
      SECOND_PROJECT_UUID,
      { planUuid: SECOND_PLAN_UUID, tag: 'second-project' },
      { originNodeId: NODE_A, localSequence: 999 }
    );
    enqueueOperation(localDb, firstOp);
    enqueueOperation(localDb, secondOp);

    const client = createSyncClient({
      db: localDb,
      serverUrl: serverUrl(server),
      nodeId: NODE_A,
      token: TOKEN,
      reconnect: false,
    });
    clients.push(client);
    client.start();

    await waitFor(() => listPendingOperations(localDb, { originNodeId: NODE_A }).length === 0);

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['first-project']);
    expect(getPlanTagsByUuid(mainDb, SECOND_PLAN_UUID).map((tag) => tag.tag)).toEqual([
      'second-project',
    ]);
    expect(getPlanTagsByUuid(localDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['first-project']);
    expect(getPlanTagsByUuid(localDb, SECOND_PLAN_UUID).map((tag) => tag.tag)).toEqual([
      'second-project',
    ]);
    expect(server.connections.size).toBe(1);
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Sync plan',
    details: 'details',
    status: 'pending',
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
  });
}

function seedSecondPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__second-repo', {
    uuid: SECOND_PROJECT_UUID,
    highestPlanId: 10,
  });
  upsertPlan(db, project.id, {
    uuid: SECOND_PLAN_UUID,
    planId: 1,
    title: 'Second sync plan',
    details: 'second details',
    status: 'pending',
    tasks: [{ uuid: SECOND_TASK_UUID, title: 'Second task', description: 'Do it too' }],
    forceOverwrite: true,
  });
}

function expectPlanGone(db: Database, planUuid: string): void {
  expect(getPlanByUuid(db, planUuid)).toBeNull();
  expect(getPlanTasksByUuid(db, planUuid)).toEqual([]);
  expect(getPlanDependenciesByUuid(db, planUuid)).toEqual([]);
  expect(getPlanTagsByUuid(db, planUuid)).toEqual([]);
  const inboundDependencyCount = db
    .prepare('SELECT COUNT(*) AS count FROM plan_dependency WHERE depends_on_uuid = ?')
    .get(planUuid) as { count: number };
  expect(inboundDependencyCount.count).toBe(0);
}

function countSyncOperations(db: Database): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM sync_operation').get() as { count: number };
  return row.count;
}

function insertSequences(db: Database, count: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `
        INSERT INTO sync_sequence (
          project_uuid,
          target_type,
          target_key,
          revision,
          operation_uuid,
          origin_node_id,
          created_at
        ) VALUES (?, 'plan', ?, 1, ?, 'main-node', '2026-04-27T12:00:00.000Z')
      `
    ).run(PROJECT_UUID, `plan:${crypto.randomUUID()}`, crypto.randomUUID());
  }
}

function sequenceIds(db: Database): number[] {
  return (
    db.prepare('SELECT sequence FROM sync_sequence ORDER BY sequence').all() as Array<{
      sequence: number;
    }>
  ).map((row) => row.sequence);
}

function startTestServer(db: Database, port = 0): SyncServerHandle {
  const server = startSyncServer({
    db,
    mainNodeId: 'main-node',
    port,
    allowedNodes: [
      { nodeId: NODE_A, tokenHash: hashToken(TOKEN) },
      { nodeId: NODE_B, tokenHash: hashToken(TOKEN) },
    ],
  });
  servers.push(server);
  return server;
}

function serverUrl(server: SyncServerHandle): string {
  return `http://${server.hostname}:${server.port}`;
}

async function openWebSocket(server: SyncServerHandle): Promise<WebSocket> {
  const ws = new WebSocket(`ws://${server.hostname}:${server.port}/sync/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket open failed')), { once: true });
  });
  return ws;
}

async function authenticatedWebSocket(
  server: SyncServerHandle,
  nodeId: string
): Promise<WebSocket> {
  const ws = await openWebSocket(server);
  ws.send(JSON.stringify({ type: 'hello', nodeId, token: TOKEN }));
  expect(await waitForMessage(ws)).toMatchObject({ type: 'hello_ack' });
  return ws;
}

function waitForMessage(ws: WebSocket): Promise<SyncFrame> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      'message',
      (event) => resolve(JSON.parse(rawToString(event.data)) as SyncFrame),
      { once: true }
    );
    ws.addEventListener('error', () => reject(new Error('WebSocket error while waiting')), {
      once: true,
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.addEventListener('close', () => resolve(), { once: true });
  });
}

async function expectNoMessage(ws: WebSocket, timeoutMs = 75): Promise<void> {
  await expect(
    Promise.race([
      waitForMessage(ws).then((frame) => {
        throw new Error(`Unexpected WebSocket message: ${JSON.stringify(frame)}`);
      }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  ).resolves.toBeUndefined();
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function getAvailablePort(): Promise<number> {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {},
      close() {},
      drain() {},
      data() {},
      error() {},
      end() {},
      timeout() {},
      connectError() {},
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

function rawToString(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}
