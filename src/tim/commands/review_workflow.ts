import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import chalk from 'chalk';
import type { Database } from 'bun:sqlite';
import PQueue from 'p-queue';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../common/env.js';
import { getGitRoot, getUsingJj } from '../../common/git.js';
import { parseLineRange } from '../../common/review_line_range.js';
import { log, warn, error } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getOrCreateProject } from '../db/project.js';
import {
  insertReviewIssues,
  type InsertReviewIssueInput,
  type ReviewCategory,
  type ReviewIssueSource,
  type ReviewRow,
  type ReviewSeverity as DbReviewSeverity,
  updateReview,
} from '../db/review.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { Executor, ExecutorOutput } from '../executors/types.js';
import {
  buildTimWorkspaceCommandEnvironmentOptionsForPath,
  getWorkspaceInfoByPathIfAvailable,
} from '../environment_options.js';
import {
  formatSeverityGroupedIssuesForTerminal,
  generateReviewSummary,
  parseJsonReviewOutput,
  type ReviewIssue,
  type ReviewSeverity,
} from '../formatters/review_formatter.js';
import { LifecycleManager } from '../lifecycle.js';
import { TMP_DIR } from '../plan_materialize.js';
import { resolveReviewExecutorSelection, type ReviewExecutorName } from '../review_runner.js';
import { isShuttingDown } from '../shutdown_state.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import {
  COMBINATION_OUTPUT_SCHEMA,
  buildIssueCombinationPrompt,
  buildReviewGuidePrompt,
  buildStandaloneSimplificationReviewPrompt,
  buildStandaloneReviewIssuesPrompt,
  type ReviewGuideDiffReference,
  type ReviewSubjectMetadata,
} from './review_pr_prompt.js';

const REVIEW_GUIDE_FILENAME = 'review-guide.md';
const REVIEW_ISSUES_FILENAME = 'review-issues.json';
const UNIFIED_DIFF_FENCE_REGEX = /```unified-diff[^\n]*\n([\s\S]*?)```/gi;

interface ExecutorIssueResult {
  issues: StoredReviewIssue[];
  source: ReviewIssueSource;
}

interface GuideResult {
  guideText: string;
}

interface UnifiedDiffCleanupResult {
  guideText: string;
  repairedSectionCount: number;
}

interface UnifiedDiffFenceBlock {
  fullMatch: string;
  diffText: string;
  index: number;
}

interface UnifiedDiffSection {
  fullMatch: string;
  diffText: string;
  index: number;
  filePath: string | null;
}

export interface ReviewGuideDiffCatalogEntry extends ReviewGuideDiffReference {
  diffText: string;
}

type CombinationIssue = {
  severity: ReviewSeverity;
  category: ReviewCategory;
  content: string;
  file: string | null;
  line: string | null;
  suggestion: string;
  source: ReviewIssueSource;
};

export type StoredReviewIssue = Omit<ReviewIssue, 'severity' | 'source' | 'file' | 'line'> & {
  severity: DbReviewSeverity;
  file?: string | null;
  line?: string | number | null;
  source?: ReviewIssueSource;
};

export interface RunReviewGuideWorkflowOptions {
  db: Database;
  config: TimConfig;
  baseDir: string;
  review: ReviewRow;
  metadata: ReviewSubjectMetadata;
  baseSha: string | null;
  reviewedSha: string;
  diffCatalog: ReviewGuideDiffCatalogEntry[] | null;
  executorSelection: ReturnType<typeof resolveReviewExecutorSelection>;
  executorTerminalInput: boolean;
  executorNoninteractive: boolean;
  customInstructions?: string;
  verbose?: boolean;
  model?: string;
  filesReviewed?: number;
  completionLabel?: string;
  planTag?: string;
}

export function buildReviewGuideWorkflowTimEnvironment(
  options: Pick<RunReviewGuideWorkflowOptions, 'config' | 'baseDir' | 'metadata'>
): TimWorkspaceCommandEnvironmentOptions {
  const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
    options.config,
    options.baseDir,
    options.metadata.kind === 'plan'
      ? {
          planId: options.metadata.planId,
          planUuid: options.metadata.planUuid,
          branch: options.metadata.headRef,
        }
      : {
          branch: options.metadata.headBranch,
        }
  );
  return {
    ...timEnvironment,
    context: {
      ...timEnvironment.context,
      workspacePath: timEnvironment.context.workspacePath ?? options.baseDir,
    },
  };
}

export async function loadCustomReviewInstructions(
  config: TimConfig,
  baseDir: string
): Promise<string | undefined> {
  const customPath = config.review?.customInstructionsPath?.trim();
  if (!customPath) {
    return undefined;
  }

  try {
    const resolvedPath = validateInstructionsFilePath(customPath, baseDir);
    const contents = await fs.readFile(resolvedPath, 'utf8');
    const trimmed = contents.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    warn(`Warning: Could not read custom instructions file: ${customPath}. ${errorMessage}`);
    return undefined;
  }
}

export async function resolveProjectContextForRepo(
  db: Database,
  cwd: string
): Promise<{ repoRoot: string; projectId: number }> {
  const repoRoot = await getGitRoot(cwd);
  const repository = await getRepositoryIdentity({ cwd: repoRoot });
  const project = getOrCreateProject(db, repository.repositoryId, {
    remoteUrl: repository.remoteUrl,
    lastGitRoot: repository.gitRoot,
  });

  return { repoRoot, projectId: project.id };
}

function getReviewTempPaths(
  baseDir: string,
  reviewId: number
): { dir: string; guidePath: string; issuesPath: string } {
  const dir = path.join(baseDir, TMP_DIR, `review-${reviewId}`);
  return {
    dir,
    guidePath: path.join(dir, REVIEW_GUIDE_FILENAME),
    issuesPath: path.join(dir, REVIEW_ISSUES_FILENAME),
  };
}

function getSubjectTag(metadata: ReviewSubjectMetadata, planTag?: string): string {
  if (planTag) {
    return planTag;
  }
  return metadata.kind === 'pr' ? metadata.prUrl : `plan ${metadata.planId}`;
}

function getGuideTitle(metadata: ReviewSubjectMetadata, tag: string): string {
  return metadata.kind === 'pr' ? `PR review guide: ${tag}` : `Plan review guide: ${tag}`;
}

function getIssuesTitlePrefix(metadata: ReviewSubjectMetadata, source: ReviewIssueSource): string {
  const sourceLabel = source === 'claude-code' ? 'claude' : 'codex';
  return metadata.kind === 'pr'
    ? `PR review issues (${sourceLabel})`
    : `Plan review issues (${sourceLabel})`;
}

function parseUnifiedDiffHunkHeader(headerLine: string): {
  oldRange: string | null;
  newRange: string | null;
} {
  const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return { oldRange: null, newRange: null };
  }

  const [, oldStart, oldCount, newStart, newCount] = match;
  const formatRange = (start: string, count: string | undefined): string | null => {
    // A zero-count hunk side (e.g. `+9,0` for a pure deletion) has no lines on
    // that side; return null so callers can prefer the non-empty side.
    if (count === '0') {
      return null;
    }
    if (!count || count === '1') {
      return start;
    }
    return `${start}-${Number(start) + Number(count) - 1}`;
  };

  return {
    oldRange: formatRange(oldStart, oldCount),
    newRange: formatRange(newStart, newCount),
  };
}

