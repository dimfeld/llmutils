export function parseLineRange(line: string | number | null | undefined): {
  startLine: string | null;
  line: string | null;
} {
  if (line == null) {
    return { startLine: null, line: null };
  }

  const lineStr = String(line);
  const rangeMatch = lineStr.match(/^(\d+)\s*[-–]\s*(\d+)$/);
  if (rangeMatch) {
    return { startLine: rangeMatch[1], line: rangeMatch[2] };
  }

  return { startLine: null, line: lineStr };
}
