import type { DiffLineAnnotation } from '@pierre/diffs';

import { parseLineRange } from '$common/review_line_range.js';
import type { ReviewIssueRow, ReviewSeverity } from '$tim/db/review.js';

export interface ReviewIssueAnnotationData {
  issueId: number;
  severity: ReviewSeverity;
  content: string;
  suggestion: string | null;
  lineLabel: string | null;
}

export interface LineRange {
  start: number;
  end: number;
  side: 'additions' | 'deletions';
}

/**
 * Parse a unified diff patch and extract line ranges from hunk headers.
 * Returns a map of filename → array of line ranges that appear in the diff.
 */
export function extractDiffLineRanges(
  patch: string,
  filename: string | null
): LineRange[] {
  const ranges: LineRange[] = [];
  if (!filename) return ranges;

  // Hunk header format: @@ -oldStart,oldCount +newStart,newCount @@
  const hunkRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
  let match;

  while ((match = hunkRegex.exec(patch)) !== null) {
    const oldStart = Number.parseInt(match[1], 10);
    const oldCount = match[2] ? Number.parseInt(match[2], 10) : 1;
    const newStart = Number.parseInt(match[3], 10);
    const newCount = match[4] ? Number.parseInt(match[4], 10) : 1;

    // Calculate the line ranges for both sides
    if (oldCount > 0) {
      ranges.push({
        start: oldStart,
        end: oldStart + oldCount - 1,
        side: 'deletions',
      });
    }
    if (newCount > 0) {
      ranges.push({
        start: newStart,
        end: newStart + newCount - 1,
        side: 'additions',
      });
    }
  }

  return ranges;
}

/**
 * Find the closest line number that falls within any of the given ranges.
 * If the target line is already in a range, returns it.
 * Otherwise, returns the closest line that is in a range.
 */
function findClosestLineInRange(
  targetLine: number,
  ranges: LineRange[],
  preferredSide: 'additions' | 'deletions'
): number | null {
  if (ranges.length === 0) return null;

  // First, check if the target line is already in a range of the preferred side
  for (const range of ranges) {
    if (range.side === preferredSide && targetLine >= range.start && targetLine <= range.end) {
      return targetLine;
    }
  }

  // If not, check if it's in any range (regardless of side)
  for (const range of ranges) {
    if (targetLine >= range.start && targetLine <= range.end) {
      return targetLine;
    }
  }

  // Find the closest line in the preferred side
  let closestLine: number | null = null;
  let minDistance = Infinity;

  for (const range of ranges) {
    if (range.side !== preferredSide) continue;

    // Check if target is before the range
    if (targetLine < range.start) {
      const distance = range.start - targetLine;
      if (distance < minDistance) {
        minDistance = distance;
        closestLine = range.start;
      }
    }
    // Check if target is after the range
    else if (targetLine > range.end) {
      const distance = targetLine - range.end;
      if (distance < minDistance) {
        minDistance = distance;
        closestLine = range.end;
      }
    }
  }

  return closestLine;
}

export function buildAnnotationsForFile(
  allIssues: ReviewIssueRow[],
  filename: string | null,
  diffLineRanges?: LineRange[]
): DiffLineAnnotation<ReviewIssueAnnotationData>[] {
  if (!filename) return [];

  const annotations: DiffLineAnnotation<ReviewIssueAnnotationData>[] = [];

  for (const issue of allIssues) {
    if (issue.file !== filename) continue;
    if (!issue.line) continue;

    // `issue.line` may be a plain number ("5") or a range ("10-20" / "10–20").
    // parseLineRange normalizes both forms; if start_line is explicitly set on the
    // row (older data path), it takes precedence over the range's parsed start.
    const parsed = parseLineRange(issue.line);
    const endStr = parsed.line ?? issue.line;
    const end = Number.parseInt(endStr, 10);
    if (!Number.isFinite(end)) continue;

    const startSource = issue.start_line ?? parsed.startLine ?? endStr;
    const parsedStart = Number.parseInt(startSource, 10);
    const start = Number.isFinite(parsedStart) ? parsedStart : end;

    const rangeStart = Math.min(start, end);
    const rangeEnd = Math.max(start, end);
    const lineLabel = rangeStart === rangeEnd ? null : `${rangeStart}–${rangeEnd}`;

    const side = issue.side === 'LEFT' ? 'deletions' : 'additions';

    // If diff line ranges are provided, check if the issue overlaps with this specific diff
    // Only include the annotation if the issue's line range overlaps with the diff's line ranges
    if (diffLineRanges && diffLineRanges.length > 0) {
      const hasOverlap = checkLineRangeOverlap(rangeStart, rangeEnd, diffLineRanges, side);
      if (!hasOverlap) continue;

      // Try to find a line that's actually in the diff
      const closestLine = findClosestLineInRange(rangeEnd, diffLineRanges, side);
      if (closestLine !== null) {
        const anchorLine = closestLine;
        const metadata: ReviewIssueAnnotationData = {
          issueId: issue.id,
          severity: issue.severity,
          content: issue.content,
          suggestion: issue.suggestion,
          lineLabel,
        };
        annotations.push({ side, lineNumber: anchorLine, metadata });
        continue;
      }
    }

    // If no diff ranges or no overlap found, use the original line
    const metadata: ReviewIssueAnnotationData = {
      issueId: issue.id,
      severity: issue.severity,
      content: issue.content,
      suggestion: issue.suggestion,
      lineLabel,
    };

    annotations.push({ side, lineNumber: rangeEnd, metadata });
  }

  return annotations;
}

/**
 * Check if an issue's line range overlaps with any of the given diff line ranges.
 * Returns true if there's any overlap between the issue range and the diff ranges
 * for the preferred side (or any side if no overlap on the preferred side).
 */
function checkLineRangeOverlap(
  issueStart: number,
  issueEnd: number,
  diffRanges: LineRange[],
  preferredSide: 'additions' | 'deletions'
): boolean {
  for (const range of diffRanges) {
    // First check if there's overlap on the preferred side
    if (range.side === preferredSide) {
      if (issueStart <= range.end && issueEnd >= range.start) {
        return true;
      }
    }
  }

  // If no overlap on preferred side, check any side (for issues that might span both)
  for (const range of diffRanges) {
    if (issueStart <= range.end && issueEnd >= range.start) {
      return true;
    }
  }

  return false;
}
