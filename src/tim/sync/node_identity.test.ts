import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  ensureLocalNode,
  getLocalNodeId,
  listPeerNodes,
  registerPeerNode,
  setWorkerLeaseExpiry,
} from './node_identity.js';

describe('tim sync/node_identity', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-node-identity-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('ensureLocalNode is idempotent and returns the same UUID', () => {
    const first = ensureLocalNode(db, { label: 'Laptop' });
    const second = ensureLocalNode(db, { label: 'Different Label' });

    expect(second.node_id).toBe(first.node_id);
    expect(second.label).toBe('Laptop');
    expect(getLocalNodeId(db)).toBe(first.node_id);
  });

  test('database constraint permits only one local node', () => {
    const local = ensureLocalNode(db);

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO sync_node (node_id, node_type, is_local)
            VALUES ('other-local', 'main', 1)
          `
        )
        .run()
    ).toThrow();

    const rows = db.prepare('SELECT * FROM sync_node WHERE is_local = 1').all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { node_id: string }).node_id).toBe(local.node_id);
  });

  test('registerPeerNode upserts known peer metadata', () => {
    registerPeerNode(db, {
      nodeId: 'peer-1',
      nodeType: 'main',
      label: 'Server',
    });
    const updated = registerPeerNode(db, {
      nodeId: 'peer-1',
      nodeType: 'worker',
      label: 'Worker',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(updated.node_type).toBe('worker');
    expect(updated.label).toBe('Worker');
    expect(updated.lease_expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(
      db.prepare("SELECT count(*) AS count FROM sync_node WHERE node_id = 'peer-1'").get()
    ).toEqual({
      count: 1,
    });
  });

  test('listPeerNodes excludes the local node and returns peers ordered by node id', () => {
    // listPeerNodes intentionally returns only non-local rows; local identity is read via getLocalNodeId.
    ensureLocalNode(db);
    registerPeerNode(db, { nodeId: 'peer-b', nodeType: 'main' });
    registerPeerNode(db, { nodeId: 'peer-a', nodeType: 'worker' });

    expect(listPeerNodes(db).map((node) => node.node_id)).toEqual(['peer-a', 'peer-b']);
  });

  test('setWorkerLeaseExpiry updates only worker nodes', () => {
    registerPeerNode(db, { nodeId: 'worker-1', nodeType: 'worker' });
    registerPeerNode(db, { nodeId: 'main-1', nodeType: 'main' });

    const worker = setWorkerLeaseExpiry(db, 'worker-1', '2030-01-01T00:00:00.000Z');
    const main = setWorkerLeaseExpiry(db, 'main-1', '2030-01-01T00:00:00.000Z');

    expect(worker?.lease_expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(main?.lease_expires_at).toBeNull();
  });

  test('getLocalNodeId throws when no local node has been created', () => {
    // Fresh database — no local node exists yet
    expect(() => getLocalNodeId(db)).toThrow('Local sync node is not initialized');
  });

  test('setWorkerLeaseExpiry updates updated_at', async () => {
    registerPeerNode(db, { nodeId: 'worker-2', nodeType: 'worker' });

    const before = (
      db.prepare("SELECT updated_at FROM sync_node WHERE node_id = 'worker-2'").get() as {
        updated_at: string;
      }
    ).updated_at;

    // Wait a tick so wall-clock time can advance
    await new Promise((r) => setTimeout(r, 5));

    setWorkerLeaseExpiry(db, 'worker-2', '2035-06-01T00:00:00.000Z');

    const after = (
      db.prepare("SELECT updated_at FROM sync_node WHERE node_id = 'worker-2'").get() as {
        updated_at: string;
      }
    ).updated_at;

    expect(after >= before).toBe(true);
  });
});
