import type { DiffLineAnnotation } from '@pierre/diffs';

import { parseLineRange } from '$common/review_line_range.js';
import type { MarkdownSegment } from '$lib/utils/markdown_parser.js';
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

interface ParsedIssueAnchor {
  issue: ReviewIssueRow;
  side: 'additions' | 'deletions';
  rangeStart: number;
  rangeEnd: number;
  lineLabel: string | null;
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

  // Fall back to the closest line on any side when the preferred side does
  // not appear in this hunk (for example, a pure deletion hunk for a RIGHT-side
  // issue due to imperfect source data).
  for (const range of ranges) {
    if (targetLine < range.start) {
      const distance = range.start - targetLine;
      if (distance < minDistance) {
        minDistance = distance;
        closestLine = range.start;
      }
    } else if (targetLine > range.end) {
      const distance = targetLine - range.end;
      if (distance < minDistance) {
        minDistance = distance;
        closestLine = range.end;
      }
    }
  }

  return closestLine;
}

function parseIssueAnchor(issue: ReviewIssueRow): ParsedIssueAnchor | null {
  if (!issue.line) return null;

  // `issue.line` may be a plain number ("5") or a range ("10-20" / "10–20").
  // parseLineRange normalizes both forms; if start_line is explicitly set on the
  // row (older data path), it takes precedence over the range's parsed start.
  const parsed = parseLineRange(issue.line);
  const endStr = parsed.line ?? issue.line;
  const end = Number.parseInt(endStr, 10);
  if (!Number.isFinite(end)) return null;

  const startSource = issue.start_line ?? parsed.startLine ?? endStr;
  const parsedStart = Number.parseInt(startSource, 10);
  const start = Number.isFinite(parsedStart) ? parsedStart : end;

  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);

  return {
    issue,
    side: issue.side === 'LEFT' ? 'deletions' : 'additions',
    rangeStart,
    rangeEnd,
    lineLabel: rangeStart === rangeEnd ? null : `${rangeStart}–${rangeEnd}`,
  };
}

function toAnnotation(
  parsed: ParsedIssueAnchor,
  lineNumber: number
): DiffLineAnnotation<ReviewIssueAnnotationData> {
  return {
    side: parsed.side,
    lineNumber,
    metadata: {
      issueId: parsed.issue.id,
      severity: parsed.issue.severity,
      content: parsed.issue.content,
      suggestion: parsed.issue.suggestion,
      lineLabel: parsed.lineLabel,
    },
  };
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
    const parsed = parseIssueAnchor(issue);
    if (!parsed) continue;

    // If diff line ranges are provided, check if the issue overlaps with this specific diff
    // Only include the annotation if the issue's line range overlaps with the diff's line ranges
    if (diffLineRanges && diffLineRanges.length > 0) {
      const hasOverlap = checkLineRangeOverlap(
        parsed.rangeStart,
        parsed.rangeEnd,
        diffLineRanges,
        parsed.side
      );
      if (!hasOverlap) continue;

      // Try to find a line that's actually in the diff
      const closestLine = findClosestLineInRange(parsed.rangeEnd, diffLineRanges, parsed.side);
      if (closestLine !== null) {
        annotations.push(toAnnotation(parsed, closestLine));
        continue;
      }
    }

    // If no diff ranges or no overlap found, use the original line.
    annotations.push(toAnnotation(parsed, parsed.rangeEnd));
  }

  return annotations;
}

export function buildGuideDiffAnnotations(
  allIssues: ReviewIssueRow[],
  guideSegments: MarkdownSegment[]
): Map<number, DiffLineAnnotation<ReviewIssueAnnotationData>[]> {
  const annotationsBySegment = new Map<number, DiffLineAnnotation<ReviewIssueAnnotationData>[]>();

  const diffSegments = guideSegments.flatMap((segment, segmentIndex) => {
    if (segment.type !== 'unified-diff' || !segment.filename) return [];
    return [
      {
        segmentIndex,
        filename: segment.filename,
        ranges: extractDiffLineRanges(segment.patch, segment.filename),
      },
    ];
  });

  for (const issue of allIssues) {
    if (!issue.file) continue;

    const parsed = parseIssueAnchor(issue);
    if (!parsed) continue;

    let bestMatch:
      | {
          segmentIndex: number;
          anchorLine: number;
          distance: number;
        }
      | null = null;

    for (const segment of diffSegments) {
      if (segment.filename !== issue.file || segment.ranges.length === 0) continue;

      const hasOverlap = checkLineRangeOverlap(
        parsed.rangeStart,
        parsed.rangeEnd,
        segment.ranges,
        parsed.side
      );
      if (!hasOverlap) continue;

      const anchorLine = findClosestLineInRange(parsed.rangeEnd, segment.ranges, parsed.side);
      if (anchorLine == null) continue;

      const candidate = {
        segmentIndex: segment.segmentIndex,
        anchorLine,
        distance: Math.abs(anchorLine - parsed.rangeEnd),
      };

      if (
        bestMatch == null ||
        candidate.distance < bestMatch.distance ||
        (candidate.distance === bestMatch.distance &&
          candidate.segmentIndex < bestMatch.segmentIndex)
      ) {
        bestMatch = candidate;
      }
    }

    if (!bestMatch) continue;

    const segmentAnnotations = annotationsBySegment.get(bestMatch.segmentIndex) ?? [];
    segmentAnnotations.push(toAnnotation(parsed, bestMatch.anchorLine));
    annotationsBySegment.set(bestMatch.segmentIndex, segmentAnnotations);
  }

  return annotationsBySegment;
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
