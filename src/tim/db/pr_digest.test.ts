import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openDatabase } from '$tim/db/database.js';
import {
  getApprovedUnmergedRows,
  getOtherReadyForReviewRows,
  getStaleReviewRequestRows,
} from '$tim/db/pr_digest.js';
import {
  upsertPrReviewByAuthor,
  upsertPrReviewRequestByReviewer,
  upsertPrStatus,
} from '$tim/db/pr_status.js';

describe('tim db/pr_digest', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  describe('getApprovedUnmergedRows', () => {
    test('returns only open approved non-draft PRs scoped to the repo', () => {
      const approved = insertPr(1, { reviewDecision: 'APPROVED' });
      review(approved.status.id, 'reviewer-old', 'APPROVED', '2026-01-01T09:00:00.000Z');
      review(approved.status.id, 'reviewer-new', 'APPROVED', '2026-01-01T10:00:00.000Z');
      insertPr(2, { reviewDecision: 'APPROVED', draft: true });
      insertPr(3, { reviewDecision: 'REVIEW_REQUIRED' });
      insertPr(4, { reviewDecision: 'CHANGES_REQUESTED' });
      insertPr(5, { reviewDecision: null });
      insertPr(6, { reviewDecision: 'APPROVED', state: 'closed' });
      insertPr(7, { reviewDecision: 'APPROVED', state: 'merged' });
      insertPr(8, { owner: 'octocat', repo: 'other', reviewDecision: 'APPROVED' });
      insertPr(9, { owner: 'other-owner', repo: 'hello-world', reviewDecision: 'APPROVED' });

      const rows = getApprovedUnmergedRows(db, 'octocat', 'hello-world');

      expect(rows).toEqual([
        {
          pr_url: 'https://github.com/octocat/hello-world/pull/1',
          pr_number: 1,
          title: 'PR 1',
          author: 'author-1',
          is_stacked: 0,
          approved_at: '2026-01-01T10:00:00.000Z',
        },
      ]);
    });

    test('returns null approval time when local approval review rows are missing', () => {
      insertPr(10, { reviewDecision: 'APPROVED' });

      const rows = getApprovedUnmergedRows(db, 'octocat', 'hello-world');

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 10,
          approved_at: null,
        }),
      ]);
    });

    test('marks PRs stacked on another open PR and exposes the base branch', () => {
      // Base PR whose head branch is the stacked PR's base.
      insertPr(20, { reviewDecision: 'APPROVED', headBranch: 'feature-base', baseBranch: 'main' });
      // Stacked PR: its base is the open base PR's head branch.
      insertPr(21, {
        reviewDecision: 'APPROVED',
        baseBranch: 'feature-base',
        headBranch: 'feature-top',
      });
      // Targets default branch -> not stacked.
      insertPr(22, { reviewDecision: 'APPROVED', baseBranch: 'main', headBranch: 'feature-solo' });
      // Base branch matches a closed PR's head branch -> not stacked (only open PRs count).
      insertPr(23, { reviewDecision: 'APPROVED', state: 'closed', headBranch: 'old-base' });
      insertPr(24, {
        reviewDecision: 'APPROVED',
        baseBranch: 'old-base',
        headBranch: 'feature-on-closed',
      });

      const rows = getApprovedUnmergedRows(db, 'octocat', 'hello-world');
      const byNumber = new Map(rows.map((row) => [row.pr_number, row]));

      expect(byNumber.get(20)).toMatchObject({ is_stacked: 0 });
      expect(byNumber.get(21)).toMatchObject({ is_stacked: 1 });
      expect(byNumber.get(22)).toMatchObject({ is_stacked: 0 });
      expect(byNumber.get(24)).toMatchObject({ is_stacked: 0 });
    });
  });

  describe('getStaleReviewRequestRows', () => {
    test('returns requests older than now where no one has reviewed since the latest request', () => {
      const noReview = insertPr(10);
      requestReview(noReview.status.id, 'reviewer-no-review', REQUESTED_AT);

      const reviewedBefore = insertPr(11);
      requestReview(reviewedBefore.status.id, 'reviewer-before', REQUESTED_AT);
      review(reviewedBefore.status.id, 'reviewer-before', 'COMMENTED', '2026-01-01T09:00:00.000Z');

      const dismissedAfter = insertPr(12);
      requestReview(dismissedAfter.status.id, 'reviewer-dismissed', REQUESTED_AT);
      review(
        dismissedAfter.status.id,
        'reviewer-dismissed',
        'DISMISSED',
        '2026-01-01T11:00:00.000Z'
      );

      const twoReviewers = insertPr(13);
      requestReview(twoReviewers.status.id, 'reviewer-silent', REQUESTED_AT);
      requestReview(twoReviewers.status.id, 'reviewer-done', REQUESTED_AT);
      review(twoReviewers.status.id, 'reviewer-done', 'APPROVED', '2026-01-01T12:00:00.000Z');

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 10,
          reviewer: 'reviewer-no-review',
          requested_at: REQUESTED_AT,
        }),
        expect.objectContaining({
          pr_number: 11,
          reviewer: 'reviewer-before',
          requested_at: REQUESTED_AT,
        }),
        expect.objectContaining({
          pr_number: 12,
          reviewer: 'reviewer-dismissed',
          requested_at: REQUESTED_AT,
        }),
      ]);
    });

    test('excludes removed, null-requested, future, draft, closed, merged, and out-of-repo requests', () => {
      const removed = insertPr(20);
      requestReview(removed.status.id, 'reviewer-removed', REQUESTED_AT);
      upsertPrReviewRequestByReviewer(db, removed.status.id, {
        reviewer: 'reviewer-removed',
        action: 'removed',
        eventAt: '2026-01-01T11:00:00.000Z',
      });

      const nullRequested = insertPr(21);
      requestReview(nullRequested.status.id, 'reviewer-null-requested', REQUESTED_AT);
      db.prepare(
        `
          UPDATE pr_review_request
          SET requested_at = NULL,
              removed_at = NULL
          WHERE pr_status_id = ?
            AND reviewer = ?
        `
      ).run(nullRequested.status.id, 'reviewer-null-requested');

      const future = insertPr(22);
      requestReview(future.status.id, 'reviewer-future', '2026-01-03T10:00:00.000Z');

      const draft = insertPr(23, { draft: true });
      requestReview(draft.status.id, 'reviewer-draft', REQUESTED_AT);

      const closed = insertPr(24, { state: 'closed' });
      requestReview(closed.status.id, 'reviewer-closed', REQUESTED_AT);

      const merged = insertPr(25, { state: 'merged' });
      requestReview(merged.status.id, 'reviewer-merged', REQUESTED_AT);

      const otherRepo = insertPr(26, { repo: 'other' });
      requestReview(otherRepo.status.id, 'reviewer-other-repo', REQUESTED_AT);

      const otherOwner = insertPr(27, { owner: 'other-owner' });
      requestReview(otherOwner.status.id, 'reviewer-other-owner', REQUESTED_AT);

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([]);
    });

    test('treats any non-dismissed review submitted at or after the request as reviewed', () => {
      const reviewStates = ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'] as const;

      for (const [index, state] of reviewStates.entries()) {
        const pr = insertPr(30 + index);
        const reviewer = `reviewer-${state.toLowerCase()}`;
        requestReview(pr.status.id, reviewer, REQUESTED_AT);
        review(pr.status.id, reviewer, state, REQUESTED_AT);
      }

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([]);
    });

    test('treats a review from any active requested reviewer after the latest request as reviewed', () => {
      const pr = insertPr(35);
      requestReview(pr.status.id, 'reviewer-silent', '2026-01-01T10:00:00.000Z');
      requestReview(pr.status.id, 'reviewer-latest', '2026-01-01T11:00:00.000Z');
      review(pr.status.id, 'reviewer-silent', 'COMMENTED', '2026-01-01T11:30:00.000Z');

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([]);
    });

    test('does not treat a review from an unrequested author as reviewed', () => {
      const pr = insertPr(38);
      requestReview(pr.status.id, 'reviewer-silent', '2026-01-01T10:00:00.000Z');
      review(pr.status.id, 'unrequested-bot', 'COMMENTED', '2026-01-01T11:00:00.000Z');

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 38,
          reviewer: 'reviewer-silent',
        }),
      ]);
    });

    test('does not treat a review from the PR author as reviewed', () => {
      const pr = insertPr(37);
      requestReview(pr.status.id, 'reviewer-silent', '2026-01-01T10:00:00.000Z');
      review(pr.status.id, 'author-37', 'COMMENTED', '2026-01-01T11:00:00.000Z');

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 37,
          reviewer: 'reviewer-silent',
        }),
      ]);
    });

    test('keeps requests when the latest review is before the latest active request', () => {
      const pr = insertPr(36);
      requestReview(pr.status.id, 'reviewer-first', '2026-01-01T10:00:00.000Z');
      review(pr.status.id, 'reviewer-other', 'COMMENTED', '2026-01-01T10:30:00.000Z');
      requestReview(pr.status.id, 'reviewer-second', '2026-01-01T11:00:00.000Z');

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 36,
          reviewer: 'reviewer-first',
        }),
        expect.objectContaining({
          pr_number: 36,
          reviewer: 'reviewer-second',
        }),
      ]);
    });

    test('returns newline-joined PR labels and null when a PR has none', () => {
      const labeled = insertPr(45, { labels: ['review-p-0', 'bug'] });
      requestReview(labeled.status.id, 'reviewer-labeled', REQUESTED_AT);

      const unlabeled = insertPr(46);
      requestReview(unlabeled.status.id, 'reviewer-unlabeled', REQUESTED_AT);

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });
      const byNumber = new Map(rows.map((row) => [row.pr_number, row]));

      expect(byNumber.get(45)?.labels?.split('\n').sort()).toEqual(['bug', 'review-p-0']);
      expect(byNumber.get(46)?.labels).toBeNull();
    });

    test('uses the injected nowMs as the upper bound without applying the stale threshold', () => {
      const atNow = insertPr(40);
      requestReview(atNow.status.id, 'reviewer-at-now', new Date(NOW_MS).toISOString());

      const oneMsAfterNow = insertPr(41);
      requestReview(
        oneMsAfterNow.status.id,
        'reviewer-after-now',
        new Date(NOW_MS + 1).toISOString()
      );

      const rows = getStaleReviewRequestRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 40,
          reviewer: 'reviewer-at-now',
          requested_at: new Date(NOW_MS).toISOString(),
        }),
      ]);
    });
  });

  describe('getOtherReadyForReviewRows', () => {
    test('returns open non-draft PRs with ready_at and latest previous review', () => {
      const ready = insertPr(50, { readyAt: '2026-01-01T09:00:00.000Z' });
      review(ready.status.id, 'reviewer-old', 'COMMENTED', '2026-01-01T10:00:00.000Z');
      review(ready.status.id, 'reviewer-new', 'APPROVED', '2026-01-01T11:00:00.000Z');

      const noReview = insertPr(51, { readyAt: '2026-01-01T08:00:00.000Z' });
      expect(noReview.status.id).toBeGreaterThan(0);

      const rows = getOtherReadyForReviewRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([
        expect.objectContaining({
          pr_number: 51,
          ready_at: '2026-01-01T08:00:00.000Z',
          previous_review_at: null,
        }),
        expect.objectContaining({
          pr_number: 50,
          ready_at: '2026-01-01T09:00:00.000Z',
          previous_review_at: '2026-01-01T11:00:00.000Z',
        }),
      ]);
    });

    test('excludes PRs without ready_at and PRs not ready for review', () => {
      insertPr(60);
      insertPr(61, { readyAt: '2026-01-01T09:00:00.000Z', draft: true });
      insertPr(62, { readyAt: '2026-01-01T09:00:00.000Z', state: 'closed' });
      insertPr(63, { readyAt: '2026-01-03T09:00:00.000Z' });
      insertPr(64, {
        owner: 'octocat',
        repo: 'other',
        readyAt: '2026-01-01T09:00:00.000Z',
      });

      const rows = getOtherReadyForReviewRows(db, 'octocat', 'hello-world', { nowMs: NOW_MS });

      expect(rows).toEqual([]);
    });
  });

  function insertPr(
    prNumber: number,
    options: {
      owner?: string;
      repo?: string;
      state?: string;
      draft?: boolean;
      reviewDecision?: string | null;
      readyAt?: string | null;
      labels?: string[];
      baseBranch?: string | null;
      headBranch?: string | null;
    } = {}
  ): ReturnType<typeof upsertPrStatus> {
    const owner = options.owner ?? 'octocat';
    const repo = options.repo ?? 'hello-world';
    return upsertPrStatus(db, {
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      owner,
      repo,
      prNumber,
      author: `author-${prNumber}`,
      title: `PR ${prNumber}`,
      state: options.state ?? 'open',
      draft: options.draft ?? false,
      reviewDecision: options.reviewDecision ?? null,
      readyAt: options.readyAt,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
      labels: options.labels?.map((name) => ({ name })),
      baseBranch: options.baseBranch,
      headBranch: options.headBranch,
    });
  }

  function requestReview(prStatusId: number, reviewer: string, eventAt: string): void {
    upsertPrReviewRequestByReviewer(db, prStatusId, {
      reviewer,
      action: 'requested',
      eventAt,
    });
  }

  function review(
    prStatusId: number,
    author: string,
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED',
    submittedAt: string
  ): void {
    upsertPrReviewByAuthor(db, prStatusId, {
      author,
      state,
      submittedAt,
    });
  }
});

const REQUESTED_AT = '2026-01-01T10:00:00.000Z';
const NOW_MS = Date.parse('2026-01-02T10:00:00.000Z');
