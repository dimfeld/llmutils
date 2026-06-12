import {
  buildLinearPrReviewUrl,
  type BuildLinearPrReviewUrlOptions,
} from '$common/linear_pr_review.js';

const LINEAR_REVIEW_ORIGIN = 'https://linear.review/';
const LINEAR_DEEP_LINK_PREFIX = 'linear://';

export function toLinearReviewDeepLink(reviewUrl: string | null | undefined): string | null {
  if (!reviewUrl?.startsWith(LINEAR_REVIEW_ORIGIN)) {
    return null;
  }

  return `${LINEAR_DEEP_LINK_PREFIX}${reviewUrl.slice(LINEAR_REVIEW_ORIGIN.length)}`;
}

export function buildLinearReviewDeepLink(options: BuildLinearPrReviewUrlOptions): string | null {
  return toLinearReviewDeepLink(buildLinearPrReviewUrl(options));
}
