import type { ReviewSeverity } from '$tim/db/review.js';

export interface ReviewIssueAnnotationMetadata {
  issueId: number;
  severity: ReviewSeverity;
  content: string;
  suggestion: string | null;
  lineLabel: string | null;
}
