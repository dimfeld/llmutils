import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { createWorkerLease, setPeerCursor } from '../db/sync_schema.js';
import { getCompactionFloorSeq } from './compaction.js';
import { registerPeerNode } from './node_identity.js';

describe('sync compaction metadata floor', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-compaction-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns 0 when no durable peers or active worker leases exist', () => {
    expect(getCompactionFloorSeq(db)).toBe(0);
  });

  test('uses the minimum push cursor across durable main peers', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    registerPeerNode(db, { nodeId: '22222222-2222-4222-8222-222222222222', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '42');
    setPeerCursor(db, '22222222-2222-4222-8222-222222222222', 'push', '17');

    expect(getCompactionFloorSeq(db)).toBe(17);
  });

  test('active worker lease can hold the floor below peer cursors', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '100');
    registerPeerNode(db, { nodeId: '33333333-3333-4333-8333-333333333333', nodeType: 'worker' });
    createWorkerLease(db, {
      workerNodeId: '33333333-3333-4333-8333-333333333333',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      bundleHighWaterSeq: 12,
      leaseExpiresAt: '2026-01-01T00:00:00.000Z',
    });

    expect(getCompactionFloorSeq(db)).toBe(12);
  });

  test('completed worker leases do not hold the floor', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '100');
    registerPeerNode(db, { nodeId: '33333333-3333-4333-8333-333333333333', nodeType: 'worker' });
    createWorkerLease(db, {
      workerNodeId: '33333333-3333-4333-8333-333333333333',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      bundleHighWaterSeq: 12,
      leaseExpiresAt: '2026-01-01T00:00:00.000Z',
    });
    db.prepare("UPDATE sync_worker_lease SET status = 'completed' WHERE worker_node_id = ?").run(
      '33333333-3333-4333-8333-333333333333'
    );

    expect(getCompactionFloorSeq(db)).toBe(100);
  });

  test('durable main peer with no cursor holds the floor at 0', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    registerPeerNode(db, { nodeId: '22222222-2222-4222-8222-222222222222', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '42');

    expect(getCompactionFloorSeq(db)).toBe(0);
  });

  test('active worker lease with no high-water seq holds the floor at 0', () => {
    registerPeerNode(db, { nodeId: '33333333-3333-4333-8333-333333333333', nodeType: 'worker' });
    createWorkerLease(db, {
      workerNodeId: '33333333-3333-4333-8333-333333333333',
      issuingNodeId: '11111111-1111-4111-8111-111111111111',
      bundleHighWaterSeq: null,
      leaseExpiresAt: '2026-01-01T00:00:00.000Z',
    });

    expect(getCompactionFloorSeq(db)).toBe(0);
  });

  test('worker peer cursors are excluded from the durable peer floor', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '50');
    registerPeerNode(db, { nodeId: '33333333-3333-4333-8333-333333333333', nodeType: 'worker' });
    setPeerCursor(db, '33333333-3333-4333-8333-333333333333', 'push', '5');

    expect(getCompactionFloorSeq(db)).toBe(50);
  });

  test('transient peer cursors are excluded from the durable peer floor', () => {
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '50');
    registerPeerNode(db, {
      nodeId: '44444444-4444-4444-8444-444444444444',
      nodeType: 'transient',
    });
    setPeerCursor(db, '44444444-4444-4444-8444-444444444444', 'push', '5');

    expect(getCompactionFloorSeq(db)).toBe(50);
  });

  test('local node cursor is excluded from the durable peer floor', () => {
    // The local node is created automatically by openDatabase; set a push cursor for it
    // to verify it does not lower the floor.
    const localNode = db.prepare(`SELECT node_id FROM sync_node WHERE is_local = 1`).get() as {
      node_id: string;
    };
    expect(localNode).toBeTruthy();
    setPeerCursor(db, localNode.node_id, 'push', '5');

    // One remote main peer with a higher cursor
    registerPeerNode(db, { nodeId: '11111111-1111-4111-8111-111111111111', nodeType: 'main' });
    setPeerCursor(db, '11111111-1111-4111-8111-111111111111', 'push', '99');

    // Floor should be 99 (only the remote peer), not 5 (local node excluded)
    expect(getCompactionFloorSeq(db)).toBe(99);
  });
});
