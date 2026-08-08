import type { Database } from 'bun:sqlite';

import { canonicalizePrUrl } from '../../common/github/identifiers.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export const INBOX_ITEM_KINDS = [
  'review_requested',
  'pr_comment',
  'reviewed_pr_comment',
  'pr_merged',
  'pr_approved',
  'ci_failure',
  'merge_queue_removed',
] as const;

export type InboxItemKind = (typeof INBOX_ITEM_KINDS)[number];

export interface InboxItemRow {
  id: number;
  project_id: number | null;
  kind: InboxItemKind;
  pr_url: string;
  pr_number: number | null;
  repo: string | null;
  pr_title: string | null;
  actor: string | null;
  event_count: number;
  summary: string | null;
  dedupe_key: string;
  first_event_at: string;
  last_event_at: string;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

export interface UpsertInboxItemInput {
  projectId?: number | null;
  kind: InboxItemKind;
  prUrl: string;
  prNumber?: number | null;
  repo?: string | null;
  prTitle?: string | null;
  actor?: string | null;
  summary?: string | null;
  dedupeKey?: string;
  eventAt?: string | null;
}

export interface ListRecentInboxItemsOptions {
  projectId: number | 'all';
  limit?: number;
  includeRead?: boolean;
}

export interface MarkAllReadBeforeOptions {
  cutoff: string;
  projectId?: number;
}

function isInboxItemKind(value: unknown): value is InboxItemKind {
  return typeof value === 'string' && (INBOX_ITEM_KINDS as readonly string[]).includes(value);
}

export function upsertInboxItem(db: Database, input: UpsertInboxItemInput): InboxItemRow {
  if (!isInboxItemKind(input.kind)) {
    throw new Error(`Unknown inbox item kind: ${String(input.kind)}`);
  }

  const canonicalPrUrl = canonicalizePrUrl(input.prUrl);
  const dedupeKey = input.dedupeKey ?? `${input.kind}:${canonicalPrUrl}`;
  const row = db
    .prepare(
      `
        INSERT INTO inbox_item (
          project_id,
          kind,
          pr_url,
          pr_number,
          repo,
          pr_title,
          actor,
          summary,
          dedupe_key,
          first_event_at,
          last_event_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE(?, ${SQL_NOW_ISO_UTC}),
          COALESCE(?, ${SQL_NOW_ISO_UTC})
        )
        ON CONFLICT(dedupe_key) DO UPDATE SET
          event_count = event_count + 1,
          last_event_at = excluded.last_event_at,
          summary = COALESCE(excluded.summary, summary),
          actor = COALESCE(excluded.actor, actor),
          pr_title = COALESCE(excluded.pr_title, pr_title),
          updated_at = ${SQL_NOW_ISO_UTC},
          read_at = NULL,
          dismissed_at = NULL
        RETURNING *
      `
    )
    .get(
      input.projectId ?? null,
      input.kind,
      canonicalPrUrl,
      input.prNumber ?? null,
      input.repo ?? null,
      input.prTitle ?? null,
      input.actor ?? null,
      input.summary ?? null,
      dedupeKey,
      input.eventAt ?? null,
      input.eventAt ?? null
    ) as InboxItemRow | null;

  if (!row) {
    throw new Error(`Failed to upsert inbox item with dedupe key ${dedupeKey}`);
  }

  return row;
}

export function listRecentInboxItems(
  db: Database,
  options: ListRecentInboxItemsOptions
): InboxItemRow[] {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Inbox item list limit must be a non-negative integer: ${limit}`);
  }

  const conditions = ['dismissed_at IS NULL'];
  const parameters: Array<number | string> = [];

  if (options.projectId !== 'all') {
    conditions.push('project_id = ?');
    parameters.push(options.projectId);
  }
  if (!options.includeRead) {
    conditions.push('read_at IS NULL');
  }

  parameters.push(limit);
  return db
    .prepare(
      `
        SELECT *
        FROM inbox_item
        WHERE ${conditions.join(' AND ')}
        ORDER BY last_event_at DESC, id DESC
        LIMIT ?
      `
    )
    .all(...parameters) as InboxItemRow[];
}

export function countUnreadInboxItems(
  db: Database,
  options: { projectId: number | 'all' }
): number {
  const conditions = ['read_at IS NULL', 'dismissed_at IS NULL'];
  const parameters: Array<number | string> = [];

  if (options.projectId !== 'all') {
    conditions.push('project_id = ?');
    parameters.push(options.projectId);
  }

  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM inbox_item
        WHERE ${conditions.join(' AND ')}
      `
    )
    .get(...parameters) as { count: number };

  return row.count;
}

function getDistinctProjectIds(rows: Array<{ project_id: number | null }>): number[] {
  return Array.from(
    new Set(rows.flatMap((row) => (row.project_id === null ? [] : [row.project_id])))
  ).sort((left, right) => left - right);
}

export function markInboxItemsRead(db: Database, ids: ReadonlyArray<number>): number[] {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        UPDATE inbox_item
        SET read_at = ${SQL_NOW_ISO_UTC},
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE id IN (${placeholders})
          AND read_at IS NULL
        RETURNING project_id
      `
    )
    .all(...ids) as Array<{ project_id: number | null }>;

  return getDistinctProjectIds(rows);
}

export function markAllReadBefore(db: Database, options: MarkAllReadBeforeOptions): number[] {
  const conditions = ['read_at IS NULL', 'dismissed_at IS NULL', 'last_event_at <= ?'];
  const parameters: Array<number | string> = [options.cutoff];

  if (options.projectId !== undefined) {
    conditions.push('project_id = ?');
    parameters.push(options.projectId);
  }

  const rows = db
    .prepare(
      `
        UPDATE inbox_item
        SET read_at = ${SQL_NOW_ISO_UTC},
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE ${conditions.join(' AND ')}
        RETURNING project_id
      `
    )
    .all(...parameters) as Array<{ project_id: number | null }>;

  return getDistinctProjectIds(rows);
}

export function dismissInboxItem(db: Database, id: number): number[] {
  const rows = db
    .prepare(
      `
        UPDATE inbox_item
        SET dismissed_at = ${SQL_NOW_ISO_UTC},
            read_at = COALESCE(read_at, ${SQL_NOW_ISO_UTC}),
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE id = ?
        RETURNING project_id
      `
    )
    .all(id) as Array<{ project_id: number | null }>;

  return getDistinctProjectIds(rows);
}

export function pruneOldInboxItems(db: Database, maxAgeDays = 30): number {
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 0) {
    throw new Error(`Inbox item maxAgeDays must be a non-negative integer: ${maxAgeDays}`);
  }

  const result = db
    .prepare(
      `
        DELETE FROM inbox_item
        WHERE last_event_at < strftime(
          '%Y-%m-%dT%H:%M:%fZ',
          'now',
          printf('-%d days', ?)
        )
      `
    )
    .run(maxAgeDays);

  return result.changes;
}
