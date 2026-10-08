import type { ReviewAnnotationKind, ReviewSeverity } from '$tim/db/review.js';

export interface ReviewIssueAnnotationMetadata {
  issueId: number;
  severity: ReviewSeverity;
  annotationKind?: ReviewAnnotationKind | null;
  content: string;
  suggestion: string | null;
  lineLabel: string | null;
  resolved: boolean;
}
