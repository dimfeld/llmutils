import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl, tryCanonicalizePrUrl } from '../../common/github/identifiers.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface PrStatusRow {
  id: number;
  pr_url: string;
  owner: string;
  repo: string;
  pr_number: number;
  title: string | null;
  state: string;
  draft: number;
  mergeable: string | null;
  head_sha: string | null;
  base_branch: string | null;
  head_branch: string | null;
  review_decision: string | null;
  check_rollup_state: string | null;
  merged_at: string | null;
  last_fetched_at: string;
  created_at: string;
  updated_at: string;
}

export interface PrCheckRunRow {
  id: number;
  pr_status_id: number;
  name: string;
  source: 'check_run' | 'status_context';
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface PrReviewRow {
  id: number;
  pr_status_id: number;
  author: string;
  state: string;
  submitted_at: string | null;
}

export interface PrLabelRow {
  id: number;
  pr_status_id: number;
  name: string;
  color: string | null;
}

export interface PlanPrRow {
  plan_uuid: string;
  pr_status_id: number;
}

export interface StoredPrCheckRunInput {
  name: string;
  source: 'check_run' | 'status_context';
  status: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface StoredPrReviewInput {
  author: string;
  state: string;
  submittedAt?: string | null;
}

export interface StoredPrLabelInput {
  name: string;
  color?: string | null;
}

export interface UpsertPrStatusInput {
  prUrl: string;
  owner: string;
  repo: string;
  prNumber: number;
  title?: string | null;
  state: string;
  draft: boolean;
  mergeable?: string | null;
  headSha?: string | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  reviewDecision?: string | null;
  checkRollupState?: string | null;
  mergedAt?: string | null;
  lastFetchedAt: string;
  checks?: StoredPrCheckRunInput[];
  reviews?: StoredPrReviewInput[];
  labels?: StoredPrLabelInput[];
}

export interface PrStatusDetail {
  status: PrStatusRow;
  checks: PrCheckRunRow[];
  reviews: PrReviewRow[];
  labels: PrLabelRow[];
}

export interface PlanWithLinkedPrs {
  uuid: string;
  projectId: number;
  planId: number;
  title: string | null;
  prUrls: string[];
}

function replaceCheckRuns(db: Database, prStatusId: number, checks: StoredPrCheckRunInput[]): void {
  db.prepare('DELETE FROM pr_check_run WHERE pr_status_id = ?').run(prStatusId);

  if (checks.length === 0) {
    return;
  }

  const insert = db.prepare(
    `
      INSERT INTO pr_check_run (
        pr_status_id,
        name,
        source,
        status,
        conclusion,
        details_url,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
  );

  for (const check of checks) {
    insert.run(
      prStatusId,
      check.name,
      check.source,
      check.status,
      check.conclusion ?? null,
      check.detailsUrl ?? null,
      check.startedAt ?? null,
      check.completedAt ?? null
    );
  }
}

function replaceReviews(db: Database, prStatusId: number, reviews: StoredPrReviewInput[]): void {
  db.prepare('DELETE FROM pr_review WHERE pr_status_id = ?').run(prStatusId);

  if (reviews.length === 0) {
    return;
  }

  const insert = db.prepare(
    `
      INSERT INTO pr_review (
        pr_status_id,
        author,
        state,
        submitted_at
      ) VALUES (?, ?, ?, ?)
    `
  );

  for (const review of reviews) {
    insert.run(prStatusId, review.author, review.state, review.submittedAt ?? null);
  }
}

function replaceLabels(db: Database, prStatusId: number, labels: StoredPrLabelInput[]): void {
  db.prepare('DELETE FROM pr_label WHERE pr_status_id = ?').run(prStatusId);

  if (labels.length === 0) {
    return;
  }

  const insert = db.prepare(
    `
      INSERT INTO pr_label (
        pr_status_id,
        name,
        color
      ) VALUES (?, ?, ?)
    `
  );

  for (const label of labels) {
    insert.run(prStatusId, label.name, label.color ?? null);
  }
}

function getDetailById(db: Database, prStatusId: number): PrStatusDetail | null {
  const status =
    (db.prepare('SELECT * FROM pr_status WHERE id = ?').get(prStatusId) as PrStatusRow | null) ??
    null;

  if (!status) {
    return null;
  }

  const checks = db
    .prepare(
      `
        SELECT *
        FROM pr_check_run
        WHERE pr_status_id = ?
        ORDER BY name, id
      `
    )
    .all(prStatusId) as PrCheckRunRow[];
  const reviews = db
    .prepare(
      `
        SELECT *
        FROM pr_review
        WHERE pr_status_id = ?
        ORDER BY submitted_at, author, id
      `
    )
    .all(prStatusId) as PrReviewRow[];
  const labels = db
    .prepare(
      `
        SELECT *
        FROM pr_label
        WHERE pr_status_id = ?
        ORDER BY name, id
      `
    )
    .all(prStatusId) as PrLabelRow[];

  return {
    status,
    checks,
    reviews,
    labels,
  };
}

export function upsertPrStatus(db: Database, input: UpsertPrStatusInput): PrStatusDetail {
  const upsertInTransaction = db.transaction((nextInput: UpsertPrStatusInput): PrStatusDetail => {
    db.prepare(
      `
        INSERT INTO pr_status (
          pr_url,
          owner,
          repo,
          pr_number,
          title,
          state,
          draft,
          mergeable,
          head_sha,
          base_branch,
          head_branch,
          review_decision,
          check_rollup_state,
          merged_at,
          last_fetched_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(pr_url) DO UPDATE SET
          owner = excluded.owner,
          repo = excluded.repo,
          pr_number = excluded.pr_number,
          title = excluded.title,
          state = excluded.state,
          draft = excluded.draft,
          mergeable = excluded.mergeable,
          head_sha = excluded.head_sha,
          base_branch = excluded.base_branch,
          head_branch = excluded.head_branch,
          review_decision = excluded.review_decision,
          check_rollup_state = excluded.check_rollup_state,
          merged_at = excluded.merged_at,
          last_fetched_at = excluded.last_fetched_at,
          updated_at = ${SQL_NOW_ISO_UTC}
      `
    ).run(
      nextInput.prUrl,
      nextInput.owner,
      nextInput.repo,
      nextInput.prNumber,
      nextInput.title ?? null,
      nextInput.state,
      nextInput.draft ? 1 : 0,
      nextInput.mergeable ?? null,
      nextInput.headSha ?? null,
      nextInput.baseBranch ?? null,
      nextInput.headBranch ?? null,
      nextInput.reviewDecision ?? null,
      nextInput.checkRollupState ?? null,
      nextInput.mergedAt ?? null,
      nextInput.lastFetchedAt
    );

    const row = db.prepare('SELECT id FROM pr_status WHERE pr_url = ?').get(nextInput.prUrl) as {
      id: number;
    } | null;

    if (!row) {
      throw new Error(`Failed to upsert PR status for ${nextInput.prUrl}`);
    }

    replaceCheckRuns(db, row.id, nextInput.checks ?? []);
    replaceReviews(db, row.id, nextInput.reviews ?? []);
    replaceLabels(db, row.id, nextInput.labels ?? []);

    const detail = getDetailById(db, row.id);
    if (!detail) {
      throw new Error(`Failed to load PR status detail for ${nextInput.prUrl}`);
    }

    return detail;
  });

  return upsertInTransaction.immediate(input);
}

export function updatePrCheckRuns(
  db: Database,
  prStatusId: number,
  checks: StoredPrCheckRunInput[],
  checkRollupState: string | null,
  lastFetchedAt: string
): PrStatusDetail {
  const updateInTransaction = db.transaction(
    (
      nextPrStatusId: number,
      nextChecks: StoredPrCheckRunInput[],
      nextCheckRollupState: string | null,
      nextLastFetchedAt: string
    ): PrStatusDetail => {
      db.prepare(
        `
          UPDATE pr_status
          SET last_fetched_at = ?,
              check_rollup_state = ?,
              updated_at = ${SQL_NOW_ISO_UTC}
          WHERE id = ?
        `
      ).run(nextLastFetchedAt, nextCheckRollupState, nextPrStatusId);

      replaceCheckRuns(db, nextPrStatusId, nextChecks);

      const detail = getDetailById(db, nextPrStatusId);
      if (!detail) {
        throw new Error(`Failed to load PR status detail for id ${nextPrStatusId}`);
      }

      return detail;
    }
  );

  return updateInTransaction.immediate(prStatusId, checks, checkRollupState, lastFetchedAt);
}

export function getPrStatusByUrl(db: Database, prUrl: string): PrStatusDetail | null {
  const canonicalPrUrl = tryCanonicalizePrUrl(prUrl);
  if (canonicalPrUrl === null) {
    return null;
  }
  const row =
    (db.prepare('SELECT id FROM pr_status WHERE pr_url = ?').get(canonicalPrUrl) as {
      id: number;
    } | null) ?? null;

  if (!row) {
    return null;
  }

  return getDetailById(db, row.id);
}

export function getPrStatusByUrls(db: Database, prUrls: string[]): PrStatusDetail[] {
  const canonicalPrUrls = [
    ...new Set(
      prUrls
        .map((prUrl) => tryCanonicalizePrUrl(prUrl))
        .filter((prUrl): prUrl is string => prUrl !== null)
    ),
  ];
  if (canonicalPrUrls.length === 0) {
    return [];
  }

  const placeholders = canonicalPrUrls.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT ps.id
        FROM pr_status ps
        WHERE ps.pr_url IN (${placeholders})
        ORDER BY ps.pr_number, ps.id
      `
    )
    .all(...canonicalPrUrls) as Array<{ id: number }>;

  return rows
    .map((row) => getDetailById(db, row.id))
    .filter((detail): detail is PrStatusDetail => detail !== null);
}

export function getPrStatusForPlan(
  db: Database,
  planUuid: string,
  prUrls?: string[]
): PrStatusDetail[] {
  if (prUrls !== undefined) {
    return getPrStatusByUrls(db, prUrls);
  }

  const rows = db
    .prepare(
      `
        SELECT ps.id
        FROM pr_status ps
        INNER JOIN plan_pr pp ON pp.pr_status_id = ps.id
        WHERE pp.plan_uuid = ?
        ORDER BY ps.pr_number, ps.id
      `
    )
    .all(planUuid) as Array<{ id: number }>;

  return rows
    .map((row) => getDetailById(db, row.id))
    .filter((detail): detail is PrStatusDetail => detail !== null);
}

export function linkPlanToPr(db: Database, planUuid: string, prStatusId: number): void {
  const linkInTransaction = db.transaction((nextPlanUuid: string, nextPrStatusId: number): void => {
    db.prepare(
      `
        INSERT OR IGNORE INTO plan_pr (
          plan_uuid,
          pr_status_id
        ) VALUES (?, ?)
      `
    ).run(nextPlanUuid, nextPrStatusId);
  });

  linkInTransaction.immediate(planUuid, prStatusId);
}

export function unlinkPlanFromPr(db: Database, planUuid: string, prStatusId: number): void {
  const unlinkInTransaction = db.transaction(
    (nextPlanUuid: string, nextPrStatusId: number): void => {
      db.prepare('DELETE FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ?').run(
        nextPlanUuid,
        nextPrStatusId
      );
    }
  );

  unlinkInTransaction.immediate(planUuid, prStatusId);
}

/** Returns plans in actionable states (pending, in_progress, needs_review) that have open PRs.
 * Used by background polling to determine which PRs need status checks. */
export function getPlansWithPrs(db: Database, projectId?: number): PlanWithLinkedPrs[] {
  const query = `
    SELECT
      p.uuid AS uuid,
      p.project_id AS project_id,
      p.plan_id AS plan_id,
      p.title AS title,
      ps.pr_url AS pr_url
    FROM plan p
    INNER JOIN plan_pr pp ON pp.plan_uuid = p.uuid
    INNER JOIN pr_status ps ON ps.id = pp.pr_status_id
    WHERE ps.state = 'open'
      AND p.status IN ('pending', 'in_progress', 'needs_review')
      ${projectId === undefined ? '' : 'AND p.project_id = ?'}
    ORDER BY p.plan_id, p.uuid, ps.pr_number, ps.id
  `;

  const rows = db.prepare(query).all(...(projectId === undefined ? [] : [projectId])) as Array<{
    uuid: string;
    project_id: number;
    plan_id: number;
    title: string | null;
    pr_url: string;
  }>;

  const plans = new Map<string, PlanWithLinkedPrs>();
  for (const row of rows) {
    const existing = plans.get(row.uuid);
    if (existing) {
      existing.prUrls.push(row.pr_url);
      continue;
    }

    plans.set(row.uuid, {
      uuid: row.uuid,
      projectId: row.project_id,
      planId: row.plan_id,
      title: row.title,
      prUrls: [row.pr_url],
    });
  }

  return [...plans.values()];
}

export function cleanOrphanedPrStatus(db: Database): number {
  const cleanInTransaction = db.transaction((): number => {
    const result = db
      .prepare(
        `
        DELETE FROM pr_status
        WHERE id NOT IN (
          SELECT pr_status_id FROM plan_pr
        )
      `
      )
      .run();

    return result.changes;
  });

  return cleanInTransaction.immediate();
}
