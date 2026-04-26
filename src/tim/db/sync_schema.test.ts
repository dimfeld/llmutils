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
      'sync_tombstone',
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
  });

  test('allows at most one local sync node', () => {
    db.prepare(
      `
        INSERT INTO sync_node (node_id, node_type, is_local)
        VALUES ('node-1', 'main', 1)
      `
    ).run();

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
});
