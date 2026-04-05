import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';

export interface StoredWebhookEvent {
  id: number;
  deliveryId: string;
  eventType: string;
  action: string | null;
  installationId: number | null;
  repositoryFullName: string | null;
  payloadJson: string;
  receivedAt: string;
  ackedAt: string | null;
  lastError: string | null;
}

export interface NewWebhookEventInput {
  deliveryId: string;
  eventType: string;
  action?: string | null;
  installationId?: number | null;
  repositoryFullName?: string | null;
  payloadJson: string;
}

export class WebhookEventStore {
  private readonly db: Database;
  private lastPrunedAt: number | null = null;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        action TEXT,
        installation_id INTEGER,
        repository_full_name TEXT,
        payload_json TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        acked_at TEXT,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_event_acked_id
        ON webhook_event(acked_at, id);

      CREATE INDEX IF NOT EXISTS idx_webhook_event_repo_id
        ON webhook_event(repository_full_name, id);
    `);
  }

  public insertEvent(input: NewWebhookEventInput): { inserted: boolean; id?: number } {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO webhook_event (
        delivery_id,
        event_type,
        action,
        installation_id,
        repository_full_name,
        payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = statement.run(
      input.deliveryId,
      input.eventType,
      input.action ?? null,
      input.installationId ?? null,
      input.repositoryFullName ?? null,
      input.payloadJson
    );

    if (result.changes === 0) {
      return { inserted: false };
    }

    return { inserted: true, id: Number(result.lastInsertRowid) };
  }

  public listEvents(options?: {
    afterId?: number;
    limit?: number;
    includeAcked?: boolean;
  }): StoredWebhookEvent[] {
    const afterId = options?.afterId ?? 0;
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const includeAcked = options?.includeAcked ?? false;

    const query = includeAcked
      ? `
          SELECT *
          FROM webhook_event
          WHERE id > ?
          ORDER BY id ASC
          LIMIT ?
        `
      : `
          SELECT *
          FROM webhook_event
          WHERE id > ?
            AND acked_at IS NULL
          ORDER BY id ASC
          LIMIT ?
        `;

    const rows = this.db.prepare(query).all(afterId, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapRow(row));
  }

  public acknowledgeEvents(deliveryIds: string[]): number {
    if (deliveryIds.length === 0) {
      return 0;
    }

    const placeholders = deliveryIds.map(() => '?').join(', ');
    const statement = this.db.prepare(`
      UPDATE webhook_event
      SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE delivery_id IN (${placeholders})
    `);
    const result = statement.run(...deliveryIds);
    return result.changes;
  }

  public shouldPruneOldEvents(): boolean {
    if (!this.lastPrunedAt) {
      return true; // Never pruned before
    }

    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    return this.lastPrunedAt < oneDayAgo;
  }

  public pruneOldEvents(): number {
    const deletedCount = this.db
      .prepare(
        `
      DELETE FROM webhook_event
      WHERE received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 month')
    `
      )
      .run().changes;

    // Update the in-memory timestamp
    this.lastPrunedAt = Date.now();

    return deletedCount;
  }

  public close(): void {
    this.db.close();
  }

  private mapRow(row: Record<string, unknown>): StoredWebhookEvent {
    return {
      id: Number(row.id),
      deliveryId: String(row.delivery_id),
      eventType: String(row.event_type),
      action: (row.action as string | null) ?? null,
      installationId: (row.installation_id as number | null) ?? null,
      repositoryFullName: (row.repository_full_name as string | null) ?? null,
      payloadJson: String(row.payload_json),
      receivedAt: String(row.received_at),
      ackedAt: (row.acked_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
    };
  }
}
