export const REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY = 'reviewGuideComment';

export interface ReviewGuideCommentProjectSetting {
  enabled?: boolean;
  /** Also generate review issues and post them as a GitHub review from the App identity. */
  postReview?: boolean;
}

export function parseReviewGuideCommentProjectSetting(
  value: unknown
): ReviewGuideCommentProjectSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : undefined,
    postReview: typeof record.postReview === 'boolean' ? record.postReview : undefined,
  };
}

export function isReviewGuideCommentEnabled(value: unknown): boolean {
  return parseReviewGuideCommentProjectSetting(value)?.enabled === true;
}

export function isReviewGuideCommentPostReviewEnabled(value: unknown): boolean {
  return parseReviewGuideCommentProjectSetting(value)?.postReview === true;
}
