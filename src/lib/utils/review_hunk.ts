import type { PrReviewThreadRow } from '$tim/db/pr_status.js';

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;

type DiffSide = 'LEFT' | 'RIGHT';

interface ParsedHunkLine {
  raw: string;
  consumesOld: boolean;
  consumesNew: boolean;
  oldBefore: number;
  newBefore: number;
  oldLine: number | null;
  newLine: number | null;
}

interface ParsedHunk {
  suffix: string;
  lines: ParsedHunkLine[];
}

export interface ReviewHunkWindow {
  hunk: string;
  isTruncated: boolean;
}

function parseHunk(hunk: string): ParsedHunk | null {
  const lines = hunk.split('\n');
  const header = lines[0];
  const match = HUNK_HEADER_RE.exec(header);

  if (!match) {
    return null;
  }

  let oldLine = Number(match[1]);
  let newLine = Number(match[3]);
  const suffix = match[5] ?? '';
  const parsedLines: ParsedHunkLine[] = [];

  for (const raw of lines.slice(1)) {
    const oldBefore = oldLine;
    const newBefore = newLine;

    if (raw.startsWith(' ')) {
      parsedLines.push({
        raw,
        consumesOld: true,
        consumesNew: true,
        oldBefore,
        newBefore,
        oldLine,
        newLine,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (raw.startsWith('-')) {
      parsedLines.push({
        raw,
        consumesOld: true,
        consumesNew: false,
        oldBefore,
        newBefore,
        oldLine,
        newLine: null,
      });
      oldLine += 1;
      continue;
    }

    if (raw.startsWith('+')) {
      parsedLines.push({
        raw,
        consumesOld: false,
        consumesNew: true,
        oldBefore,
        newBefore,
        oldLine: null,
        newLine,
      });
      newLine += 1;
      continue;
    }

    parsedLines.push({
      raw,
      consumesOld: false,
      consumesNew: false,
      oldBefore,
      newBefore,
      oldLine: null,
      newLine: null,
    });
  }

  return { suffix, lines: parsedLines };
}

function getThreadLine(
  thread: PrReviewThreadRow,
  side: DiffSide,
  endpoint: 'start' | 'end'
): number | null {
  if (side === 'LEFT') {
    return endpoint === 'start'
      ? (thread.original_start_line ?? thread.original_line)
      : (thread.original_line ?? thread.original_start_line);
  }

  return endpoint === 'start'
    ? (thread.start_line ?? thread.line)
    : (thread.line ?? thread.start_line);
}

function getThreadSide(thread: PrReviewThreadRow, endpoint: 'start' | 'end'): DiffSide | null {
  const side =
    endpoint === 'start' ? (thread.start_diff_side ?? thread.diff_side) : thread.diff_side;
  return side === 'LEFT' || side === 'RIGHT' ? side : null;
}

function positionForSide(line: ParsedHunkLine, side: DiffSide): number | null {
  if (side === 'LEFT') {
    return line.oldLine ?? (line.consumesNew ? line.oldBefore : null);
  }

  return line.newLine ?? (line.consumesOld ? line.newBefore : null);
}

function buildHeader(line: ParsedHunkLine[], suffix: string): string {
  const first = line[0];

  const oldStart = first.oldBefore;
  const newStart = first.newBefore;
  const oldCount = line.filter((entry) => entry.consumesOld).length;
  const newCount = line.filter((entry) => entry.consumesNew).length;
  const oldLength = Math.max(0, oldCount);
  const newLength = Math.max(0, newCount);

  return `@@ -${oldStart},${oldLength} +${newStart},${newLength} @@${suffix}`;
}

function rebuildHunk(lines: ParsedHunkLine[], suffix: string): string {
  if (lines.length === 0) {
    return '';
  }

  return [buildHeader(lines, suffix), ...lines.map((line) => line.raw)].join('\n');
}

export function getReviewThreadHunkWindow(
  thread: PrReviewThreadRow,
  diffHunk: string,
  contextLines = 5
): ReviewHunkWindow {
  const parsed = parseHunk(diffHunk);
  if (!parsed) {
    return { hunk: diffHunk, isTruncated: false };
  }

  const endSide = getThreadSide(thread, 'end');
  const startSide = getThreadSide(thread, 'start') ?? endSide;

  if (!endSide || !startSide) {
    return { hunk: diffHunk, isTruncated: false };
  }

  const endLine = getThreadLine(thread, endSide, 'end');
  const startLine = getThreadLine(thread, startSide, 'start') ?? endLine;

  if (endLine == null || startLine == null) {
    return { hunk: diffHunk, isTruncated: false };
  }

  const focusStart = Math.min(startLine, endLine);
  const focusEnd = Math.max(startLine, endLine);

  const visibleIndexes = parsed.lines
    .map((line, index) => ({ index, position: positionForSide(line, endSide) }))
    .filter(
      (entry) =>
        entry.position != null &&
        entry.position >= focusStart - contextLines &&
        entry.position <= focusEnd + contextLines
    )
    .map((entry) => entry.index);

  if (visibleIndexes.length === 0) {
    return { hunk: diffHunk, isTruncated: false };
  }

  const visibleStart = Math.max(0, Math.min(...visibleIndexes));
  const visibleEnd = Math.min(parsed.lines.length - 1, Math.max(...visibleIndexes));
  const visibleLines = parsed.lines.slice(visibleStart, visibleEnd + 1);
  const isTruncated = visibleStart > 0 || visibleEnd < parsed.lines.length - 1;

  if (!isTruncated) {
    return { hunk: diffHunk, isTruncated: false };
  }

  return {
    hunk: rebuildHunk(visibleLines, parsed.suffix),
    isTruncated: true,
  };
}
