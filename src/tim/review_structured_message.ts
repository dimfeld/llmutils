import type { ReviewOutput } from './formatters/review_output_schema.js';

type StructuredReviewIssue = ReviewOutput['issues'][number];

export interface StructuredReviewIssueInput {
  severity: StructuredReviewIssue['severity'];
  category: string;
  content: string;
  file?: string | null;
  line?: string | number | null;
  suggestion?: string | null;
}

export function toStructuredReviewIssue(issue: StructuredReviewIssueInput): StructuredReviewIssue {
  return {
    severity: issue.severity,
    // TODO fix up the rest of the types used in the code to actually allow this to be a string,
    // but without changing the zod schema that generates the JSON schema for the agents
    category: issue.category as ReviewOutput['issues'][number]['category'],
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
