/** Prefix for tasks generated from a review issue. */
export const REVIEW_FEEDBACK_TITLE_PREFIX = 'Address Review Feedback:';
/** Prefix for tasks generated from a pull request review thread. */
export const PR_REVIEW_THREAD_TITLE_PREFIX = 'Address review:';

export const REVIEW_FOLLOW_UP_TITLE_PREFIXES = [
  REVIEW_FEEDBACK_TITLE_PREFIX,
  PR_REVIEW_THREAD_TITLE_PREFIX,
] as const;

export function isReviewFollowUpTaskTitle(title: string): boolean {
  const normalizedTitle = title.trim().toLowerCase();
  return REVIEW_FOLLOW_UP_TITLE_PREFIXES.some((prefix) =>
    normalizedTitle.startsWith(prefix.toLowerCase())
  );
}

/**
 * Clears the structural-review marker when a substantive task is added to a plan.
 *
 * Shared by every task-adding entry point (the `tim add-task` command and the MCP
 * add-task tool) so the definition of "review follow-up" cannot diverge between
 * them. The marker is preserved when the caller passes the explicit
 * `reviewFollowUp` signal or when the title carries a known follow-up prefix.
 * Plans whose marker is already unset are left untouched, so no redundant
 * `plan.set_scalar` write is queued.
 *
 * Mutates `plan` in place; the caller persists it with the same plan write that
 * adds the task.
 */
export function clearStructuralReviewMarkerForTaskAdd(
  plan: { structuralReviewAt?: string | undefined },
  options: { title: string; reviewFollowUp?: boolean | undefined }
): void {
  if (plan.structuralReviewAt == null) {
    return;
  }
  if (options.reviewFollowUp === true || isReviewFollowUpTaskTitle(options.title)) {
    return;
  }
  plan.structuralReviewAt = undefined;
}
