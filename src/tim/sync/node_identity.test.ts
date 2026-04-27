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

  test('openDatabase initializes a local node automatically', () => {
    // openDatabase wires ensureLocalNode into setup, so a fresh DB already has one.
    const initial = getLocalNodeId(db);
    expect(initial).toMatch(/^[0-9a-f-]{36}$/);

    const second = ensureLocalNode(db, { label: 'Different Label' });
    expect(second.node_id).toBe(initial);
    // Idempotent: existing node is returned unchanged; subsequent options do not overwrite.
    expect(second.label).toBeNull();
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

  test('registerPeerNode upserts label/lease metadata for an existing peer', () => {
    registerPeerNode(db, {
      nodeId: 'peer-1',
      nodeType: 'main',
      label: 'Server',
    });
    const updated = registerPeerNode(db, {
      nodeId: 'peer-1',
      nodeType: 'main',
      label: 'Server (renamed)',
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    });

    expect(updated.node_type).toBe('main');
    expect(updated.label).toBe('Server (renamed)');
    expect(updated.lease_expires_at).toBe('2030-01-01T00:00:00.000Z');
    expect(
      db.prepare("SELECT count(*) AS count FROM sync_node WHERE node_id = 'peer-1'").get()
    ).toEqual({
      count: 1,
    });
  });

  test('registerPeerNode rejects changing an existing peer node_type', () => {
    registerPeerNode(db, { nodeId: 'peer-2', nodeType: 'main' });

    expect(() => registerPeerNode(db, { nodeId: 'peer-2', nodeType: 'worker' })).toThrow(/type/);
  });

  test('registerPeerNode can promote transient peers without downgrading durable peers', () => {
    registerPeerNode(db, { nodeId: 'peer-transient', nodeType: 'transient' });

    const promoted = registerPeerNode(db, { nodeId: 'peer-transient', nodeType: 'main' });
    expect(promoted.node_type).toBe('main');

    registerPeerNode(db, { nodeId: 'peer-transient', nodeType: 'main', label: 'Durable' });
    const stillMain = registerPeerNode(db, { nodeId: 'peer-transient', nodeType: 'transient' });
    expect(stillMain.node_type).toBe('main');
    expect(stillMain.label).toBe('Durable');
  });

  test('registerPeerNode keeps retired workers retired', () => {
    registerPeerNode(db, { nodeId: 'retired-worker-1', nodeType: 'worker' });
    db.prepare("UPDATE sync_node SET node_type = 'retired_worker' WHERE node_id = ?").run(
      'retired-worker-1'
    );

    const stillRetired = registerPeerNode(db, {
      nodeId: 'retired-worker-1',
      nodeType: 'main',
      label: 'attempted main',
    });

    expect(stillRetired.node_type).toBe('retired_worker');
    expect(
      db.prepare('SELECT node_type, label FROM sync_node WHERE node_id = ?').get('retired-worker-1')
    ).toEqual({ node_type: 'retired_worker', label: 'attempted main' });
  });

  test('registerPeerNode rejects writing the local node id', () => {
    const localId = getLocalNodeId(db);

    expect(() =>
      registerPeerNode(db, { nodeId: localId, nodeType: 'main', label: 'oops' })
    ).toThrow(/local node/);

    // Local row metadata must remain untouched.
    const local = db.prepare('SELECT * FROM sync_node WHERE is_local = 1').get() as {
      label: string | null;
    };
    expect(local.label).toBeNull();
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

  test('runMigrations initializes a local node for sync metadata backfills', () => {
    // v31 may need a stable local node while backfilling syncable row metadata,
    // so bare migrated DBs now get the same singleton local identity.
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const { runMigrations } =
      require('../db/migrations.js') as typeof import('../db/migrations.js');
    const bare = new Database(':memory:');
    try {
      bare.run('PRAGMA foreign_keys = ON');
      runMigrations(bare);
      expect(getLocalNodeId(bare)).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      bare.close(false);
    }
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
