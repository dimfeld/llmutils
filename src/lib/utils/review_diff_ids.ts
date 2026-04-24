const REVIEW_GUIDE_DIFF_ID_PREFIX = 'review-guide-diff';
const REVIEW_GUIDE_ANNOTATION_ID_PREFIX = 'review-guide-annotation';

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function getReviewGuideDiffId(filename: string | null, patch: string): string {
  const source = `${filename ?? ''}\n${patch}`;
  return `${REVIEW_GUIDE_DIFF_ID_PREFIX}-${hashString(source)}`;
}

export function getReviewGuideAnnotationId(issueId: number): string {
  return `${REVIEW_GUIDE_ANNOTATION_ID_PREFIX}-${issueId}`;
}
