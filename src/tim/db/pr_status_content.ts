import type { Database } from 'bun:sqlite';

/**
 * Large PR text that the PR detail view shows: the PR description and the review guide
 * comment that tim posts. It is kept out of `pr_status` so the PR list queries stay small.
 */
export interface PrStatusContentRow {
  pr_status_id: number;
  body: string | null;
  review_guide_comment_id: number | null;
  review_guide_comment_body: string | null;
  review_guide_comment_url: string | null;
  review_guide_comment_updated_at: string | null;
}

export interface StoredReviewGuideCommentInput {
  commentId: number;
  body: string;
  url: string | null;
  updatedAt: string | null;
}

export function getPrStatusContent(db: Database, prStatusId: number): PrStatusContentRow | null {
  return (
    (db
      .prepare('SELECT * FROM pr_status_content WHERE pr_status_id = ?')
      .get(prStatusId) as PrStatusContentRow | null) ?? null
  );
}

/** Load the content for a PR by its canonical URL. */
export function getPrStatusContentByUrl(db: Database, prUrl: string): PrStatusContentRow | null {
  return (
    (db
      .prepare(
        `
        SELECT pr_status_content.*
        FROM pr_status_content
        JOIN pr_status ON pr_status.id = pr_status_content.pr_status_id
        WHERE pr_status.pr_url = ?
      `
      )
      .get(prUrl) as PrStatusContentRow | null) ?? null
  );
}

/** Store the PR description. Returns true when the stored value changed. */
export function setPrBody(db: Database, prStatusId: number, body: string | null): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO pr_status_content (pr_status_id, body) VALUES (?, ?)
      ON CONFLICT(pr_status_id) DO UPDATE SET body = excluded.body
      WHERE pr_status_content.body IS NOT excluded.body
    `
    )
    .run(prStatusId, body);
  return result.changes > 0;
}

/**
 * Store the review guide comment. A comment update that is older than the stored one is
 * ignored, so webhook deliveries that arrive out of order do not replace newer text.
 * Returns true when the stored value changed.
 */
export function upsertPrReviewGuideComment(
  db: Database,
  prStatusId: number,
  input: StoredReviewGuideCommentInput
): boolean {
  const result = db
    .prepare(
      `
      INSERT INTO pr_status_content (
        pr_status_id,
        review_guide_comment_id,
        review_guide_comment_body,
        review_guide_comment_url,
        review_guide_comment_updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(pr_status_id) DO UPDATE SET
        review_guide_comment_id = excluded.review_guide_comment_id,
        review_guide_comment_body = excluded.review_guide_comment_body,
        review_guide_comment_url = excluded.review_guide_comment_url,
        review_guide_comment_updated_at = excluded.review_guide_comment_updated_at
      WHERE (
          excluded.review_guide_comment_updated_at IS NULL
          OR pr_status_content.review_guide_comment_updated_at IS NULL
          OR excluded.review_guide_comment_updated_at >= pr_status_content.review_guide_comment_updated_at
        )
        AND (
          pr_status_content.review_guide_comment_id IS NOT excluded.review_guide_comment_id
          OR pr_status_content.review_guide_comment_body IS NOT excluded.review_guide_comment_body
          OR pr_status_content.review_guide_comment_url IS NOT excluded.review_guide_comment_url
          OR pr_status_content.review_guide_comment_updated_at IS NOT excluded.review_guide_comment_updated_at
        )
    `
    )
    .run(prStatusId, input.commentId, input.body, input.url, input.updatedAt);
  return result.changes > 0;
}

/**
 * Remove the stored review guide comment. When `commentId` is given, the stored comment is
 * removed only if it is that comment. Returns true when the stored value changed.
 */
export function clearPrReviewGuideComment(
  db: Database,
  prStatusId: number,
  commentId?: number
): boolean {
  const result = db
    .prepare(
      `
      UPDATE pr_status_content SET
        review_guide_comment_id = NULL,
        review_guide_comment_body = NULL,
        review_guide_comment_url = NULL,
        review_guide_comment_updated_at = NULL
      WHERE pr_status_id = ?
        AND review_guide_comment_id IS NOT NULL
        AND (? IS NULL OR review_guide_comment_id = ?)
    `
    )
    .run(prStatusId, commentId ?? null, commentId ?? null);
  return result.changes > 0;
}
