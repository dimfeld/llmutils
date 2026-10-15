import type { PrReviewRow, PrStatusDetail } from '../../tim/db/pr_status.js';
import { isBotLogin, normalizeGitHubUsername } from './username.js';

/**
 * Returns whether a reviewer is a bot. Most bots use the `[bot]` login suffix, but the
 * Copilot reviewer appears in review requests as plain `Copilot`. We store only logins, not the
 * GitHub account type, so this check must use the login.
 */
export function isBotReviewer(login: string): boolean {
  return isBotLogin(login) || login.toLowerCase() === 'copilot';
}

/** True when the PR has an active review request for a human reviewer. */
export function hasHumanReviewRequest(detail: PrStatusDetail): boolean {
  if (
    detail.reviewRequests.some(
      (request) => request.requested_at && !request.removed_at && !isBotReviewer(request.reviewer)
    )
  ) {
    return true;
  }

  try {
    const requestedReviewers: unknown = JSON.parse(detail.status.requested_reviewers ?? '[]');
    return (
      Array.isArray(requestedReviewers) &&
      requestedReviewers.some(
        (reviewer) => typeof reviewer === 'string' && !isBotReviewer(reviewer)
      )
    );
  } catch {
    return false;
  }
}

/**
 * True when a human other than the PR author submitted a review. Reviews by the author do not
 * count, because replies to review comments create COMMENTED reviews by the author.
 */
export function hasHumanReview(detail: PrStatusDetail): boolean {
  const author = detail.status.author ? normalizeGitHubUsername(detail.status.author) : null;
  return detail.reviews.some(
    (review) =>
      review.state !== 'PENDING' &&
      !isBotReviewer(review.author) &&
      normalizeGitHubUsername(review.author) !== author
  );
}

/**
 * True when the PR is open and ready, but no human reviewer has been requested and no human
 * has reviewed it. This finds PRs that got bot review but still need a human review request.
 */
export function needsHumanReviewRequest(detail: PrStatusDetail): boolean {
  const { state, draft, review_decision } = detail.status;
  // An approval or a change request from GitHub means that a reviewer already looked at the PR,
  // even if the review rows are not stored.
  if (isPrApproved(detail) || review_decision === 'CHANGES_REQUESTED') {
    return false;
  }
  return state === 'open' && !draft && !hasHumanReviewRequest(detail) && !hasHumanReview(detail);
}

/** True when at least one non-bot reviewer has a submitted approval. */
export function hasHumanApproval(
  reviews: ReadonlyArray<Pick<PrReviewRow, 'author' | 'state'>>
): boolean {
  return reviews.some((review) => review.state === 'APPROVED' && !isBotReviewer(review.author));
}

/**
 * True when GitHub reports the PR as approved and at least one non-bot reviewer approved it.
 * Repositories or stacked PRs without branch protection can report APPROVED from a bot approval
 * alone, so the review decision by itself is not sufficient.
 */
export function isPrApproved(detail: Pick<PrStatusDetail, 'status' | 'reviews'>): boolean {
  return detail.status.review_decision === 'APPROVED' && hasHumanApproval(detail.reviews);
}

/**
 * The review decision to show for a PR. This is GitHub's review decision, except that an APPROVED
 * decision without a non-bot approval is treated as no decision.
 */
export function getEffectiveReviewDecision(
  detail: Pick<PrStatusDetail, 'status' | 'reviews'>
): string | null {
  const decision = detail.status.review_decision;
  if (decision === 'APPROVED' && !isPrApproved(detail)) {
    return null;
  }
  return decision;
}
