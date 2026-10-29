import type { Database } from 'bun:sqlite';

import type { PrStatusRow } from './pr_status.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type PrShepherdSource = 'auto' | 'manual';

export interface PrShepherdRow {
  pr_status_id: number;
  source: PrShepherdSource;
  enrolled_at: string;
  /** Set when the user removed the PR. The row stays so auto-enroll does not add it again. */
  removed_at: string | null;
  /** JSON array of the notification flags that were active at the last notification pass. */
  notified_flags: string | null;
  updated_at: string;
  /** Set while the shepherd bot watches the PR. */
  bot_enabled_at: string | null;
  /** JSON snapshot of the PR state that the bot trigger logic saw last. */
  bot_snapshot: string | null;
}

export interface ShepherdedPr {
  shepherd: PrShepherdRow;
  status: PrStatusRow;
}

function isPrShepherdSource(value: unknown): value is PrShepherdSource {
  return value === 'auto' || value === 'manual';
}

export function getPrShepherd(db: Database, prStatusId: number): PrShepherdRow | null {
  return (
    (db
      .prepare('SELECT * FROM pr_shepherd WHERE pr_status_id = ?')
      .get(prStatusId) as PrShepherdRow | null) ?? null
  );
}

/**
 * Add a PR to the shepherd list.
 *
 * A manual enrollment always makes the PR active again, also after the user removed it.
 * An automatic enrollment never adds back a PR that the user removed.
 *
 * Returns true when the PR is active after the call.
 */
export function enrollPrShepherd(
  db: Database,
  prStatusId: number,
  source: PrShepherdSource
): boolean {
  if (!isPrShepherdSource(source)) {
    throw new Error(`Unknown PR shepherd source: ${String(source)}`);
  }

  if (source === 'manual') {
    db.prepare(
      `
        INSERT INTO pr_shepherd (pr_status_id, source)
        VALUES (?, 'manual')
        ON CONFLICT(pr_status_id) DO UPDATE SET
          source = 'manual',
          removed_at = NULL,
          enrolled_at = CASE WHEN pr_shepherd.removed_at IS NULL
            THEN pr_shepherd.enrolled_at
            ELSE ${SQL_NOW_ISO_UTC} END,
          notified_flags = CASE WHEN pr_shepherd.removed_at IS NULL
            THEN pr_shepherd.notified_flags
            ELSE NULL END,
          updated_at = ${SQL_NOW_ISO_UTC}
      `
    ).run(prStatusId);
    return true;
  }

  db.prepare(
    `
      INSERT INTO pr_shepherd (pr_status_id, source)
      VALUES (?, 'auto')
      ON CONFLICT(pr_status_id) DO NOTHING
    `
  ).run(prStatusId);
  return getPrShepherd(db, prStatusId)?.removed_at === null;
}

/** Mark a PR as removed by the user. Returns true when an active row changed. */
export function removePrShepherd(db: Database, prStatusId: number): boolean {
  const result = db
    .prepare(
      `
        UPDATE pr_shepherd
        SET removed_at = ${SQL_NOW_ISO_UTC},
            bot_enabled_at = NULL,
            bot_snapshot = NULL,
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE pr_status_id = ?
          AND removed_at IS NULL
      `
    )
    .run(prStatusId);
  return result.changes > 0;
}

/** Active (not removed) shepherd rows for the given PR status IDs. */
export function getActivePrShepherdsByPrStatusIds(
  db: Database,
  prStatusIds: readonly number[]
): Map<number, PrShepherdRow> {
  const result = new Map<number, PrShepherdRow>();
  const uniqueIds = [...new Set(prStatusIds)];
  const CHUNK_SIZE = 500;
  for (let i = 0; i < uniqueIds.length; i += CHUNK_SIZE) {
    const chunk = uniqueIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `
          SELECT *
          FROM pr_shepherd
          WHERE removed_at IS NULL
            AND pr_status_id IN (${placeholders})
        `
      )
      .all(...chunk) as PrShepherdRow[];
    for (const row of rows) {
      result.set(row.pr_status_id, row);
    }
  }
  return result;
}

function mapShepherdedRows(rows: Array<Record<string, unknown>>): ShepherdedPr[] {
  return rows.map((row) => {
    const {
      shepherd_source,
      shepherd_enrolled_at,
      shepherd_removed_at,
      shepherd_notified_flags,
      shepherd_updated_at,
      shepherd_bot_enabled_at,
      shepherd_bot_snapshot,
      ...status
    } = row;
    const statusRow = status as unknown as PrStatusRow;
    return {
      status: statusRow,
      shepherd: {
        pr_status_id: statusRow.id,
        source: shepherd_source as PrShepherdSource,
        enrolled_at: shepherd_enrolled_at as string,
        removed_at: shepherd_removed_at as string | null,
        notified_flags: shepherd_notified_flags as string | null,
        updated_at: shepherd_updated_at as string,
        bot_enabled_at: (shepherd_bot_enabled_at as string | null) ?? null,
        bot_snapshot: (shepherd_bot_snapshot as string | null) ?? null,
      },
    };
  });
}

