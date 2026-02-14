import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  closeDatabaseForTesting,
  getDatabase,
  getDefaultDatabasePath,
  openDatabase,
} from './database.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('tim db/database', () => {
  let tempDir: string;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(async () => {
    tempDir = await createTempDir('tim-db-test-');
    closeDatabaseForTesting();
  });

  afterEach(async () => {
    closeDatabaseForTesting();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('openDatabase initializes pragmas and schema', () => {
    const dbPath = path.join(tempDir, 'tim.db');
    const db = openDatabase(dbPath);

    const journalMode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(journalMode?.journal_mode).toBe('wal');

    const foreignKeys = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get();
    expect(foreignKeys?.foreign_keys).toBe(1);

    const busyTimeout = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get();
    expect(busyTimeout?.timeout).toBe(5000);

    const synchronous = db.query<{ synchronous: number }, []>('PRAGMA synchronous').get();
    expect(synchronous?.synchronous).toBe(1);

    const version = db
      .query<
        { version: number; import_completed: number },
        []
      >('SELECT version, import_completed FROM schema_version')
      .get();
    expect(version?.version).toBe(2);
    expect(version?.import_completed).toBe(1);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain('schema_version');
    expect(tables).toContain('project');
    expect(tables).toContain('workspace');
    expect(tables).toContain('workspace_issue');
    expect(tables).toContain('workspace_lock');
    expect(tables).toContain('permission');
    expect(tables).toContain('assignment');

    const indices = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"
      )
      .all()
      .map((row) => row.name);
    expect(indices).toContain('idx_workspace_project_id');
    expect(indices).toContain('idx_permission_project_id');
    expect(indices).toContain('idx_assignment_workspace_id');

    db.close(false);
  });

  test('openDatabase is idempotent across repeated opens', () => {
    const dbPath = path.join(tempDir, 'tim.db');

    const db1 = openDatabase(dbPath);
    db1.close(false);

    const db2 = openDatabase(dbPath);
    const version = db2
      .query<
        { version: number; import_completed: number },
        []
      >('SELECT version, import_completed FROM schema_version')
      .get();
    expect(version?.version).toBe(2);
    expect(version?.import_completed).toBe(1);
    const versionRowCount = db2
      .query<{ count: number }, []>('SELECT count(*) as count FROM schema_version')
      .get();
    expect(versionRowCount?.count).toBe(1);
    db2.close(false);
  });

  test('getDatabase returns singleton and closeDatabaseForTesting resets it', () => {
    process.env.XDG_CONFIG_HOME = tempDir;

    const db1 = getDatabase();
    const db2 = getDatabase();
    expect(db1).toBe(db2);

    closeDatabaseForTesting();
    expect(() => db1.query('SELECT 1').get()).toThrow();

    const db3 = getDatabase();
    expect(db3).not.toBe(db1);

    closeDatabaseForTesting();
  });

  test('getDefaultDatabasePath resolves under tim config root', () => {
    process.env.XDG_CONFIG_HOME = tempDir;
    expect(getDefaultDatabasePath()).toBe(path.join(tempDir, 'tim', 'tim.db'));
  });
});
