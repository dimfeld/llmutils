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
 * Returns the normalized logins of the human reviewers that have an active review request.
 * Bots and the PR author are not included.
 *
 * A review request row is active when it was not removed after it was made, and the reviewer
 * did not submit a review after the request. A reviewer in the requested reviewers snapshot
 * without a request row is active when that reviewer has no submitted review.
 */
export function getActiveHumanRequestedReviewers(
  detail: Pick<PrStatusDetail, 'status' | 'reviews' | 'reviewRequests'>
): Set<string> {
  const author = detail.status.author ? normalizeGitHubUsername(detail.status.author) : null;

  const latestReviewAt = new Map<string, string>();
  for (const review of detail.reviews) {
    if (review.state === 'PENDING' || review.submitted_at == null) {
      continue;
    }
    const reviewer = normalizeGitHubUsername(review.author);
    const previous = latestReviewAt.get(reviewer);
    if (previous === undefined || review.submitted_at > previous) {
      latestReviewAt.set(reviewer, review.submitted_at);
    }
  }

  const active = new Set<string>();
  const reviewersWithRows = new Set<string>();
  for (const request of detail.reviewRequests) {
    const reviewer = normalizeGitHubUsername(request.reviewer);
    reviewersWithRows.add(reviewer);
    if (request.requested_at === null) {
      continue;
    }
    if (request.removed_at !== null && request.requested_at <= request.removed_at) {
      continue;
    }
    const lastReviewAt = latestReviewAt.get(reviewer);
    if (lastReviewAt !== undefined && request.requested_at <= lastReviewAt) {
      continue;
    }
    active.add(reviewer);
  }

  for (const reviewer of parseRequestedReviewerSnapshot(detail.status.requested_reviewers)) {
    const normalized = normalizeGitHubUsername(reviewer);
    if (!reviewersWithRows.has(normalized) && !latestReviewAt.has(normalized)) {
      active.add(normalized);
    }
  }

  for (const reviewer of active) {
    if (reviewer === author || isBotReviewer(reviewer)) {
      active.delete(reviewer);
    }
  }
  return active;
}

/**
 * True when the given user has an active review request and is the only human reviewer on the
 * PR. Another human counts as a reviewer when they have an active review request or submitted a
 * review. Bots and the PR author are not counted.
 */
export function isOnlyHumanReviewer(
  detail: Pick<PrStatusDetail, 'status' | 'reviews' | 'reviewRequests'>,
  username: string
): boolean {
  const normalizedUsername = normalizeGitHubUsername(username);
  const requested = getActiveHumanRequestedReviewers(detail);
  if (requested.size !== 1 || !requested.has(normalizedUsername)) {
    return false;
  }

  const author = detail.status.author ? normalizeGitHubUsername(detail.status.author) : null;
  return !detail.reviews.some((review) => {
    if (review.state === 'PENDING' || isBotReviewer(review.author)) {
      return false;
    }
    const reviewer = normalizeGitHubUsername(review.author);
    return reviewer !== author && reviewer !== normalizedUsername;
  });
}

function parseRequestedReviewerSnapshot(requestedReviewers: string | null): string[] {
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
