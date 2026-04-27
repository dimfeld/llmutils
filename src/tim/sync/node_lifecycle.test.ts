import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { createWorkerLease } from '../db/sync_schema.js';
import { registerPeerNode } from './node_identity.js';
import { pruneEphemeralNodes } from './node_lifecycle.js';

describe('sync node lifecycle pruning', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-node-lifecycle-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('expires and retires worker nodes only after pending ops are resolved', () => {
    registerPeerNode(db, {
      nodeId: '33333333-3333-4333-8333-333333333333',
      nodeType: 'worker',
    });
    createWorkerLease(db, {
      workerNodeId: '33333333-3333-4333-8333-333333333333',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    db.prepare(
      `
        INSERT INTO sync_pending_op (peer_node_id, op_id, op_json)
        VALUES (?, 'op-1', '{}')
      `
    ).run('33333333-3333-4333-8333-333333333333');

    const first = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
      transientMaxAgeMs: 0,
    });
    expect(first.expiredLeases).toBe(1);
    expect(first.prunedWorkerNodes).toBe(0);
    expect(db.prepare('SELECT status FROM sync_worker_lease').get()).toEqual({
      status: 'expired',
    });

    db.prepare('DELETE FROM sync_pending_op WHERE peer_node_id = ?').run(
      '33333333-3333-4333-8333-333333333333'
    );
    const second = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
      transientMaxAgeMs: 0,
    });
    expect(second.prunedWorkerNodes).toBe(1);
    expect(
      db
        .prepare('SELECT node_type FROM sync_node WHERE node_id = ?')
        .get('33333333-3333-4333-8333-333333333333')
    ).toEqual({
      node_type: 'retired_worker',
    });
    expect(db.prepare('SELECT status FROM sync_worker_lease').get()).toEqual({
      status: 'expired',
    });
  });

  test('prunes old transient nodes without affecting durable mains', () => {
    registerPeerNode(db, {
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeType: 'main',
    });
    registerPeerNode(db, {
      nodeId: '44444444-4444-4444-8444-444444444444',
      nodeType: 'transient',
    });
    db.prepare('UPDATE sync_node SET updated_at = ? WHERE node_type = ?').run(
      '2026-01-01T00:00:00.000Z',
      'transient'
    );

    const result = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
      transientMaxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(result.prunedTransientNodes).toBe(1);
    expect(
      db
        .prepare('SELECT node_type FROM sync_node WHERE node_id = ?')
        .get('11111111-1111-4111-8111-111111111111')
    ).toEqual({ node_type: 'main' });
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_node WHERE node_type = ?').get('transient')
    ).toEqual({ count: 0 });
  });

  test('completed worker lease is retired once pending ops are cleared', () => {
    registerPeerNode(db, {
      nodeId: '55555555-5555-4555-8555-555555555555',
      nodeType: 'worker',
    });
    createWorkerLease(db, {
      workerNodeId: '55555555-5555-4555-8555-555555555555',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    db.prepare("UPDATE sync_worker_lease SET status = 'completed' WHERE worker_node_id = ?").run(
      '55555555-5555-4555-8555-555555555555'
    );
    db.prepare(
      `
        INSERT INTO sync_peer_cursor (
          peer_node_id,
          direction,
          hlc_physical_ms,
          hlc_logical,
          last_op_id
        ) VALUES (?, 'pull', 1, 0, '10')
      `
    ).run('55555555-5555-4555-8555-555555555555');

    // No pending ops — should be retired immediately.
    const result = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.expiredLeases).toBe(0);
    expect(result.prunedWorkerNodes).toBe(1);
    expect(
      db
        .prepare('SELECT node_type FROM sync_node WHERE node_id = ?')
        .get('55555555-5555-4555-8555-555555555555')
    ).toEqual({ node_type: 'retired_worker' });
    expect(
      db
        .prepare('SELECT status FROM sync_worker_lease WHERE worker_node_id = ?')
        .get('55555555-5555-4555-8555-555555555555')
    ).toEqual({ status: 'completed' });
    expect(
      db
        .prepare('SELECT count(*) AS count FROM sync_peer_cursor WHERE peer_node_id = ?')
        .get('55555555-5555-4555-8555-555555555555')
    ).toEqual({ count: 0 });
  });

  test('completed worker lease with pending ops is not pruned', () => {
    registerPeerNode(db, {
      nodeId: '66666666-6666-4666-8666-666666666666',
      nodeType: 'worker',
    });
    createWorkerLease(db, {
      workerNodeId: '66666666-6666-4666-8666-666666666666',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    db.prepare("UPDATE sync_worker_lease SET status = 'completed' WHERE worker_node_id = ?").run(
      '66666666-6666-4666-8666-666666666666'
    );
    db.prepare(
      "INSERT INTO sync_pending_op (peer_node_id, op_id, op_json) VALUES (?, 'op-pending', '{}')"
    ).run('66666666-6666-4666-8666-666666666666');

    const result = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(result.prunedWorkerNodes).toBe(0);
    expect(
      db
        .prepare('SELECT count(*) AS count FROM sync_node WHERE node_id = ?')
        .get('66666666-6666-4666-8666-666666666666')
    ).toEqual({ count: 1 });
  });

  test('recent transient node is not pruned; only old transient nodes are pruned', () => {
    const oldTransientId = '77777777-7777-4777-8777-777777777777';
    const recentTransientId = '88888888-8888-4888-8888-888888888888';

    registerPeerNode(db, { nodeId: oldTransientId, nodeType: 'transient' });
    registerPeerNode(db, { nodeId: recentTransientId, nodeType: 'transient' });

    // Age the old node but leave the recent one untouched.
    db.prepare('UPDATE sync_node SET updated_at = ? WHERE node_id = ?').run(
      '2026-01-01T00:00:00.000Z',
      oldTransientId
    );

    const result = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
      transientMaxAgeMs: 24 * 60 * 60 * 1000, // 1 day
    });

    expect(result.prunedTransientNodes).toBe(1);
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_node WHERE node_id = ?').get(oldTransientId)
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_node WHERE node_id = ?').get(recentTransientId)
    ).toEqual({ count: 1 });
  });

  test('durable main nodes are never pruned', () => {
    registerPeerNode(db, {
      nodeId: '11111111-1111-4111-8111-111111111111',
      nodeType: 'main',
    });
    // Age the peer main node far into the past.
    db.prepare('UPDATE sync_node SET updated_at = ? WHERE node_id = ?').run(
      '2020-01-01T00:00:00.000Z',
      '11111111-1111-4111-8111-111111111111'
    );

    const result = pruneEphemeralNodes(db, {
      now: new Date('2026-02-01T00:00:00.000Z'),
      transientMaxAgeMs: 0,
    });

    expect(result.prunedWorkerNodes).toBe(0);
    expect(result.prunedTransientNodes).toBe(0);
    // The registered peer main node must still be present.
    expect(
      db
        .prepare('SELECT node_type FROM sync_node WHERE node_id = ?')
        .get('11111111-1111-4111-8111-111111111111')
    ).toEqual({ node_type: 'main' });
  });
});
