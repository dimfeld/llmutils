import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface PendingReviewRequestNotification {
  id: number;
  pr_status_id: number;
  reviewer: string;
  requested_at: string | null;
  last_event_at: string;
  request_version: number;
  previously_requested: number;
  owner: string;
  repo: string;
  pr_url: string;
  pr_number: number;
  title: string;
  author: string;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
}

export function getPendingReviewRequestNotifications(
  db: Database
): PendingReviewRequestNotification[] {
  return db
    .prepare(
      `
        SELECT
          pr_review_request.id,
          pr_review_request.pr_status_id,
          pr_review_request.reviewer,
          pr_review_request.requested_at,
          pr_review_request.last_event_at,
          pr_review_request.request_version,
          CASE WHEN pr_review_request.request_version > 0 THEN 1 ELSE 0 END AS previously_requested,
          pr_status.owner,
          pr_status.repo,
          pr_status.pr_url,
          pr_status.pr_number,
          COALESCE(pr_status.title, '') AS title,
          COALESCE(pr_status.author, '') AS author,
          pr_status.additions,
          pr_status.deletions,
          pr_status.changed_files
        FROM pr_review_request
        INNER JOIN pr_status ON pr_status.id = pr_review_request.pr_status_id
        WHERE pr_review_request.removed_at IS NULL
          AND pr_review_request.notified_at IS NULL
          AND pr_status.state = 'open'
        ORDER BY pr_review_request.requested_at ASC, pr_review_request.id ASC
      `
    )
    .all() as PendingReviewRequestNotification[];
}

export function markReviewRequestsNotifiedBefore(db: Database, cutoff: string): number {
  const result = db
    .prepare(
      `
        UPDATE pr_review_request
        SET notified_at = ${SQL_NOW_ISO_UTC}
        WHERE removed_at IS NULL
          AND notified_at IS NULL
          AND requested_at IS NOT NULL
          AND unixepoch(requested_at) < unixepoch(?)
      `
    )
    .run(cutoff);

  return result.changes;
}

export function markReviewRequestsNotified(
  db: Database,
  rows: ReadonlyArray<{ id: number; request_version: number }>
): void {
  if (rows.length === 0) {
    return;
  }

  const markInTransaction = db.transaction(
    (nextRows: ReadonlyArray<{ id: number; request_version: number }>): void => {
      const markStatement = db.prepare(
        `
          UPDATE pr_review_request
          SET notified_at = ${SQL_NOW_ISO_UTC}
          WHERE id = ?
            AND request_version = ?
            AND notified_at IS NULL
            AND removed_at IS NULL
        `
      );

      for (const row of nextRows) {
        markStatement.run(row.id, row.request_version);
      }
    }
  );

  markInTransaction.immediate(rows);
}

export function countClosedPrReviewRequestsPendingNotification(db: Database): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM pr_review_request
        INNER JOIN pr_status ON pr_status.id = pr_review_request.pr_status_id
        WHERE pr_review_request.removed_at IS NULL
          AND pr_review_request.notified_at IS NULL
          AND pr_status.state IN ('closed', 'merged')
      `
    )
    .get() as { count: number };

  return row.count;
}

export function markClosedPrReviewRequestsNotified(db: Database): number {
  const result = db
    .prepare(
      `
        UPDATE pr_review_request
        SET notified_at = ${SQL_NOW_ISO_UTC}
        WHERE removed_at IS NULL
          AND notified_at IS NULL
          AND pr_status_id IN (
            SELECT id
            FROM pr_status
            WHERE state IN ('closed', 'merged')
          )
      `
    )
    .run();

  return result.changes;
}
