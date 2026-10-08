import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { ReviewFileChangeType } from '../../common/review_guide_patch.js';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export type ReviewFileKind = 'changed' | 'context';
export type ReviewViewedItemKind = 'section' | 'file';

export interface ReviewFileInput {
  path: string;
  oldPath?: string | null;
  kind: ReviewFileKind;
  changeType?: ReviewFileChangeType | null;
  /** Full per-file unified diff for changed files. */
  patch?: string | null;
  /** Old-side (base) contents, or null when not stored. */
  oldContent?: string | null;
  /** New-side (reviewed) contents, or null when not stored. */
  newContent?: string | null;
}

export interface ReviewFileRow {
  path: string;
  oldPath: string | null;
  kind: ReviewFileKind;
  changeType: ReviewFileChangeType | null;
  patch: string | null;
  oldContent: string | null;
  newContent: string | null;
}

interface ReviewFileDbRow {
  path: string;
  old_path: string | null;
  kind: ReviewFileKind;
  change_type: ReviewFileChangeType | null;
  patch: string | null;
  old_content: string | null;
  new_content: string | null;
}

export interface ReviewViewedItemRow {
  kind: ReviewViewedItemKind;
  key: string;
  viewedAt: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Store the files for a review: per-file patches for changed files, and the full
 * old/new contents (deduplicated by content hash in `review_blob`) so the viewer
 * can expand unchanged lines and show unchanged context files. Replaces any
 * files stored earlier for the same review, then removes blobs that no review
 * references any more.
 */
export function replaceReviewFiles(db: Database, reviewId: number, files: ReviewFileInput[]): void {
  db.transaction(() => {
    const insertBlob = db.prepare(
      'INSERT OR IGNORE INTO review_blob (hash, content, byte_size) VALUES (?, ?, ?)'
    );
    const insertFile = db.prepare(
      `
        INSERT INTO review_file (
          review_id, path, old_path, kind, change_type, patch, old_blob_hash, new_blob_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(review_id, path) DO UPDATE SET
          old_path = excluded.old_path,
          kind = excluded.kind,
          change_type = excluded.change_type,
          patch = excluded.patch,
          old_blob_hash = excluded.old_blob_hash,
          new_blob_hash = excluded.new_blob_hash
      `
    );

    const storeBlob = (content: string | null | undefined): string | null => {
      if (content == null) {
        return null;
      }
      const hash = hashContent(content);
      insertBlob.run(hash, content, Buffer.byteLength(content, 'utf8'));
      return hash;
    };

    db.prepare('DELETE FROM review_file WHERE review_id = ?').run(reviewId);
    for (const file of files) {
      insertFile.run(
        reviewId,
        file.path,
        file.oldPath ?? null,
        file.kind,
        file.changeType ?? null,
        file.patch ?? null,
        storeBlob(file.oldContent),
        storeBlob(file.newContent)
      );
    }
    deleteOrphanReviewBlobs(db);
  }).immediate();
}

/** Delete blobs that no review_file row references. */
export function deleteOrphanReviewBlobs(db: Database): number {
  return db
    .prepare(
      `
        DELETE FROM review_blob
        WHERE NOT EXISTS (SELECT 1 FROM review_file WHERE old_blob_hash = review_blob.hash)
          AND NOT EXISTS (SELECT 1 FROM review_file WHERE new_blob_hash = review_blob.hash)
      `
    )
    .run().changes;
}

export function getReviewFiles(db: Database, reviewId: number): ReviewFileRow[] {
  const rows = db
    .prepare(
      `
        SELECT
          f.path,
          f.old_path,
          f.kind,
          f.change_type,
          f.patch,
          old_blob.content AS old_content,
          new_blob.content AS new_content
        FROM review_file f
        LEFT JOIN review_blob old_blob ON old_blob.hash = f.old_blob_hash
        LEFT JOIN review_blob new_blob ON new_blob.hash = f.new_blob_hash
        WHERE f.review_id = ?
        ORDER BY f.kind, f.id
      `
    )
    .all(reviewId) as ReviewFileDbRow[];

  return rows.map((row) => ({
    path: row.path,
    oldPath: row.old_path,
    kind: row.kind,
    changeType: row.change_type,
    patch: row.patch,
    oldContent: row.old_content,
    newContent: row.new_content,
  }));
}

function assertValidViewedItemKind(kind: string): asserts kind is ReviewViewedItemKind {
  if (kind !== 'section' && kind !== 'file') {
    throw new Error(`Invalid review viewed item kind: ${kind}`);
  }
}

export function getReviewViewedItems(db: Database, reviewId: number): ReviewViewedItemRow[] {
  const rows = db
    .prepare(
      `
        SELECT item_kind, item_key, viewed_at
        FROM review_viewed_item
        WHERE review_id = ?
        ORDER BY viewed_at, item_key
      `
    )
    .all(reviewId) as Array<{ item_kind: string; item_key: string; viewed_at: string }>;

  return rows.map((row) => {
    assertValidViewedItemKind(row.item_kind);
    return { kind: row.item_kind, key: row.item_key, viewedAt: row.viewed_at };
  });
}

/** Mark a guide section or file as viewed (or not viewed) for a review. */
export function setReviewItemViewed(
  db: Database,
  input: { reviewId: number; kind: ReviewViewedItemKind; key: string; viewed: boolean }
): void {
  assertValidViewedItemKind(input.kind);
  if (input.viewed) {
    db.prepare(
      `
        INSERT INTO review_viewed_item (review_id, item_kind, item_key, viewed_at)
        VALUES (?, ?, ?, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(review_id, item_kind, item_key) DO NOTHING
      `
    ).run(input.reviewId, input.kind, input.key);
  } else {
    db.prepare(
      'DELETE FROM review_viewed_item WHERE review_id = ? AND item_kind = ? AND item_key = ?'
    ).run(input.reviewId, input.kind, input.key);
  }
}
