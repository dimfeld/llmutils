import type { ReviewIssue } from '../formatters/review_formatter.js';

export type ReviewIssueWithOptionalNote = Omit<ReviewIssue, 'severity'> & {
  severity: ReviewIssue['severity'] | 'note';
};

export function filterActionableReviewIssues<T extends ReviewIssueWithOptionalNote>(
  issues: readonly T[]
): Array<T & ReviewIssue> {
  return issues.filter((issue): issue is T & ReviewIssue => issue.severity !== 'note');
}

export function partitionReviewIssues<T extends ReviewIssueWithOptionalNote>(
  issues: readonly T[]
): { open: Array<T & ReviewIssue>; rejected: Array<T & ReviewIssue> } {
  const actionableIssues = filterActionableReviewIssues(issues);
  return actionableIssues.reduce<{
    open: Array<T & ReviewIssue>;
    rejected: Array<T & ReviewIssue>;
  }>(
    (partition, issue) => {
      if (issue.rejected === true) {
        partition.rejected.push(issue);
      } else {
        partition.open.push(issue);
      }
      return partition;
    },
    { open: [], rejected: [] }
  );
}
