/**
 * Compute whether a review-guide diff segment should expose interactive
 * issue-creation affordances (line selection and the gutter "add issue"
 * button). These must be gated together with the issue-management controls
 * (resolve/edit/delete) so plan-only viewers don't create orphaned issues
 * via the gutter when the management UI is hidden.
 */
export interface ReviewGuideDiffOverrideFlags {
  enableLineSelection: boolean;
  enableGutterUtility: boolean;
  exposeGutterClick: boolean;
}

export function computeReviewGuideDiffOverrideFlags(
  filename: string | null,
  allowIssueActions: boolean
): ReviewGuideDiffOverrideFlags {
  const canAddIssues = filename != null && allowIssueActions;
  return {
    enableLineSelection: allowIssueActions,
    enableGutterUtility: canAddIssues,
    exposeGutterClick: canAddIssues,
  };
}