function buildDiffPreview(lines: string[]): string | null {
  const previewLines = lines
    .filter(
      (line) =>
        (line.startsWith('+') || line.startsWith('-')) &&
        !line.startsWith('+++ ') &&
        !line.startsWith('--- ')
    )
    .slice(0, 3)
    .map((line) => line.trim());

  return previewLines.length > 0 ? previewLines.join(' | ') : null;
}

export function buildReviewGuideDiffCatalog(diffText: string): ReviewGuideDiffCatalogEntry[] {
  const sections = splitUnifiedDiffSections(diffText);
  const entries: ReviewGuideDiffCatalogEntry[] = [];

  for (const section of sections) {
    const lines = section.diffText.trim().split('\n');
    const hunkStartIndexes = lines
      .map((line, index) => (line.startsWith('@@ ') ? index : -1))
      .filter((index) => index >= 0);

    if (hunkStartIndexes.length === 0) {
      const fallbackRef = `${section.filePath ?? `diff-section-${section.index + 1}`}#change`;
      entries.push({
        ref: fallbackRef,
        filePath: section.filePath,
        oldRange: null,
        newRange: null,
        header: null,
        preview: null,
        diffText: normalizePatchText(section.diffText).trimEnd(),
      });
      continue;
    }

    const fileHeaderLines = lines.slice(0, hunkStartIndexes[0]);
    for (let hunkIndex = 0; hunkIndex < hunkStartIndexes.length; hunkIndex++) {
      const startIndex = hunkStartIndexes[hunkIndex];
      const endIndex = hunkStartIndexes[hunkIndex + 1] ?? lines.length;
      const hunkLines = lines.slice(startIndex, endIndex);
      const headerLine = hunkLines[0] ?? '';
      const { oldRange, newRange } = parseUnifiedDiffHunkHeader(headerLine);
      const ref = `${section.filePath ?? `diff-section-${section.index + 1}`}#hunk-${hunkIndex + 1}`;

      entries.push({
        ref,
        filePath: section.filePath,
        oldRange,
        newRange,
        header: headerLine || null,
        preview: buildDiffPreview(hunkLines),
        diffText: normalizePatchText([...fileHeaderLines, ...hunkLines].join('\n')).trimEnd(),
      });
    }
  }

  return entries;
}

export async function loadReviewGuideDiffCatalog(options: {
  baseDir: string;
  baseSha: string | null;
  reviewedSha: string;
}): Promise<ReviewGuideDiffCatalogEntry[]> {
  if (!options.baseSha) {
    throw new Error('Unable to build review diff catalog because the base SHA is unknown.');
  }

  log(`Generating review diff catalog from ${options.baseSha} to ${options.reviewedSha}.`);
  const result =
    await $`git diff --no-color --find-renames ${options.baseSha} ${options.reviewedSha}`
      .cwd(options.baseDir)
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `Failed to build canonical review diff catalog: ${stderr || 'git diff failed.'}`
    );
  }

  const diffText = result.stdout.toString();
  const catalog = buildReviewGuideDiffCatalog(diffText);
  log(
    `Generated review diff catalog with ${catalog.length} diff ref${catalog.length === 1 ? '' : 's'}.`
  );
  return catalog;
}

export async function readCurrentHeadSha(baseDir: string): Promise<string | null> {
  try {
    const usingJjForSha = await getUsingJj(baseDir);
    if (usingJjForSha) {
      const result = await $`jj log -r @- --no-graph -T commit_id`.cwd(baseDir).quiet().nothrow();
      const sha = result.stdout.toString().trim();
      return sha && result.exitCode === 0 ? sha : null;
    }

    const result = await $`git rev-parse HEAD`.cwd(baseDir).quiet().nothrow();
    const sha = result.stdout.toString().trim();
    return sha && result.exitCode === 0 ? sha : null;
  } catch {
    return null;
  }
}

function normalizeExecutorOutput(executorOutput: unknown): string {
  if (typeof executorOutput === 'string') {
    return executorOutput;
  }

  if (
    executorOutput &&
    typeof executorOutput === 'object' &&
    'structuredOutput' in executorOutput
  ) {
    const structuredOutput = (executorOutput as ExecutorOutput).structuredOutput;
    if (structuredOutput) {
      return JSON.stringify(structuredOutput);
    }
  }

  if (executorOutput && typeof executorOutput === 'object' && 'content' in executorOutput) {
    const content = (executorOutput as ExecutorOutput).content;
    if (typeof content === 'string') {
      return content;
    }
  }

  throw new Error('Review executor returned no output.');
}

