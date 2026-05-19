import type { ReviewIssue } from '../formatters/review_formatter.js';

export type ReviewIssueWithOptionalNote = Omit<ReviewIssue, 'severity'> & {
  severity: ReviewIssue['severity'] | 'note';
};

export function filterActionableReviewIssues<T extends ReviewIssueWithOptionalNote>(
  issues: readonly T[]
): Array<T & ReviewIssue> {
  return issues.filter((issue): issue is T & ReviewIssue => issue.severity !== 'note');
}
