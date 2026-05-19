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
  resolved: boolean;
}

export interface LineRange {
  start: number;
  end: number;
  side: 'additions' | 'deletions';
}

interface ParsedIssueAnchor {
  issue: ReviewIssueRow;
  side: 'additions' | 'deletions' | null;
  rangeStart: number;
  rangeEnd: number;
  lineLabel: string | null;
}

/**
 * Parse a unified diff patch and extract line ranges from hunk headers.
 * Returns a map of filename → array of line ranges that appear in the diff.
 */
export function extractDiffLineRanges(patch: string, filename: string | null): LineRange[] {
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

function toAnnotationSide(side: ReviewIssueRow['side']): ParsedIssueAnchor['side'] {
  if (side === 'LEFT') return 'deletions';
  if (side === 'RIGHT') return 'additions';
  return null;
}

function inferAnchorSideFromRanges(
  rangeStart: number,
  rangeEnd: number,
  ranges: LineRange[]
): 'additions' | 'deletions' | null {
  let overlapsAdditions = false;
  let overlapsDeletions = false;

  for (const range of ranges) {
    const overlaps = rangeStart <= range.end && rangeEnd >= range.start;
    if (!overlaps) continue;

    if (range.side === 'additions') {
      overlapsAdditions = true;
    } else {
      overlapsDeletions = true;
    }
  }

  // Unambiguous: only one side overlaps.
  if (overlapsAdditions !== overlapsDeletions) {
    return overlapsAdditions ? 'additions' : 'deletions';
  }
  // Both overlap (same-number / numerically-overlapping mixed hunk): default
  // to additions so a plain `<annotation file="..." line="11">` still renders
  // inline. Cross-side comma anchors (e.g. line="5,11" against old=4-6 /
  // new=10-12) avoid this branch because each candidate falls in only one
  // range, so they continue to resolve to the correct per-anchor side.
  if (overlapsAdditions && overlapsDeletions) return 'additions';
  // Neither side overlaps — caller will skip the anchor.
  return null;
}

function parseSingleAnchor(
  issue: ReviewIssueRow,
  rawLine: string,
  rawStartLine: string | null
): ParsedIssueAnchor | null {
  // `rawLine` may be a plain number ("5") or a range ("10-20" / "10–20").
  // parseLineRange normalizes both forms; if start_line is explicitly set on the
  // row (older data path), it takes precedence over the range's parsed start.
  const parsed = parseLineRange(rawLine);
  const endStr = parsed.line ?? rawLine;
  const end = Number.parseInt(endStr, 10);
  if (!Number.isFinite(end)) return null;

  const startSource = rawStartLine ?? parsed.startLine ?? endStr;
  const parsedStart = Number.parseInt(startSource, 10);
  const start = Number.isFinite(parsedStart) ? parsedStart : end;

  const rangeStart = Math.min(start, end);
  const rangeEnd = Math.max(start, end);

  return {
    issue,
    side: toAnnotationSide(issue.side),
    rangeStart,
    rangeEnd,
    lineLabel: rangeStart === rangeEnd ? null : `${rangeStart}–${rangeEnd}`,
  };
}

// Returns one anchor per comma-separated candidate. A bare value like "5" or a
// range like "10-20" yields a single anchor; "1,3,5" yields three; "1,5-7,10"
// yields three (with the middle one being a range). start_line on the row, if
// present, applies only to the first candidate (it has no meaning for comma
// lists).
function parseIssueAnchors(issue: ReviewIssueRow): ParsedIssueAnchor[] {
  if (!issue.line) return [];
  const lineText = issue.line.trim();
  if (!lineText) return [];

  if (!lineText.includes(',')) {
    const anchor = parseSingleAnchor(issue, lineText, issue.start_line);
    return anchor ? [anchor] : [];
  }

  const anchors: ParsedIssueAnchor[] = [];
  const parts = lineText.split(',').map((part) => part.trim());
  parts.forEach((part, index) => {
    if (!part) return;
    const startLineForPart = index === 0 ? issue.start_line : null;
    const anchor = parseSingleAnchor(issue, part, startLineForPart);
    if (anchor) anchors.push(anchor);
  });
  return anchors;
}

function toAnnotation(
  parsed: ParsedIssueAnchor,
  side: 'additions' | 'deletions',
  lineNumber: number
): DiffLineAnnotation<ReviewIssueAnnotationData> {
  return {
    side,
    lineNumber,
    metadata: {
      issueId: parsed.issue.id,
      severity: parsed.issue.severity,
      content: parsed.issue.content,
      suggestion: parsed.issue.suggestion,
      lineLabel: parsed.lineLabel,
      resolved: Boolean(parsed.issue.resolved),
    },
  };
}

function findAnnotationPlacement(
  parsed: ParsedIssueAnchor,
  ranges: LineRange[]
): { side: 'additions' | 'deletions'; lineNumber: number } | null {
  const side = parsed.side ?? inferAnchorSideFromRanges(parsed.rangeStart, parsed.rangeEnd, ranges);
  if (side == null) return null;

  const hasOverlap = checkLineRangeOverlap(parsed.rangeStart, parsed.rangeEnd, ranges, side);
  if (!hasOverlap) return null;

  const lineNumber = findClosestLineInRange(parsed.rangeEnd, ranges, side);
  return lineNumber == null ? null : { side, lineNumber };
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
    const parsedAnchors = parseIssueAnchors(issue);
    if (parsedAnchors.length === 0) continue;

    if (diffLineRanges && diffLineRanges.length > 0) {
      if (issue.side == null) {
        for (const parsed of parsedAnchors) {
          const placement = findAnnotationPlacement(parsed, diffLineRanges);
          if (placement) {
            annotations.push(toAnnotation(parsed, placement.side, placement.lineNumber));
          }
        }
        continue;
      }

      // For comma-separated line lists, take the first candidate whose range
      // overlaps the diff. Drop the issue if none overlap (matching the
      // single-anchor exclusion behavior).
      let placed = false;
      for (const parsed of parsedAnchors) {
        const placement = findAnnotationPlacement(parsed, diffLineRanges);
        if (placement) {
          annotations.push(toAnnotation(parsed, placement.side, placement.lineNumber));
          placed = true;
          break;
        }
      }
      if (!placed) continue;
    } else {
      // No diff ranges: use the original line of the first parsed anchor.
      const fallback = parsedAnchors[0];
      annotations.push(toAnnotation(fallback, fallback.side ?? 'additions', fallback.rangeEnd));
    }
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

    const parsedAnchors = parseIssueAnchors(issue);
    if (parsedAnchors.length === 0) continue;

    if (issue.side == null) {
      for (const parsed of parsedAnchors) {
        const bestMatch = findBestGuideDiffMatch(parsed, issue.file, diffSegments);
        if (!bestMatch) continue;

        const segmentAnnotations = annotationsBySegment.get(bestMatch.segmentIndex) ?? [];
        segmentAnnotations.push(
          toAnnotation(bestMatch.parsed, bestMatch.side, bestMatch.anchorLine)
        );
        annotationsBySegment.set(bestMatch.segmentIndex, segmentAnnotations);
      }
      continue;
    }

    // Iterate candidates in order. The first comma-separated candidate that has
    // any matching segment wins, matching the first-overlap semantics used by
    // buildAnnotationsForFile. Within that candidate, pick the best (closest)
    // segment.
    let bestMatch: GuideDiffMatch | null = null;

    for (const parsed of parsedAnchors) {
      const candidateMatch = findBestGuideDiffMatch(parsed, issue.file, diffSegments);
      if (candidateMatch) {
        bestMatch = candidateMatch;
        break;
      }
    }

    if (!bestMatch) continue;

    const segmentAnnotations = annotationsBySegment.get(bestMatch.segmentIndex) ?? [];
    segmentAnnotations.push(toAnnotation(bestMatch.parsed, bestMatch.side, bestMatch.anchorLine));
    annotationsBySegment.set(bestMatch.segmentIndex, segmentAnnotations);
  }

  return annotationsBySegment;
}

