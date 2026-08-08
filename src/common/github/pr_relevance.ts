import type { Database } from 'bun:sqlite';

import { normalizeGitHubUsername } from './username.js';
import { getPrStatusByProjectAndNumber } from '../../tim/db/pr_status.js';

export interface ReviewerPredicateReviewRequest {
  reviewer: string;
  removed_at: string | null;
}

export interface ReviewerPredicateReview {
  author: string;
  state: string;
}

export interface ReviewerPredicateResult {
  isRequestedReviewer: boolean;
  hasSubmittedReview: boolean;
}

/**
 * Determine whether a user is requested to review a PR or has submitted a review.
 *
 * The requested reviewer snapshot and active review request rows are both checked.
 * A PENDING review does not count as a submitted review.
 */
export function getReviewerPredicate(
  requestedReviewers: readonly string[],
  reviewRequests: readonly ReviewerPredicateReviewRequest[],
  reviews: readonly ReviewerPredicateReview[],
  username: string
): ReviewerPredicateResult {
  const normalizedUsername = normalizeGitHubUsername(username);
  const isRequestedReviewer =
    requestedReviewers.some(
      (reviewer) => normalizeGitHubUsername(reviewer) === normalizedUsername
    ) ||
    reviewRequests.some(
      (reviewRequest) =>
        reviewRequest.removed_at === null &&
        normalizeGitHubUsername(reviewRequest.reviewer) === normalizedUsername
    );
  const hasSubmittedReview = reviews.some(
    (review) =>
      normalizeGitHubUsername(review.author) === normalizedUsername && review.state !== 'PENDING'
  );

  return { isRequestedReviewer, hasSubmittedReview };
}

function parseRequestedReviewers(requestedReviewers: string | null): string[] {
  if (!requestedReviewers) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(requestedReviewers);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Read the reviewer predicate inputs for a project PR from the local database. */
export function getReviewerPredicateForPr(
  db: Database,
  projectId: number,
  prNumber: number,
  username: string
): ReviewerPredicateResult | null {
  const pr = getPrStatusByProjectAndNumber(db, projectId, prNumber);
  if (!pr) {
    return null;
  }

  return getReviewerPredicate(
    parseRequestedReviewers(pr.status.requested_reviewers),
    pr.reviewRequests,
    pr.reviews,
    username
  );
}
