import type { Database } from 'bun:sqlite';

export interface ApprovedUnmergedRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  /** 1 when the PR is stacked on another open PR (its base is that PR's head branch). */
  is_stacked: number;
  /** Latest approval review timestamp, if known. */
  approved_at: string | null;
}

export interface StaleReviewRequestRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  /** 1 when the PR is stacked on another open PR (its base is that PR's head branch). */
  is_stacked: number;
  reviewer: string;
  /** UTC ISO timestamp from pr_review_request.requested_at. */
  requested_at: string;
  /** Newline-separated label names on the PR, or null when it has no labels. */
  labels: string | null;
}

export interface OtherReadyForReviewRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  /** 1 when the PR is stacked on another open PR (its base is that PR's head branch). */
  is_stacked: number;
  /** UTC ISO timestamp from pr_status.ready_at. */
  ready_at: string;
  /** Latest non-dismissed review timestamp, if any. */
  previous_review_at: string | null;
}

/**
 * SQL fragment that resolves to 1 when the surrounding `pr_status` row is stacked on another open
 * PR — i.e. its base branch is the head branch of a different open PR in the same repo. Correlates
 * on `pr_status.owner`/`pr_status.repo`, so it only works where `pr_status` is in scope.
 */
const IS_STACKED_SQL = `
  CASE WHEN EXISTS (
    SELECT 1
    FROM pr_status AS base_pr
    WHERE base_pr.owner = pr_status.owner
      AND base_pr.repo = pr_status.repo
      AND base_pr.state = 'open'
      AND base_pr.id != pr_status.id
      AND base_pr.head_branch IS NOT NULL
      AND base_pr.head_branch = pr_status.base_branch
  ) THEN 1 ELSE 0 END
`;

export interface ReviewRequestDebugRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  review_decision: string | null;
  ready_at: string | null;
  request_reviewer: string | null;
  requested_at: string | null;
  removed_at: string | null;
  request_version: number | null;
  latest_active_requested_at: string | null;
  pr_clearing_review_author: string | null;
  pr_clearing_review_state: string | null;
  pr_clearing_review_submitted_at: string | null;
  clearing_review_author: string | null;
  clearing_review_state: string | null;
  clearing_review_submitted_at: string | null;
  latest_reviewer_review_state: string | null;
  latest_reviewer_review_submitted_at: string | null;
  latest_pr_reviews: string | null;
}

export interface GetStaleReviewRequestRowsOptions {
  nowMs: number;
}

export function getApprovedUnmergedRows(
  db: Database,
  owner: string,
  repo: string
): ApprovedUnmergedRow[] {
  return db
    .prepare(
      `
        SELECT
          pr_status.pr_url,
          pr_status.pr_number,
          COALESCE(pr_status.title, '') AS title,
          COALESCE(pr_status.author, '') AS author,
          ${IS_STACKED_SQL} AS is_stacked,
          (
            SELECT MAX(pr_review.submitted_at)
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.state = 'APPROVED'
              AND pr_review.submitted_at IS NOT NULL
          ) AS approved_at
        FROM pr_status
        WHERE pr_status.owner = ?
          AND pr_status.repo = ?
          AND pr_status.state = 'open'
          AND pr_status.review_decision = 'APPROVED'
          AND pr_status.draft = 0
        ORDER BY pr_status.pr_number ASC, pr_status.id ASC
      `
    )
    .all(owner, repo) as ApprovedUnmergedRow[];
}

/**
 * Returns active individual review requests (not removed, with a request time) on open,
 * non-draft PRs where no active requested reviewer has submitted a non-dismissed review since
 * the latest active request.
 *
 * NOTE: this applies only a coarse `requested_at <= now` bound. The actual `staleAfterHours`
 * threshold is applied downstream in `buildPrDigest` (see src/lib/server/pr_digest.ts), so
 * callers must pass the same `nowMs` to both and always run these rows through `buildPrDigest`,
 * otherwise fresh requests will leak into the digest.
 */
