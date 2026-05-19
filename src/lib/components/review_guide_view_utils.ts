/**
 * Compute whether a review-guide diff segment should expose the gutter
 * "add issue" button. Requires a filename — diff segments without one
 * (e.g. pre-diff context) can't anchor a new issue.
 */
export interface ReviewGuideDiffOverrideFlags {
  enableLineSelection: boolean;
  enableGutterUtility: boolean;
  exposeGutterClick: boolean;
}

export function computeReviewGuideDiffOverrideFlags(
  filename: string | null
): ReviewGuideDiffOverrideFlags {
  const canAddIssues = filename != null;
  return {
    enableLineSelection: true,
    enableGutterUtility: canAddIssues,
    exposeGutterClick: canAddIssues,
  };
}
