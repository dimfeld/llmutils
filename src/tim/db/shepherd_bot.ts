import type { Database } from 'bun:sqlite';

import { SQL_NOW_ISO_UTC } from './sql_utils.js';

/**
 * Durable state for the PR shepherd bot. All of it is local-only (no sync), like the other
 * `pr_*` tables. The queue lives here so that a server restart loses nothing.
 */

export type ShepherdBotRunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type ShepherdBotTriggerKind =
  /** The cached state of a watched PR changed in a way the bot cares about. */
  | 'pr_changed'
  /** A fix-type session (`pr-fix`, `ci-fix`, ...) for a watched PR ended. */
  | 'session_ended'
  /** The bot asked to be woken up again later. */
  | 'recheck'
  /** The user started the bot. The run gets the full state of all watched stacks. */
  | 'bot_started'
  /** The user added PRs to the bot. */
  | 'prs_added';

export type ShepherdBotActionKind = 'ci_fix' | 'pr_fix' | 'pr_rebase' | 'notify' | 'recheck';

export type ShepherdBotActionStatus = 'requested' | 'launched' | 'rejected' | 'failed' | 'done';

export interface ShepherdBotRunRow {
  id: number;
  project_id: number;
  status: ShepherdBotRunStatus;
  pid: number | null;
  started_at: string;
  heartbeat_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
}

export interface ShepherdBotTriggerRow {
  id: number;
  project_id: number;
  pr_status_id: number | null;
  pr_url: string | null;
  kind: ShepherdBotTriggerKind;
  /** JSON object with kind-specific details. */
  details: string | null;
  created_at: string;
  /** The trigger does not cause a run before this time. */
  due_at: string;
  /** How many runs already took this trigger and did not finish. */
  attempts: number;
  run_id: number | null;
}

export interface ShepherdBotActionRow {
  id: number;
  project_id: number;
  run_id: number | null;
  pr_status_id: number | null;
  pr_url: string | null;
  pr_number: number | null;
  kind: ShepherdBotActionKind;
  head_sha: string | null;
  dedupe_key: string | null;
  reason: string | null;
  status: ShepherdBotActionStatus;
  result: string | null;
  created_at: string;
  updated_at: string;
}

/** A trigger goes back to the queue at most this many times after a failed run. */
export const SHEPHERD_BOT_MAX_TRIGGER_ATTEMPTS = 2;
/** Delay before a released trigger can start a new run. */
const RELEASED_TRIGGER_DELAY_MS = 60_000;

// ---------------------------------------------------------------------------
// Start/stop flag

export function isShepherdBotRunning(db: Database, projectId: number): boolean {
  const row = db
    .prepare('SELECT running FROM shepherd_bot_project WHERE project_id = ?')
    .get(projectId) as { running: number } | null;
  return row?.running === 1;
}

