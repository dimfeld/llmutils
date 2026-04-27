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

  test('expires and prunes worker nodes only after pending ops are resolved', () => {
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
      db.prepare('SELECT count(*) AS count FROM sync_node WHERE node_type = ?').get('worker')
    ).toEqual({
      count: 0,
    });
    expect(db.prepare('SELECT count(*) AS count FROM sync_worker_lease').get()).toEqual({
      count: 0,
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
});