function tryExtractJsonCandidate(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const jsonFence = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (jsonFence?.[1]) {
    return jsonFence[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function withSource(issues: ReviewIssue[], source: ReviewIssueSource): StoredReviewIssue[] {
  return issues.map((issue) => ({
    ...issue,
    source: issue.source === 'claude-code' || issue.source === 'codex-cli' ? issue.source : source,
  }));
}

function parseCombinationIssues(rawOutput: string): StoredReviewIssue[] {
  const candidate = tryExtractJsonCandidate(rawOutput);
  if (!candidate) {
    throw new Error('Combination executor returned empty output.');
  }
  const parsed = JSON.parse(candidate) as {
    issues?: unknown;
    recommendations?: unknown;
    actionItems?: unknown;
  };

  if (!parsed || !Array.isArray(parsed.issues)) {
    throw new Error('Combination output must include an issues array.');
  }

  const severitySet = new Set(
    COMBINATION_OUTPUT_SCHEMA.properties.issues.items.properties.severity.enum
  );
  const categorySet = new Set(
    COMBINATION_OUTPUT_SCHEMA.properties.issues.items.properties.category.enum
  );
  const sourceSet = new Set(
    COMBINATION_OUTPUT_SCHEMA.properties.issues.items.properties.source.enum
  );

  const normalized: StoredReviewIssue[] = [];
  for (const issue of parsed.issues) {
    if (!issue || typeof issue !== 'object') {
      throw new Error('Combination output issue entries must be objects.');
    }

    const entry = issue as Partial<CombinationIssue>;
    if (
      typeof entry.severity !== 'string' ||
      !severitySet.has(entry.severity) ||
      typeof entry.category !== 'string' ||
      !categorySet.has(entry.category) ||
      typeof entry.content !== 'string' ||
      (entry.file !== null && entry.file !== undefined && typeof entry.file !== 'string') ||
      (entry.line !== null && entry.line !== undefined && typeof entry.line !== 'string') ||
      typeof entry.suggestion !== 'string' ||
      typeof entry.source !== 'string' ||
      !sourceSet.has(entry.source)
    ) {
      throw new Error('Combination output issue has invalid schema.');
    }

    normalized.push({
      severity: entry.severity,
      category: entry.category,
      content: entry.content,
      file: entry.file ?? null,
      line: entry.line ?? null,
      suggestion: entry.suggestion,
      source: entry.source,
    });
  }

  return normalized;
}

export function toInsertIssue(issue: StoredReviewIssue): InsertReviewIssueInput {
  const { startLine, line } = parseLineRange(issue.line);
  return {
    severity: issue.severity,
    category: issue.category as InsertReviewIssueInput['category'],
    content: issue.content,
    file: issue.file ?? null,
    line,
    startLine,
    suggestion: issue.suggestion ?? null,
    source: issue.source ?? null,
    // Default actionable executor-emitted issues to RIGHT so the GitHub
    // submission partitioner can inline findings on context lines. Notes go
    // through annotationToInsertIssue and preserve nullable side.
    side: 'RIGHT',
    resolved: false,
  };
}

function annotationToInsertIssue(annotation: ExtractedAnnotation): InsertReviewIssueInput {
  return {
    severity: 'note',
    category: 'other',
    content: annotation.content,
    file: annotation.file,
    line: annotation.line,
    startLine: annotation.startLine,
    suggestion: null,
    source: null,
    side: annotation.side,
    resolved: false,
    submittedInPrReviewId: null,
  };
}

function sortIssues(issues: StoredReviewIssue[]): StoredReviewIssue[] {
  return [...issues].toSorted((a, b) => {
    const fileA = a.file ?? '';
    const fileB = b.file ?? '';
    if (fileA !== fileB) {
      return fileA.localeCompare(fileB);
    }

    const lineA = a.line != null ? String(a.line) : '';
    const lineB = b.line != null ? String(b.line) : '';
    return lineA.localeCompare(lineB, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function summarizeTopIssues(issues: StoredReviewIssue[]): string[] {
  const severityRank: Record<string, number> = {
    critical: 0,
    major: 1,
    minor: 2,
    info: 3,
  };
  const important = issues
    .filter((issue) => issue.severity !== 'info' && issue.severity !== 'note')
    .toSorted((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3))
    .slice(0, 5);
  return important.map((issue, index) => {
    const location = issue.file
      ? `${issue.file}${issue.line != null ? `:${String(issue.line)}` : ''}`
      : '(no file)';
    return `${index + 1}. [${issue.severity}] ${issue.content} (${location})`;
  });
}

function asErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  return String(reason);
}

async function ensureTmpDir(tmpDir: string): Promise<void> {
  await fs.mkdir(tmpDir, { recursive: true });
}

async function cleanupTempFiles(paths: {
  dir: string;
  guidePath: string;
  issuesPath: string;
}): Promise<void> {
  await fs
    .rm(paths.dir, { recursive: true, force: true })
    .catch((err) => warn('Failed to clean up temp files: ' + String(err)));
}

function normalizePatchText(diffText: string): string {
  const trimmed = diffText.trim();
  return trimmed.length > 0 ? `${trimmed}\n` : '';
}

function getUnifiedDiffSectionFilePath(diffText: string): string | null {
  const gitHeaderMatch = diffText.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (gitHeaderMatch?.[2]) {
    return gitHeaderMatch[2].trim();
  }

  const plusHeaderMatch = diffText.match(/^\+\+\+ b\/(.+)$/m);
  if (plusHeaderMatch?.[1]) {
    return plusHeaderMatch[1].trim();
  }

  const minusHeaderMatch = diffText.match(/^--- a\/(.+)$/m);
  if (minusHeaderMatch?.[1]) {
    return minusHeaderMatch[1].trim();
  }

  return null;
}

function extractUnifiedDiffBlocks(guideText: string): UnifiedDiffFenceBlock[] {
  const blocks: UnifiedDiffFenceBlock[] = [];
  let match: RegExpExecArray | null;
  let index = 0;

  UNIFIED_DIFF_FENCE_REGEX.lastIndex = 0;
  while ((match = UNIFIED_DIFF_FENCE_REGEX.exec(guideText)) !== null) {
    blocks.push({
      fullMatch: match[0],
      diffText: match[1] ?? '',
      index,
    });
    index += 1;
  }

  return blocks;
}

function splitUnifiedDiffSections(diffText: string): UnifiedDiffSection[] {
  const trimmed = diffText.trim();
  if (!trimmed) {
    return [];
  }

  const lines = trimmed.split('\n');
  const sections: UnifiedDiffSection[] = [];
  let startIndex = 0;
  let sectionIndex = 0;

  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].startsWith('diff --git ')) {
      continue;
    }

    const sectionText = lines.slice(startIndex, index).join('\n').trim();
    if (sectionText.length > 0) {
      sections.push({
        fullMatch: sectionText,
        diffText: sectionText,
        index: sectionIndex,
        filePath: getUnifiedDiffSectionFilePath(sectionText),
      });
      sectionIndex += 1;
    }

    startIndex = index;
  }

  const finalSectionText = lines.slice(startIndex).join('\n').trim();
  if (finalSectionText.length > 0) {
    sections.push({
      fullMatch: finalSectionText,
      diffText: finalSectionText,
      index: sectionIndex,
      filePath: getUnifiedDiffSectionFilePath(finalSectionText),
    });
  }

  if (sections.length === 0) {
    return [
      {
        fullMatch: trimmed,
        diffText: trimmed,
        index: 0,
        filePath: getUnifiedDiffSectionFilePath(trimmed),
      },
    ];
  }

  return sections;
}

function joinUnifiedDiffSections(sections: string[]): string {
  return sections.map((section) => normalizePatchText(section).trimEnd()).join('\n\n');
}

const DIFF_REF_TAG_REGEX = /<diff\s+ref=(?:"([^"]+)"|'([^']+)')\s*\/>/g;
const ANNOTATION_TAG_REGEX = /<annotation\b([^>]*)>([\s\S]*?)<\/annotation>/g;
// Matches an opening fenced-code-block delimiter: 3+ backticks or tildes, with
// an optional info string after. CommonMark allows arbitrary info-string text
// after the opener.
const FENCE_OPEN_LINE_REGEX = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Matches a closing fenced-code-block delimiter: 3+ backticks or tildes
// followed only by trailing whitespace. A language tag like ```ts is NOT a
// valid close — it can only open a new fence.
const FENCE_CLOSE_LINE_REGEX = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/;
const ANNOTATION_ATTRIBUTE_REGEX = /(?:^|\s)(file|line)=(?:"([^"]*)"|'([^']*)')/g;

export interface ExtractedAnnotation {
  file: string | null;
  line: string | null;
  startLine: string | null;
  content: string;
  // When anchoring to a diff ref's hunk, side indicates which side of a split
  // diff should receive the note. null means the renderer infers the side
  // per-anchor from the surrounding hunk's old/new ranges; ambiguous overlaps
  // fall back to the additions side so plain file/line annotations still
  // render inline.
  side: 'LEFT' | 'RIGHT' | null;
}

function parseAnnotationAttributes(attrString: string): {
  file: string | null;
  line: string | null;
} {
  const attributes: { file: string | null; line: string | null } = {
    file: null,
    line: null,
  };

  ANNOTATION_ATTRIBUTE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANNOTATION_ATTRIBUTE_REGEX.exec(attrString)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? '';
    if (key === 'file') {
      attributes.file = value.trim() || null;
    } else if (key === 'line') {
      attributes.line = value.trim() || null;
    }
  }

  return attributes;
}

