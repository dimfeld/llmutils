import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getOrCreateClockRow } from '../db/sync_schema.js';
import { compareHlc, formatHlc, formatOpId, HlcGenerator, parseHlc, parseOpId } from './hlc.js';

describe('tim sync/hlc', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-hlc-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('compares HLC values by physical time then logical counter', () => {
    expect(compareHlc({ physicalMs: 1, logical: 0 }, { physicalMs: 2, logical: 0 })).toBeLessThan(
      0
    );
    expect(
      compareHlc({ physicalMs: 2, logical: 1 }, { physicalMs: 2, logical: 0 })
    ).toBeGreaterThan(0);
    expect(compareHlc({ physicalMs: 2, logical: 1 }, { physicalMs: 2, logical: 1 })).toBe(0);
  });

  test('formats HLC values so lexical order matches numeric order', () => {
    const formatted = [
      { physicalMs: 1000, logical: 0 },
      { physicalMs: 999, logical: 999 },
      { physicalMs: 1000, logical: 1 },
    ]
      .map(formatHlc)
      .sort();

    expect(formatted).toEqual([
      '0000000000000999.00000999',
      '0000000000001000.00000000',
      '0000000000001000.00000001',
    ]);
    expect(parseHlc(formatted[0])).toEqual({ physicalMs: 999, logical: 999 });
  });

  test('tick remains monotonic when wall time moves backwards', () => {
    const generator = new HlcGenerator(db, 'node-a');

    const first = generator.tick(1000);
    const second = generator.tick(900);

    expect(first.hlc).toEqual({ physicalMs: 1000, logical: 0 });
    expect(second.hlc).toEqual({ physicalMs: 1000, logical: 1 });
    expect(second.localCounter).toBe(first.localCounter + 1);
  });

  test('tick can persist inside a caller transaction', () => {
    const generator = new HlcGenerator(db, 'node-a');
    const runInTransaction = db.transaction(() => generator.tick(1000, db));

    const result = runInTransaction.immediate();

    expect(result.hlc).toEqual({ physicalMs: 1000, logical: 0 });
    expect(getOrCreateClockRow(db).local_counter).toBe(1);
  });

  test('observe advances physical and logical counters for remote clocks', () => {
    const generator = new HlcGenerator(db, 'node-a');

    generator.tick(1000);
    generator.observe({ physicalMs: 2000, logical: 4 }, 1500);

    const afterRemoteAhead = getOrCreateClockRow(db);
    expect(afterRemoteAhead.physical_ms).toBe(2000);
    expect(afterRemoteAhead.logical).toBe(5);
    expect(afterRemoteAhead.local_counter).toBe(1);

    generator.observe({ physicalMs: 2000, logical: 2 }, 1500);
    const afterSamePhysical = getOrCreateClockRow(db);
    expect(afterSamePhysical.physical_ms).toBe(2000);
    expect(afterSamePhysical.logical).toBe(6);
  });

  test('formatOpId and parseOpId round trip', () => {
    const hlc = { physicalMs: 1234, logical: 5 };
    const opId = formatOpId(hlc, 'node-123', 42);

    expect(opId).toBe('0000000000001234.00000005/node-123/42');
    expect(parseOpId(opId)).toEqual({
      hlc,
      nodeId: 'node-123',
      localCounter: 42,
    });
  });
});
