import type { Database } from 'bun:sqlite';

export interface ApprovedUnmergedRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
}

export interface StaleReviewRequestRow {
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
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
  /** UTC ISO timestamp from pr_status.ready_at. */
  ready_at: string;
  /** Latest non-dismissed review timestamp, if any. */
  previous_review_at: string | null;
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
          COALESCE(pr_status.author, '') AS author
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
 * non-draft PRs where the reviewer has not submitted a non-dismissed review since the request.
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
              AND pr_review.author = pr_review_request.reviewer
              AND pr_review.submitted_at IS NOT NULL
              AND pr_review.submitted_at >= pr_review_request.requested_at
              -- Dismissed reviews do not clear the digest nudge; the PR needs attention again.
              AND pr_review.state != 'DISMISSED'
          )
        ORDER BY pr_review_request.requested_at ASC, pr_status.pr_number ASC, pr_review_request.reviewer ASC
      `
    )
    .all(owner, repo, nowIso) as StaleReviewRequestRow[];
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
