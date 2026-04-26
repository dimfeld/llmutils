import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';

describe('tim db/sync_schema migration', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-schema-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates sync tables on a fresh database', () => {
    const tables = db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'sync_%'
          ORDER BY name
        `
      )
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toEqual([
      'sync_clock',
      'sync_field_clock',
      'sync_node',
      'sync_op_log',
      'sync_peer_cursor',
      'sync_pending_op',
      'sync_tombstone',
      'sync_worker_lease',
    ]);

    const nodeColumns = db.prepare("PRAGMA table_info('sync_node')").all() as Array<{
      name: string;
    }>;
    expect(nodeColumns.map((column) => column.name)).toEqual([
      'node_id',
      'node_type',
      'is_local',
      'label',
      'lease_expires_at',
      'created_at',
      'updated_at',
    ]);

    const clockColumns = db.prepare("PRAGMA table_info('sync_clock')").all() as Array<{
      name: string;
    }>;
    expect(clockColumns.map((column) => column.name)).toEqual([
      'id',
      'physical_ms',
      'logical',
      'local_counter',
      'updated_at',
      'bootstrap_completed_at',
    ]);
  });

  test('sync_pending_op has the expected primary key', () => {
    const columns = db.prepare("PRAGMA table_info('sync_pending_op')").all() as Array<{
      name: string;
      pk: number;
    }>;

    expect(
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name)
    ).toEqual(['peer_node_id', 'op_id']);
  });

  test('allows at most one local sync node', () => {
    // openDatabase already initialized one local node — attempting to insert a second must fail.
    const existing = db
      .prepare('SELECT count(*) AS count FROM sync_node WHERE is_local = 1')
      .get() as { count: number };
    expect(existing.count).toBe(1);

    expect(() =>
      db
        .prepare(
          `
            INSERT INTO sync_node (node_id, node_type, is_local)
            VALUES ('node-2', 'main', 1)
          `
        )
        .run()
    ).toThrow();
  });

  test('cascades peer cursors when a peer node is deleted', () => {
    db.prepare(
      `
        INSERT INTO sync_node (node_id, node_type, is_local)
        VALUES ('peer-1', 'main', 0)
      `
    ).run();
    db.prepare(
      `
        INSERT INTO sync_peer_cursor (peer_node_id, direction, hlc_physical_ms, hlc_logical)
        VALUES ('peer-1', 'pull', 10, 2)
      `
    ).run();

    db.prepare("DELETE FROM sync_node WHERE node_id = 'peer-1'").run();

    const count = db
      .prepare("SELECT count(*) AS count FROM sync_peer_cursor WHERE peer_node_id = 'peer-1'")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });

  test('sync_op_log has the expected indexes', () => {
    const indexes = db.prepare("PRAGMA index_list('sync_op_log')").all() as Array<{
      name: string;
      unique: number;
    }>;

    const indexNames = indexes.map((idx) => idx.name).sort();

    expect(indexNames).toContain('idx_sync_op_log_order');
    expect(indexNames).toContain('idx_sync_op_log_entity');
    expect(indexNames).toContain('idx_sync_op_log_origin');
  });

  test('sync_clock CHECK constraint rejects id != 1', () => {
    expect(() =>
      db
        .prepare(
          `
            INSERT INTO sync_clock (id, physical_ms, logical, local_counter, updated_at)
            VALUES (2, 0, 0, 0, datetime('now'))
          `
        )
        .run()
    ).toThrow();
  });
});