function getFirstLineFromRange(range: string | null): string | null {
  if (!range) {
    return null;
  }

  const trimmed = range.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.split(/[-\u2013]/, 1)[0]?.trim() || null;
}

function parseNumericLineInterval(lineRange: string | null): { min: number; max: number } | null {
  const { startLine, line } = parseLineRange(lineRange);
  if (line == null) {
    return null;
  }

  const start = startLine ?? line;
  if (!/^\d+$/.test(start) || !/^\d+$/.test(line)) {
    return null;
  }

  const startNumber = Number(start);
  const endNumber = Number(line);
  return {
    min: Math.min(startNumber, endNumber),
    max: Math.max(startNumber, endNumber),
  };
}

// Annotation/issue `line` values support comma-separated anchors (e.g. "5,11").
// Split on commas and parse each segment into a numeric interval; segments that
// don't parse (non-numeric, blank) are dropped.
function parseNumericLineIntervalCandidates(
  lineRange: string | null
): Array<{ min: number; max: number }> {
  if (lineRange == null) {
    return [];
  }
  const text = String(lineRange).trim();
  if (!text) {
    return [];
  }
  if (!text.includes(',')) {
    const single = parseNumericLineInterval(text);
    return single ? [single] : [];
  }
  const out: Array<{ min: number; max: number }> = [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const interval = parseNumericLineInterval(trimmed);
    if (interval) out.push(interval);
  }
  return out;
}

function lineIntervalsOverlap(
  left: { min: number; max: number } | null,
  right: { min: number; max: number } | null
): boolean {
  if (left == null || right == null) {
    return false;
  }

  return left.min <= right.max && right.min <= left.max;
}

function classifyLineIntervalAgainstDiffRanges(
  candidate: { min: number; max: number },
  oldInterval: { min: number; max: number } | null,
  newInterval: { min: number; max: number } | null
): 'LEFT' | 'RIGHT' | 'BOTH' | 'NEITHER' {
  const overlapsOld = lineIntervalsOverlap(candidate, oldInterval);
  const overlapsNew = lineIntervalsOverlap(candidate, newInterval);
  if (overlapsOld && overlapsNew) {
    return 'BOTH';
  }
  if (overlapsOld) {
    return 'LEFT';
  }
  if (overlapsNew) {
    return 'RIGHT';
  }
  return 'NEITHER';
}

function deriveSideForMixedDiffRefLine(
  lineRange: string | null,
  oldRange: string | null,
  newRange: string | null
): 'LEFT' | 'RIGHT' | null {
  const oldInterval = parseNumericLineInterval(oldRange);
  const newInterval = parseNumericLineInterval(newRange);
  const classifications = parseNumericLineIntervalCandidates(lineRange).map((candidate) =>
    classifyLineIntervalAgainstDiffRanges(candidate, oldInterval, newInterval)
  );

  if (classifications.length === 0 || classifications.includes('BOTH')) {
    return null;
  }

  const firstClassification = classifications[0];
  if (
    (firstClassification === 'LEFT' || firstClassification === 'RIGHT') &&
    classifications.every((classification) => classification === firstClassification)
  ) {
    return firstClassification;
  }

  return null;
}

