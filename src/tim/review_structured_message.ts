import type { ReviewOutput } from './formatters/review_output_schema.js';

type StructuredReviewIssue = ReviewOutput['issues'][number];

export interface StructuredReviewIssueInput {
  severity: StructuredReviewIssue['severity'];
  category: StructuredReviewIssue['category'];
  content: string;
  file?: string | null;
  line?: string | number | null;
  suggestion?: string | null;
}

export function toStructuredReviewIssue(issue: StructuredReviewIssueInput): StructuredReviewIssue {
  return {
    severity: issue.severity,
    category: issue.category,
    content: issue.content,
    file: issue.file ?? '',
    line: issue.line != null ? String(issue.line) : '',
    suggestion: issue.suggestion ?? '',
  };
}

export function toStructuredReviewIssues(
  issues: readonly StructuredReviewIssueInput[]
): ReviewOutput['issues'] {
  return issues.map((issue) => toStructuredReviewIssue(issue));
}
