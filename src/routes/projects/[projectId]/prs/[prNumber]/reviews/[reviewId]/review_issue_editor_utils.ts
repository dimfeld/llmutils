export type ReviewIssueSide = 'RIGHT' | 'LEFT';
export type ReviewSeverity = 'critical' | 'major' | 'minor' | 'info';
export type ReviewCategory =
  | 'security'
  | 'performance'
  | 'bug'
  | 'style'
  | 'compliance'
  | 'testing'
  | 'other';

export interface EditableReviewIssueSource {
  severity: ReviewSeverity;
  category: ReviewCategory;
  file: string | null;
  start_line: string | null;
  line: string | null;
  side: ReviewIssueSide;
  content: string;
  suggestion: string | null;
}

export type ReviewIssuePatch = {
  severity?: ReviewSeverity;
  category?: ReviewCategory;
  file?: string | null;
  startLine?: string | null;
  line?: string | null;
  side?: ReviewIssueSide;
  content?: string;
  suggestion?: string | null;
};

export interface FormState {
  severity: ReviewSeverity;
  category: ReviewCategory;
  file: string;
  startLine: string;
  line: string;
  side: ReviewIssueSide;
  content: string;
  suggestion: string;
}

export function isPositiveInteger(value: string): boolean {
  return /^[1-9]\d*$/.test(value);
}

export function nullIfEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function buildPatch(
  current: FormState,
  issue: EditableReviewIssueSource
): ReviewIssuePatch | null {
  const patch: ReviewIssuePatch = {};

  if (current.severity !== issue.severity) patch.severity = current.severity;
  if (current.category !== issue.category) patch.category = current.category;

  const nextFile = nullIfEmpty(current.file);
  if (nextFile !== (issue.file ?? null)) patch.file = nextFile;

  const nextStartLine = nullIfEmpty(current.startLine);
  if (nextStartLine !== (issue.start_line ?? null)) patch.startLine = nextStartLine;

  const nextLine = nullIfEmpty(current.line);
  if (nextLine !== (issue.line ?? null)) patch.line = nextLine;

  if (current.side !== issue.side) patch.side = current.side;

  const nextContent = current.content.trim();
  if (nextContent !== issue.content) patch.content = nextContent;

  const nextSuggestion = nullIfEmpty(current.suggestion);
  if (nextSuggestion !== (issue.suggestion ?? null)) patch.suggestion = nextSuggestion;

  return Object.keys(patch).length > 0 ? patch : null;
}

export function validatePatch(
  patch: ReviewIssuePatch,
  issue: EditableReviewIssueSource
): string | null {
  if ('content' in patch && (!patch.content || patch.content.length === 0)) {
    return 'Content is required.';
  }

  const mergedStartLine = 'startLine' in patch ? patch.startLine : (issue.start_line ?? null);
  const mergedLine = 'line' in patch ? patch.line : (issue.line ?? null);

  if (mergedStartLine != null && !isPositiveInteger(mergedStartLine)) {
    return 'Start line must be a positive integer.';
  }
  if (mergedLine != null && !isPositiveInteger(mergedLine)) {
    return 'Line must be a positive integer.';
  }
  if (mergedStartLine != null && mergedLine == null) {
    return 'Start line cannot be set without line.';
  }
  if (mergedStartLine != null && mergedLine != null) {
    const startNum = Number.parseInt(mergedStartLine, 10);
    const endNum = Number.parseInt(mergedLine, 10);
    if (startNum > endNum) {
      return 'Start line must be less than or equal to line.';
    }
  }
  return null;
}
