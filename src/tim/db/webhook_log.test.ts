import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  getWebhookCursor,
  insertWebhookLogEntry,
  pruneOldWebhookLogs,
  updateWebhookCursor,
} from './webhook_log.js';

describe('tim db/webhook_log', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-webhook-log-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('insertWebhookLogEntry inserts once per delivery id', () => {
    expect(
      insertWebhookLogEntry(db, {
        deliveryId: 'delivery-1',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        payloadJson: '{"number":1}',
        receivedAt: '2026-03-30T00:00:00.000Z',
      })
    ).toEqual({ inserted: true });

    expect(
      insertWebhookLogEntry(db, {
        deliveryId: 'delivery-1',
        eventType: 'pull_request',
        action: 'synchronize',
        repositoryFullName: 'example/repo',
        payloadJson: '{"number":1}',
        receivedAt: '2026-03-30T00:01:00.000Z',
      })
    ).toEqual({ inserted: false });

    const storedRows = db
      .query<{ action: string; received_at: string }, []>(
        `
          SELECT action, received_at
          FROM webhook_log
          WHERE delivery_id = 'delivery-1'
        `
      )
      .all();

    expect(storedRows).toEqual([
      {
        action: 'opened',
        received_at: '2026-03-30T00:00:00.000Z',
      },
    ]);
  });

  test('getWebhookCursor and updateWebhookCursor read and persist the single cursor row', () => {
    expect(getWebhookCursor(db)).toBe(0);

    updateWebhookCursor(db, 123);

    expect(getWebhookCursor(db)).toBe(123);
  });

  test('pruneOldWebhookLogs removes old ingested entries', () => {
    db.prepare(
      `
        INSERT INTO webhook_log (
          delivery_id,
          event_type,
          action,
          repository_full_name,
          payload_json,
          received_at,
          ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'delivery-old',
      'pull_request',
      'opened',
      'example/repo',
      '{"number":1}',
      '2026-02-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z'
    );
    db.prepare(
      `
        INSERT INTO webhook_log (
          delivery_id,
          event_type,
          action,
          repository_full_name,
          payload_json,
          received_at,
          ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      'delivery-new',
      'check_run',
      'completed',
      'example/repo',
      '{"name":"tests"}',
      '2026-03-30T00:00:00.000Z',
      '2099-03-30T00:00:00.000Z'
    );

    expect(pruneOldWebhookLogs(db)).toBe(1);
    const remainingRows = db
      .query<
        { delivery_id: string },
        []
      >('SELECT delivery_id FROM webhook_log ORDER BY delivery_id')
      .all();

    expect(remainingRows).toEqual([{ delivery_id: 'delivery-new' }]);
  });
});
