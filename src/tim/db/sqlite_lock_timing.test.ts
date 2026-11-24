import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { installSlowTransactionLogging, type SlowTransactionEntry } from './sqlite_lock_timing.js';

describe('tim db/sqlite_lock_timing', () => {
  let tempDir: string;
  let dbPath: string;
  let logFile: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sqlite-lock-timing-test-'));
    dbPath = path.join(tempDir, 'test.db');
    logFile = path.join(tempDir, 'logs', 'slow.log');
    db = new Database(dbPath);
    db.run('PRAGMA journal_mode = WAL');
    db.run('CREATE TABLE t (x INTEGER)');
    installSlowTransactionLogging(db, dbPath, { thresholdMs: 20, logFile });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function readEntries(): Promise<SlowTransactionEntry[]> {
    const text = await fs.readFile(logFile, 'utf8').catch(() => '');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SlowTransactionEntry);
  }

  function slowInsert(value: number): number {
    db.prepare('INSERT INTO t VALUES (?)').run(value);
    Bun.sleepSync(40);
    return value;
  }

  test('logs a slow transaction with its mode, duration, and caller', async () => {
    const result = db.transaction(slowInsert).immediate(7);

    expect(result).toBe(7);
    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe('immediate');
    expect(entries[0].holdMs).toBeGreaterThanOrEqual(20);
    expect(entries[0].pid).toBe(process.pid);
    expect(entries[0].db).toBe(dbPath);
    expect(entries[0].stack).toContain('sqlite_lock_timing.test');
    expect(db.query('SELECT x FROM t').all()).toEqual([{ x: 7 }]);
  });

  test('does not log a fast transaction', async () => {
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)');
    })();

    expect(await readEntries()).toEqual([]);
    expect(db.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  test('logs a nested slow transaction once, for the outermost transaction', async () => {
    const inner = db.transaction(slowInsert);
    db.transaction(() => {
      inner(1);
      inner(2);
    }).exclusive();

    const entries = await readEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].mode).toBe('exclusive');
    expect(entries[0].holdMs).toBeGreaterThanOrEqual(80);
    expect(db.query('SELECT x FROM t ORDER BY x').all()).toEqual([{ x: 1 }, { x: 2 }]);
  });

  test('rolls back and rethrows when the body throws, and still logs a slow body', async () => {
    expect(() =>
      db.transaction(() => {
        slowInsert(1);
        throw new Error('boom');
      })()
    ).toThrow('boom');

    expect(db.query('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
    expect(await readEntries()).toHaveLength(1);
  });

  test('a threshold of 0 disables the logging', async () => {
    const other = new Database(dbPath);
    try {
      const original = other.transaction;
      installSlowTransactionLogging(other, dbPath, { thresholdMs: 0, logFile });
      expect(other.transaction).toBe(original);
    } finally {
      other.close(false);
    }
  });
});
