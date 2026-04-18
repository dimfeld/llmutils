import { parsePrOrIssueNumber } from './identifiers.js';
import { getOctokit } from './octokit.js';
import { parseLineRange } from '../review_line_range.js';

export type DiffSide = 'LEFT' | 'RIGHT';
export type DiffAnnotationSide = 'additions' | 'deletions';
export type PrReviewEvent = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export interface DiffFileIndex {
  additions: Set<number>;
  deletions: Set<number>;
}

export interface ReviewIssueForSubmission {
  id: number;
  file: string | null;
  line: string | null;
  start_line: string | null;
  side?: DiffSide | null;
  content: string;
  suggestion: string | null;
}

export interface ReviewCommentPayload {
  path: string;
  body: string;
  line: number;
  side: DiffSide;
  start_line?: number;
  start_side?: DiffSide;
}

export interface SubmitPrReviewInput {
  prUrl: string;
  commitSha: string;
  event: PrReviewEvent;
  body: string;
  comments: ReviewCommentPayload[];
}

function normalizeDiffPath(diffPath: string): string {
  const trimmed = diffPath.trim();
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function ensureDiffFileIndex(
  diffIndex: Map<string, DiffFileIndex>,
  filePath: string | null
): DiffFileIndex | null {
  if (!filePath) {
    return null;
  }
  const normalized = normalizeDiffPath(filePath);
  if (!normalized || normalized === '/dev/null') {
    return null;
  }

  const existing = diffIndex.get(normalized);
  if (existing) {
    return existing;
  }

  const created = {
    additions: new Set<number>(),
    deletions: new Set<number>(),
  };
  diffIndex.set(normalized, created);
  return created;
}

export function buildDiffIndex(unifiedDiff: string): Map<string, DiffFileIndex> {
  const diffIndex = new Map<string, DiffFileIndex>();
  const lines = unifiedDiff.split('\n');

  let currentFile: string | null = null;
  let currentFileIndex: DiffFileIndex | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match ? match[2] : null;
      currentFileIndex = ensureDiffFileIndex(diffIndex, currentFile);
      inHunk = false;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const plusPath = line.slice(4).trim();
      if (plusPath !== '/dev/null') {
        currentFile = plusPath;
      }
      currentFileIndex = ensureDiffFileIndex(diffIndex, currentFile);
      inHunk = false;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1] ?? '', 10);
      newLine = Number.parseInt(hunkMatch[2] ?? '', 10);
      inHunk = true;
      continue;
    }

    if (!inHunk || !currentFileIndex) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentFileIndex.additions.add(newLine);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      currentFileIndex.deletions.add(oldLine);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return diffIndex;
}

function parseIssueLineRange(issue: Pick<ReviewIssueForSubmission, 'line' | 'start_line'>): {
  start: number;
  end: number;
} | null {
  const parsed = parseLineRange(issue.line);
  const endRaw = parsed.line ?? (issue.line != null ? String(issue.line) : null);
  const startRaw = issue.start_line ?? parsed.startLine ?? endRaw;

  if (!startRaw || !endRaw) {
    return null;
  }
  if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw)) {
    return null;
  }

  const start = Number.parseInt(startRaw, 10);
  const end = Number.parseInt(endRaw, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
    return null;
  }

  return { start, end };
}

function inferIssueSide(
  issue: ReviewIssueForSubmission,
  fileIndex: DiffFileIndex,
  start: number,
  end: number
): DiffSide | null {
  const endpoints = start === end ? [start] : [start, end];
  const allInAdditions = endpoints.every((line) => fileIndex.additions.has(line));
  const allInDeletions = endpoints.every((line) => fileIndex.deletions.has(line));

  if (allInAdditions === allInDeletions) {
    return null;
  }

  return allInAdditions ? 'RIGHT' : 'LEFT';
}

