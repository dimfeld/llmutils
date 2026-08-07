import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { getOrCreateProject } from '../../tim/db/project.js';
import { openDatabase } from '../../tim/db/database.js';
import { upsertPrReviewRequestByReviewer, upsertPrStatus } from '../../tim/db/pr_status.js';
import { getReviewerPredicate, getReviewerPredicateForPr } from './pr_relevance.js';

describe('getReviewerPredicate', () => {
  test('normalizes snapshot, request, and review usernames', () => {
    expect(
      getReviewerPredicate(
        ['REVIEWER'],
        [{ reviewer: 'OtherUser', removed_at: null }],
        [{ author: 'reviewer', state: 'APPROVED' }],
        'Reviewer'
      )
    ).toEqual({ isRequestedReviewer: true, hasSubmittedReview: true });
  });

  test('ignores removed requests and pending reviews', () => {
    expect(
      getReviewerPredicate(
        [],
        [{ reviewer: 'Reviewer', removed_at: '2026-03-30T12:00:00.000Z' }],
        [{ author: 'REVIEWER', state: 'PENDING' }],
        'reviewer'
      )
    ).toEqual({ isRequestedReviewer: false, hasSubmittedReview: false });
  });

  test('recognizes an active request and a non-pending review independently', () => {
    expect(
      getReviewerPredicate(
        [],
        [{ reviewer: 'Reviewer', removed_at: null }],
        [{ author: 'SomeoneElse', state: 'COMMENTED' }],
        'reviewer'
      )
    ).toEqual({ isRequestedReviewer: true, hasSubmittedReview: false });

    expect(
      getReviewerPredicate([], [], [{ author: 'Reviewer', state: 'DISMISSED' }], 'reviewer')
    ).toEqual({ isRequestedReviewer: false, hasSubmittedReview: true });
  });
});

describe('getReviewerPredicateForPr', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  test('reads the snapshot, requests, and reviews for a project PR', () => {
    const project = getOrCreateProject(db, 'github.com__example__repo');
    const pr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      author: 'author',
      title: 'Review this PR',
      state: 'open',
      draft: false,
      requestedReviewers: ['snapshot-user'],
      lastFetchedAt: '2026-03-30T10:00:00.000Z',
      reviews: [{ author: 'Reviewer', state: 'APPROVED' }],
    });
    upsertPrReviewRequestByReviewer(db, pr.status.id, {
      reviewer: 'requested-user',
      action: 'requested',
      eventAt: '2026-03-30T11:00:00.000Z',
    });

    expect(getReviewerPredicateForPr(db, project.id, 42, 'rEvIeWeR')).toEqual({
      isRequestedReviewer: false,
      hasSubmittedReview: true,
    });
    expect(getReviewerPredicateForPr(db, project.id, 42, 'REQUESTED-USER')).toEqual({
      isRequestedReviewer: true,
      hasSubmittedReview: false,
    });
    expect(getReviewerPredicateForPr(db, project.id, 42, 'SNAPSHOT-USER')).toEqual({
      isRequestedReviewer: true,
      hasSubmittedReview: false,
    });
  });

  test('returns null when the project PR is not cached', () => {
    const project = getOrCreateProject(db, 'github.com__example__repo');

    expect(getReviewerPredicateForPr(db, project.id, 404, 'reviewer')).toBeNull();
  });
});
