import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import chalk from 'chalk';
import type { Database } from 'bun:sqlite';
import PQueue from 'p-queue';
import {
  getGitInfoExcludePath,
  getMergeBase,
  getGitRoot,
  getUsingJj,
  isIgnoredByGitSharedExcludes,
} from '../../common/git.js';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { parseLineRange } from '../../common/review_line_range.js';
export { parseLineRange };
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { log, warn, error } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import {
  createReview,
  getLatestReviewByPrUrl,
  getReviewIssues,
  insertReviewIssues,
  type InsertReviewIssueInput,
  type ReviewCategory,
  type ReviewIssueRow,
  type ReviewIssueSource,
  updateReview,
} from '../db/review.js';
import { getLinkedPlansByPrUrl } from '../db/pr_status.js';
import { getOrCreateProject } from '../db/project.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { Executor, ExecutorOutput } from '../executors/types.js';
import {
  formatSeverityGroupedIssuesForTerminal,
  generateReviewSummary,
  parseJsonReviewOutput,
  type ReviewIssue,
  type ReviewSeverity,
} from '../formatters/review_formatter.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { TMP_DIR } from '../plan_materialize.js';
import {
  COMBINATION_OUTPUT_SCHEMA,
  buildIssueCombinationPrompt,
  buildReviewGuidePrompt,
  buildStandaloneReviewIssuesPrompt,
  type PrReviewMetadata,
  type ReviewGuideDiffReference,
} from './review_pr_prompt.js';
import { resolveReviewExecutorSelection, type ReviewExecutorName } from '../review_runner.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { LifecycleManager } from '../lifecycle.js';
import { getWorkspaceInfoByPath } from '../workspace/workspace_info.js';
import { getSignalExitCode, isShuttingDown, setDeferSignalExit } from '../shutdown_state.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

export interface ReviewGuideCommandOptions {
  plan?: number;
  executor?: string;
  autoWorkspace?: boolean;
  model?: string;
  terminalInput?: boolean;
  nonInteractive?: boolean;
  verbose?: boolean;
}

interface MaterializeCommandOptions {
  // Currently no options; placeholder for future extension.
}

interface ExecutorIssueResult {
  issues: StoredReviewIssue[];
  source: ReviewIssueSource;
}