export function partitionIssuesForSubmission<T extends ReviewIssueForSubmission>(
  issues: T[],
  diffIndex: Map<string, DiffFileIndex>
): { inlineable: T[]; appendToBody: T[] } {
  const inlineable: T[] = [];
  const appendToBody: T[] = [];

  for (const issue of issues) {
    const file = issue.file?.trim() ?? '';
    if (!file) {
      appendToBody.push(issue);
      continue;
    }

    const fileIndex = diffIndex.get(file) ?? diffIndex.get(normalizeDiffPath(file));
    if (!fileIndex) {
      appendToBody.push(issue);
      continue;
    }

    const range = parseIssueLineRange(issue);
    if (!range) {
      appendToBody.push(issue);
      continue;
    }

    const resolvedSide =
      issue.side ?? inferIssueSide(issue, fileIndex, range.start, range.end) ?? null;
    if (!resolvedSide) {
      appendToBody.push(issue);
      continue;
    }

    const sideLines = resolvedSide === 'RIGHT' ? fileIndex.additions : fileIndex.deletions;
    const endpointLines = range.start === range.end ? [range.start] : [range.start, range.end];
    const endpointsInDiff = endpointLines.every((line) => sideLines.has(line));

    if (!endpointsInDiff) {
      appendToBody.push(issue);
      continue;
    }

    inlineable.push({
      ...issue,
      side: resolvedSide,
    });
  }

  return { inlineable, appendToBody };
}

function buildCommentBody(issue: Pick<ReviewIssueForSubmission, 'content' | 'suggestion'>): string {
  const base = issue.content.trim();
  const suggestion = issue.suggestion?.trim() ?? '';
  if (!suggestion) {
    return base;
  }

  return `${base}\n\nSuggestion: ${suggestion}`;
}

export function buildReviewComments<T extends ReviewIssueForSubmission>(
  inlineable: T[]
): ReviewCommentPayload[] {
  const comments: ReviewCommentPayload[] = [];

  for (const issue of inlineable) {
    const range = parseIssueLineRange(issue);
    if (!issue.file || !range) {
      throw new Error(
        `Issue ${issue.id} is missing required inline comment fields (file and parseable line range)`
      );
    }
    if (!issue.side) {
      throw new Error(
        `Issue ${issue.id} is missing required inline comment field (side). Did you call partitionIssuesForSubmission first?`
      );
    }
    const side = issue.side;

    const comment: ReviewCommentPayload = {
      path: issue.file,
      body: buildCommentBody(issue),
      line: range.end,
      side,
    };

    if (range.start !== range.end) {
      comment.start_line = range.start;
      comment.start_side = side;
    }

    comments.push(comment);
  }

  return comments;
}

export function appendIssuesToBody<T extends ReviewIssueForSubmission>(
  body: string,
  appendToBody: T[]
): string {
  if (appendToBody.length === 0) {
    return body;
  }

  const bulletLines = appendToBody.map((issue) => {
    const location = issue.file ? `**${issue.file}${issue.line ? `:${issue.line}` : ''}**: ` : '';
    const suggestionLine = issue.suggestion ? `\n  - Suggestion: ${issue.suggestion}` : '';
    return `- ${location}${issue.content}${suggestionLine}`;
  });

  return `${body}\n\n## Additional notes\n${bulletLines.join('\n')}`;
}

export async function submitPrReview(input: SubmitPrReviewInput): Promise<{
  id: number;
  html_url: string | null;
}> {
  const parsed = await parsePrOrIssueNumber(input.prUrl);
  if (!parsed) {
    throw new Error(`Invalid pull request identifier: ${input.prUrl}`);
  }

  const octokit = getOctokit();
  const response = await octokit.rest.pulls.createReview({
    owner: parsed.owner,
    repo: parsed.repo,
    pull_number: parsed.number,
    commit_id: input.commitSha,
    event: input.event,
    body: input.body,
    comments: input.comments,
  });

  return {
    id: response.data.id,
    html_url: response.data.html_url ?? null,
  };
}
