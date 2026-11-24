import type { Database } from 'bun:sqlite';
import { logSlowSqliteOperation } from './sqlite_lock_timing.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface WebhookLogEntry {
  deliveryId: string;
  eventType: string;
  action: string | null;
  repositoryFullName: string | null;
  payloadJson: string;
  receivedAt: string;
}

export function insertWebhookLogEntry(db: Database, entry: WebhookLogEntry): { inserted: boolean } {
  const result = db
    .prepare(
      `
        INSERT OR IGNORE INTO webhook_log (
          delivery_id,
          event_type,
          action,
          repository_full_name,
          payload_json,
          received_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      entry.deliveryId,
      entry.eventType,
      entry.action,
      entry.repositoryFullName,
      entry.payloadJson,
      entry.receivedAt
    );

  return {
    inserted: result.changes > 0,
  };
}

export function getWebhookCursor(db: Database): number {
  const row = db.prepare('SELECT last_event_id FROM webhook_cursor WHERE id = 1').get() as {
    last_event_id?: number;
  } | null;

  return row?.last_event_id ?? 0;
}

export function updateWebhookCursor(db: Database, lastEventId: number): void {
  db.prepare(
    `
      UPDATE webhook_cursor
      SET last_event_id = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = 1
    `
  ).run(lastEventId);
}

const PRUNE_BATCH_SIZE = 500;

/**
 * Delete webhook log entries older than `maxAgeDays`. Rows can hold large payloads, so the
 * delete runs in small batches. Each batch is its own statement, so other processes can
 * take the write lock between batches.
 */
export function pruneOldWebhookLogs(
  db: Database,
  maxAgeDays = 7,
  options: { batchSize?: number; now?: Date } = {}
): number {
  const batchSize = Math.max(1, options.batchSize ?? PRUNE_BATCH_SIZE);
  const cutoff = new Date(
    (options.now ?? new Date()).getTime() - maxAgeDays * 24 * 60 * 60 * 1000
  ).toISOString();
  const deleteBatch = db.prepare(
    `
      DELETE FROM webhook_log
      WHERE id IN (
        SELECT id FROM webhook_log
        WHERE ingested_at < ?
        ORDER BY ingested_at
        LIMIT ?
      )
    `
  );

  let total = 0;
  let slowestBatchMs = 0;
  for (;;) {
    const start = performance.now();
    const { changes } = deleteBatch.run(cutoff, batchSize);
    slowestBatchMs = Math.max(slowestBatchMs, performance.now() - start);
    total += changes;
    if (changes < batchSize) {
      break;
    }
  }
  logSlowSqliteOperation(db.filename, 'pruneOldWebhookLogs batch', slowestBatchMs);

  if (total) {
    console.log(
      `[webhook-ingest] Pruned ${total} webhook log entries older than ${maxAgeDays} days`
    );
  }
  return total;
}