export function getStaleReviewRequestRows(
  db: Database,
  owner: string,
  repo: string,
  options: GetStaleReviewRequestRowsOptions
): StaleReviewRequestRow[] {
  const nowIso = new Date(options.nowMs).toISOString();

  // Team review requests are not stored in pr_review_request, so this covers individual reviewers only.
  return db
    .prepare(
      `
        SELECT
          pr_status.pr_url,
          pr_status.pr_number,
          COALESCE(pr_status.title, '') AS title,
          COALESCE(pr_status.author, '') AS author,
          ${IS_STACKED_SQL} AS is_stacked,
          pr_review_request.reviewer,
          pr_review_request.requested_at,
          (
            SELECT GROUP_CONCAT(pr_label.name, char(10))
            FROM pr_label
            WHERE pr_label.pr_status_id = pr_status.id
          ) AS labels
        FROM pr_review_request
        INNER JOIN pr_status ON pr_status.id = pr_review_request.pr_status_id
        WHERE pr_status.owner = ?
          AND pr_status.repo = ?
          AND pr_status.state = 'open'
          AND pr_status.draft = 0
          AND pr_review_request.removed_at IS NULL
          AND pr_review_request.requested_at IS NOT NULL
          AND pr_review_request.requested_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_review_request.pr_status_id
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at >= (
                SELECT MAX(latest_request.requested_at)
                FROM pr_review_request AS latest_request
                WHERE latest_request.pr_status_id = pr_status.id
                  AND latest_request.removed_at IS NULL
                  AND latest_request.requested_at IS NOT NULL
                  AND latest_request.requested_at <= ?
              )
              AND EXISTS (
                SELECT 1
                FROM pr_review_request AS requested_reviewer
                WHERE requested_reviewer.pr_status_id = pr_status.id
                  AND requested_reviewer.reviewer = pr_review.author
                  AND requested_reviewer.removed_at IS NULL
                  AND requested_reviewer.requested_at IS NOT NULL
                  AND requested_reviewer.requested_at <= ?
              )
              -- Dismissed reviews do not clear the digest nudge; the PR still needs attention.
              AND pr_review.state != 'DISMISSED'
          )
        ORDER BY pr_review_request.requested_at ASC, pr_status.pr_number ASC, pr_review_request.reviewer ASC
      `
    )
    .all(owner, repo, nowIso, nowIso, nowIso) as StaleReviewRequestRow[];
}

/**
 * Returns open, non-draft PRs that are ready for review in the broad GitHub sense.
 * Callers apply the > 3 day threshold and remove PRs already shown in higher-priority
 * digest buckets.
 */
export function getOtherReadyForReviewRows(
  db: Database,
  owner: string,
  repo: string,
  options: GetStaleReviewRequestRowsOptions
): OtherReadyForReviewRow[] {
  const nowIso = new Date(options.nowMs).toISOString();

  return db
    .prepare(
      `
        SELECT
          pr_status.pr_url,
          pr_status.pr_number,
          COALESCE(pr_status.title, '') AS title,
          COALESCE(pr_status.author, '') AS author,
          ${IS_STACKED_SQL} AS is_stacked,
          pr_status.ready_at,
          (
            SELECT MAX(pr_review.submitted_at)
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at <= ?
              AND pr_review.state != 'DISMISSED'
          ) AS previous_review_at
        FROM pr_status
        WHERE pr_status.owner = ?
          AND pr_status.repo = ?
          AND pr_status.state = 'open'
          AND pr_status.draft = 0
          AND pr_status.ready_at IS NOT NULL
          AND pr_status.ready_at <= ?
        ORDER BY ready_at ASC, pr_status.pr_number ASC, pr_status.id ASC
      `
    )
    .all(nowIso, owner, repo, nowIso) as OtherReadyForReviewRow[];
}

