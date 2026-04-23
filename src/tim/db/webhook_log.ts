import type { Database } from 'bun:sqlite';
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

export function pruneOldWebhookLogs(db: Database, maxAgeDays = 7): number {
  const result = db
    .prepare(
      `
        DELETE FROM webhook_log
        WHERE ingested_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', printf('-%d days', ?))
      `
    )
    .run(maxAgeDays);

  if (result.changes) {
    console.log(
      `[webhook-ingest] Pruned ${result.changes} webhook log entries older than ${maxAgeDays} days`
    );
  }
  return result.changes;
}
