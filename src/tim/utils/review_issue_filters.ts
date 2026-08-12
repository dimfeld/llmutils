import type { ReviewIssue, ReviewIssueState } from '../formatters/review_formatter.js';

export type ReviewIssueWithOptionalNote = Omit<ReviewIssue, 'severity'> & {
  severity: ReviewIssue['severity'] | 'note';
};

/** Older plan files used `rejected: true`; keep those records fully compatible. */
export function getReviewIssueState(
  issue: Pick<ReviewIssue, 'state' | 'rejected'>
): ReviewIssueState | undefined {
  return issue.state ?? (issue.rejected === true ? 'rejected' : undefined);
}

export function hasReviewIssueDisposition(issue: Pick<ReviewIssue, 'state' | 'rejected'>): boolean {
  return getReviewIssueState(issue) !== undefined;
}

export function filterActionableReviewIssues<T extends ReviewIssueWithOptionalNote>(
  issues: readonly T[]
): Array<T & ReviewIssue> {
  return issues.filter((issue): issue is T & ReviewIssue => issue.severity !== 'note');
}

export function partitionReviewIssues<T extends ReviewIssueWithOptionalNote>(
  issues: readonly T[]
): {
  open: Array<T & ReviewIssue>;
  rejected: Array<T & ReviewIssue>;
  nonBlocking: Array<T & ReviewIssue>;
} {
  const actionableIssues = filterActionableReviewIssues(issues);
  return actionableIssues.reduce<{
    open: Array<T & ReviewIssue>;
    rejected: Array<T & ReviewIssue>;
    nonBlocking: Array<T & ReviewIssue>;
  }>(
    (partition, issue) => {
      if (getReviewIssueState(issue) === 'rejected') {
        partition.rejected.push(issue);
      } else if (getReviewIssueState(issue) === 'non-blocking') {
        partition.nonBlocking.push(issue);
      } else {
        partition.open.push(issue);
      }
      return partition;
    },
    { open: [], rejected: [], nonBlocking: [] }
  );
}