export function getReviewRequestDebugRows(
  db: Database,
  owner: string,
  repo: string
): ReviewRequestDebugRow[] {
  return db
    .prepare(
      `
        SELECT
          pr_status.pr_url,
          pr_status.pr_number,
          COALESCE(pr_status.title, '') AS title,
          COALESCE(pr_status.author, '') AS author,
          pr_status.review_decision,
          pr_status.ready_at,
          pr_review_request.reviewer AS request_reviewer,
          pr_review_request.requested_at,
          pr_review_request.removed_at,
          pr_review_request.request_version,
          (
            SELECT MAX(latest_request.requested_at)
            FROM pr_review_request AS latest_request
            WHERE latest_request.pr_status_id = pr_status.id
              AND latest_request.removed_at IS NULL
              AND latest_request.requested_at IS NOT NULL
          ) AS latest_active_requested_at,
          (
            SELECT pr_review.author
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at >= (
                SELECT MAX(latest_request.requested_at)
                FROM pr_review_request AS latest_request
                WHERE latest_request.pr_status_id = pr_status.id
                  AND latest_request.removed_at IS NULL
                  AND latest_request.requested_at IS NOT NULL
              )
              AND EXISTS (
                SELECT 1
                FROM pr_review_request AS requested_reviewer
                WHERE requested_reviewer.pr_status_id = pr_status.id
                  AND requested_reviewer.reviewer = pr_review.author
                  AND requested_reviewer.removed_at IS NULL
                  AND requested_reviewer.requested_at IS NOT NULL
              )
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS pr_clearing_review_author,
          (
            SELECT pr_review.state
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at >= (
                SELECT MAX(latest_request.requested_at)
                FROM pr_review_request AS latest_request
                WHERE latest_request.pr_status_id = pr_status.id
                  AND latest_request.removed_at IS NULL
                  AND latest_request.requested_at IS NOT NULL
              )
              AND EXISTS (
                SELECT 1
                FROM pr_review_request AS requested_reviewer
                WHERE requested_reviewer.pr_status_id = pr_status.id
                  AND requested_reviewer.reviewer = pr_review.author
                  AND requested_reviewer.removed_at IS NULL
                  AND requested_reviewer.requested_at IS NOT NULL
              )
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS pr_clearing_review_state,
          (
            SELECT pr_review.submitted_at
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at >= (
                SELECT MAX(latest_request.requested_at)
                FROM pr_review_request AS latest_request
                WHERE latest_request.pr_status_id = pr_status.id
                  AND latest_request.removed_at IS NULL
                  AND latest_request.requested_at IS NOT NULL
              )
              AND EXISTS (
                SELECT 1
                FROM pr_review_request AS requested_reviewer
                WHERE requested_reviewer.pr_status_id = pr_status.id
                  AND requested_reviewer.reviewer = pr_review.author
                  AND requested_reviewer.removed_at IS NULL
                  AND requested_reviewer.requested_at IS NOT NULL
              )
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS pr_clearing_review_submitted_at,
          (
            SELECT pr_review.author
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review_request.requested_at IS NOT NULL
              AND pr_review.submitted_at >= pr_review_request.requested_at
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS clearing_review_author,
          (
            SELECT pr_review.state
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review_request.requested_at IS NOT NULL
              AND pr_review.submitted_at >= pr_review_request.requested_at
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS clearing_review_state,
          (
            SELECT pr_review.submitted_at
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review_request.requested_at IS NOT NULL
              AND pr_review.submitted_at >= pr_review_request.requested_at
              AND pr_review.state != 'DISMISSED'
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS clearing_review_submitted_at,
          (
            SELECT pr_review.state
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS latest_reviewer_review_state,
          (
            SELECT pr_review.submitted_at
            FROM pr_review
            WHERE pr_review.pr_status_id = pr_status.id
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
            ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            LIMIT 1
          ) AS latest_reviewer_review_submitted_at,
          (
            SELECT GROUP_CONCAT(review_summary.summary, char(10))
            FROM (
              SELECT
                pr_review.author || ':' || pr_review.state || '@' ||
                  COALESCE(pr_review.submitted_at, 'no-submitted-at') AS summary
              FROM pr_review
              WHERE pr_review.pr_status_id = pr_status.id
              ORDER BY pr_review.submitted_at DESC, pr_review.id DESC
            ) AS review_summary
          ) AS latest_pr_reviews
        FROM pr_status
        LEFT JOIN pr_review_request ON pr_review_request.pr_status_id = pr_status.id
        WHERE pr_status.owner = ?
          AND pr_status.repo = ?
          AND pr_status.state = 'open'
          AND pr_status.draft = 0
          AND (
            pr_review_request.id IS NOT NULL
            OR EXISTS (
              SELECT 1
              FROM pr_review
              WHERE pr_review.pr_status_id = pr_status.id
            )
          )
        ORDER BY pr_status.pr_number ASC, pr_review_request.reviewer ASC
      `
    )
    .all(owner, repo) as ReviewRequestDebugRow[];
}