const SHEPHERDED_SELECT = `
  SELECT ps.*,
    sh.source AS shepherd_source,
    sh.enrolled_at AS shepherd_enrolled_at,
    sh.removed_at AS shepherd_removed_at,
    sh.notified_flags AS shepherd_notified_flags,
    sh.updated_at AS shepherd_updated_at,
    sh.bot_enabled_at AS shepherd_bot_enabled_at,
    sh.bot_snapshot AS shepherd_bot_snapshot
  FROM pr_shepherd sh
  INNER JOIN pr_status ps ON ps.id = sh.pr_status_id
  WHERE sh.removed_at IS NULL
`;

/** All active shepherd rows for open PRs, joined with their PR status rows. */
export function listOpenShepherdedPrs(db: Database): ShepherdedPr[] {
  const rows = db
    .prepare(`${SHEPHERDED_SELECT} AND ps.state = 'open' ORDER BY ps.owner, ps.repo, ps.pr_number`)
    .all() as Array<Record<string, unknown>>;
  return mapShepherdedRows(rows);
}

/** Active shepherded open PRs in a repository whose base or head branch is `branch`. */
export function findOpenShepherdedPrsByBranch(
  db: Database,
  params: { owner: string; repo: string; branch: string }
): ShepherdedPr[] {
  const rows = db
    .prepare(
      `${SHEPHERDED_SELECT}
        AND ps.state = 'open'
        AND ps.owner = ? COLLATE NOCASE
        AND ps.repo = ? COLLATE NOCASE
        AND (ps.base_branch = ? OR ps.head_branch = ?)
      ORDER BY ps.pr_number`
    )
    .all(params.owner, params.repo, params.branch, params.branch) as Array<Record<string, unknown>>;
  return mapShepherdedRows(rows);
}

export function isPrShepherded(db: Database, prStatusId: number): boolean {
  return getPrShepherd(db, prStatusId)?.removed_at === null;
}

export function parseNotifiedFlags(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((flag): flag is string => typeof flag === 'string')
      : [];
  } catch {
    return [];
  }
}

export function setPrShepherdNotifiedFlags(
  db: Database,
  prStatusId: number,
  flags: readonly string[]
): void {
  db.prepare(
    `
      UPDATE pr_shepherd
      SET notified_flags = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE pr_status_id = ?
    `
  ).run(JSON.stringify([...new Set(flags)].sort()), prStatusId);
}

/**
 * Turn the shepherd bot on or off for a PR. Turning it on also adds the PR to the shepherd
 * list. `snapshot` is the baseline for the bot trigger logic, so that the bot is not woken
 * for the state that the PR already had when it was added.
 */
export function setPrShepherdBotEnabled(
  db: Database,
  prStatusId: number,
  enabled: boolean,
  snapshot?: string | null
): void {
  if (!enabled) {
    db.prepare(
      `
        UPDATE pr_shepherd
        SET bot_enabled_at = NULL,
            bot_snapshot = NULL,
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE pr_status_id = ?
      `
    ).run(prStatusId);
    return;
  }

  db.transaction(() => {
    enrollPrShepherd(db, prStatusId, 'manual');
    db.prepare(
      `
        UPDATE pr_shepherd
        SET bot_enabled_at = COALESCE(bot_enabled_at, ${SQL_NOW_ISO_UTC}),
            bot_snapshot = CASE WHEN bot_enabled_at IS NULL THEN ? ELSE bot_snapshot END,
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE pr_status_id = ?
      `
    ).run(snapshot ?? null, prStatusId);
  }).immediate();
}

export function setPrShepherdBotSnapshot(db: Database, prStatusId: number, snapshot: string): void {
  db.prepare('UPDATE pr_shepherd SET bot_snapshot = ? WHERE pr_status_id = ?').run(
    snapshot,
    prStatusId
  );
}

/**
 * PRs that the bot watches, joined with their status rows. Closed and merged PRs are
 * included, so that the trigger logic can see the change to `merged` once.
 */
export function listBotEnabledShepherdPrs(db: Database): ShepherdedPr[] {
  const rows = db
    .prepare(
      `${SHEPHERDED_SELECT} AND sh.bot_enabled_at IS NOT NULL ORDER BY ps.owner, ps.repo, ps.pr_number`
    )
    .all() as Array<Record<string, unknown>>;
  return mapShepherdedRows(rows);
}
