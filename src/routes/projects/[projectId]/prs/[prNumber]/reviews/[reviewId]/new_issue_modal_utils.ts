import type { ReviewIssueSide } from '$tim/db/review.js';

export interface GutterRangeInput {
  start: number;
  end: number | null | undefined;
  side: string;
  endSide?: string | null;
}

export interface NormalizedGutterRange {
  startLine: number;
  endLine: number;
  side: ReviewIssueSide;
}

/**
 * Normalize a Pierre gutter-utility range into inputs for the new-issue modal.
 * Pierre's side is 'additions' | 'deletions'; we map to GitHub's LEFT/RIGHT.
 * When end is missing/equal to start, produces a single-line range.
 *
 * Returns null when the drag spans both sides (e.g. from a deletion line to an
 * addition line). GitHub won't accept such anchors for a single review comment,
 * so the caller should skip opening the modal.
 */
export function normalizeGutterRange(range: GutterRangeInput): NormalizedGutterRange | null {
  if (range.endSide != null && range.endSide !== range.side) {
    return null;
  }
  const rawEnd = range.end == null ? range.start : range.end;
  const startLine = Math.min(range.start, rawEnd);
  const endLine = Math.max(range.start, rawEnd);
  const side: ReviewIssueSide = range.side === 'deletions' ? 'LEFT' : 'RIGHT';
  return { startLine, endLine, side };
}

/**
 * Build the `start_line` / `line` string pair that `review_issue` stores, from
 * a pair of numeric line endpoints. Single-line ranges return `startLine=null`,
 * matching how `parseLineRange` in review_pr.ts stores them.
 */
export function buildLineStrings(
  startLine: number,
  endLine: number
): { startLine: string | null; line: string } {
  if (startLine === endLine) {
    return { startLine: null, line: String(startLine) };
  }
  return { startLine: String(startLine), line: String(endLine) };
}

export interface BuildCreateReviewIssueInputParams {
  reviewId: number;
  file: string;
  startLine: number;
  endLine: number;
  side: ReviewIssueSide;
  content: string;
  suggestion: string;
}

export function buildCreateReviewIssueInput(params: BuildCreateReviewIssueInputParams) {
  const { startLine, line } = buildLineStrings(params.startLine, params.endLine);
  const trimmedSuggestion = params.suggestion.trim();

  return {
    reviewId: params.reviewId,
    content: params.content.trim(),
    suggestion: trimmedSuggestion.length > 0 ? trimmedSuggestion : undefined,
    file: params.file,
    startLine,
    line,
    side: params.side,
    severity: 'minor' as const,
    category: 'other' as const,
  };
}