function trimBoundaryNewlines(content: string): string {
  return content.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

function segmentGuideByFences(guideText: string): Array<{ kind: 'prose' | 'fence'; text: string }> {
  const segments: Array<{ kind: 'prose' | 'fence'; text: string }> = [];
  const lines = guideText.split('\n');
  let buffer: string[] = [];
  // Track the full opening fence delimiter so the closing fence must match its
  // character AND be at least as long (per CommonMark). A four-backtick fence
  // must not be closed by a three-backtick line.
  let fenceMarker: string | null = null;

  const pushBuffer = (kind: 'prose' | 'fence') => {
    if (buffer.length === 0) return;
    segments.push({ kind, text: buffer.join('') });
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    const lineWithNewline = isLast ? line : line + '\n';
    if (fenceMarker === null) {
      const openMatch = line.match(FENCE_OPEN_LINE_REGEX);
      if (openMatch) {
        pushBuffer('prose');
        fenceMarker = openMatch[1];
        buffer.push(lineWithNewline);
      } else {
        buffer.push(lineWithNewline);
      }
    } else {
      buffer.push(lineWithNewline);
      const closeMatch = line.match(FENCE_CLOSE_LINE_REGEX);
      if (
        closeMatch &&
        closeMatch[1][0] === fenceMarker[0] &&
        closeMatch[1].length >= fenceMarker.length
      ) {
        pushBuffer('fence');
        fenceMarker = null;
      }
    }
  }

  // Unterminated fence: treat the remaining buffer as a fence so we don't
  // accidentally extract annotations from inside an unclosed code block.
  pushBuffer(fenceMarker === null ? 'prose' : 'fence');
  return segments;
}

export function extractReviewGuideAnnotations(options: {
  guideText: string;
  diffCatalog: ReviewGuideDiffCatalogEntry[] | null;
}): { guideText: string; annotations: ExtractedAnnotation[] } {
  const annotations: ExtractedAnnotation[] = [];
  const diffRefMap = new Map((options.diffCatalog ?? []).map((entry) => [entry.ref, entry]));

  const extractFromProse = (segment: string): string => {
    ANNOTATION_TAG_REGEX.lastIndex = 0;
    return segment.replace(ANNOTATION_TAG_REGEX, (_fullMatch, attrString, rawContent) => {
      const attributes = parseAnnotationAttributes(String(attrString ?? ''));
      const refEntry = attributes.file ? diffRefMap.get(attributes.file) : undefined;
      // When file= resolves to a diff ref, derive side from the ref's ranges.
      // Auto-anchor line when line= is missing: prefer newRange (RIGHT) but
      // fall back to oldRange (LEFT) for pure-deletion hunks.
      let derivedLine: string | null = attributes.line;
      let derivedSide: 'LEFT' | 'RIGHT' | null = null;
      if (refEntry) {
        const hasNewRange = getFirstLineFromRange(refEntry.newRange) != null;
        const hasOldRange = getFirstLineFromRange(refEntry.oldRange) != null;
        if (derivedLine == null) {
          if (hasNewRange) {
            derivedLine = getFirstLineFromRange(refEntry.newRange);
            derivedSide = 'RIGHT';
          } else if (hasOldRange) {
            derivedLine = getFirstLineFromRange(refEntry.oldRange);
            derivedSide = 'LEFT';
          }
        } else if (!hasNewRange && hasOldRange) {
          // Pure-deletion hunk with an explicit line: place on LEFT.
          derivedSide = 'LEFT';
        } else if (hasNewRange && !hasOldRange) {
          // Pure-addition hunk with an explicit line: place on RIGHT.
          derivedSide = 'RIGHT';
        } else if (hasNewRange && hasOldRange) {
          // Explicit `line=` may carry comma-separated anchors. Force a side
          // only when every parsed anchor unambiguously belongs to the same
          // side. For ambiguous / out-of-range / cross-side cases the helper
          // returns null, and review_detail_utils infers the per-anchor side
          // from the hunk ranges at render time.
          derivedSide = deriveSideForMixedDiffRefLine(
            derivedLine,
            refEntry.oldRange,
            refEntry.newRange
          );
        }
      }
      const { startLine, line } = parseLineRange(derivedLine);

      annotations.push({
        file: refEntry ? refEntry.filePath : attributes.file,
        line,
        startLine,
        content: trimBoundaryNewlines(String(rawContent ?? '')),
        side: derivedSide,
      });

      return '';
    });
  };

  const segments = segmentGuideByFences(options.guideText);
  const result = segments
    .map((segment) => (segment.kind === 'prose' ? extractFromProse(segment.text) : segment.text))
    .join('');

  return { guideText: result, annotations };
}

export function expandReviewGuideDiffReferences(options: {
  guideText: string;
  diffCatalog: ReviewGuideDiffCatalogEntry[];
}): {
  guideText: string;
  replacedCount: number;
  unresolvedRefs: string[];
  unusedRefs: string[];
} {
  if (options.diffCatalog.length === 0) {
    return { guideText: options.guideText, replacedCount: 0, unresolvedRefs: [], unusedRefs: [] };
  }

  const diffMap = new Map(options.diffCatalog.map((entry) => [entry.ref, entry.diffText]));
  let replacedCount = 0;
  const unresolvedRefs = new Set<string>();
  const usedRefs = new Set<string>();

  const guideText = options.guideText.replace(
    DIFF_REF_TAG_REGEX,
    (fullMatch, doubleQuoted, singleQuoted) => {
      const ref = String(doubleQuoted ?? singleQuoted ?? '').trim();
      const diffText = diffMap.get(ref);
      if (!diffText) {
        unresolvedRefs.add(ref || fullMatch);
        return fullMatch;
      }

      replacedCount += 1;
      usedRefs.add(ref);
      return `\`\`\`unified-diff\n${normalizePatchText(diffText)}\`\`\``;
    }
  );

  const unusedEntries = options.diffCatalog.filter((entry) => !usedRefs.has(entry.ref));
  const otherChangesSection =
    unusedEntries.length > 0
      ? [
          '## Other changes',
          'These are the remaining changes that the model did not include above.',
          '',
          ...unusedEntries.flatMap((entry) => [
            '```unified-diff',
            normalizePatchText(entry.diffText).trimEnd(),
            '```',
            '',
          ]),
        ]
          .join('\n')
          .trimEnd()
      : '';

  return {
    guideText:
      otherChangesSection.length > 0
        ? `${guideText.trimEnd()}\n\n${otherChangesSection}\n`
        : guideText,
    replacedCount,
    unresolvedRefs: [...unresolvedRefs],
    unusedRefs: unusedEntries.map((entry) => entry.ref),
  };
}

async function validateUnifiedDiffSection(options: {
  baseDir: string;
  tempDir: string;
  diffText: string;
  sectionIndex: number;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  const normalizedPatch = normalizePatchText(options.diffText);
  if (!normalizedPatch) {
    return { valid: false, reason: 'Diff block is empty.' };
  }

  if (!/(^|\n)--- /.test(normalizedPatch) || !/(^|\n)\+\+\+ /.test(normalizedPatch)) {
    return { valid: false, reason: 'Diff is missing ---/+++ file headers.' };
  }

  const patchPath = path.join(options.tempDir, `guide-diff-${options.sectionIndex}.patch`);
  await fs.writeFile(patchPath, normalizedPatch, 'utf8');

  try {
    const result = await $`git apply --reverse --check ${patchPath}`
      .cwd(options.baseDir)
      .quiet()
      .nothrow();

    if (result.exitCode === 0) {
      return { valid: true };
    }

    const stderr = result.stderr.toString().trim();
    const stdout = result.stdout.toString().trim();
    return {
      valid: false,
      reason: stderr || stdout || 'git apply rejected the diff.',
    };
  } finally {
    await fs.rm(patchPath, { force: true }).catch(() => {});
  }
}

function extractPatchedDiffText(rawOutput: string): string {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:unified-diff|diff)[^\n]*\n([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return trimmed;
}

function buildUnifiedDiffRepairPrompt(options: {
  brokenDiff: string;
  validationError: string;
  baseSha: string | null;
  reviewedSha: string;
  subjectTag: string;
  subjectKind: ReviewSubjectMetadata['kind'];
  sectionIndex: number;
  filePath: string | null;
}): string {
  const baseShaLine = options.baseSha
    ? `Base SHA for the ${options.subjectKind === 'pr' ? 'PR' : 'plan'} diff is ${options.baseSha}.`
    : 'Base SHA could not be resolved automatically.';
  const sectionLabel = options.filePath ?? `section ${options.sectionIndex + 1}`;

  return [
    `You are repairing a malformed unified diff section from a ${options.subjectKind === 'pr' ? 'PR' : 'plan'} review guide for ${options.subjectTag}.`,
    `The repository is currently checked out at reviewed SHA ${options.reviewedSha}.`,
    `This section targets ${sectionLabel}.`,
    baseShaLine,
    '',
    'Requirements:',
    '1. Return only the corrected unified diff content for this section. Do not wrap it in markdown fences.',
    '2. Preserve the intended changes from the broken diff section as closely as possible.',
    '3. Produce a real unified diff with valid ---/+++ file headers and @@ hunk headers.',
    '4. Before returning, verify the section with `git apply --reverse --check` or a similar `git apply` command.',
    '5. Do not include commentary, explanation, or unrelated file sections.',
    '',
    'Validation failure from git apply --reverse --check:',
    options.validationError,
    '',
    'Broken diff:',
    '',
    options.brokenDiff.trim(),
    '',
  ].join('\n');
}

async function repairUnifiedDiffBlock(options: {
  config: TimConfig;
  baseDir: string;
  timEnvironment: TimWorkspaceCommandEnvironmentOptions;
  tempDir: string;
  diffText: string;
  validationError: string;
  baseSha: string | null;
  reviewedSha: string;
  subjectTag: string;
  subjectKind: ReviewSubjectMetadata['kind'];
  reviewId: number;
  sectionIndex: number;
  filePath: string | null;
}): Promise<string> {
  const repairExecutor = buildExecutorAndLog(
    'claude-code',
    {
      baseDir: options.baseDir,
      model: 'sonnet',
      terminalInput: false,
      noninteractive: true,
      extraAllowedTools: ['Bash(git apply --reverse --check:*)', 'Bash(git apply --check:*)'],
      timEnvironment: options.timEnvironment,
    },
    options.config,
    { reasoningEffort: 'medium' }
  );

  const output = await repairExecutor.execute(
    buildUnifiedDiffRepairPrompt({
      brokenDiff: options.diffText,
      validationError: options.validationError,
      baseSha: options.baseSha,
      reviewedSha: options.reviewedSha,
      subjectTag: options.subjectTag,
      subjectKind: options.subjectKind,
      sectionIndex: options.sectionIndex,
      filePath: options.filePath,
    }),
    {
      planId: String(options.reviewId),
      planTitle: `${options.subjectKind === 'pr' ? 'PR' : 'Plan'} review diff cleanup: ${options.subjectTag}#${options.sectionIndex + 1}`,
      planFilePath: '',
      captureOutput: 'result',
      executionMode: 'bare',
    }
  );

  const repairedDiff = extractPatchedDiffText(normalizeExecutorOutput(output));
  const validation = await validateUnifiedDiffSection({
    baseDir: options.baseDir,
    tempDir: options.tempDir,
    diffText: repairedDiff,
    sectionIndex: options.sectionIndex,
  });
  if (!validation.valid) {
    error(
      `Claude repair produced an invalid unified diff section for section ${options.sectionIndex + 1}: ${validation.reason}\n${repairedDiff}`
    );
  }

  return repairedDiff;
}

async function cleanupUnifiedDiffBlocks(options: {
  config: TimConfig;
  baseDir: string;
  timEnvironment: TimWorkspaceCommandEnvironmentOptions;
  tempDir: string;
  guideText: string;
  reviewId: number;
  subjectTag: string;
  subjectKind: ReviewSubjectMetadata['kind'];
  baseSha: string | null;
  reviewedSha: string;
}): Promise<UnifiedDiffCleanupResult> {
  const blocks = extractUnifiedDiffBlocks(options.guideText);
  if (blocks.length === 0) {
    return { guideText: options.guideText, repairedSectionCount: 0 };
  }

  const repairQueue = new PQueue({ concurrency: 4 });
  let cleanedGuideText = options.guideText;
  let repairedSectionCount = 0;

  for (const block of blocks) {
    const sections = splitUnifiedDiffSections(block.diffText);
    if (sections.length === 0) {
      continue;
    }

    const sectionResults = await Promise.all(
      sections.map(async (section) => {
        const validation = await validateUnifiedDiffSection({
          baseDir: options.baseDir,
          tempDir: options.tempDir,
          diffText: section.diffText,
          sectionIndex: section.index,
        });

        if (validation.valid) {
          return {
            cleanedText: section.fullMatch,
            repaired: false,
          };
        }

        const repairedDiff = await repairQueue.add(() =>
          repairUnifiedDiffBlock({
            config: options.config,
            baseDir: options.baseDir,
            timEnvironment: options.timEnvironment,
            tempDir: options.tempDir,
            diffText: section.diffText,
            validationError: validation.reason,
            baseSha: options.baseSha,
            reviewedSha: options.reviewedSha,
            subjectTag: options.subjectTag,
            subjectKind: options.subjectKind,
            reviewId: options.reviewId,
            sectionIndex: section.index,
            filePath: section.filePath,
          })
        );

        return {
          cleanedText: normalizePatchText(repairedDiff).trimEnd(),
          repaired: true,
        };
      })
    );

    const blockChanged = sectionResults.some((result) => result.repaired);
    if (blockChanged) {
      repairedSectionCount += sectionResults.filter((result) => result.repaired).length;
      cleanedGuideText = cleanedGuideText.replace(
        block.fullMatch,
        `\`\`\`unified-diff\n${normalizePatchText(
          joinUnifiedDiffSections(sectionResults.map((result) => result.cleanedText))
        )}\`\`\``
      );
    }
  }

  return { guideText: cleanedGuideText, repairedSectionCount };
}

async function runReviewGuide(options: {
  executor: Executor;
  metadata: ReviewSubjectMetadata;
  useJj: boolean;
  diffReferences?: ReviewGuideDiffReference[] | null;
  customInstructions?: string;
  guidePath: string;
  reviewId: number;
  planTag?: string;
}): Promise<GuideResult> {
  const subjectTag = getSubjectTag(options.metadata, options.planTag);
  const guidePrompt = buildReviewGuidePrompt({
    metadata: options.metadata,
    guidePath: options.guidePath,
    useJj: options.useJj,
    diffReferences: options.diffReferences,
    customInstructions: options.customInstructions,
  });

  await options.executor.execute(guidePrompt, {
    planId: String(options.reviewId),
    planTitle: getGuideTitle(options.metadata, subjectTag),
    planFilePath: '',
    captureOutput: 'result',
    executionMode: 'bare',
  });

  let guideText: string;
  try {
    guideText = await fs.readFile(options.guidePath, 'utf8');
  } catch (err) {
    throw new Error(
      `Review guide executor completed but did not write the expected review guide to ${options.guidePath}. Check that the prompt instructs the agent to write to this exact path.`,
      { cause: err }
    );
  }

  return { guideText };
}

async function runReviewIssues(options: {
  executor: Executor;
  metadata: ReviewSubjectMetadata;
  useJj: boolean;
  customInstructions?: string;
  reviewId: number;
  planTag?: string;
  source: ReviewIssueSource;
}): Promise<ExecutorIssueResult> {
  const subjectTag = getSubjectTag(options.metadata, options.planTag);
  const prompt = buildStandaloneReviewIssuesPrompt({
    metadata: options.metadata,
    useJj: options.useJj,
    customInstructions: options.customInstructions,
  });

  const rawOutput = await options.executor.execute(prompt, {
    planId: String(options.reviewId),
    planTitle: `${getIssuesTitlePrefix(options.metadata, options.source)}: ${subjectTag}`,
    planFilePath: '',
    captureOutput: 'result',
    executionMode: 'review',
  });

  const parsed = parseJsonReviewOutput(tryExtractJsonCandidate(normalizeExecutorOutput(rawOutput)));

  return {
    issues: withSource(parsed.issues, options.source),
    source: options.source,
  };
}

async function runSimplificationReviewIssues(options: {
  executor: Executor;
  metadata: ReviewSubjectMetadata;
  useJj: boolean;
  customInstructions?: string;
  reviewId: number;
  planTag?: string;
}): Promise<ExecutorIssueResult> {
  const subjectTag = getSubjectTag(options.metadata, options.planTag);
  const prompt = buildStandaloneSimplificationReviewPrompt({
    metadata: options.metadata,
    useJj: options.useJj,
    customInstructions: options.customInstructions,
  });

  const rawOutput = await options.executor.execute(prompt, {
    planId: String(options.reviewId),
    planTitle: `${options.metadata.kind === 'pr' ? 'PR' : 'Plan'} simplification review: ${subjectTag}`,
    planFilePath: '',
    captureOutput: 'result',
    executionMode: 'review',
  });

  const parsed = parseJsonReviewOutput(tryExtractJsonCandidate(normalizeExecutorOutput(rawOutput)));

  return {
    issues: withSource(parsed.issues, 'codex-cli'),
    source: 'codex-cli',
  };
}

async function runCombinationStep(options: {
  config: TimConfig;
  baseDir: string;
  timEnvironment: TimWorkspaceCommandEnvironmentOptions;
  claudeIssues: StoredReviewIssue[];
  codexIssues: StoredReviewIssue[];
  reviewId: number;
  subjectTag: string;
  subjectKind: ReviewSubjectMetadata['kind'];
}): Promise<StoredReviewIssue[]> {
  const prompt = buildIssueCombinationPrompt({
    subjectKind: options.subjectKind,
    claudeIssues: {
      issues: options.claudeIssues,
      recommendations: [],
      actionItems: [],
    },
    codexIssues: {
      issues: options.codexIssues,
      recommendations: [],
      actionItems: [],
    },
  });

  log(
    `Combining ${options.claudeIssues.length} claude issues and ${options.codexIssues.length} codex issues...`
  );
  const combinationExecutor = buildExecutorAndLog(
    'claude-code',
    {
      baseDir: options.baseDir,
      model: 'haiku',
      terminalInput: false,
      noninteractive: true,
      timEnvironment: options.timEnvironment,
    },
    options.config
  );

  const output = await combinationExecutor.execute(prompt, {
    planId: String(options.reviewId),
    planTitle: `${options.subjectKind === 'pr' ? 'PR' : 'Plan'} review issue merge: ${options.subjectTag}`,
    planFilePath: '',
    captureOutput: 'result',
    executionMode: 'bare',
  });

  return parseCombinationIssues(normalizeExecutorOutput(output));
}

function getExecutorNames(
  selection: ReturnType<typeof resolveReviewExecutorSelection>
): ReviewExecutorName[] {
  return selection === 'both' ? ['claude-code', 'codex-cli'] : [selection];
}

function toFormatterIssue(issue: StoredReviewIssue): ReviewIssue | null {
  // Notes are descriptive guide annotations, not actionable review findings, so keep them
  // out of formatter summaries instead of silently folding them into another severity.
  if (issue.severity === 'note') {
    return null;
  }

  return {
    ...issue,
    severity: issue.severity,
    file: issue.file ?? undefined,
    line: issue.line ?? undefined,
    source:
      issue.source === 'claude-code' || issue.source === 'codex-cli' ? issue.source : undefined,
  };
}

export async function runReviewGuideWorkflow(
  options: RunReviewGuideWorkflowOptions
): Promise<void> {
  const tempPaths = getReviewTempPaths(options.baseDir, options.review.id);
  const selectedExecutorNames = getExecutorNames(options.executorSelection);
  const subjectTag = getSubjectTag(options.metadata, options.planTag);
  const timEnvironment = buildReviewGuideWorkflowTimEnvironment(options);
  let lifecycleManager: LifecycleManager | undefined;
  let workflowError: unknown;

  try {
    if (
      options.config.lifecycle?.commands &&
      options.config.lifecycle.commands.length > 0 &&
      !isShuttingDown()
    ) {
      const workspaceInfo = getWorkspaceInfoByPathIfAvailable(options.baseDir);
      lifecycleManager = new LifecycleManager(
        options.config.lifecycle.commands,
        options.baseDir,
        workspaceInfo?.workspaceType,
        'review',
        undefined,
        {
          timEnvironment,
        }
      );
      await lifecycleManager.startup();
    }

    try {
      await ensureTmpDir(tempPaths.dir);
      const usingJj = await getUsingJj(options.baseDir);

      const executorPromises: Array<Promise<GuideResult | ExecutorIssueResult>> = [];
      const executorOrder: Array<'guide' | ReviewExecutorName | 'codex-simplification'> = [];
      const hasClaude = selectedExecutorNames.includes('claude-code');
      const hasCodex = selectedExecutorNames.includes('codex-cli');
      const guideExecutorName: ReviewExecutorName | null = hasClaude
        ? 'claude-code'
        : hasCodex
          ? 'codex-cli'
          : null;
      const concurrentJobCount =
        (guideExecutorName ? 1 : 0) + (hasClaude ? 1 : 0) + (hasCodex ? 1 : 0);
      const isConcurrent = concurrentJobCount > 1;
      const executorTerminalInput = isConcurrent ? false : options.executorTerminalInput;
      const executorNoninteractive = isConcurrent || options.executorNoninteractive;

      if (guideExecutorName) {
        executorOrder.push('guide');
        const guideExecutor = buildExecutorAndLog(
          guideExecutorName,
          {
            baseDir: options.baseDir,
            model:
              options.model ??
              (guideExecutorName === 'claude-code'
                ? options.config.reviewGuide?.model?.claude
                : options.config.reviewGuide?.model?.codex),
            terminalInput: executorTerminalInput,
            noninteractive: executorNoninteractive,
            timEnvironment,
          },
          options.config,
          guideExecutorName === 'claude-code' ? { reasoningEffort: 'high' } : {}
        );

        executorPromises.push(
          runReviewGuide({
            executor: guideExecutor,
            metadata: options.metadata,
            useJj: usingJj,
            diffReferences: options.diffCatalog,
            customInstructions: options.customInstructions,
            guidePath: tempPaths.guidePath,
            reviewId: options.review.id,
            planTag: options.planTag,
          })
        );
      }

      if (hasClaude) {
        executorOrder.push('claude-code');
        const claudeIssuesExecutor = buildExecutorAndLog(
          'claude-code',
          {
            baseDir: options.baseDir,
            model: options.model ?? options.config.reviewGuide?.model?.claude,
            terminalInput: executorTerminalInput,
            noninteractive: executorNoninteractive,
            timEnvironment,
          },
          options.config,
          { reasoningEffort: 'high' }
        );

        executorPromises.push(
          runReviewIssues({
            executor: claudeIssuesExecutor,
            metadata: options.metadata,
            useJj: usingJj,
            customInstructions: options.customInstructions,
            reviewId: options.review.id,
            planTag: options.planTag,
            source: 'claude-code',
          })
        );
      }

      if (hasCodex) {
        executorOrder.push('codex-cli');
        const codexExecutor = buildExecutorAndLog(
          'codex-cli',
          {
            baseDir: options.baseDir,
            model: options.model ?? options.config.reviewGuide?.model?.codex,
            terminalInput: executorTerminalInput,
            noninteractive: executorNoninteractive,
            timEnvironment,
          },
          options.config
        );

        executorPromises.push(
          runReviewIssues({
            executor: codexExecutor,
            metadata: options.metadata,
            useJj: usingJj,
            customInstructions: options.customInstructions,
            reviewId: options.review.id,
            planTag: options.planTag,
            source: 'codex-cli',
          })
        );

        executorOrder.push('codex-simplification');
        const codexSimplificationExecutor = buildExecutorAndLog(
          'codex-cli',
          {
            baseDir: options.baseDir,
            model: options.model ?? options.config.reviewGuide?.model?.codex,
            terminalInput: executorTerminalInput,
            noninteractive: executorNoninteractive,
            timEnvironment,
          },
          options.config
        );

        executorPromises.push(
          runSimplificationReviewIssues({
            executor: codexSimplificationExecutor,
            metadata: options.metadata,
            useJj: usingJj,
            customInstructions: options.customInstructions,
            reviewId: options.review.id,
            planTag: options.planTag,
          })
        );
      }

      const settled = await Promise.allSettled(executorPromises);

      let guideResult: GuideResult | null = null;
      let claudeIssuesResult: ExecutorIssueResult | null = null;
      let codexResult: ExecutorIssueResult | null = null;
      let codexSimplificationResult: ExecutorIssueResult | null = null;

      for (let index = 0; index < settled.length; index++) {
        const result = settled[index];
        const executorName = executorOrder[index];
        if (!executorName || !result) {
          continue;
        }

        if (result.status === 'rejected') {
          warn(`${executorName} review failed: ${asErrorMessage(result.reason)}`);
          continue;
        }

        if (executorName === 'guide') {
          guideResult = result.value as GuideResult;
        } else if (executorName === 'claude-code') {
          claudeIssuesResult = result.value as ExecutorIssueResult;
        } else if (executorName === 'codex-cli') {
          codexResult = result.value as ExecutorIssueResult;
        } else if (executorName === 'codex-simplification') {
          codexSimplificationResult = result.value as ExecutorIssueResult;
        }
      }

      if (codexSimplificationResult) {
        const mergedCodexIssues = [
          ...(codexResult?.issues ?? []),
          ...codexSimplificationResult.issues,
        ];
        if (codexResult || mergedCodexIssues.length > 0) {
          codexResult = {
            issues: mergedCodexIssues,
            source: 'codex-cli',
          };
        }
      }

      const issueResults = [claudeIssuesResult, codexResult].filter(
        (entry): entry is ExecutorIssueResult => entry != null
      );

      if (issueResults.length === 0) {
        const allErrors = settled
          .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
          .map((entry) => asErrorMessage(entry.reason));
        const errorMessage = `All review executors failed. ${allErrors.join(' | ')}`;
        throw new Error(errorMessage);
      }

      let finalIssues: StoredReviewIssue[] = [];
      let reviewGuide = guideResult?.guideText ?? null;
      let extractedAnnotations: ExtractedAnnotation[] = [];

      if (reviewGuide) {
        try {
          const cleanupResult = await cleanupUnifiedDiffBlocks({
            config: options.config,
            baseDir: options.baseDir,
            timEnvironment,
            tempDir: tempPaths.dir,
            guideText: reviewGuide,
            reviewId: options.review.id,
            subjectTag,
            subjectKind: options.metadata.kind,
            baseSha: options.baseSha,
            reviewedSha: options.reviewedSha,
          });
          reviewGuide = cleanupResult.guideText;
          if (cleanupResult.repairedSectionCount > 0) {
            log(
              `Repaired ${cleanupResult.repairedSectionCount} malformed unified diff section${cleanupResult.repairedSectionCount === 1 ? '' : 's'} in the review guide.`
            );
          }
        } catch (err) {
          warn(
            `Failed to repair malformed unified diff sections in the review guide; storing the original guide and continuing: ${asErrorMessage(err)}`
          );
        }

        if (options.diffCatalog && options.diffCatalog.length > 0) {
          const expansionResult = expandReviewGuideDiffReferences({
            guideText: reviewGuide,
            diffCatalog: options.diffCatalog,
          });
          reviewGuide = expansionResult.guideText;

          if (expansionResult.unresolvedRefs.length > 0) {
            warn(
              `Review guide referenced unknown diff ref(s): ${expansionResult.unresolvedRefs.join(', ')}`
            );
          }
        }

        const annotationResult = extractReviewGuideAnnotations({
          guideText: reviewGuide,
          diffCatalog: options.diffCatalog,
        });
        reviewGuide = annotationResult.guideText;
        extractedAnnotations = annotationResult.annotations;
      }

      if (claudeIssuesResult && codexResult) {
        try {
          finalIssues = await runCombinationStep({
            config: options.config,
            baseDir: options.baseDir,
            timEnvironment,
            claudeIssues: claudeIssuesResult.issues,
            codexIssues: codexResult.issues,
            reviewId: options.review.id,
            subjectTag,
            subjectKind: options.metadata.kind,
          });
        } catch (err) {
          warn(
            `Issue combination failed, falling back to merged raw issues: ${asErrorMessage(err)}`
          );
          finalIssues = [...claudeIssuesResult.issues, ...codexResult.issues];
        }
      } else if (claudeIssuesResult) {
        finalIssues = claudeIssuesResult.issues;
      } else if (codexResult) {
        finalIssues = codexResult.issues;
      }

      finalIssues = sortIssues(finalIssues);
      const noteIssues = extractedAnnotations.map(annotationToInsertIssue);

      insertReviewIssues(options.db, {
        reviewId: options.review.id,
        issues: [...finalIssues.map(toInsertIssue), ...noteIssues],
      });

      updateReview(options.db, options.review.id, {
        status: 'complete',
        reviewGuide,
        reviewedSha: options.reviewedSha,
        errorMessage: null,
      });

      const formatterIssues = finalIssues
        .map(toFormatterIssue)
        .filter((issue): issue is ReviewIssue => issue != null);
      const summary = generateReviewSummary(formatterIssues, options.filesReviewed ?? 0);
      log(chalk.green(`Review complete for ${options.completionLabel ?? subjectTag}`));
      log(
        `Issues: ${summary.totalIssues} total (${summary.criticalCount} critical, ${summary.majorCount} major, ${summary.minorCount} minor, ${summary.infoCount} info)`
      );

      const topIssues = summarizeTopIssues(finalIssues);
      if (topIssues.length > 0) {
        log('Top issues:');
        for (const issue of topIssues) {
          log(`  ${issue}`);
        }
      }

      if (options.verbose) {
        const terminalDetails = formatSeverityGroupedIssuesForTerminal(formatterIssues, {
          verbosity: 'detailed',
          includeHeader: false,
        });
        if (terminalDetails) {
          log(terminalDetails);
        }
      }
    } finally {
      await cleanupTempFiles(tempPaths);
    }
  } catch (err) {
    workflowError = err;
  } finally {
    if (lifecycleManager) {
      try {
        await lifecycleManager.shutdown();
      } catch (shutdownErr) {
        if (workflowError) {
          warn(`Lifecycle shutdown failed for review command: ${asErrorMessage(shutdownErr)}`);
        } else {
          workflowError = shutdownErr;
        }
      }
    }
  }

  if (workflowError) {
    try {
      updateReview(options.db, options.review.id, {
        status: 'error',
        errorMessage: asErrorMessage(workflowError),
        reviewedSha: options.reviewedSha,
      });
    } catch (updateErr) {
      warn(`Failed to mark review as error: ${asErrorMessage(updateErr)}`);
    }
    throw workflowError;
  }
}
