import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPrStatus, upsertPrReviewRequestByReviewer } from '$tim/db/pr_status.js';
import {
  countClosedPrReviewRequestsPendingNotification,
  getPendingReviewRequestNotifications,
  markClosedPrReviewRequestsNotified,
  markReviewRequestsNotified,
} from '$tim/db/pr_review_request_notifications.js';
import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';

function getReviewRequestIdentity(
  db: Database,
  reviewer: string
): { id: number; request_version: number } {
  return db
    .prepare('SELECT id, request_version FROM pr_review_request WHERE reviewer = ?')
    .get(reviewer) as { id: number; request_version: number };
}

describe('tim db/pr_review_request_notifications', () => {
  let tempDir: string;
  let db: Database;
  let prStatusId: number;
  let pr2StatusId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-notif-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));

    getOrCreateProject(db, constructGitHubRepositoryId('octocat', 'hello-world'));

    const pr1 = upsertPrStatus(db, {
      prUrl: 'https://github.com/octocat/hello-world/pull/1',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 1,
      author: 'alice',
      title: 'Fix the thing',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
      additions: 42,
      deletions: 17,
      changedFiles: 3,
    });
    prStatusId = pr1.status.id;

    const pr2 = upsertPrStatus(db, {
      prUrl: 'https://github.com/octocat/hello-world/pull/2',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 2,
      author: 'bob',
      title: 'Add feature',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
    });
    pr2StatusId = pr2.status.id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('getPendingReviewRequestNotifications', () => {
    test('returns rows where removed_at IS NULL and notified_at IS NULL', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'charlie',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const rows = getPendingReviewRequestNotifications(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].reviewer).toBe('charlie');
    });

    test('excludes rows where removed_at is set', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'charlie',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'charlie',
        action: 'removed',
        eventAt: '2026-01-01T11:00:00.000Z',
      });

      const rows = getPendingReviewRequestNotifications(db);
      expect(rows).toHaveLength(0);
    });

    test('excludes rows where notified_at is set', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'charlie',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const row = getReviewRequestIdentity(db, 'charlie');
      markReviewRequestsNotified(db, [row]);

      const rows = getPendingReviewRequestNotifications(db);
      expect(rows).toHaveLength(0);
    });

    test('includes joined pr_status fields correctly', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'dave',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const rows = getPendingReviewRequestNotifications(db);
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.reviewer).toBe('dave');
      expect(row.pr_status_id).toBe(prStatusId);
      expect(row.owner).toBe('octocat');
      expect(row.repo).toBe('hello-world');
      expect(row.pr_url).toBe('https://github.com/octocat/hello-world/pull/1');
      expect(row.pr_number).toBe(1);
      expect(row.title).toBe('Fix the thing');
      expect(row.author).toBe('alice');
      expect(row.additions).toBe(42);
      expect(row.deletions).toBe(17);
      expect(row.changed_files).toBe(3);
      expect(row.requested_at).toBe('2026-01-01T10:00:00.000Z');
      expect(typeof row.id).toBe('number');
      expect(typeof row.request_version).toBe('number');
    });

    test('returns multiple pending rows across PRs', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'bob',
        action: 'requested',
        eventAt: '2026-01-01T10:01:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, pr2StatusId, {
        reviewer: 'charlie',
        action: 'requested',
        eventAt: '2026-01-01T10:02:00.000Z',
      });

      const rows = getPendingReviewRequestNotifications(db);
      expect(rows).toHaveLength(3);
    });

    test('excludes rows for closed and merged PRs', () => {
      const closedPrStatusId = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/3',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 3,
        author: 'closed-author',
        title: 'Closed PR',
        state: 'closed',
        draft: false,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      }).status.id;
      const mergedPrStatusId = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/4',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 4,
        author: 'merged-author',
        title: 'Merged PR',
        state: 'merged',
        draft: false,
        mergedAt: '2026-01-01T12:00:00.000Z',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      }).status.id;

      upsertPrReviewRequestByReviewer(db, closedPrStatusId, {
        reviewer: 'closed-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, mergedPrStatusId, {
        reviewer: 'merged-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:01:00.000Z',
      });

      expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);
    });
  });

  describe('upsertPrReviewRequestByReviewer: re-request lifecycle', () => {
    test('re-request after notification clears notified_at and removed_at so row reappears as pending', () => {
      const T1 = '2026-01-01T10:00:00.000Z';
      const T2 = '2026-01-01T11:00:00.000Z';
      const T3 = '2026-01-01T12:00:00.000Z';

      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: T1,
      });
      expect(getPendingReviewRequestNotifications(db).map((r) => r.reviewer)).toContain('alice');

      markReviewRequestsNotified(db, [getReviewRequestIdentity(db, 'alice')]);
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);

      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'removed',
        eventAt: T2,
      });
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);

      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: T3,
      });

      const pending = getPendingReviewRequestNotifications(db);
      expect(pending.map((r) => r.reviewer)).toContain('alice');

      const row = db
        .prepare(
          'SELECT requested_at, removed_at, notified_at FROM pr_review_request WHERE reviewer = ?'
        )
        .get('alice') as {
        requested_at: string;
        removed_at: string | null;
        notified_at: string | null;
      };
      expect(row.requested_at).toBe(T3);
      expect(row.removed_at).toBeNull();
      expect(row.notified_at).toBeNull();
    });

    test('stale (older) requested event does not clear notified_at or removed_at', () => {
      const T1 = '2026-01-01T10:00:00.000Z';
      const T0 = '2026-01-01T09:00:00.000Z'; // older than T1

      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'bob',
        action: 'requested',
        eventAt: T1,
      });
      markReviewRequestsNotified(db, [getReviewRequestIdentity(db, 'bob')]);

      // Attempt to upsert with a stale (older) requested event
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'bob',
        action: 'requested',
        eventAt: T0,
      });

      // notified_at must NOT be cleared by a stale event
      const row = db
        .prepare('SELECT notified_at, requested_at FROM pr_review_request WHERE reviewer = ?')
        .get('bob') as { notified_at: string | null; requested_at: string | null };
      expect(row.notified_at).not.toBeNull();
      // requested_at should still be T1, not T0
      expect(row.requested_at).toBe(T1);
    });

    test('first-time request → notify: no spurious reset when no newer event arrives', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'carol',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      markReviewRequestsNotified(db, [getReviewRequestIdentity(db, 'carol')]);

      // No subsequent upsert — row should remain notified
      const pending = getPendingReviewRequestNotifications(db);
      expect(pending.map((r) => r.reviewer)).not.toContain('carol');
    });
  });

  describe('markReviewRequestsNotified', () => {
    test('sets notified_at for the given ids', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'eve',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const row = getReviewRequestIdentity(db, 'eve');

      markReviewRequestsNotified(db, [row]);

      const updated = db
        .prepare('SELECT notified_at FROM pr_review_request WHERE id = ?')
        .get(row.id) as { notified_at: string | null };
      expect(updated.notified_at).not.toBeNull();
    });

    test('empty array is a safe no-op', () => {
      expect(() => markReviewRequestsNotified(db, [])).not.toThrow();
    });

    test('marked rows disappear from getPendingReviewRequestNotifications', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'eve',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'frank',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const eveRow = getReviewRequestIdentity(db, 'eve');

      markReviewRequestsNotified(db, [eveRow]);

      const pending = getPendingReviewRequestNotifications(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].reviewer).toBe('frank');
    });

    test('marking only sets notified_at for specified ids, not others', () => {
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'grace',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'henry',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const graceRow = getReviewRequestIdentity(db, 'grace');
      const henryRow = db
        .prepare('SELECT id, request_version FROM pr_review_request WHERE reviewer = ?')
        .get('henry') as { id: number; request_version: number };

      markReviewRequestsNotified(db, [graceRow]);

      const graceUpdated = db
        .prepare('SELECT notified_at FROM pr_review_request WHERE id = ?')
        .get(graceRow.id) as { notified_at: string | null };
      const henryUpdated = db
        .prepare('SELECT notified_at FROM pr_review_request WHERE id = ?')
        .get(henryRow.id) as { notified_at: string | null };

      expect(graceUpdated.notified_at).not.toBeNull();
      expect(henryUpdated.notified_at).toBeNull();
    });
  });

  describe('markClosedPrReviewRequestsNotified', () => {
    let closedPrStatusId: number;
    let mergedPrStatusId: number;

    beforeEach(() => {
      closedPrStatusId = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/3',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 3,
        author: 'closed-author',
        title: 'Closed PR',
        state: 'closed',
        draft: false,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      }).status.id;

      mergedPrStatusId = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/4',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 4,
        author: 'merged-author',
        title: 'Merged PR',
        state: 'merged',
        draft: false,
        mergedAt: '2026-01-01T12:00:00.000Z',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      }).status.id;
    });

    test('counts pending unremoved notifications for closed and merged PRs', () => {
      upsertPrReviewRequestByReviewer(db, closedPrStatusId, {
        reviewer: 'closed-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, mergedPrStatusId, {
        reviewer: 'merged-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:01:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'open-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:02:00.000Z',
      });

      expect(countClosedPrReviewRequestsPendingNotification(db)).toBe(2);
    });

    test('marks closed and merged PR notifications while leaving open PRs pending', () => {
      upsertPrReviewRequestByReviewer(db, closedPrStatusId, {
        reviewer: 'closed-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, mergedPrStatusId, {
        reviewer: 'merged-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:01:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'open-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:02:00.000Z',
      });

      const markedCount = markClosedPrReviewRequestsNotified(db);

      expect(markedCount).toBe(2);
      expect(countClosedPrReviewRequestsPendingNotification(db)).toBe(0);
      expect(getPendingReviewRequestNotifications(db).map((row) => row.reviewer)).toEqual([
        'open-reviewer',
      ]);
    });

    test('does not mark removed closed PR review requests', () => {
      upsertPrReviewRequestByReviewer(db, closedPrStatusId, {
        reviewer: 'closed-reviewer',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, closedPrStatusId, {
        reviewer: 'closed-reviewer',
        action: 'removed',
        eventAt: '2026-01-01T11:00:00.000Z',
      });

      expect(countClosedPrReviewRequestsPendingNotification(db)).toBe(0);
      expect(markClosedPrReviewRequestsNotified(db)).toBe(0);
    });
  });
});
