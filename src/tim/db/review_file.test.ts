import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import { openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import {
  createReview,
  getReviewIssueById,
  getReviewIssues,
  insertReviewIssues,
  updateReviewIssue,
  type ReviewAnnotationKind,
} from './review.js';
import {
  deleteOrphanReviewBlobs,
  getReviewFiles,
  getReviewViewedItems,
  replaceReviewFiles,
  setReviewItemViewed,
  type ReviewFileInput,
  type ReviewViewedItemKind,
} from './review_file.js';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

describe('tim db/review_file', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'repo-review-file').id;
  });

  afterEach(() => {
    db.close(false);
  });

  function newReview(n: number): number {
    return createReview(db, {
      projectId,
      prUrl: `https://github.com/example/repo/pull/${n}`,
    }).id;
  }

  function blobCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM review_blob').get() as { n: number }).n;
  }

  function blobContents(): string[] {
    return (
      db.prepare('SELECT content FROM review_blob ORDER BY content').all() as Array<{
        content: string;
      }>
    ).map((row) => row.content);
  }

  describe('replaceReviewFiles / getReviewFiles', () => {
    test('round trips changed and context files', () => {
      const reviewId = newReview(1);
      const files: ReviewFileInput[] = [
        {
          path: 'src/a.ts',
          kind: 'changed',
          changeType: 'modified',
          patch: PATCH,
          oldContent: 'old\n',
          newContent: 'new\n',
        },
        {
          path: 'src/renamed.ts',
          oldPath: 'src/original.ts',
          kind: 'changed',
          changeType: 'renamed',
          patch: 'diff --git a/src/original.ts b/src/renamed.ts\n',
          oldContent: null,
          newContent: null,
        },
        {
          path: 'src/new.ts',
          kind: 'changed',
          changeType: 'added',
          oldContent: null,
          newContent: '',
        },
        { path: 'README.md', kind: 'context', newContent: '# Readme\n' },
      ];
      replaceReviewFiles(db, reviewId, files);

      expect(getReviewFiles(db, reviewId)).toEqual([
        {
          path: 'src/a.ts',
          oldPath: null,
          kind: 'changed',
          changeType: 'modified',
          patch: PATCH,
          oldContent: 'old\n',
          newContent: 'new\n',
        },
        {
          path: 'src/renamed.ts',
          oldPath: 'src/original.ts',
          kind: 'changed',
          changeType: 'renamed',
          patch: 'diff --git a/src/original.ts b/src/renamed.ts\n',
          oldContent: null,
          newContent: null,
        },
        {
          path: 'src/new.ts',
          oldPath: null,
          kind: 'changed',
          changeType: 'added',
          patch: null,
          oldContent: null,
          // An empty string is a real (empty) blob, not a missing one.
          newContent: '',
        },
        {
          path: 'README.md',
          oldPath: null,
          kind: 'context',
          changeType: null,
          patch: null,
          oldContent: null,
          newContent: '# Readme\n',
        },
      ]);
      expect(blobContents()).toEqual(['', '# Readme\n', 'new\n', 'old\n']);
    });

    test('returns [] for a review without files', () => {
      expect(getReviewFiles(db, newReview(1))).toEqual([]);
    });

    test('stores identical contents once across reviews and files', () => {
      const first = newReview(1);
      const second = newReview(2);
      const shared = 'export const shared = true;\n';
      replaceReviewFiles(db, first, [
        { path: 'a.ts', kind: 'context', oldContent: shared, newContent: shared },
      ]);
      replaceReviewFiles(db, second, [
        { path: 'b.ts', kind: 'context', newContent: shared },
        { path: 'c.ts', kind: 'context', newContent: 'other\n' },
      ]);

      expect(blobCount()).toBe(2);
      const row = db.prepare('SELECT byte_size FROM review_blob WHERE content = ?').get(shared) as {
        byte_size: number;
      };
      expect(row.byte_size).toBe(Buffer.byteLength(shared, 'utf8'));
      expect(getReviewFiles(db, first)[0].newContent).toBe(shared);
      expect(getReviewFiles(db, second).map((file) => file.newContent)).toEqual([
        shared,
        'other\n',
      ]);
    });

    test('records byte size in UTF-8 bytes', () => {
      const reviewId = newReview(1);
      replaceReviewFiles(db, reviewId, [{ path: 'u.txt', kind: 'context', newContent: 'é\n' }]);
      const row = db.prepare('SELECT byte_size FROM review_blob').get() as { byte_size: number };
      expect(row.byte_size).toBe(3);
    });

    test('replacing files for a review drops the old rows and orphan blobs', () => {
      const reviewId = newReview(1);
      replaceReviewFiles(db, reviewId, [
        {
          path: 'a.ts',
          kind: 'changed',
          changeType: 'modified',
          oldContent: 'a1\n',
          newContent: 'a2\n',
        },
        { path: 'b.ts', kind: 'context', newContent: 'b\n' },
      ]);
      expect(blobContents()).toEqual(['a1\n', 'a2\n', 'b\n']);

      replaceReviewFiles(db, reviewId, [
        {
          path: 'a.ts',
          kind: 'changed',
          changeType: 'modified',
          oldContent: 'a2\n',
          newContent: 'a3\n',
        },
      ]);

      expect(getReviewFiles(db, reviewId)).toEqual([
        {
          path: 'a.ts',
          oldPath: null,
          kind: 'changed',
          changeType: 'modified',
          patch: null,
          oldContent: 'a2\n',
          newContent: 'a3\n',
        },
      ]);
      expect(blobContents()).toEqual(['a2\n', 'a3\n']);
    });

    test('replacing one review keeps blobs that another review still uses', () => {
      const first = newReview(1);
      const second = newReview(2);
      replaceReviewFiles(db, first, [{ path: 'a.ts', kind: 'context', newContent: 'shared\n' }]);
      replaceReviewFiles(db, second, [{ path: 'a.ts', kind: 'context', newContent: 'shared\n' }]);

      replaceReviewFiles(db, first, []);

      expect(getReviewFiles(db, first)).toEqual([]);
      expect(getReviewFiles(db, second)[0].newContent).toBe('shared\n');
      expect(blobContents()).toEqual(['shared\n']);
    });

    test('a later entry with the same path replaces the earlier one', () => {
      const reviewId = newReview(1);
      replaceReviewFiles(db, reviewId, [
        { path: 'a.ts', kind: 'context', newContent: 'first\n' },
        { path: 'a.ts', kind: 'changed', changeType: 'modified', newContent: 'second\n' },
      ]);
      const files = getReviewFiles(db, reviewId);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ kind: 'changed', newContent: 'second\n' });
      expect(blobContents()).toEqual(['second\n']);
    });

    test('rolls back everything when an insert fails', () => {
      const reviewId = newReview(1);
      replaceReviewFiles(db, reviewId, [{ path: 'a.ts', kind: 'context', newContent: 'keep\n' }]);

      expect(() =>
        replaceReviewFiles(db, reviewId, [
          { path: 'b.ts', kind: 'context', newContent: 'new\n' },
          { path: 'c.ts', kind: 'bogus' as ReviewFileInput['kind'], newContent: 'x\n' },
        ])
      ).toThrow();

      expect(getReviewFiles(db, reviewId).map((file) => file.path)).toEqual(['a.ts']);
      expect(blobContents()).toEqual(['keep\n']);
    });

    test('deleting a review cascades to its files; the next replace removes orphan blobs', () => {
      const deleted = newReview(1);
      const other = newReview(2);
      replaceReviewFiles(db, deleted, [
        { path: 'a.ts', kind: 'context', oldContent: 'gone-old\n', newContent: 'gone-new\n' },
      ]);

      // There is no production API that deletes a review, so delete the row directly.
      db.prepare('DELETE FROM review WHERE id = ?').run(deleted);
      expect(getReviewFiles(db, deleted)).toEqual([]);
      expect((db.prepare('SELECT COUNT(*) AS n FROM review_file').get() as { n: number }).n).toBe(
        0
      );
      // Blobs are not reference-counted by foreign keys, so they stay for now.
      expect(blobContents()).toEqual(['gone-new\n', 'gone-old\n']);

      replaceReviewFiles(db, other, [{ path: 'b.ts', kind: 'context', newContent: 'b\n' }]);
      expect(blobContents()).toEqual(['b\n']);
    });

    test('deleteOrphanReviewBlobs returns the number of removed blobs', () => {
      const reviewId = newReview(1);
      replaceReviewFiles(db, reviewId, [
        { path: 'a.ts', kind: 'context', oldContent: 'x\n', newContent: 'y\n' },
      ]);
      expect(deleteOrphanReviewBlobs(db)).toBe(0);
      db.prepare('DELETE FROM review WHERE id = ?').run(reviewId);
      expect(deleteOrphanReviewBlobs(db)).toBe(2);
      expect(blobCount()).toBe(0);
    });
  });

  describe('setReviewItemViewed / getReviewViewedItems', () => {
    test('marks sections and files as viewed', () => {
      const reviewId = newReview(1);
      setReviewItemViewed(db, { reviewId, kind: 'section', key: 'intro', viewed: true });
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'src/a.ts', viewed: true });

      const items = getReviewViewedItems(db, reviewId);
      expect(
        items.map(({ kind, key }) => ({ kind, key })).sort((a, b) => a.key.localeCompare(b.key))
      ).toEqual([
        { kind: 'section', key: 'intro' },
        { kind: 'file', key: 'src/a.ts' },
      ]);
      for (const item of items) {
        expect(item.viewedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      }
      expect(getReviewViewedItems(db, newReview(2))).toEqual([]);
    });

    test('the same key may be used for a section and a file', () => {
      const reviewId = newReview(1);
      setReviewItemViewed(db, { reviewId, kind: 'section', key: 'same', viewed: true });
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'same', viewed: true });
      expect(getReviewViewedItems(db, reviewId)).toHaveLength(2);
    });

    test('setting viewed twice keeps one row and the first timestamp', () => {
      const reviewId = newReview(1);
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'a.ts', viewed: true });
      db.prepare('UPDATE review_viewed_item SET viewed_at = ? WHERE item_key = ?').run(
        '2020-01-01T00:00:00.000Z',
        'a.ts'
      );
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'a.ts', viewed: true });

      expect(getReviewViewedItems(db, reviewId)).toEqual([
        { kind: 'file', key: 'a.ts', viewedAt: '2020-01-01T00:00:00.000Z' },
      ]);
    });

    test('unsetting removes only the matching item', () => {
      const reviewId = newReview(1);
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'a.ts', viewed: true });
      setReviewItemViewed(db, { reviewId, kind: 'section', key: 'a.ts', viewed: true });

      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'a.ts', viewed: false });
      expect(getReviewViewedItems(db, reviewId).map((item) => item.kind)).toEqual(['section']);

      // Unsetting an item that is not set is a no-op.
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'missing', viewed: false });
      expect(getReviewViewedItems(db, reviewId)).toHaveLength(1);
    });

    test('orders items by viewed time, then key', () => {
      const reviewId = newReview(1);
      for (const key of ['b', 'a', 'c']) {
        setReviewItemViewed(db, { reviewId, kind: 'section', key, viewed: true });
      }
      db.prepare('UPDATE review_viewed_item SET viewed_at = ?').run('2021-01-01T00:00:00.000Z');
      db.prepare('UPDATE review_viewed_item SET viewed_at = ? WHERE item_key = ?').run(
        '2020-01-01T00:00:00.000Z',
        'c'
      );
      expect(getReviewViewedItems(db, reviewId).map((item) => item.key)).toEqual(['c', 'a', 'b']);
    });

    test('an invalid kind throws before writing', () => {
      const reviewId = newReview(1);
      expect(() =>
        setReviewItemViewed(db, {
          reviewId,
          kind: 'hunk' as ReviewViewedItemKind,
          key: 'x',
          viewed: true,
        })
      ).toThrow('Invalid review viewed item kind: hunk');
      expect(() =>
        setReviewItemViewed(db, {
          reviewId,
          kind: 'hunk' as ReviewViewedItemKind,
          key: 'x',
          viewed: false,
        })
      ).toThrow('Invalid review viewed item kind: hunk');
      expect(getReviewViewedItems(db, reviewId)).toEqual([]);
    });

    test('viewed items are removed with their review', () => {
      const reviewId = newReview(1);
      setReviewItemViewed(db, { reviewId, kind: 'file', key: 'a.ts', viewed: true });
      db.prepare('DELETE FROM review WHERE id = ?').run(reviewId);
      expect(getReviewViewedItems(db, reviewId)).toEqual([]);
    });
  });

  describe('review issue annotationKind', () => {
    test('insertReviewIssues stores annotationKind and defaults it to null', () => {
      const reviewId = newReview(1);
      const inserted = insertReviewIssues(db, {
        reviewId,
        issues: [
          { severity: 'note', category: 'other', content: 'Why', annotationKind: 'why' },
          { severity: 'note', category: 'other', content: 'Check', annotationKind: 'verify' },
          { severity: 'major', category: 'bug', content: 'Plain issue' },
        ],
      });

      expect(inserted.map((issue) => issue.annotationKind)).toEqual(['why', 'verify', null]);
      expect(getReviewIssues(db, reviewId).map((issue) => issue.annotationKind)).toEqual([
        'why',
        'verify',
        null,
      ]);
    });

    test('updateReviewIssue changes and clears annotationKind', () => {
      const reviewId = newReview(1);
      const [issue] = insertReviewIssues(db, {
        reviewId,
        issues: [{ severity: 'note', category: 'other', content: 'Note', annotationKind: 'note' }],
      });

      expect(updateReviewIssue(db, issue.id, { annotationKind: 'question' })?.annotationKind).toBe(
        'question'
      );
      expect(getReviewIssueById(db, issue.id)?.annotationKind).toBe('question');

      // Leaving the field out keeps the value.
      expect(updateReviewIssue(db, issue.id, { content: 'Edited' })?.annotationKind).toBe(
        'question'
      );

      expect(updateReviewIssue(db, issue.id, { annotationKind: null })?.annotationKind).toBeNull();
    });

    test('an invalid annotationKind throws on insert and update', () => {
      const reviewId = newReview(1);
      expect(() =>
        insertReviewIssues(db, {
          reviewId,
          issues: [
            { severity: 'note', category: 'other', content: 'ok', annotationKind: 'why' },
            {
              severity: 'note',
              category: 'other',
              content: 'bad',
              annotationKind: 'opinion' as ReviewAnnotationKind,
            },
          ],
        })
      ).toThrow('Invalid review_issue.annotation_kind value in insertReviewIssues: opinion');
      // The transaction rolls back the valid issue too.
      expect(getReviewIssues(db, reviewId)).toEqual([]);

      const [issue] = insertReviewIssues(db, {
        reviewId,
        issues: [{ severity: 'note', category: 'other', content: 'ok', annotationKind: 'why' }],
      });
      expect(() =>
        updateReviewIssue(db, issue.id, { annotationKind: 'opinion' as ReviewAnnotationKind })
      ).toThrow('Invalid review_issue.annotation_kind value in updateReviewIssue: opinion');
      expect(getReviewIssueById(db, issue.id)?.annotationKind).toBe('why');
    });
  });
});