interface ClaudeGuideResult {
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

interface ReviewGuideDiffCatalogEntry extends ReviewGuideDiffReference {
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

type StoredReviewIssue = Omit<ReviewIssue, 'source' | 'file' | 'line'> & {
  file?: string | null;
  line?: string | number | null;
  source?: ReviewIssueSource;
};

const REVIEW_GUIDE_FILENAME = 'review-guide.md';
const REVIEW_ISSUES_FILENAME = 'review-issues.json';
const MATERIALIZED_REVIEWS_DIR = path.join('.tim', 'reviews');
const UNIFIED_DIFF_FENCE_REGEX = /```unified-diff[^\n]*\n([\s\S]*?)```/gi;

const SEVERITY_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'info'];

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function buildPrMetadata(context: Awaited<ReturnType<typeof gatherPrContext>>): PrReviewMetadata {
  return {
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    title: context.prStatus.title,
    author: context.prStatus.author,
    baseBranch: context.baseBranch,
    headBranch: context.headBranch,
    owner: context.owner,
    repo: context.repo,
  };
}

function updateReviewGuideSessionInfo(
  db: Database,
  context: Awaited<ReturnType<typeof gatherPrContext>>
): void {
  const linkedPlan = getLinkedPlansByPrUrl(db, [context.prUrl]).get(context.prUrl)?.[0];

  updateHeadlessSessionInfo({
    linkedPrUrl: context.prUrl,
    linkedPrNumber: context.prNumber,
    linkedPrTitle: context.prStatus.title ?? undefined,
    linkedPlanId: linkedPlan?.planId,
    linkedPlanUuid: linkedPlan?.planUuid,
    linkedPlanTitle: linkedPlan?.title ?? undefined,
  });
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

function parseUnifiedDiffHunkHeader(headerLine: string): {
  oldRange: string | null;
  newRange: string | null;
} {
  const match = headerLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) {
    return { oldRange: null, newRange: null };
  }

  const [, oldStart, oldCount, newStart, newCount] = match;
  const formatRange = (start: string, count: string | undefined) => {
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
      const startIndex = hunkStartIndexes[hunkIndex]!;
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

async function loadReviewGuideDiffCatalog(options: {
  baseDir: string;
  baseSha: string | null;
  reviewedSha: string;
}): Promise<ReviewGuideDiffCatalogEntry[] | null> {
  if (!options.baseSha) {
    return null;
  }

  const result =
    await $`git diff --no-color --find-renames ${options.baseSha} ${options.reviewedSha}`
      .cwd(options.baseDir)
      .quiet()
      .nothrow();

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    warn(
      `Failed to build canonical PR diff catalog; falling back to raw diff instructions: ${stderr || 'git diff failed.'}`
    );
    return null;
  }

  const diffText = result.stdout.toString();
  return buildReviewGuideDiffCatalog(diffText);
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

function toInsertIssue(issue: StoredReviewIssue): InsertReviewIssueInput {
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
    resolved: false,
  };
}

function sortIssues(issues: StoredReviewIssue[]): StoredReviewIssue[] {
  return [...issues].sort((a, b) => {
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
  const severityRank: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };
  const important = issues
    .filter((issue) => issue.severity !== 'info')
    .sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3))
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
  prUrl: string;
  sectionIndex: number;
  filePath: string | null;
}): string {
  const baseShaLine = options.baseSha
    ? `Base SHA for the PR diff is ${options.baseSha}.`
    : 'Base SHA could not be resolved automatically.';
  const sectionLabel = options.filePath ?? `section ${options.sectionIndex + 1}`;

  return [
    `You are repairing a malformed unified diff section from a PR review guide for ${options.prUrl}.`,
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
  tempDir: string;
  diffText: string;
  validationError: string;
  baseSha: string | null;
  reviewedSha: string;
  prUrl: string;
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
      prUrl: options.prUrl,
      sectionIndex: options.sectionIndex,
      filePath: options.filePath,
    }),
    {
      planId: String(options.reviewId),
      planTitle: `PR review diff cleanup: ${options.prUrl}#${options.sectionIndex + 1}`,
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
  tempDir: string;
  guideText: string;
  reviewId: number;
  prUrl: string;
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
            tempDir: options.tempDir,
            diffText: section.diffText,
            validationError: validation.reason,
            baseSha: options.baseSha,
            reviewedSha: options.reviewedSha,
            prUrl: options.prUrl,
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

async function runClaudeGuide(options: {
  executor: Executor;
  metadata: PrReviewMetadata;
  useJj: boolean;
  diffReferences?: ReviewGuideDiffReference[] | null;
  customInstructions?: string;
  guidePath: string;
  reviewId: number;
  prUrl: string;
}): Promise<ClaudeGuideResult> {
  const guidePrompt = buildReviewGuidePrompt({
    metadata: options.metadata,
    guidePath: options.guidePath,
    useJj: options.useJj,
    diffReferences: options.diffReferences,
    customInstructions: options.customInstructions,
  });

  await options.executor.execute(guidePrompt, {
    planId: String(options.reviewId),
    planTitle: `PR review guide: ${options.prUrl}`,
    planFilePath: '',
    captureOutput: 'result',
    executionMode: 'bare',
  });

  let guideText: string;
  try {
    guideText = await fs.readFile(options.guidePath, 'utf8');
  } catch (error) {
    throw new Error(
      `Claude executor completed but did not write the expected review guide to ${options.guidePath}. Check that the prompt instructs the agent to write to this exact path.`,
      { cause: error }
    );
  }

  return { guideText };
}

async function runReviewIssues(options: {
  executor: Executor;
  metadata: PrReviewMetadata;
  useJj: boolean;
  customInstructions?: string;
  reviewId: number;
  prUrl: string;
  source: ReviewIssueSource;
  planTitlePrefix: string;
}): Promise<ExecutorIssueResult> {
  const prompt = buildStandaloneReviewIssuesPrompt({
    metadata: options.metadata,
    useJj: options.useJj,
    customInstructions: options.customInstructions,
  });

  const rawOutput = await options.executor.execute(prompt, {
    planId: String(options.reviewId),
    planTitle: `${options.planTitlePrefix}: ${options.prUrl}`,
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

async function runCombinationStep(options: {
  config: TimConfig;
  baseDir: string;
  claudeIssues: StoredReviewIssue[];
  codexIssues: StoredReviewIssue[];
  reviewId: number;
  prUrl: string;
}): Promise<StoredReviewIssue[]> {
  const prompt = buildIssueCombinationPrompt({
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
    },
    options.config
  );

  const output = await combinationExecutor.execute(prompt, {
    planId: String(options.reviewId),
    planTitle: `PR review issue merge: ${options.prUrl}`,
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

function toFormatterIssue(issue: StoredReviewIssue): ReviewIssue {
  return {
    ...issue,
    file: issue.file ?? undefined,
    line: issue.line ?? undefined,
    source:
      issue.source === 'claude-code' || issue.source === 'codex-cli' ? issue.source : undefined,
  };
}

async function loadCustomReviewInstructions(
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

async function ensureReviewsDirExcluded(repoRoot: string): Promise<void> {
  const infoExcludePath = await getGitInfoExcludePath(repoRoot);
  if (!infoExcludePath) {
    return;
  }

  const isIgnored = await isIgnoredByGitSharedExcludes(
    repoRoot,
    path.join(MATERIALIZED_REVIEWS_DIR, '__tim_review_probe__')
  );
  if (isIgnored) {
    return;
  }

  let existing = '';
  try {
    existing = await fs.readFile(infoExcludePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const lines = existing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.includes(MATERIALIZED_REVIEWS_DIR)) {
    return;
  }

  const suffix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await fs.writeFile(infoExcludePath, `${existing}${suffix}${MATERIALIZED_REVIEWS_DIR}\n`);
}

function formatIssueLocation(issue: Pick<ReviewIssueRow, 'file' | 'line' | 'start_line'>): string {
  if (!issue.file) {
    return '(no file)';
  }

  if (issue.start_line && issue.line) {
    return `${issue.file}:${issue.start_line}-${issue.line}`;
  }

  if (issue.line) {
    return `${issue.file}:${issue.line}`;
  }

  return issue.file;
}

export function formatReviewIssuesMarkdown(issues: ReviewIssueRow[]): string {
  const sections: string[] = ['# Review Issues', ''];

  for (const severity of SEVERITY_ORDER) {
    const severityIssues = issues.filter((issue) => issue.severity === severity);
    if (severityIssues.length === 0) {
      continue;
    }

    sections.push(`## ${severity[0].toUpperCase()}${severity.slice(1)} (${severityIssues.length})`);
    sections.push('');

    severityIssues.forEach((issue, index) => {
      sections.push(`### ${index + 1}. ${issue.content}`);
      sections.push(`- Category: ${issue.category}`);
      sections.push(`- Location: ${formatIssueLocation(issue)}`);
      if (issue.suggestion) {
        sections.push(`- Suggestion: ${issue.suggestion}`);
      }
      if (issue.source) {
        sections.push(`- Source: ${issue.source}`);
      }
      sections.push(`- Resolved: ${issue.resolved === 1 ? 'yes' : 'no'}`);
      sections.push('');
    });
  }

  if (sections.length === 2) {
    sections.push('No issues were stored for this review.');
  }

  return sections.join('\n').trimEnd() + '\n';
}

async function resolveProjectContextForRepo(
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

export async function handleReviewGuideCommand(
  prArg: string | undefined,
  options: ReviewGuideCommandOptions,
  command: RootCommandLike
): Promise<void> {
  if (!prArg && options.plan === undefined) {
    throw new Error('Provide a PR URL/number or use --plan <id>.');
  }

  const globalOpts = getRootOptions(command);
  const db = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });
  const tunnelActive = isTunnelActive();

  // Review sessions can accept follow-up input from three channels:
  // terminal stdin, tunnel forwarding, or the headless adapter. TTY presence
  // only controls terminal input availability; it should not force the whole
  // review into noninteractive mode when forwarded input is still available.
  const reviewInteractive = options.nonInteractive !== true;

  const effectiveTerminalInput =
    options.terminalInput !== false &&
    config.terminalInput !== false &&
    reviewInteractive &&
    process.stdin.isTTY === true;

  const reviewSelection = resolveReviewExecutorSelection(options.executor, config);
  const selectedExecutorNames = getExecutorNames(reviewSelection);

  let baseDir = initialRepoRoot;

  try {
    // Allow SIGTERM/SIGINT to be captured while this command finishes async cleanup.
    // The tim CLI will exit using the stored signal code once the callback completes.
    setDeferSignalExit(true);

    await runWithHeadlessAdapterIfEnabled({
      enabled: !tunnelActive,
      command: 'review',
      interactive: reviewInteractive,
      callback: async () => {
        const prContext = await gatherPrContext({
          db,
          prUrlOrNumber: prArg,
          plan: options.plan,
          cwd: baseDir,
        });
        updateReviewGuideSessionInfo(db, prContext);

        const metadata = buildPrMetadata(prContext);
        const { projectId, repoRoot } = await resolveProjectContextForRepo(db, baseDir);
        const repoIdentity = await getRepositoryIdentity({ cwd: repoRoot });
        const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
        if (!parsedRepositoryId) {
          throw new Error(
            `Cannot validate repository identity: ${repoIdentity.repositoryId} is not a recognized GitHub repository. This command only works with GitHub PRs.`
          );
        }
        if (
          parsedRepositoryId.owner.toLowerCase() !== prContext.owner.toLowerCase() ||
          parsedRepositoryId.repo.toLowerCase() !== prContext.repo.toLowerCase()
        ) {
          throw new Error(
            `PR ${prContext.prUrl} belongs to ${prContext.owner}/${prContext.repo}, but the current repository is ${parsedRepositoryId.owner}/${parsedRepositoryId.repo}. Run this command from inside the matching repository.`
          );
        }

        if (options.autoWorkspace === true) {
          const selector = new WorkspaceAutoSelector(baseDir, config);
          const taskId = `pr-review-${prContext.prNumber}-${Date.now()}`;
          const selectedWorkspace = await selector.selectWorkspace(taskId, undefined, {
            interactive: options.nonInteractive !== true,
            createBranch: false,
          });
          if (!selectedWorkspace) {
            throw new Error('Failed to select or create a workspace for PR review.');
          }

          const lockInfo = await WorkspaceLock.acquireLock(
            selectedWorkspace.workspace.workspacePath,
            'tim pr review-guide',
            { type: 'pid' }
          );
          WorkspaceLock.setupCleanupHandlers(
            selectedWorkspace.workspace.workspacePath,
            lockInfo.type
          );

          baseDir = selectedWorkspace.workspace.workspacePath;
          updateHeadlessSessionInfo({ workspacePath: baseDir });
        }

        await checkoutPrBranch({
          branch: prContext.headBranch,
          baseBranch: prContext.baseBranch,
          prNumber: prContext.prNumber,
          skipDirtyCheck: options.autoWorkspace === true,
          cwd: baseDir,
        });

        // Read the actual reviewed SHA after checkout, not the cached pr_status value,
        // since the remote branch may have advanced since the cache was written.
        // For jj, `jj new` creates a synthetic working-copy commit on top of the branch,
        // so `git rev-parse HEAD` would return the wrong SHA. Use the parent instead.
        let reviewedSha = prContext.headSha;
        try {
          const usingJjForSha = await getUsingJj(baseDir);
          if (usingJjForSha) {
            const result = await $`jj log -r @- --no-graph -T commit_id`
              .cwd(baseDir)
              .quiet()
              .nothrow();
            const sha = result.stdout.toString().trim();
            if (sha && result.exitCode === 0) {
              reviewedSha = sha;
            }
          } else {
            const result = await $`git rev-parse HEAD`.cwd(baseDir).quiet().nothrow();
            const sha = result.stdout.toString().trim();
            if (sha && result.exitCode === 0) {
              reviewedSha = sha;
            }
          }
        } catch {
          // Fall back to cached SHA if we can't read HEAD
        }
        const baseSha = await getMergeBase(baseDir, prContext.baseBranch, 'HEAD');
        const diffCatalog = await loadReviewGuideDiffCatalog({
          baseDir,
          baseSha,
          reviewedSha,
        });

        const review = createReview(db, {
          projectId,
          prStatusId: prContext.prStatus.id,
          prUrl: prContext.prUrl,
          branch: prContext.headBranch,
          baseBranch: prContext.baseBranch,
          status: 'in_progress',
        });

        const tempPaths = getReviewTempPaths(baseDir, review.id);
        let lifecycleManager: LifecycleManager | undefined;
        let workflowError: unknown;

        try {
          if (
            config.lifecycle?.commands &&
            config.lifecycle.commands.length > 0 &&
            !isShuttingDown()
          ) {
            const workspaceInfo = getWorkspaceInfoByPath(baseDir);
            lifecycleManager = new LifecycleManager(
              config.lifecycle.commands,
              baseDir,
              workspaceInfo?.workspaceType,
              'review'
            );
            await lifecycleManager.startup();
          }

          try {
            await ensureTmpDir(tempPaths.dir);
            const usingJj = await getUsingJj(baseDir);
            const customInstructions = await loadCustomReviewInstructions(config, baseDir);

            const executorPromises: Array<Promise<ClaudeGuideResult | ExecutorIssueResult>> = [];
            const executorOrder: Array<'claude-guide' | ReviewExecutorName> = [];
            const hasClaude = selectedExecutorNames.includes('claude-code');
            const hasCodex = selectedExecutorNames.includes('codex-cli');
            const concurrentJobCount = (hasClaude ? 2 : 0) + (hasCodex ? 1 : 0);
            const isConcurrent = concurrentJobCount > 1;
            const executorTerminalInput = isConcurrent ? false : effectiveTerminalInput;
            const executorNoninteractive = isConcurrent || !reviewInteractive;

            if (hasClaude) {
              executorOrder.push('claude-guide');
              const claudeGuideExecutor = buildExecutorAndLog(
                'claude-code',
                {
                  baseDir,
                  model: options.model,
                  terminalInput: executorTerminalInput,
                  noninteractive: executorNoninteractive,
                },
                config,
                { reasoningEffort: 'high' }
              );

              executorPromises.push(
                runClaudeGuide({
                  executor: claudeGuideExecutor,
                  metadata,
                  useJj: usingJj,
                  diffReferences: diffCatalog,
                  customInstructions,
                  guidePath: tempPaths.guidePath,
                  reviewId: review.id,
                  prUrl: prContext.prUrl,
                })
              );

              executorOrder.push('claude-code');
              const claudeIssuesExecutor = buildExecutorAndLog(
                'claude-code',
                {
                  baseDir,
                  model: options.model,
                  terminalInput: executorTerminalInput,
                  noninteractive: executorNoninteractive,
                },
                config,
                { reasoningEffort: 'high' }
              );

              executorPromises.push(
                runReviewIssues({
                  executor: claudeIssuesExecutor,
                  metadata,
                  useJj: usingJj,
                  customInstructions,
                  reviewId: review.id,
                  prUrl: prContext.prUrl,
                  source: 'claude-code',
                  planTitlePrefix: 'PR review issues (claude)',
                })
              );
            }

            if (hasCodex) {
              executorOrder.push('codex-cli');
              const codexExecutor = buildExecutorAndLog(
                'codex-cli',
                {
                  baseDir,
                  model: options.model,
                  terminalInput: executorTerminalInput,
                  noninteractive: executorNoninteractive,
                },
                config
              );

              executorPromises.push(
                runReviewIssues({
                  executor: codexExecutor,
                  metadata,
                  useJj: usingJj,
                  customInstructions,
                  reviewId: review.id,
                  prUrl: prContext.prUrl,
                  source: 'codex-cli',
                  planTitlePrefix: 'PR review issues (codex)',
                })
              );
            }

            const settled = await Promise.allSettled(executorPromises);

            let claudeGuideResult: ClaudeGuideResult | null = null;
            let claudeIssuesResult: ExecutorIssueResult | null = null;
            let codexResult: ExecutorIssueResult | null = null;

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

              if (executorName === 'claude-guide') {
                claudeGuideResult = result.value as ClaudeGuideResult;
              } else if (executorName === 'claude-code') {
                claudeIssuesResult = result.value as ExecutorIssueResult;
              } else if (executorName === 'codex-cli') {
                codexResult = result.value as ExecutorIssueResult;
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
            let reviewGuide = claudeGuideResult?.guideText ?? null;

            if (reviewGuide) {
              try {
                const cleanupResult = await cleanupUnifiedDiffBlocks({
                  config,
                  baseDir,
                  tempDir: tempPaths.dir,
                  guideText: reviewGuide,
                  reviewId: review.id,
                  prUrl: prContext.prUrl,
                  baseSha,
                  reviewedSha,
                });
                reviewGuide = cleanupResult.guideText;
                if (cleanupResult.repairedSectionCount > 0) {
                  log(
                    `Repaired ${cleanupResult.repairedSectionCount} malformed unified diff section${cleanupResult.repairedSectionCount === 1 ? '' : 's'} in the review guide.`
                  );
                }
              } catch (error) {
                warn(
                  `Failed to repair malformed unified diff sections in the review guide; storing the original guide and continuing: ${asErrorMessage(error)}`
                );
              }

              if (diffCatalog && diffCatalog.length > 0) {
                const expansionResult = expandReviewGuideDiffReferences({
                  guideText: reviewGuide,
                  diffCatalog,
                });
                reviewGuide = expansionResult.guideText;

                if (expansionResult.unresolvedRefs.length > 0) {
                  warn(
                    `Review guide referenced unknown diff ref(s): ${expansionResult.unresolvedRefs.join(', ')}`
                  );
                }
              }
            }

            if (claudeIssuesResult && codexResult) {
              try {
                finalIssues = await runCombinationStep({
                  config,
                  baseDir,
                  claudeIssues: claudeIssuesResult.issues,
                  codexIssues: codexResult.issues,
                  reviewId: review.id,
                  prUrl: prContext.prUrl,
                });
              } catch (error) {
                warn(
                  `Issue combination failed, falling back to merged raw issues: ${asErrorMessage(error)}`
                );
                finalIssues = [...claudeIssuesResult.issues, ...codexResult.issues];
              }
            } else if (claudeIssuesResult) {
              finalIssues = claudeIssuesResult.issues;
            } else if (codexResult) {
              finalIssues = codexResult.issues;
            }

            finalIssues = sortIssues(finalIssues);

            insertReviewIssues(db, {
              reviewId: review.id,
              issues: finalIssues.map(toInsertIssue),
            });

            updateReview(db, review.id, {
              status: 'complete',
              reviewGuide,
              reviewedSha,
              errorMessage: null,
            });

            const filesReviewed = prContext.prStatus.changed_files ?? 0;
            const formatterIssues = finalIssues.map(toFormatterIssue);
            const summary = generateReviewSummary(formatterIssues, filesReviewed);
            log(chalk.green(`Review complete for ${prContext.prUrl}`));
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
        } catch (error) {
          workflowError = error;
        } finally {
          if (lifecycleManager) {
            try {
              await lifecycleManager.shutdown();
            } catch (shutdownErr) {
              if (workflowError) {
                warn(
                  `Lifecycle shutdown failed for review command: ${asErrorMessage(shutdownErr)}`
                );
              } else {
                workflowError = shutdownErr;
              }
            }
          }
        }

        if (workflowError) {
          try {
            updateReview(db, review.id, {
              status: 'error',
              errorMessage: asErrorMessage(workflowError),
              reviewedSha,
            });
          } catch (updateErr) {
            warn(`Failed to mark review as error: ${asErrorMessage(updateErr)}`);
          }
          throw workflowError;
        }
      },
    });
  } finally {
    setDeferSignalExit(false);
    if (isShuttingDown()) {
      process.exit(getSignalExitCode() ?? 1);
    }
  }
}

export async function handleMaterializeCommand(
  prArg: string,
  _options: MaterializeCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const globalOpts = getRootOptions(command);
  const db = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });

  const canonicalPrUrl = await resolvePrUrl({
    db,
    prUrlOrNumber: prArg,
    cwd: process.cwd(),
  });
  const { repoRoot, projectId } = await resolveProjectContextForRepo(db, process.cwd());
  const review = getLatestReviewByPrUrl(db, canonicalPrUrl, { projectId, status: 'complete' });
  if (!review) {
    throw new Error(
      `No completed review found for ${canonicalPrUrl}. Run 'tim pr review-guide ${prArg}' first.`
    );
  }

  const issues = getReviewIssues(db, review.id);
  const reviewsDir = path.join(repoRoot, MATERIALIZED_REVIEWS_DIR);
  await fs.mkdir(reviewsDir, { recursive: true });
  await ensureReviewsDirExcluded(repoRoot);

  const guidePath = path.join(reviewsDir, REVIEW_GUIDE_FILENAME);
  const issuesPath = path.join(reviewsDir, 'review-issues.md');

  const guideContent = review.review_guide?.trim().length
    ? review.review_guide
    : '# Review Guide\n\nNo review guide was stored for this run.\n';
  await fs.writeFile(guidePath, guideContent, 'utf8');
  await fs.writeFile(issuesPath, formatReviewIssuesMarkdown(issues), 'utf8');

  log(`Materialized review artifacts:`);
  log(`  ${guidePath}`);
  log(`  ${issuesPath}`);
}
