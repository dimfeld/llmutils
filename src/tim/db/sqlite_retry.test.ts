import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { isSqliteBusyError, retryOnSqliteBusy } from './sqlite_retry.js';

describe('tim db/sqlite_retry', () => {
  let tempDir: string;
  let holder: Database;
  let writer: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sqlite-retry-test-'));
    const dbPath = path.join(tempDir, 'test.db');
    holder = new Database(dbPath);
    holder.run('PRAGMA journal_mode = WAL');
    holder.run('CREATE TABLE t (x INTEGER)');
    writer = new Database(dbPath);
    writer.run('PRAGMA busy_timeout = 10');
  });

  afterEach(async () => {
    if (holder.inTransaction) {
      holder.run('ROLLBACK');
    }
    holder.close(false);
    writer.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function captureBusyError(): unknown {
    holder.run('BEGIN IMMEDIATE');
    try {
      writer.run('INSERT INTO t VALUES (1)');
    } catch (err) {
      return err;
    } finally {
      holder.run('ROLLBACK');
    }
    throw new Error('Expected SQLITE_BUSY');
  }

  test('isSqliteBusyError recognizes a real lock error', () => {
    expect(isSqliteBusyError(captureBusyError())).toBe(true);
  });

  test('isSqliteBusyError rejects other errors', () => {
    expect(isSqliteBusyError(new Error('no such table: t'))).toBe(false);
    expect(isSqliteBusyError('database is locked')).toBe(false);
    expect(isSqliteBusyError(undefined)).toBe(false);
  });

  test('retries until the lock is released', async () => {
    holder.run('BEGIN IMMEDIATE');
    let attempts = 0;

    const result = await retryOnSqliteBusy(
      () => {
        attempts++;
        if (attempts === 2) {
          holder.run('ROLLBACK');
        }
        writer.run('INSERT INTO t VALUES (1)');
        return 'ok';
      },
      { attempts: 3, initialDelayMs: 1 }
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(writer.query('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 });
  });

  test('throws the busy error after the last attempt', async () => {
    holder.run('BEGIN IMMEDIATE');
    let attempts = 0;

    const err = await retryOnSqliteBusy(
      () => {
        attempts++;
        writer.run('INSERT INTO t VALUES (1)');
      },
      { attempts: 3, initialDelayMs: 1 }
    ).catch((e: unknown) => e);

    expect(isSqliteBusyError(err)).toBe(true);
    expect(attempts).toBe(3);
  });

  test('does not retry other errors', async () => {
    let attempts = 0;

    await expect(
      retryOnSqliteBusy(
        () => {
          attempts++;
          throw new Error('boom');
        },
        { attempts: 3, initialDelayMs: 1 }
      )
    ).rejects.toThrow('boom');
    expect(attempts).toBe(1);
  });
});