export function setShepherdBotRunning(db: Database, projectId: number, running: boolean): void {
  db.prepare(
    `
      INSERT INTO shepherd_bot_project (project_id, running)
      VALUES (?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        running = excluded.running,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(projectId, running ? 1 : 0);
}

export function listRunningShepherdBotProjectIds(db: Database): number[] {
  const rows = db
    .prepare('SELECT project_id FROM shepherd_bot_project WHERE running = 1 ORDER BY project_id')
    .all() as Array<{ project_id: number }>;
  return rows.map((row) => row.project_id);
}

// ---------------------------------------------------------------------------
// Triggers

export interface InsertShepherdBotTriggerInput {
  projectId: number;
  prStatusId?: number | null;
  prUrl?: string | null;
  kind: ShepherdBotTriggerKind;
  details?: Record<string, unknown> | null;
  dueAt: Date;
}

export function insertShepherdBotTrigger(
  db: Database,
  input: InsertShepherdBotTriggerInput
): number {
  const result = db
    .prepare(
      `
        INSERT INTO shepherd_bot_trigger (project_id, pr_status_id, pr_url, kind, details, due_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.projectId,
      input.prStatusId ?? null,
      input.prUrl ?? null,
      input.kind,
      input.details ? JSON.stringify(input.details) : null,
      input.dueAt.toISOString()
    );
  return Number(result.lastInsertRowid);
}

/** Triggers that no run has taken yet, oldest first. */
export function listPendingShepherdBotTriggers(
  db: Database,
  projectId: number
): ShepherdBotTriggerRow[] {
  return db
    .prepare(
      `
        SELECT * FROM shepherd_bot_trigger
        WHERE project_id = ? AND run_id IS NULL
        ORDER BY created_at, id
      `
    )
    .all(projectId) as ShepherdBotTriggerRow[];
}

export function listShepherdBotTriggersForRun(
  db: Database,
  runId: number
): ShepherdBotTriggerRow[] {
  return db
    .prepare('SELECT * FROM shepherd_bot_trigger WHERE run_id = ? ORDER BY created_at, id')
    .all(runId) as ShepherdBotTriggerRow[];
}

/** True when a trigger of this kind was added for the PR at or after `sinceIso`. */
export function hasShepherdBotTriggerSince(
  db: Database,
  params: { prUrl: string; kind: ShepherdBotTriggerKind; sinceIso: string }
): boolean {
  const row = db
    .prepare(
      `
        SELECT 1 FROM shepherd_bot_trigger
        WHERE pr_url = ? AND kind = ? AND created_at >= ?
        LIMIT 1
      `
    )
    .get(params.prUrl, params.kind, params.sinceIso);
  return row != null;
}

/** Remove triggers that are older than `beforeIso` and that a run already took. */
export function pruneShepherdBotTriggers(db: Database, beforeIso: string): void {
  db.prepare('DELETE FROM shepherd_bot_trigger WHERE run_id IS NOT NULL AND created_at < ?').run(
    beforeIso
  );
}

// ---------------------------------------------------------------------------
// Runs

/**
 * Create a run and give it the triggers. Returns null when the project already has a
 * running run, so that two callers can never start two runs at the same time.
 */
export function startShepherdBotRun(
  db: Database,
  projectId: number,
  triggerIds: readonly number[]
): number | null {
  return db
    .transaction((): number | null => {
      if (getActiveShepherdBotRun(db, projectId)) {
        return null;
      }
      const result = db
        .prepare(`INSERT INTO shepherd_bot_run (project_id, status) VALUES (?, 'running')`)
        .run(projectId);
      const runId = Number(result.lastInsertRowid);
      const claim = db.prepare(
        'UPDATE shepherd_bot_trigger SET run_id = ? WHERE id = ? AND run_id IS NULL'
      );
      for (const triggerId of triggerIds) {
        claim.run(runId, triggerId);
      }
      return runId;
    })
    .immediate();
}

export function getShepherdBotRun(db: Database, runId: number): ShepherdBotRunRow | null {
  return (
    (db.prepare('SELECT * FROM shepherd_bot_run WHERE id = ?').get(runId) as
      | ShepherdBotRunRow
      | undefined) ?? null
  );
}

export function getActiveShepherdBotRun(db: Database, projectId: number): ShepherdBotRunRow | null {
  return (
    (db
      .prepare(`SELECT * FROM shepherd_bot_run WHERE project_id = ? AND status = 'running' LIMIT 1`)
      .get(projectId) as ShepherdBotRunRow | undefined) ?? null
  );
}

export function heartbeatShepherdBotRun(db: Database, runId: number, pid?: number): void {
  db.prepare(
    `
      UPDATE shepherd_bot_run
      SET heartbeat_at = ${SQL_NOW_ISO_UTC},
          pid = COALESCE(?, pid)
      WHERE id = ? AND status = 'running'
    `
  ).run(pid ?? null, runId);
}

/**
 * Record the end of a run. When the run did not complete, its triggers go back to the queue
 * so that a later run handles them, but each trigger only a limited number of times.
 *
 * Returns false when the run had already finished.
 */
export function finishShepherdBotRun(
  db: Database,
  runId: number,
  status: Exclude<ShepherdBotRunStatus, 'running'>,
  options: { summary?: string | null; error?: string | null; now?: Date } = {}
): boolean {
  return db
    .transaction((): boolean => {
      const result = db
        .prepare(
          `
          UPDATE shepherd_bot_run
          SET status = ?,
              finished_at = ${SQL_NOW_ISO_UTC},
              summary = ?,
              error = ?
          WHERE id = ? AND status = 'running'
        `
        )
        .run(status, options.summary ?? null, options.error ?? null, runId);
      if (result.changes === 0) {
        return false;
      }

      if (status !== 'completed') {
        const dueAt = new Date((options.now ?? new Date()).getTime() + RELEASED_TRIGGER_DELAY_MS);
        db.prepare(
          `
          UPDATE shepherd_bot_trigger
          SET run_id = NULL,
              attempts = attempts + 1,
              due_at = ?
          WHERE run_id = ? AND attempts + 1 < ?
        `
        ).run(dueAt.toISOString(), runId, SHEPHERD_BOT_MAX_TRIGGER_ATTEMPTS);
      }
      return true;
    })
    .immediate();
}

/** Running runs whose last heartbeat is older than `beforeIso`. */
export function listStaleShepherdBotRuns(db: Database, beforeIso: string): ShepherdBotRunRow[] {
  return db
    .prepare(
      `SELECT * FROM shepherd_bot_run WHERE status = 'running' AND heartbeat_at < ? ORDER BY id`
    )
    .all(beforeIso) as ShepherdBotRunRow[];
}

export function listRunningShepherdBotRuns(db: Database): ShepherdBotRunRow[] {
  return db
    .prepare(`SELECT * FROM shepherd_bot_run WHERE status = 'running' ORDER BY id`)
    .all() as ShepherdBotRunRow[];
}

export function countShepherdBotRunsSince(
  db: Database,
  projectId: number,
  sinceIso: string
): number {
  const row = db
    .prepare(
      'SELECT count(*) AS count FROM shepherd_bot_run WHERE project_id = ? AND started_at >= ?'
    )
    .get(projectId, sinceIso) as { count: number };
  return row.count;
}

export function listRecentShepherdBotRuns(
  db: Database,
  projectId: number,
  limit: number
): ShepherdBotRunRow[] {
  return db
    .prepare(
      'SELECT * FROM shepherd_bot_run WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?'
    )
    .all(projectId, limit) as ShepherdBotRunRow[];
}

// ---------------------------------------------------------------------------
// Actions

export interface InsertShepherdBotActionInput {
  projectId: number;
  runId?: number | null;
  prStatusId?: number | null;
  prUrl?: string | null;
  prNumber?: number | null;
  kind: ShepherdBotActionKind;
  headSha?: string | null;
  dedupeKey?: string | null;
  reason?: string | null;
  status: ShepherdBotActionStatus;
  result?: string | null;
}

export function insertShepherdBotAction(db: Database, input: InsertShepherdBotActionInput): number {
  const result = db
    .prepare(
      `
        INSERT INTO shepherd_bot_action (
          project_id, run_id, pr_status_id, pr_url, pr_number, kind, head_sha, dedupe_key,
          reason, status, result
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.projectId,
      input.runId ?? null,
      input.prStatusId ?? null,
      input.prUrl ?? null,
      input.prNumber ?? null,
      input.kind,
      input.headSha ?? null,
      input.dedupeKey ?? null,
      input.reason ?? null,
      input.status,
      input.result ?? null
    );
  return Number(result.lastInsertRowid);
}

export function updateShepherdBotAction(
  db: Database,
  actionId: number,
  update: { status: ShepherdBotActionStatus; result?: string | null; dedupeKey?: string | null }
): void {
  db.prepare(
    `
      UPDATE shepherd_bot_action
      SET status = ?,
          result = ?,
          dedupe_key = COALESCE(?, dedupe_key),
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = ?
    `
  ).run(update.status, update.result ?? null, update.dedupeKey ?? null, actionId);
}

/** Actions that a run asked for and that the server has not handled yet, oldest first. */
export function listRequestedShepherdBotActions(db: Database): ShepherdBotActionRow[] {
  return db
    .prepare(`SELECT * FROM shepherd_bot_action WHERE status = 'requested' ORDER BY id`)
    .all() as ShepherdBotActionRow[];
}

/** Count launched actions of one kind for a PR, optionally for one head SHA or dedupe key. */
export function countLaunchedShepherdBotActions(
  db: Database,
  params: {
    prStatusId: number;
    kind: ShepherdBotActionKind;
    headSha?: string | null;
    dedupeKey?: string | null;
  }
): number {
  const conditions = [`status = 'launched'`, 'pr_status_id = ?', 'kind = ?'];
  const values: Array<string | number> = [params.prStatusId, params.kind];
  if (params.headSha != null) {
    conditions.push('head_sha = ?');
    values.push(params.headSha);
  }
  if (params.dedupeKey != null) {
    conditions.push('dedupe_key = ?');
    values.push(params.dedupeKey);
  }
  const row = db
    .prepare(`SELECT count(*) AS count FROM shepherd_bot_action WHERE ${conditions.join(' AND ')}`)
    .get(...values) as { count: number };
  return row.count;
}

export function listRecentShepherdBotActions(
  db: Database,
  projectId: number,
  limit: number
): ShepherdBotActionRow[] {
  return db
    .prepare(
      'SELECT * FROM shepherd_bot_action WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(projectId, limit) as ShepherdBotActionRow[];
}