interface GuideDiffSegment {
  segmentIndex: number;
  filename: string;
  ranges: LineRange[];
}

interface GuideDiffMatch {
  parsed: ParsedIssueAnchor;
  side: 'additions' | 'deletions';
  segmentIndex: number;
  anchorLine: number;
  distance: number;
}

function findBestGuideDiffMatch(
  parsed: ParsedIssueAnchor,
  filename: string,
  diffSegments: GuideDiffSegment[]
): GuideDiffMatch | null {
  let bestMatch: GuideDiffMatch | null = null;

  for (const segment of diffSegments) {
    if (segment.filename !== filename || segment.ranges.length === 0) continue;

    const placement = findAnnotationPlacement(parsed, segment.ranges);
    if (!placement) continue;

    const candidate: GuideDiffMatch = {
      parsed,
      side: placement.side,
      segmentIndex: segment.segmentIndex,
      anchorLine: placement.lineNumber,
      distance: Math.abs(placement.lineNumber - parsed.rangeEnd),
    };

    if (
      bestMatch == null ||
      candidate.distance < bestMatch.distance ||
      (candidate.distance === bestMatch.distance && candidate.segmentIndex < bestMatch.segmentIndex)
    ) {
      bestMatch = candidate;
    }
  }

  return bestMatch;
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
