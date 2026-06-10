import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl } from '../../common/github/identifiers.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

/**
 * Lifecycle status of a recorded job.
 *
 * - `running`: the session was started but has not finished yet (or the
 *   process exited without recording an outcome).
 * - `completed`: the session callback returned successfully.
 * - `failed`: the session callback threw.
 */
export type JobStatus = 'running' | 'completed' | 'failed';

/**
 * A row in the `job` table. Each row records one non-tunneled session that was
 * started — generating a review guide, generating proof, running an agent, etc.
 */
export interface JobRow {
  id: number;
  project_id: number | null;
  job_type: string;
  plan_id: number | null;
  plan_uuid: string | null;
  plan_title: string | null;
  pr_url: string | null;
  pr_number: number | null;
  workspace_path: string | null;
  git_remote: string | null;
  status: JobStatus;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordJobStartInput {
  projectId?: number | null;
  jobType: string;
  planId?: number | null;
  planUuid?: string | null;
  planTitle?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  workspacePath?: string | null;
  gitRemote?: string | null;
}

/**
 * Inserts a `running` job row and returns its id. Callers should later call
 * {@link markJobFinished} to record the outcome.
 */
export function recordJobStart(db: Database, input: RecordJobStartInput): number {
  const canonicalPrUrl =
    input.prUrl == null || input.prUrl.trim() === '' ? null : canonicalizePrUrl(input.prUrl);

  const result = db
    .prepare(
      `
        INSERT INTO job (
          project_id,
          job_type,
          plan_id,
          plan_uuid,
          plan_title,
          pr_url,
          pr_number,
          workspace_path,
          git_remote,
          status,
          started_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      `
    )
    .run(
      input.projectId ?? null,
      input.jobType,
      input.planId ?? null,
      input.planUuid ?? null,
      input.planTitle ?? null,
      canonicalPrUrl,
      input.prNumber ?? null,
      input.workspacePath ?? null,
      input.gitRemote ?? null
    );

  return Number(result.lastInsertRowid);
}

/**
 * Records the terminal status for a job and stamps `finished_at`. No-op if the
 * job no longer exists.
 */
export function markJobFinished(
  db: Database,
  jobId: number,
  status: Exclude<JobStatus, 'running'>
): void {
  db.prepare(
    `
      UPDATE job
      SET status = ?, finished_at = ${SQL_NOW_ISO_UTC}, updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = ?
    `
  ).run(status, jobId);
}

/**
 * Returns recent jobs, most recent first, enriched with the target plan's
 * numeric id/title and any linked PR number/title so the activity view can
 * render labels and build output links without extra round-trips.
 */
export function listRecentJobs(
  db: Database,
  options: { projectId?: number | 'all'; limit?: number } = {}
): JobRow[] {
  const conditions: string[] = [];
  const params: Array<number | string> = [];

  if (options.projectId !== undefined && options.projectId !== 'all') {
    conditions.push('j.project_id = ?');
    params.push(options.projectId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(options.limit ?? 100);

  return db
    .prepare(
      `
        SELECT
          j.id,
          j.project_id,
          j.job_type,
          COALESCE(j.plan_id, p.plan_id) AS plan_id,
          j.plan_uuid,
          COALESCE(j.plan_title, p.title) AS plan_title,
          j.pr_url,
          COALESCE(j.pr_number, ps.pr_number) AS pr_number,
          j.workspace_path,
          j.git_remote,
          j.status,
          j.started_at,
          j.finished_at,
          j.created_at,
          j.updated_at
        FROM job j
        LEFT JOIN plan p ON p.uuid = j.plan_uuid
        LEFT JOIN pr_status ps ON ps.pr_url = j.pr_url
        ${whereClause}
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT ?
      `
    )
    .all(...params) as JobRow[];
}
