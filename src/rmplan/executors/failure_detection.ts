/**
 * Utilities to detect and parse standardized FAILED reports from agent outputs.
 */

import type { RepositoryState } from '../../common/git.ts';
import { compareRepositoryStates } from '../../common/git.ts';

export interface FailureDetection {
  failed: boolean;
  summary?: string;
}

export interface FailureDetails {
  requirements: string;
  problems: string;
  solutions?: string;
}

// Exact, case-sensitive FAILED prefix. Detection is only valid when it appears
// as the first non-empty line of the assistant's final message.
const FAILED_PREFIX_FIRST_LINE = /^\s*FAILED:\s*(.*)$/;

// More permissive detection: match any line in the content starting with FAILED:
const FAILED_PREFIX_ANY_LINE = /^\s*FAILED:\s*(.*)$/;

/** Returns true and the 1-line summary if content contains a FAILED line. */
export function detectFailedLine(content: string): FailureDetection {
  const text = content.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  // Find the first non-empty line
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return { failed: false };
  const m = lines[i].match(FAILED_PREFIX_FIRST_LINE);
  if (!m) return { failed: false };
  const summary = (m[1] || '').trim();
  return { failed: true, summary };
}

/** Returns true and the 1-line summary even if FAILED appears later in the message. */
export function detectFailedLineAnywhere(content: string): FailureDetection & { index?: number } {
  const text = content.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim() === '') continue;
    const m = line.match(FAILED_PREFIX_ANY_LINE);
    if (m) {
      const summary = (m[1] || '').trim();
      return { failed: true, summary, index: i };
    }
  }
  return { failed: false };
}

/** Slice message starting at the first FAILED line when present. */
export function sliceFromFirstFailed(content: string): string | undefined {
  const det = detectFailedLineAnywhere(content);
  if (!det.failed || det.index == null) return undefined;
  const text = content.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  return lines.slice(det.index).join('\n');
}

/**
 * Attempt to extract detailed sections (requirements, problems, solutions) from a FAILED report.
 * Falls back gracefully when some sections are missing.
 */
export function extractFailureDetails(content: string): FailureDetails | undefined {
  if (!detectFailedLine(content).failed) return undefined;

  // Normalize newlines
  const text = content.replace(/\r\n?/g, '\n');

  // Find section indices by common headings (case-insensitive)
  const patterns = {
    requirements:
      /^(?:##?\s*)?(requirements?|goals|what\s+you\s+were\s+trying\s+to\s+do)\s*:?\s*$/i,
    problems:
      /^(?:##?\s*)?(problems?|issues|conflicts|why\s+this\s+is\s+impossible|constraints)\s*:?\s*$/i,
    solutions:
      /^(?:##?\s*)?(possible\s+solutions?|potential\s+solutions?|solutions?|next\s+steps|recommendations)\s*:?\s*$/i,
  } as const;

  const lines = text.split('\n');

  type Key = keyof typeof patterns;
  const indices: Partial<Record<Key, number>> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    (Object.keys(patterns) as Key[]).forEach((k) => {
      if (indices[k] == null && patterns[k].test(line)) {
        indices[k] = i;
      }
    });
  }

  // Helper to slice content between a heading and the next heading (or end)
  function sliceSection(startIdx: number): string {
    const headingPositions = Object.values(indices)
      .filter((n): n is number => n != null)
      .sort((a, b) => a - b);
    const next = headingPositions.find((n) => n > startIdx);
    const from = startIdx + 1; // skip the heading line
    const to = next != null ? next : lines.length;
    return lines.slice(from, to).join('\n').trim();
  }

  let req = '';
  let probs = '';
  let sols = '';

  if (indices.requirements != null) req = sliceSection(indices.requirements);
  if (indices.problems != null) probs = sliceSection(indices.problems);
  if (indices.solutions != null) sols = sliceSection(indices.solutions);

  // Fallback heuristics when headings are missing: use text after FAILED line (first non-empty line only)
  if (!req || !probs) {
    // Find first non-empty line
    let idx = 0;
    while (idx < lines.length && lines[idx].trim() === '') idx++;
    const failedLineIdx =
      idx < lines.length && FAILED_PREFIX_FIRST_LINE.test(lines[idx]) ? idx : -1;
    if (failedLineIdx >= 0) {
      const after = lines
        .slice(failedLineIdx + 1)
        .join('\n')
        .trim();
      if (!probs) probs = after;
    }
  }

  // Ensure we have at least problems when a FAILED was detected
  if (!probs) probs = 'Unspecified problems encountered; see original FAILED report.';

  return {
    requirements: req,
    problems: probs,
    solutions: sols || undefined,
  };
}

/** Convenience that returns both detection and extracted details when available. */
export function parseFailedReport(
  content: string
): { failed: true; summary?: string; details?: FailureDetails } | { failed: false } {
  const det = detectFailedLine(content);
  if (!det.failed) return { failed: false };
  const details = extractFailureDetails(content);
  return { failed: true, summary: det.summary, details };
}

/** Like parseFailedReport, but will detect FAILED lines anywhere and parse from there. */
export function parseFailedReportAnywhere(
  content: string
): { failed: true; summary?: string; details?: FailureDetails } | { failed: false } {
  const slice = sliceFromFirstFailed(content);
  if (!slice) return { failed: false };
  return parseFailedReport(slice);
}

export interface PlanningWithoutImplementationDetection {
  detected: boolean;
  planningIndicators: string[];
  commitChanged: boolean;
  workingTreeChanged: boolean;
  repositoryStatusUnavailable: boolean;
  recommendedAction: 'retry' | 'proceed';
}

const PLANNING_LINE_PATTERNS: RegExp[] = [
  /^\s*(?:[-*]\s*)?(?:detailed\s+)?plan\b/i,
  /plan\s*:?\s*$/i,
  /^\s*here'?s\s+what\s+i'?ll\s+do\b/i,
  /^\s*i\s+(?:will|can)\s+plan\b/i,
  /^\s*i\s+will\s+(?:implement|do|make)\b/i,
  /^\s*the\s+implementation\s+will\b/i,
];

const MAX_INDICATORS_TO_COLLECT = 5;

export function detectPlanningWithoutImplementation(
  output: string,
  beforeState: RepositoryState,
  afterState: RepositoryState
): PlanningWithoutImplementationDetection {
  const normalized = output.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const planningIndicators: string[] = [];

  for (const line of lines) {
    if (planningIndicators.length >= MAX_INDICATORS_TO_COLLECT) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (PLANNING_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      planningIndicators.push(trimmed);
    }
  }

  const repoComparison = compareRepositoryStates(beforeState, afterState);
  const repositoryStatusUnavailable = Boolean(
    beforeState.statusCheckFailed || afterState.statusCheckFailed
  );

  const repositoryChanged = repoComparison.hasDifferences;
  const detected =
    planningIndicators.length > 0 && !repositoryChanged && !repositoryStatusUnavailable;

  return {
    detected,
    planningIndicators,
    commitChanged: repoComparison.commitChanged,
    workingTreeChanged: repoComparison.workingTreeChanged,
    repositoryStatusUnavailable,
    recommendedAction: detected ? 'retry' : 'proceed',
  };
}
