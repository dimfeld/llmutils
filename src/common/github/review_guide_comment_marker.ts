/** Hidden marker at the start of the review guide comment that tim posts on a PR. */
export const REVIEW_GUIDE_COMMENT_MARKER = '<!-- tim:pr-review-guide -->';

export function isReviewGuideCommentBody(body: string | null | undefined): body is string {
  return typeof body === 'string' && body.includes(REVIEW_GUIDE_COMMENT_MARKER);
}

/** Remove the hidden marker so that only the visible comment text is left. */
export function stripReviewGuideCommentMarker(body: string): string {
  return body.replace(REVIEW_GUIDE_COMMENT_MARKER, '').trim();
}
