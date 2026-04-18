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

export function buildAnnotationsForFile(
  allIssues: ReviewIssueRow[],
  filename: string | null
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
