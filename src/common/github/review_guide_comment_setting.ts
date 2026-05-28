export const REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY = 'reviewGuideComment';

export interface ReviewGuideCommentProjectSetting {
  enabled?: boolean;
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
  };
}

export function isReviewGuideCommentEnabled(value: unknown): boolean {
  return parseReviewGuideCommentProjectSetting(value)?.enabled === true;
}
