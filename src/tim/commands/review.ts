// Command handler for 'tim review'
// Analyzes code changes against plan requirements using the reviewer agent

import chalk from 'chalk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import {
  fetchRemoteBranch,
  getCurrentBranchName,
  getCurrentCommitHash,
  getUsingJj,
} from '../../common/git.js';
import { promptCheckbox, promptSelect } from '../../common/input.js';
import { readPlanFile, resolvePlanByNumericId, writePlanFile, writePlanToDb } from '../plans.js';
import { log, warn, runWithLogger, sendStructured } from '../../logging.js';
import { getLoggerAdapter, type LoggerAdapter } from '../../logging/adapter.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import { formatStructuredMessage } from '../../logging/console_formatter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig, loadGlobalConfigForNotifications } from '../configLoader.js';
import { getDefaultConfig, type TimConfig } from '../configSchema.js';
import type { HeadlessPlanSummary } from '../headless.js';
import { buildExecutorAndLog } from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { getReviewerPrompt } from '../executors/claude_code/agent_prompts.js';
import { sendNotification } from '../notifications.js';
import type { PlanSchema } from '../planSchema.js';
import { gatherPlanContext } from '../utils/context_gathering.js';
import {
  createReviewResult,
  createFormatter,
  generateReviewSummary,
  type ReviewResult,
  type VerbosityLevel,
  type FormatterOptions,
  type ReviewIssue,
} from '../formatters/review_formatter.js';
import {
  saveReviewResult,
  createReviewsDirectory,
  createGitNote,
  type ReviewMetadata,
} from '../review_persistence.js';
import {
  storeLastReviewMetadata,
  generateDiffForReview,
  type IncrementalReviewMetadata,
  type DiffResult,
} from '../incremental_review.js';
import { access, constants } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import {
  prepareReviewExecutors,
  runReview,
  type ReviewExecutorName,
  type ReviewPromptBuilder,
  type StructuralReviewPromptBuilder,
} from '../review_runner.js';
import { createHeadlessAdapterForCommand, updateHeadlessSessionInfo } from '../headless.js';
import { toStructuredReviewIssues } from '../review_structured_message.js';
import { timestamp } from './agent/agent_helpers.js';
import { resolveOrchestratorInput } from '../utils/orchestrator_input.js';
import { loadAgentInstructionsFor } from '../executors/codex_cli/agent_helpers.js';
import type { PrReviewThreadDetail } from '../db/pr_status.js';
import {
  deleteBatchReviewCache,
  readBatchReviewCache,
  writeBatchReviewCache,
} from '../batch_review_cache.js';
import which from 'which';
import { getMaterializedPlanPath, materializePlan, withPlanAutoSync } from '../plan_materialize.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { isReopenableCompletedStatus } from '../plans/plan_state_utils.js';
import {
  buildStandaloneSimplificationReviewPrompt,
  type PlanReviewMetadata,
} from './review_pr_prompt.js';
import {
  resolveReviewTarget,
  type CurrentWorktreeReviewTarget,
  type BranchReviewTarget,
  type PlanReviewTarget,
  type PullRequestReviewTarget,
} from './review_target.js';
const FIX_EXECUTOR_COMMANDS = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
} as const satisfies Record<ReviewExecutorName, string>;
type FixAction = 'fix-claude' | 'fix-codex';
const FIX_ACTION_EXECUTOR_MAP: Record<FixAction, ReviewExecutorName> = {
  'fix-claude': 'claude-code',
  'fix-codex': 'codex-cli',
};
const FIX_ACTION_LABELS: Record<FixAction, string> = {
  'fix-claude': 'Fix now with Claude (apply fixes immediately)',
  'fix-codex': 'Fix now with Codex (apply fixes immediately)',
};
import { createCleanupPlan, type CleanupPlanOptions } from '../utils/cleanup_plan_creator.js';
import { filterActionableReviewIssues } from '../utils/review_issue_filters.js';

/**
 * Result returned from handleReviewCommand indicating what actions were taken
 */
export interface ReviewCommandResult {
  /** Number of tasks appended to the plan from review issues */
  tasksAppended: number;
  /** Number of issues saved to reviewIssues for later triage */
  issuesSaved?: number;
}

/**
 * Comprehensive error handling for saving review results
 */
async function saveReviewResultWithErrorHandling(
  filePath: string,
  content: string,
  logger: (message: string) => void
): Promise<void> {
  try {
    // Validate file path
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid file path provided');
    }

    // Check if path is too long (common file system limitation)
    if (filePath.length > 260) {
      throw new Error('File path too long (exceeds 260 characters)');
    }

    // Ensure directory exists with error handling
    const outputDir = dirname(filePath);
    try {
      await mkdir(outputDir, { recursive: true });
    } catch (mkdirErr) {
      if (mkdirErr instanceof Error && (mkdirErr as any).code === 'EEXIST') {
        // Directory already exists, check if it's actually a directory
        try {
          const stat = statSync(outputDir);
          if (!stat.isDirectory()) {
            throw new Error(`Output directory path exists but is not a directory: ${outputDir}`, {
              cause: mkdirErr,
            });
          }
        } catch {
          throw new Error(`Cannot access output directory: ${outputDir}`);
        }
      } else {
        throw new Error(`Failed to create output directory: ${(mkdirErr as Error).message}`, {
          cause: mkdirErr,
        });
      }
    }

    // Check directory permissions
    try {
      await access(outputDir, constants.W_OK);
    } catch {
      throw new Error(`No write permission for directory: ${outputDir}`);
    }

    // Check available disk space (basic check)
    if (content.length > 100 * 1024 * 1024) {
      // 100MB
      logger(chalk.yellow('Warning: Large review output detected, checking available space...'));
    }

    // Validate content size
    const contentSize = Buffer.byteLength(content, 'utf-8');
    if (contentSize > 50 * 1024 * 1024) {
      // 50MB limit
      throw new Error(
        `Review content too large (${Math.round(contentSize / 1024 / 1024)}MB). Consider reducing verbosity.`
      );
    }

    // Attempt to write file with retry mechanism
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
      try {
        await writeFile(filePath, content, 'utf-8');
        logger(chalk.green(`Review results saved to: ${filePath}`));
        return;
      } catch (writeErr) {
        retryCount++;
        const errorCode = (writeErr as any)?.code;

        if (errorCode === 'ENOSPC') {
          throw new Error('Insufficient disk space to save review results', { cause: writeErr });
        } else if (errorCode === 'EMFILE' || errorCode === 'ENFILE') {
          if (retryCount < maxRetries) {
            logger(
              chalk.yellow(
                `Temporary file handle exhaustion, retrying... (${retryCount}/${maxRetries})`
              )
            );
            await new Promise((resolve) => setTimeout(resolve, 100 * retryCount)); // Exponential backoff
            continue;
          }
          throw new Error('Too many open files - system resource exhaustion', { cause: writeErr });
        } else if (errorCode === 'EACCES') {
          throw new Error(`Permission denied when writing to: ${filePath}`, { cause: writeErr });
        } else if (errorCode === 'EROFS') {
          throw new Error('Cannot write to read-only file system', { cause: writeErr });
        } else if (retryCount < maxRetries) {
          logger(
            chalk.yellow(
              `Write failed, retrying... (${retryCount}/${maxRetries}): ${(writeErr as Error).message}`
            )
          );
          await new Promise((resolve) => setTimeout(resolve, 100 * retryCount));
          continue;
        } else {
          throw writeErr;
        }
      }
    }

    throw new Error(`Failed to write file after ${maxRetries} attempts`);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger(chalk.red(`Error saving review results: ${errorMessage}`));

    // Attempt fallback save to current directory
    try {
      const fallbackPath = `review-fallback-${Date.now()}.txt`;
      await writeFile(fallbackPath, content, 'utf-8');
      logger(chalk.yellow(`Fallback save successful: ${fallbackPath}`));
    } catch (fallbackErr) {
      logger(chalk.red(`Fallback save also failed: ${(fallbackErr as Error).message}`));
      logger(chalk.yellow('Review results could not be saved to file.'));
    }
  }
}

/** Logger for --print --verbose mode: outputs progress to stderr */
const reviewPrintVerboseLogger: LoggerAdapter = {
  log: (...args: any[]) => {
    console.error(...args);
  },
  warn: (...args: any[]) => {
    console.warn(...args);
  },
  error: (...args: any[]) => {
    console.error(...args);
  },
  writeStdout: (data: string) => {
    process.stderr.write(data);
  },
  writeStderr: (data: string) => {
    process.stderr.write(data);
  },
  debugLog: (...args: any[]) => {
    console.error(...args);
  },
  sendStructured: (message: StructuredMessage) => {
    const formatted = formatStructuredMessage(message);
    if (formatted.length > 0) {
      console.error(formatted);
    }
  },
};

/** Quiet logger for --print mode (no --verbose): suppresses all output */
const reviewPrintQuietLogger: LoggerAdapter = {
  log: () => {},
  warn: () => {},
  error: () => {},
  writeStdout: () => {},
  writeStderr: () => {},
  debugLog: () => {},
  sendStructured: () => {},
};

function debugStdinTrace(message: string): void {
  if (process.env.TIM_DEBUG_STDIN !== '1') {
    return;
  }

  const ts = new Date().toISOString();
  try {
    process.stderr.write(`[TIM_DEBUG_STDIN] ${ts} review ${message}\n`);
  } catch {
    // Best-effort debug logging only.
  }
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const result = await which(command, { nothrow: true });
  return Boolean(result);
}

async function getAvailableFixActions(): Promise<
  Array<{ action: FixAction; executor: ReviewExecutorName; label: string }>
> {
  const results = await Promise.all(
    (Object.entries(FIX_ACTION_EXECUTOR_MAP) as Array<[FixAction, ReviewExecutorName]>).map(
      async ([action, executor]) => {
        const command = FIX_EXECUTOR_COMMANDS[executor];
        const available = await isCommandAvailable(command);

        if (!available) {
          return null;
        }

        return { action, executor, label: FIX_ACTION_LABELS[action] };
      }
    )
  );

  return results.filter(
    (result): result is { action: FixAction; executor: ReviewExecutorName; label: string } =>
      result !== null
  );
}

type ReviewIssueAction = FixAction | 'cleanup' | 'append' | 'exit' | 'exit-manually-resolved';

type ReviewIssueWorkflowResult = {
  appendedTaskCount: number;
  actionCompleted: boolean;
  savedIssuesForLater: boolean;
  skipNotification: boolean;
};

export async function saveReviewIssuesToPlan(
  planId: number,
  issues: readonly ReviewIssue[],
  repoRoot: string
): Promise<void> {
  const { plan: latestPlan, planPath } = await resolveReviewPlanForWriteById(planId, repoRoot);
  latestPlan.reviewIssues = filterActionableReviewIssues(issues).map((issue) => ({ ...issue }));
  await writePlanFile(planPath, latestPlan, { cwdForIdentity: repoRoot });
}

export async function clearSavedReviewIssues(planId: number, repoRoot: string): Promise<void> {
  const { plan: latestPlan, planPath } = await resolveReviewPlanForWriteById(planId, repoRoot);
  if (!latestPlan.reviewIssues) {
    return;
  }

  delete latestPlan.reviewIssues;
  await writePlanFile(planPath, latestPlan, { cwdForIdentity: repoRoot });
}

export async function listSavedReviewIssues(
  planId: number,
  repoRoot: string
): Promise<NonNullable<PlanSchema['reviewIssues']>> {
  const { plan } = await resolveReviewPlanForWriteById(planId, repoRoot);
  return filterActionableReviewIssues(plan.reviewIssues ?? []).map((issue) => ({ ...issue }));
}

function reviewIssueKey(issue: ReviewIssue): string {
  return JSON.stringify(issue);
}

export async function resolveSavedReviewIssues(
  planId: number,
  issueIndexes: readonly number[] | 'all',
  repoRoot: string
): Promise<number> {
  const { plan: latestPlan, planPath } = await resolveReviewPlanForWriteById(planId, repoRoot);
  const savedIssues = latestPlan.reviewIssues ?? [];
  const actionableIssues = filterActionableReviewIssues(savedIssues);
  if (actionableIssues.length === 0) {
    return 0;
  }

  const issuesToResolve =
    issueIndexes === 'all'
      ? actionableIssues
      : issueIndexes.map((index) => {
          if (!Number.isInteger(index) || index < 1 || index > actionableIssues.length) {
            throw new Error(
              `Review issue index ${index} is out of range. Expected 1-${actionableIssues.length}.`
            );
          }
          return actionableIssues[index - 1]!;
        });

  const remainingIssues = [...savedIssues];
  let resolvedCount = 0;

  for (const issue of issuesToResolve) {
    const key = reviewIssueKey(issue);
    const index = remainingIssues.findIndex((candidate) => reviewIssueKey(candidate) === key);
    if (index >= 0) {
      remainingIssues.splice(index, 1);
      resolvedCount++;
    }
  }

  if (resolvedCount === 0) {
    return 0;
  }

  if (remainingIssues.length > 0) {
    latestPlan.reviewIssues = remainingIssues;
  } else {
    delete latestPlan.reviewIssues;
  }
  await writePlanFile(planPath, latestPlan, { cwdForIdentity: repoRoot });
  return resolvedCount;
}

function formatSavedReviewIssue(index: number, issue: ReviewIssue): string {
  const location = issue.file
    ? ` ${chalk.gray(issue.line ? `${issue.file}:${issue.line}` : issue.file)}`
    : '';
  const suggestion = issue.suggestion
    ? `\n    ${chalk.gray(`Suggestion: ${issue.suggestion}`)}`
    : '';
  return `${index}. ${chalk.bold(issue.severity)} ${chalk.gray(issue.category)}${location}\n   ${issue.content}${suggestion}`;
}

function parseReviewIssueIndexes(values: readonly string[] | undefined): number[] | 'all' {
  if (!values || values.length === 0) {
    throw new Error('Provide one or more review issue indexes, or --all.');
  }

  return values
    .flatMap((value) => value.split(','))
    .map((value) => {
      const trimmed = value.trim();
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`Review issue indexes must be positive integers, got: "${value}"`);
      }
      return parsed;
    });
}

export async function handleReviewIssuesListCommand(
  planId: number,
  options: { json?: boolean },
  command: any
): Promise<void> {
  const globalOpts = command.parent?.opts?.() ?? command.opts?.() ?? {};
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const issues = await listSavedReviewIssues(planId, repoRoot);

  if (options.json) {
    console.log(JSON.stringify(issues, null, 2));
    return;
  }

  if (issues.length === 0) {
    log(chalk.yellow(`No saved review issues found for plan ${planId}.`));
    return;
  }

  log(chalk.cyan(`Saved review issues for plan ${planId}:`));
  issues.forEach((issue, index) => log(formatSavedReviewIssue(index + 1, issue)));
}

export async function handleReviewIssuesResolveCommand(
  planId: number,
  issueIndexArgs: readonly string[] | undefined,
  options: { all?: boolean },
  command: any
): Promise<void> {
  const globalOpts = command.parent?.opts?.() ?? command.opts?.() ?? {};
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const indexes = options.all ? 'all' : parseReviewIssueIndexes(issueIndexArgs);
  const resolvedCount = await resolveSavedReviewIssues(planId, indexes, repoRoot);
  log(
    chalk.green(
      `Marked ${resolvedCount} saved review issue${resolvedCount === 1 ? '' : 's'} resolved.`
    )
  );
}

function summarizeReviewIssues(issues: readonly ReviewIssue[]): string {
  const actionableIssues = filterActionableReviewIssues(issues);
  const counts = {
    critical: 0,
    major: 0,
    minor: 0,
    info: 0,
  };

  for (const issue of actionableIssues) {
    counts[issue.severity]++;
  }

  return [
    `${actionableIssues.length} unresolved review issue${actionableIssues.length === 1 ? '' : 's'}`,
    `${counts.critical} critical`,
    `${counts.major} major`,
    `${counts.minor} minor`,
    `${counts.info} info`,
  ].join(', ');
}

function createReviewResultFromSavedIssues(
  planData: PlanSchema,
  diffResult: DiffResult,
  issues: readonly ReviewIssue[]
): ReviewResult {
  const actionableIssues = filterActionableReviewIssues(issues);
  const summary = generateReviewSummary(actionableIssues, diffResult.changedFiles.length);
  return {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Untitled Plan',
    reviewTimestamp: new Date().toISOString(),
    baseBranch: diffResult.baseBranch,
    changedFiles: diffResult.changedFiles,
    summary,
    issues: actionableIssues,
    rawOutput: JSON.stringify({ issues: actionableIssues }),
    recommendations: [],
    actionItems: [],
  };
}

type PlanlessReviewTarget =
  | CurrentWorktreeReviewTarget
  | BranchReviewTarget
  | PullRequestReviewTarget;

export interface ReviewCommandOptions {
  cwd?: string;
  current?: boolean;
  branch?: string;
  pr?: string;
  plan?: number;
  base?: string;
  workspace?: string;
  autoWorkspace?: boolean;
  nonInteractive?: boolean;
  model?: string;
  print?: boolean;
  verbose?: boolean;
  executor?: ReviewExecutorName | 'both' | string;
  serialBoth?: boolean;
  dryRun?: boolean;
  format?: string;
  verbosity?: VerbosityLevel;
  outputFile?: string;
  save?: boolean;
  noSave?: boolean;
  gitNote?: boolean;
  noColor?: boolean;
  showFiles?: boolean;
  noSuggestions?: boolean;
  incremental?: boolean;
  sinceLastReview?: boolean;
  issues?: boolean;
  saveIssues?: boolean;
  since?: string;
  autofix?: boolean;
  autofixAll?: boolean;
  noAutofix?: boolean;
  createCleanupPlan?: boolean;
  cleanupPriority?: CleanupPlanOptions['priority'];
  cleanupAssign?: string;
  taskIndex?: string | string[];
  taskTitle?: string | string[];
  instructions?: string;
  instructionsFile?: string;
  input?: string;
  inputFile?: string | string[];
  previousResponse?: string;
  focus?: string;
}

type ReviewLog = (...args: unknown[]) => void;

interface PlanlessExecutionContext {
  target: PlanlessReviewTarget;
  baseDir: string;
  repoRoot: string;
  baseBranch: string;
  targetId: string;
  targetTitle: string;
  diffResult: DiffResult;
}

const PLANLESS_REVIEW_REJECTED_OPTIONS: Array<{
  key: keyof ReviewCommandOptions;
  flag: string;
  rejectWhen: (options: ReviewCommandOptions) => boolean;
}> = [
  {
    key: 'saveIssues',
    flag: '--save-issues',
    rejectWhen: (options) => options.saveIssues === true,
  },
  { key: 'issues', flag: '--issues', rejectWhen: (options) => options.issues === true },
  { key: 'taskIndex', flag: '--task-index', rejectWhen: (options) => options.taskIndex != null },
  { key: 'taskTitle', flag: '--task-title', rejectWhen: (options) => options.taskTitle != null },
  {
    key: 'createCleanupPlan',
    flag: '--create-cleanup-plan',
    rejectWhen: (options) => options.createCleanupPlan === true,
  },
  {
    key: 'cleanupPriority',
    flag: '--cleanup-priority',
    rejectWhen: (options) =>
      options.cleanupPriority != null && options.cleanupPriority !== 'medium',
  },
  {
    key: 'cleanupAssign',
    flag: '--cleanup-assign',
    rejectWhen: (options) => options.cleanupAssign != null,
  },
  {
    key: 'incremental',
    flag: '--incremental',
    rejectWhen: (options) => options.incremental === true,
  },
  {
    key: 'sinceLastReview',
    flag: '--since-last-review',
    rejectWhen: (options) => options.sinceLastReview === true,
  },
];

function validatePlanlessReviewOptions(options: ReviewCommandOptions): void {
  for (const rejected of PLANLESS_REVIEW_REJECTED_OPTIONS) {
    if (rejected.rejectWhen(options)) {
      throw new Error(`${rejected.flag} requires a plan-backed review target.`);
    }
  }
}

function normalizeReviewExecutorName(value: string | undefined): ReviewExecutorName | null {
  return value === 'claude-code' || value === 'codex-cli' ? value : null;
}

function getPlanlessTargetLabel(target: PlanlessReviewTarget): string {
  switch (target.kind) {
    case 'current':
      return `current worktree${target.currentBranch ? ` (${target.currentBranch})` : ''}`;
    case 'branch':
      return `branch ${target.requestedBranch}`;
    case 'pr':
      return `PR #${target.prNumber}${target.title ? `: ${target.title}` : ''}`;
  }
}

function getPlanlessTargetId(target: PlanlessReviewTarget): string {
  switch (target.kind) {
    case 'current':
      return target.currentBranch ? `current:${target.currentBranch}` : 'current';
    case 'branch':
      return `branch:${target.requestedBranch}`;
    case 'pr':
      return `pr:${target.prNumber}`;
  }
}

function formatPlanlessTargetMetadata(target: PlanlessReviewTarget, baseDir: string): string[] {
  const lines = [
    `# Review Target`,
    ``,
    `**Target Kind:** ${target.kind}`,
    `**Repository Root:** ${target.repoRoot}`,
    `**Worktree Path:** ${baseDir}`,
    `**Base Branch:** ${target.baseBranch}`,
  ];

  switch (target.kind) {
    case 'current':
      lines.push(`**Current Branch:** ${target.currentBranch ?? '(detached or unknown)'}`);
      break;
    case 'branch':
      lines.push(`**Requested Branch:** ${target.requestedBranch}`);
      break;
    case 'pr':
      lines.push(
        `**PR URL:** ${target.canonicalPrUrl}`,
        `**PR Number:** #${target.prNumber}`,
        `**PR Title:** ${target.title ?? '(unknown)'}`,
        `**Repository:** ${target.owner}/${target.repo}`,
        `**Head Branch:** ${target.headBranch}`,
        `**Head SHA:** ${target.headSha}`
      );
      break;
  }

  return lines;
}

function buildPlanlessDiffGuidance(baseBranch: string): string[] {
  return [
    `# Diff Guidance`,
    ``,
    `Review only changes reachable from the selected target relative to the selected base.`,
    `For git repositories, use \`origin/${baseBranch}\` as the base ref, for example: \`git merge-base origin/${baseBranch} HEAD\` then \`git diff <merge-base>\`.`,
    `For jj repositories, use \`${baseBranch}@origin\` as the base bookmark, for example: \`jj diff --from 'heads(::@ & ::${baseBranch}@origin)'\`.`,
  ];
}

function buildAutoreviewReviewPromptGuidance(): string[] {
  if (process.env.TIM_AUTOREVIEW !== '1') {
    return [];
  }

  return [
    `# Check Assumptions`,
    ``,
    `Do not run tests, type checking, linting, formatting, or similar verification commands. Assume automated checks pass unless the provided context already shows otherwise.`,
    ``,
  ];
}

export function buildPlanlessReviewPrompt(
  target: PlanlessReviewTarget,
  diffResult: DiffResult,
  baseDir: string,
  includeDiff: boolean = false,
  useSubagents: boolean = false,
  customInstructions?: string,
  previousReviewResponse?: string
): string {
  const changedFilesSection = [
    `# Code Changes to Review`,
    ``,
    `**Diff Base:** ${diffResult.mergeBaseCommit ?? diffResult.baseBranch}`,
    `**Changed Files (${diffResult.changedFiles.length}):**`,
    ...diffResult.changedFiles.map((file) => `- ${file}`),
  ];

  if (includeDiff) {
    changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');
  }

  const contextContent = [
    ...formatPlanlessTargetMetadata(target, baseDir),
    ``,
    ...buildPlanlessDiffGuidance(target.baseBranch),
    ``,
    `# Planless Review Semantics`,
    ``,
    `This review is not associated with a tim plan. Findings are ephemeral for this run and must not be saved to plan tasks, plan files, cleanup plans, or plan-owned review issue queues.`,
    ``,
    ...changedFilesSection,
    ``,
    ...buildAutoreviewReviewPromptGuidance(),
    ...(previousReviewResponse?.trim()
      ? [
          `# Previous Fixer Response`,
          ``,
          `We just ran a round of fixing in response to a previous review. The final output from the fixing work is below. Please conduct a general review of the target, taking this fixer output into account:`,
          ``,
          previousReviewResponse.trim(),
          ``,
        ]
      : []),
    `# Review Instructions`,
    ``,
    `Please review the code changes above in the context of the selected target. Focus on:`,
    `1. **Correctness:** Look for bugs, logic errors, security issues, and performance problems`,
    `2. **Completeness:** Are the changed files coherent and complete for the target branch or PR?`,
    `3. **Error Handling:** Are edge cases and error conditions properly handled?`,
    `4. **Testing:** Are the changes adequately tested?`,
    `5. **Maintainability:** Do the changes fit existing project conventions?`,
    ``,
    `**Pre-existing Issues:** If you notice concerns in code that was not modified by these changes, they may still be worth noting. However, any pre-existing issues MUST be labeled as "info" severity. Only issues introduced or affected by the current changes should receive higher severity ratings.`,
    ``,
  ].join('\n');

  const reviewerPromptWithContext = getReviewerPrompt(
    contextContent,
    getPlanlessTargetId(target),
    customInstructions,
    undefined,
    useSubagents,
    false,
    undefined,
    false
  );

  return reviewerPromptWithContext.prompt;
}

function buildPlanlessAutofixPrompt(
  context: PlanlessExecutionContext,
  reviewResult: ReviewResult,
  selectedIssues?: ReviewIssue[] | null
): string {
  const prompt = [
    `# Autofix Request`,
    ``,
    ...formatPlanlessTargetMetadata(context.target, context.baseDir),
    ``,
    `This autofix run is not associated with a tim plan. Do not update plan files, plan tasks, cleanup plans, or plan-owned review issue queues.`,
    ``,
    `## Review Findings`,
    ``,
    `A code review has identified the following issues that need to be fixed:`,
    ``,
  ];

  const issuesToFix = filterActionableReviewIssues(selectedIssues || reviewResult.issues);
  if (issuesToFix.length > 0) {
    if (
      selectedIssues &&
      reviewResult.issues &&
      selectedIssues.length < reviewResult.issues.length
    ) {
      prompt.push(
        `Note: ${selectedIssues.length} of ${reviewResult.issues.length} issues selected for fixing.`,
        ``
      );
    }

    issuesToFix.forEach((issue, index) => {
      prompt.push(`### Issue ${index + 1}: ${issue.content || 'Unnamed Issue'}`);
      if (issue.file) {
        prompt.push(`**File:** ${issue.file}`);
      }
      if (issue.severity) {
        prompt.push(`**Severity:** ${issue.severity}`);
      }
      prompt.push(``);
    });
  } else {
    prompt.push(
      `**Review Output:**`,
      reviewResult.rawOutput || 'No specific issues identified.',
      ``
    );
  }

  prompt.push(
    `## Files to Fix`,
    ``,
    `**Diff Base:** ${context.diffResult.mergeBaseCommit ?? context.diffResult.baseBranch}`,
    `**Changed Files:**`,
    ...context.diffResult.changedFiles.map((file) => `- ${file}`),
    ``,
    `## Instructions`,
    ``,
    `Please fix the selected issues while preserving the target branch/PR intent.`,
    `After making changes, run relevant tests or checks where practical.`,
    `Do not commit, push, or resolve PR review threads unless explicitly requested by the user.`
  );

  return prompt.join('\n');
}

async function tryFetchBaseBranch(baseDir: string, baseBranch: string): Promise<void> {
  try {
    const fetched = await fetchRemoteBranch(baseDir, baseBranch);
    if (!fetched) {
      warn(chalk.yellow(`Warning: Could not fetch base branch '${baseBranch}' from origin.`));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(chalk.yellow(`Warning: Could not fetch base branch '${baseBranch}': ${message}`));
  }
}

interface ResolvedReviewPromptContext {
  customInstructions: string;
  previousReviewResponse?: string;
}

async function resolveReviewPromptContext(params: {
  options: ReviewCommandOptions;
  config: TimConfig;
  baseDir: string;
  reviewLog: ReviewLog;
}): Promise<ResolvedReviewPromptContext> {
  const { options, config, baseDir, reviewLog } = params;
  let customInstructions = '';
  let previousReviewResponse: string | undefined;

  if (options.instructions) {
    customInstructions = options.instructions;
    reviewLog(chalk.gray('Using inline custom instructions from CLI'));
  } else if (options.instructionsFile) {
    try {
      const instructionsPath = validateInstructionsFilePath(options.instructionsFile, baseDir);
      customInstructions = await readFile(instructionsPath, 'utf-8');
      reviewLog(chalk.gray(`Using custom instructions from CLI file: ${options.instructionsFile}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      reviewLog(
        chalk.yellow(
          `Warning: Could not read instructions file from CLI: ${options.instructionsFile}. ${errorMessage}`
        )
      );
    }
  } else if (config.review?.customInstructionsPath) {
    try {
      const instructionsPath = validateInstructionsFilePath(
        config.review.customInstructionsPath,
        baseDir
      );
      customInstructions = await readFile(instructionsPath, 'utf-8');
      reviewLog(
        chalk.gray(`Using custom instructions from config: ${config.review.customInstructionsPath}`)
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      reviewLog(
        chalk.yellow(
          `Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${errorMessage}`
        )
      );
    }
  } else {
    customInstructions = (await loadAgentInstructionsFor('reviewer', baseDir, config)) ?? '';
  }

  if (options.previousResponse) {
    try {
      previousReviewResponse = await readFile(options.previousResponse, 'utf-8');
      reviewLog(
        chalk.gray(`Using previous review response from file: ${options.previousResponse}`)
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      reviewLog(
        chalk.yellow(
          `Warning: Could not read previous review response file: ${options.previousResponse}. ${errorMessage}`
        )
      );
    }
  }

  const orchestratorInput = await resolveOrchestratorInput(options);
  if (orchestratorInput?.trim()) {
    reviewLog(chalk.gray('Using additional context from --input / --input-file'));
    customInstructions = customInstructions
      ? `${customInstructions}\n\n## Additional Context from Orchestrator\n\n${orchestratorInput}`
      : `## Additional Context from Orchestrator\n\n${orchestratorInput}`;
  }

  let focusAreas: string[] = [];
  if (options.focus) {
    const rawFocusAreas = options.focus
      .split(',')
      .map((area: string) => area.trim())
      .filter(Boolean);
    try {
      focusAreas = validateFocusAreas(rawFocusAreas);
      reviewLog(chalk.gray(`Using focus areas from CLI: ${focusAreas.join(', ')}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      reviewLog(chalk.yellow(`Warning: Invalid focus areas from CLI: ${errorMessage}`));
      focusAreas = [];
    }
  } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
    try {
      focusAreas = validateFocusAreas(config.review.focusAreas);
      reviewLog(chalk.gray(`Using focus areas from config: ${focusAreas.join(', ')}`));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      reviewLog(chalk.yellow(`Warning: Invalid focus areas from config: ${errorMessage}`));
      focusAreas = [];
    }
  }

  if (focusAreas.length > 0) {
    const focusInstruction = `Focus on: ${focusAreas.join(', ')}`;
    customInstructions = customInstructions
      ? `${customInstructions}\n\n${focusInstruction}`
      : focusInstruction;
  }

  return { customInstructions, previousReviewResponse };
}

interface ReviewFormatAndPersistResult {
  formattedOutput: string;
  hasIssues: boolean;
  currentCommitHash: string;
}

async function formatAndPersistReviewResult(params: {
  reviewResult: ReviewResult;
  rawOutput: string;
  baseDir: string;
  baseBranch: string;
  changedFiles: string[];
  targetId: string;
  targetTitle: string;
  historyId: string;
  options: ReviewCommandOptions;
  config: TimConfig;
  isPrintMode: boolean;
  reviewLog: ReviewLog;
  gitNoteSummary: (metadata: ReviewMetadata) => string;
}): Promise<ReviewFormatAndPersistResult> {
  const {
    reviewResult,
    rawOutput,
    baseDir,
    baseBranch,
    changedFiles,
    targetId,
    targetTitle,
    historyId,
    options,
    config,
    isPrintMode,
    reviewLog,
    gitNoteSummary,
  } = params;
  const outputFormat = isPrintMode
    ? 'json'
    : options.format || config.review?.outputFormat || 'terminal';
  const verbosity: VerbosityLevel = isPrintMode ? 'detailed' : options.verbosity || 'detailed';

  if (!['json', 'markdown', 'terminal'].includes(outputFormat)) {
    log(chalk.yellow(`Warning: Invalid format '${outputFormat}', using 'terminal'`));
  }

  const formatterOptions: FormatterOptions = {
    verbosity,
    showFiles: isPrintMode ? true : options.showFiles !== false && verbosity !== 'minimal',
    showSuggestions: isPrintMode ? true : !options.noSuggestions,
    colorEnabled: !options.noColor && outputFormat === 'terminal',
  };

  const formatter = createFormatter(
    outputFormat === 'json' || outputFormat === 'markdown' ? outputFormat : 'terminal'
  );
  const formattedOutput = formatter.format(reviewResult, formatterOptions);
  const hasIssues = detectIssuesInReview(reviewResult, rawOutput);
  const currentCommitHash = (await getCurrentCommitHash(baseDir, true)) ?? 'unknown';
  const shouldSave =
    options.save ||
    (config.review?.autoSave && !options.noSave) ||
    (!options.noSave && !options.outputFile && !config.review?.saveLocation);

  if (shouldSave) {
    try {
      const reviewsDir = await createReviewsDirectory(baseDir);
      if (currentCommitHash !== 'unknown') {
        const metadata: ReviewMetadata = {
          planId: targetId,
          planTitle: targetTitle,
          commitHash: currentCommitHash,
          timestamp: new Date(),
          reviewer: process.env.USER || process.env.USERNAME,
          baseBranch,
          changedFiles,
        };

        const savedPath = await saveReviewResult(reviewsDir, formattedOutput, metadata);
        reviewLog(chalk.cyan(`Review saved to: ${savedPath}`));

        if (options.gitNote) {
          const noteCreated = await createGitNote(
            baseDir,
            currentCommitHash,
            gitNoteSummary(metadata)
          );
          if (noteCreated) {
            reviewLog(chalk.cyan('Git note created with review summary'));
          } else {
            reviewLog(chalk.yellow('Warning: Could not create Git note'));
          }
        }
      } else {
        reviewLog(chalk.yellow('Warning: Could not save review - unable to determine commit hash'));
      }
    } catch (persistenceErr) {
      const persistenceErrorMessage =
        persistenceErr instanceof Error ? persistenceErr.message : String(persistenceErr);
      reviewLog(
        chalk.yellow(`Warning: Could not save review to history: ${persistenceErrorMessage}`)
      );
    }
  }

  if (options.outputFile) {
    await saveReviewResultWithErrorHandling(options.outputFile, formattedOutput, log);
  } else if (config.review?.saveLocation) {
    try {
      const saveDir = isAbsolute(config.review.saveLocation)
        ? config.review.saveLocation
        : join(baseDir, config.review.saveLocation);
      const safeHistoryId = historyId.replace(/[^a-zA-Z0-9._-]+/g, '-');
      const timestampValue = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `review-${safeHistoryId}-${timestampValue}${formatter.getFileExtension()}`;
      const savePath = join(saveDir, filename);
      await saveReviewResultWithErrorHandling(savePath, formattedOutput, log);
    } catch (saveErr) {
      const saveErrorMessage = saveErr instanceof Error ? saveErr.message : String(saveErr);
      reviewLog(chalk.yellow(`Warning: Could not prepare save location: ${saveErrorMessage}`));
    }
  }

  return { formattedOutput, hasIssues, currentCommitHash };
}

async function buildPlanlessExecutionContext(
  target: PlanlessReviewTarget,
  options: ReviewCommandOptions,
  config: TimConfig
): Promise<PlanlessExecutionContext> {
  let baseDir: string;
  if (target.kind === 'current') {
    baseDir = target.worktreePath;
    await tryFetchBaseBranch(baseDir, target.baseBranch);
  } else {
    const workspaceResult = await setupWorkspace(
      {
        workspace: options.workspace,
        autoWorkspace: options.autoWorkspace !== false,
        nonInteractive: options.nonInteractive,
        checkoutBranch: target.kind === 'branch' ? target.requestedBranch : target.headBranch,
        branchName: target.kind === 'branch' ? target.requestedBranch : target.headBranch,
        createBranch: false,
        allowPrimaryWorkspaceWhenLocked: false,
        requireWorkspace: true,
      },
      target.repoRoot,
      undefined,
      config,
      'tim review'
    );
    baseDir = workspaceResult.baseDir;
    await tryFetchBaseBranch(baseDir, target.baseBranch);
  }

  const diffResult = await generateDiffForReview(baseDir, {
    baseBranch: target.baseBranch,
    sinceCommit: options.since,
  });
  return {
    target,
    baseDir,
    repoRoot: target.repoRoot,
    baseBranch: target.baseBranch,
    targetId: getPlanlessTargetId(target),
    targetTitle: getPlanlessTargetLabel(target),
    diffResult,
  };
}

async function runPlanlessAutofix(params: {
  context: PlanlessExecutionContext;
  reviewResult: ReviewResult;
  reviewExecutorName: ReviewExecutorName | null;
  options: ReviewCommandOptions;
  isInteractiveEnv: boolean;
  isPrintMode: boolean;
  sharedExecutorOptions: ExecutorCommonOptions;
  config: TimConfig;
  notifyReviewInput: (message: string) => Promise<void>;
}): Promise<boolean> {
  const {
    context,
    reviewResult,
    reviewExecutorName,
    options,
    isInteractiveEnv,
    isPrintMode,
    sharedExecutorOptions,
    config,
    notifyReviewInput,
  } = params;
  const actionableIssues = filterActionableReviewIssues(reviewResult.issues);
  const noAutofixRequested = options.noAutofix === true || options.autofix === false;
  if (isPrintMode || noAutofixRequested) {
    return false;
  }

  let shouldAutofix = false;
  let selectedIssues: ReviewIssue[] | null = null;
  if (options.autofixAll) {
    selectedIssues = actionableIssues;
    shouldAutofix = actionableIssues.length > 0;
  } else if (options.autofix) {
    if (actionableIssues.length > 0) {
      selectedIssues = isInteractiveEnv
        ? await selectIssuesToFix(actionableIssues, 'fix', () =>
            notifyReviewInput('Review needs input: select issues for autofix.')
          )
        : actionableIssues;
      shouldAutofix = selectedIssues.length > 0;
    }
  }

  if (!shouldAutofix) {
    return false;
  }

  const executorName = reviewExecutorName ?? options.executor ?? config.defaultExecutor;
  if (!executorName) {
    throw new Error('No executor available for autofix.');
  }

  sendStructured({
    type: 'workflow_progress',
    timestamp: timestamp(),
    phase: 'autofix',
    message: 'Executing autofix',
  });

  const autofixExecutor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);
  await autofixExecutor.execute(buildPlanlessAutofixPrompt(context, reviewResult, selectedIssues), {
    planId: context.targetId,
    planTitle: `${context.targetTitle} - Autofix`,
    planFilePath: '',
    captureOutput: 'none',
    executionMode: 'normal',
  });
  log(chalk.green('Autofix execution completed successfully!'));
  return true;
}

async function promptForReviewIssueAction(
  notifyReviewInput: (message: string) => Promise<void>
): Promise<ReviewIssueAction> {
  const availableFixActions = await getAvailableFixActions();

  await notifyReviewInput('Review needs input: choose how to proceed with issues.');
  sendStructured({
    type: 'input_required',
    timestamp: timestamp(),
    prompt: 'Choose how to proceed with review issues',
  });
  debugStdinTrace('about to open issue-action prompt');

  try {
    const action = await promptSelect<ReviewIssueAction>({
      message: 'Issues were found during review. What would you like to do?',
      choices: [
        { name: 'Append issues to the current plan as tasks', value: 'append' },
        ...availableFixActions.map((option) => ({
          name: option.label,
          value: option.action,
        })),
        { name: 'Create a cleanup plan (for later execution)', value: 'cleanup' },
        { name: 'Exit (manually resolved)', value: 'exit-manually-resolved' },
        { name: 'Exit (save issues for later)', value: 'exit' },
      ],
      default: 'append',
    });
    debugStdinTrace(`issue-action prompt resolved with action=${action}`);
    return action;
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    debugStdinTrace(`issue-action prompt threw name=${name} message=${message}`);
    throw err;
  }
}

async function handleReviewIssueActions(params: {
  issues: ReviewIssue[];
  reviewResult: ReviewResult;
  reviewExecutorName: ReviewExecutorName | null;
  planData: PlanSchema;
  scopedPlanData: PlanSchema;
  diffResult: DiffResult;
  planRefForWrite: number;
  planFileForWrite: string;
  executionPlanFile: string;
  options: ReviewCommandOptions;
  isInteractiveEnv: boolean;
  isPrintMode: boolean;
  taskScopeNote?: string;
  isScoped: boolean;
  sharedExecutorOptions: ExecutorCommonOptions;
  config: TimConfig;
  globalOpts: any;
  notifyReviewInput: (message: string) => Promise<void>;
}): Promise<ReviewIssueWorkflowResult> {
  const {
    issues,
    reviewResult,
    reviewExecutorName,
    planData,
    scopedPlanData,
    diffResult,
    planRefForWrite,
    planFileForWrite,
    executionPlanFile,
    options,
    isInteractiveEnv,
    isPrintMode,
    taskScopeNote,
    isScoped,
    sharedExecutorOptions,
    config,
    globalOpts,
    notifyReviewInput,
  } = params;
  const actionableIssues = filterActionableReviewIssues(issues);

  let shouldAutofix = false;
  let shouldCreateCleanupPlan = false;
  let shouldAppendTasksToPlan = false;
  let selectedIssues: ReviewIssue[] | null = null;
  let issuesToSaveForLater: ReviewIssue[] | null = null;
  let autofixExecutorName: ReviewExecutorName | null = reviewExecutorName;
  let appendedTaskCount = 0;
  let actionCompleted = false;
  let skipNotification = false;
  const noAutofixRequested = options.noAutofix === true || options.autofix === false;

  if (!noAutofixRequested && (options.autofix || options.autofixAll)) {
    shouldAutofix = true;
    if (options.autofixAll) {
      selectedIssues = actionableIssues;
      shouldAutofix = actionableIssues.length > 0;
      if (!shouldAutofix) {
        log(chalk.yellow('No actionable review issues available for autofix.'));
      }
    } else if (actionableIssues.length > 0) {
      if (isInteractiveEnv) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'fix', () =>
          notifyReviewInput('Review needs input: select issues for autofix.')
        );
      } else {
        selectedIssues = actionableIssues;
      }
      shouldAutofix = selectedIssues.length > 0;
      if (!shouldAutofix) {
        log(chalk.yellow('No issues selected for autofix.'));
      }
    } else {
      shouldAutofix = false;
      log(chalk.yellow('No actionable review issues available for autofix.'));
    }
  } else if (options.createCleanupPlan) {
    shouldCreateCleanupPlan = true;
    if (actionableIssues.length > 0) {
      if (isInteractiveEnv) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'include in cleanup plan', () =>
          notifyReviewInput('Review needs input: select issues for the cleanup plan.')
        );
      } else {
        selectedIssues = actionableIssues;
      }
      shouldCreateCleanupPlan = selectedIssues.length > 0;
      if (!shouldCreateCleanupPlan) {
        log(chalk.yellow('No issues selected for cleanup plan.'));
      }
    } else {
      shouldCreateCleanupPlan = false;
      log(chalk.yellow('No actionable review issues available for cleanup plan.'));
    }
  } else if (!noAutofixRequested && isInteractiveEnv) {
    const action = await promptForReviewIssueAction(notifyReviewInput);

    if (action === 'fix-claude' || action === 'fix-codex') {
      shouldAutofix = true;
      autofixExecutorName = FIX_ACTION_EXECUTOR_MAP[action];
      if (actionableIssues.length > 0) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'fix', () =>
          notifyReviewInput('Review needs input: select issues for autofix.')
        );
        shouldAutofix = selectedIssues.length > 0;
        if (!shouldAutofix) {
          log(chalk.yellow('No issues selected for autofix.'));
        }
      } else {
        shouldAutofix = false;
        log(chalk.yellow('No actionable review issues available for autofix.'));
      }
    } else if (action === 'cleanup') {
      skipNotification = true;
      shouldCreateCleanupPlan = true;
      if (actionableIssues.length > 0) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'include in cleanup plan', () =>
          notifyReviewInput('Review needs input: select issues for the cleanup plan.')
        );
        shouldCreateCleanupPlan = selectedIssues.length > 0;
        if (!shouldCreateCleanupPlan) {
          log(chalk.yellow('No issues selected for cleanup plan.'));
        }
      } else {
        shouldCreateCleanupPlan = false;
        log(chalk.yellow('No actionable review issues available for cleanup plan.'));
      }
    } else if (action === 'append') {
      skipNotification = true;
      shouldAppendTasksToPlan = true;
      if (actionableIssues.length > 0) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'append as plan tasks', () =>
          notifyReviewInput('Review needs input: select issues to append as tasks.')
        );
        shouldAppendTasksToPlan = selectedIssues.length > 0;
        if (!shouldAppendTasksToPlan) {
          log(chalk.yellow('No issues selected to append as tasks.'));
        }
      }
    } else if (action === 'exit-manually-resolved') {
      actionCompleted = true;
    } else if (action === 'exit') {
      skipNotification = true;
      if (actionableIssues.length > 0) {
        selectedIssues = await selectIssuesToFix(actionableIssues, 'save for later', () =>
          notifyReviewInput('Review needs input: select issues to save for later.')
        );
        issuesToSaveForLater = selectedIssues;
      } else {
        issuesToSaveForLater = [];
      }

      if (issuesToSaveForLater.length > 0) {
        actionCompleted = true;
      } else {
        log(chalk.yellow('No issues selected to save for later.'));
      }
    }
  }

  if (shouldAppendTasksToPlan && !isPrintMode) {
    const issuesToAppend =
      selectedIssues && selectedIssues.length > 0 ? selectedIssues : actionableIssues;

    if (issuesToAppend.length === 0) {
      log(chalk.yellow('No review issues available to append as tasks.'));
    } else {
      try {
        const originalStatus = planData.status;
        const appendedCount = await appendIssuesToPlanTasks(
          planRefForWrite,
          issuesToAppend,
          sharedExecutorOptions.baseDir
        );
        appendedTaskCount = appendedCount;
        actionCompleted = true;

        if (appendedCount > 0) {
          await reopenParentForAppendedReviewTasks(
            { parent: planData.parent, status: originalStatus },
            sharedExecutorOptions.baseDir
          );
          const plural = appendedCount === 1 ? '' : 's';
          log(
            chalk.green(
              `✓ Added ${appendedCount} review issue${plural} as task${plural} to plan ${planData.id}.`
            )
          );
        } else {
          log(chalk.gray('No new tasks were added (likely due to duplicate titles).'));
        }
      } catch (appendErr) {
        const appendMessage = appendErr instanceof Error ? appendErr.message : String(appendErr);
        log(chalk.red(`Error appending review issues to plan tasks: ${appendMessage}`));
      }
    }
  }

  if (shouldCreateCleanupPlan && planData.id && !isPrintMode) {
    sendStructured({
      type: 'workflow_progress',
      timestamp: timestamp(),
      phase: 'cleanup',
      message: 'Creating cleanup plan',
    });

    const cleanupScopeNote =
      isScoped && taskScopeNote ? taskScopeNote.replace('review', 'cleanup plan') : undefined;
    const cleanupOptions: CleanupPlanOptions = {
      priority: options.cleanupPriority || 'medium',
      assign: options.cleanupAssign,
      scopeNote: cleanupScopeNote,
      scopedPlan: isScoped ? scopedPlanData : undefined,
    };

    const cleanupResult = await createCleanupPlan(
      planData.id,
      selectedIssues || actionableIssues,
      cleanupOptions,
      globalOpts
    );

    log(
      chalk.green(
        `✓ Created cleanup plan: ${cleanupResult.filePath} for ID ${chalk.green(cleanupResult.planId)}`
      )
    );
    log(
      chalk.gray(
        `  Next step: Use "tim generate ${cleanupResult.planId}" or "tim run ${cleanupResult.planId}"`
      )
    );
    actionCompleted = true;
  }

  const performAutofix = shouldAutofix && !noAutofixRequested;

  if (performAutofix && !isPrintMode) {
    sendStructured({
      type: 'workflow_progress',
      timestamp: timestamp(),
      phase: 'autofix',
      message: 'Executing autofix',
    });

    const autofixPrompt = buildAutofixPrompt(
      scopedPlanData,
      reviewResult,
      diffResult,
      selectedIssues
    );
    const executorName = autofixExecutorName ?? reviewExecutorName;
    if (!executorName) {
      throw new Error('No executor available for autofix.');
    }

    const autofixExecutor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);
    await autofixExecutor.execute(autofixPrompt, {
      planId: planData.id?.toString() ?? 'unknown',
      planTitle: `${planData.title ?? 'Untitled Plan'} - Autofix`,
      planFilePath: executionPlanFile,
      captureOutput: 'none',
      executionMode: 'normal',
    });
    const materializedPlanPath =
      planData.id != null
        ? getMaterializedPlanPath(sharedExecutorOptions.baseDir, planData.id)
        : null;
    const shouldSyncEditedPlan =
      executionPlanFile !== planFileForWrite || executionPlanFile === materializedPlanPath;
    if (shouldSyncEditedPlan) {
      const updatedPlan = await readPlanFile(executionPlanFile);
      await writePlanToDb(updatedPlan, {
        cwdForIdentity: sharedExecutorOptions.baseDir,
        config,
      });
    }

    log(chalk.green('Autofix execution completed successfully!'));
    actionCompleted = true;
  }

  if (issuesToSaveForLater && !isPrintMode) {
    await saveReviewIssuesToPlan(
      planRefForWrite,
      issuesToSaveForLater,
      sharedExecutorOptions.baseDir
    );
    actionCompleted = true;
    log(
      chalk.green(
        `Saved ${issuesToSaveForLater.length} review issue${issuesToSaveForLater.length === 1 ? '' : 's'} for later.`
      )
    );
  }

  if (actionCompleted && issuesToSaveForLater == null) {
    if (selectedIssues && selectedIssues.length > 0) {
      const resolvedCount = await resolveSavedReviewIssues(
        planRefForWrite,
        selectedIssues.map((issue) => actionableIssues.indexOf(issue) + 1),
        sharedExecutorOptions.baseDir
      );
      log(
        chalk.green(
          `Marked ${resolvedCount} saved review issue${resolvedCount === 1 ? '' : 's'} resolved.`
        )
      );
    } else {
      await clearSavedReviewIssues(planRefForWrite, sharedExecutorOptions.baseDir);
    }
  }

  return {
    appendedTaskCount,
    actionCompleted,
    savedIssuesForLater: issuesToSaveForLater != null,
    skipNotification,
  };
}

export async function handleReviewCommand(
  planId: number | undefined,
  options: ReviewCommandOptions,
  command: any
): Promise<ReviewCommandResult> {
  const isPrintMode = options.print === true;
  const tunnelActive = isTunnelActive();
  const withReviewLogger = <T>(cb: () => Promise<T>): Promise<T> => {
    if (isPrintMode && !tunnelActive && !headlessAdapter) {
      // In print mode without tunnel or headless: suppress or redirect output to avoid
      // polluting stdout (which the executor captures). When the tunnel is
      // active the adapter installed at tim.ts level already forwards output
      // to the parent process, so we let it handle everything. When headless
      // is active it already wraps the print-mode logger, so no replacement needed.
      const logger = options.verbose ? reviewPrintVerboseLogger : reviewPrintQuietLogger;
      return runWithLogger(logger, cb);
    } else {
      return cb();
    }
  };

  const isInteractiveEnv = !isTunnelActive() && !isPrintMode && process.env.TIM_INTERACTIVE !== '0';
  const globalOpts = command.parent.opts();
  let config = getDefaultConfig();
  let completionMessage = '';
  let completionStatus: 'success' | 'error' = 'success';
  let completionErrorMessage: string | undefined;
  let notifyPlan: PlanSchema | undefined;
  let notifyPlanFile: string | undefined;
  let notifyCwd = '';
  let skipNotification = false;
  let appendedTaskCount = 0;
  let issuesSavedCount = 0;
  let headlessAdapter: HeadlessAdapter | undefined;
  const notifyReviewDone = async (
    message: string,
    status: 'success' | 'error',
    errorMessage?: string
  ): Promise<void> => {
    try {
      await sendNotification(config, {
        command: 'review',
        event: 'review_done',
        status,
        message,
        errorMessage,
        cwd: notifyCwd || process.cwd(),
        plan: notifyPlan,
        planFile: notifyPlanFile,
      });
    } catch (err) {
      warn(`Failed to send notification: ${err as Error}`);
    }
  };

  // Helper for conditional logging in print mode
  const reviewLog = (...args: any[]) => {
    if (!isPrintMode) {
      log(...args);
    } else if (options.verbose) {
      console.error(...args);
    }
    // else: suppress in quiet print mode
  };

  try {
    try {
      config = await loadEffectiveConfig(globalOpts.config);
    } catch (err) {
      config = await loadGlobalConfigForNotifications(globalOpts.config);
      throw err;
    }

    const hasExplicitPlanlessSelector =
      options.current === true ||
      (typeof options.branch === 'string' && options.branch.trim().length > 0) ||
      (typeof options.pr === 'string' && options.pr.trim().length > 0);
    if (hasExplicitPlanlessSelector) {
      validatePlanlessReviewOptions(options);
    }

    const reviewTarget = await resolveReviewTarget({
      planId,
      options,
      configPath: globalOpts.config,
    });
    if (reviewTarget.kind !== 'plan' && !hasExplicitPlanlessSelector) {
      validatePlanlessReviewOptions(options);
    }

    const planTarget: PlanReviewTarget | undefined =
      reviewTarget.kind === 'plan' ? reviewTarget : undefined;
    if (planTarget?.autoSelected?.selectionReason === 'branch-name') {
      const resolvedPlan = planTarget.plan;
      if (resolvedPlan) {
        reviewLog(chalk.cyan(`Auto-selected plan: ${resolvedPlan.id} - ${resolvedPlan.title}`));
      }
      if (planTarget.autoSelected.displayPath) {
        reviewLog(chalk.gray(`Plan file: ${planTarget.autoSelected.displayPath}`));
      }
    }

    const reviewPlanId = planTarget?.planId;
    let initialResolvedPlan: Awaited<ReturnType<typeof resolveReviewPlanForWriteById>> | undefined;
    let resolvedPlanFilePath: string | undefined;
    if (planTarget?.autoSelected?.selectionReason === 'branch-name') {
      const resolvedPlan = planTarget.plan;
      if (!resolvedPlan) {
        throw new Error('Auto-selected review target is missing resolved plan metadata.');
      }
      const repoRoot = planTarget.repoRoot;
      const existingPath = await materializedPlanFileExists(repoRoot, resolvedPlan.id);
      let materializedPath: string;
      if (existingPath) {
        // Validate the existing file belongs to this plan before reusing it
        const filePlan = await readPlanFile(existingPath);
        if (filePlan.id !== resolvedPlan.id) {
          // File has wrong ID — re-materialize from DB
          materializedPath = await materializePlan(resolvedPlan.id, repoRoot);
        } else {
          materializedPath = existingPath;
        }
      } else {
        materializedPath = await materializePlan(resolvedPlan.id, repoRoot);
      }
      initialResolvedPlan = {
        plan: structuredClone(resolvedPlan),
        planPath: materializedPath,
        repoRoot,
      };
      resolvedPlanFilePath = initialResolvedPlan.planPath ?? materializedPath;
    }
    notifyPlanFile = resolvedPlanFilePath;
    // We intentionally manage headless setup/teardown manually here instead of
    // runWithHeadlessAdapterIfEnabled because review needs the adapter lifecycle to span
    // setup/flow/finalization and guarantee destroy() runs before completion notifications.
    // In print mode the headless adapter wraps the print-specific logger so output is
    // both redirected away from stdout AND mirrored to the WebSocket.
    if (!tunnelActive) {
      let planSummary: HeadlessPlanSummary | undefined;
      if (planTarget) {
        try {
          const planSummaryRepoRoot =
            initialResolvedPlan?.repoRoot ??
            (await resolveRepoRoot(globalOpts.config, options.cwd));
          const { plan } =
            initialResolvedPlan ??
            (await resolveReviewPlanForWriteById(planTarget.planId, planSummaryRepoRoot));
          planSummary = {
            id: plan.id,
            uuid: plan.uuid,
            title: plan.title,
          };
        } catch {
          // No-op: missing plan metadata should not block review execution.
        }
      }

      const currentAdapter = getLoggerAdapter();

      if (!(currentAdapter instanceof HeadlessAdapter)) {
        if (isPrintMode) {
          // In print mode, install the print-specific logger first so the headless
          // adapter wraps it — output goes to stderr (or is suppressed) while also
          // being mirrored to the WebSocket.
          const printLogger = options.verbose ? reviewPrintVerboseLogger : reviewPrintQuietLogger;
          headlessAdapter = await runWithLogger(printLogger, () =>
            createHeadlessAdapterForCommand({
              command: 'review',
              interactive: false,
              plan: planSummary,
            })
          );
        } else {
          headlessAdapter = await createHeadlessAdapterForCommand({
            command: 'review',
            interactive: false,
            plan: planSummary,
          });
        }
      }
    }

    const executeReviewFlow = async (): Promise<void> => {
      if (reviewTarget.kind !== 'plan') {
        const planlessContext = await buildPlanlessExecutionContext(reviewTarget, options, config);
        notifyCwd = planlessContext.baseDir;
        updateHeadlessSessionInfo({ workspacePath: planlessContext.baseDir });
        if (reviewTarget.kind === 'pr') {
          updateHeadlessSessionInfo({
            linkedPrUrl: reviewTarget.canonicalPrUrl,
            linkedPrNumber: reviewTarget.prNumber,
            linkedPrTitle: reviewTarget.title,
          });
        }

        if (!planlessContext.diffResult.hasChanges) {
          reviewLog(
            chalk.yellow(
              `No changes detected compared to ${planlessContext.baseBranch}. Nothing to review.`
            )
          );
          skipNotification = true;
          return;
        }

        reviewLog(chalk.green(`Reviewing target: ${planlessContext.targetTitle}`));
        reviewLog(chalk.gray(`Base branch: ${planlessContext.baseBranch}`));

        const { customInstructions, previousReviewResponse } = await resolveReviewPromptContext({
          options,
          config,
          baseDir: planlessContext.baseDir,
          reviewLog,
        });

        const sharedExecutorOptions: ExecutorCommonOptions = {
          baseDir: planlessContext.baseDir,
          model: options.model,
          noninteractive: isPrintMode,
          timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
            config,
            planlessContext.baseDir,
            null,
            planlessContext.repoRoot
          ),
        };

        const notifyReviewInput = async (message: string): Promise<void> => {
          if (!isInteractiveEnv) {
            return;
          }
          await sendNotification(config, {
            command: 'review',
            event: 'review_input',
            status: 'input',
            message,
            cwd: planlessContext.baseDir,
          });
        };

        const buildPrompt: ReviewPromptBuilder = ({ includeDiff, useSubagents }) =>
          buildPlanlessReviewPrompt(
            reviewTarget,
            planlessContext.diffResult,
            planlessContext.baseDir,
            includeDiff,
            useSubagents,
            customInstructions,
            previousReviewResponse
          );

        if (options.dryRun) {
          const prepared = await prepareReviewExecutors({
            executorSelection: options.executor,
            config,
            sharedExecutorOptions,
            buildPrompt,
          });

          log(chalk.cyan('\n## Dry Run - Generated Review Prompt\n'));
          for (const preparedExecutor of prepared) {
            if (prepared.length > 1) {
              log(chalk.cyan(`\n### Executor: ${preparedExecutor.name}\n`));
            }
            log(preparedExecutor.prompt);
          }
          log('\n--dry-run mode: Would execute the above prompt');
          skipNotification = true;
          return;
        }

        sendStructured({
          type: 'review_start',
          timestamp: timestamp(),
          executor: options.executor || config.defaultExecutor,
        });

        try {
          const planInfo = {
            planId: planlessContext.targetId,
            planTitle: planlessContext.targetTitle,
            planFilePath: '',
            baseBranch: planlessContext.baseBranch,
            changedFiles: planlessContext.diffResult.changedFiles,
            isTaskScoped: false,
          };

          const runReviewCall = () =>
            runReview({
              executorSelection: options.executor,
              serialBoth: options.serialBoth,
              config,
              sharedExecutorOptions,
              buildPrompt,
              planInfo,
            });

          const reviewOutput = isPrintMode
            ? await withReviewLogger(runReviewCall)
            : await runReviewCall();

          if (reviewOutput.warnings.length > 0) {
            for (const warning of reviewOutput.warnings) {
              warn(chalk.yellow(warning));
            }
          }

          const reviewResult = reviewOutput.reviewResult;
          const rawOutput = reviewOutput.rawOutput;
          const reviewExecutorName = reviewOutput.usedExecutors[0];
          if (!reviewExecutorName) {
            throw new Error('Review completed without a usable executor result.');
          }

          const { formattedOutput, hasIssues } = await formatAndPersistReviewResult({
            reviewResult,
            rawOutput,
            baseDir: planlessContext.baseDir,
            baseBranch: planlessContext.baseBranch,
            changedFiles: planlessContext.diffResult.changedFiles,
            targetId: planlessContext.targetId,
            targetTitle: planlessContext.targetTitle,
            historyId: planlessContext.targetId,
            options,
            config,
            isPrintMode,
            reviewLog,
            gitNoteSummary: (metadata) =>
              `Code review completed for ${metadata.planId}: ${metadata.planTitle}`,
          });

          sendStructured({
            type: 'review_result',
            timestamp: timestamp(),
            verdict: hasIssues ? 'NEEDS_FIXES' : 'ACCEPTABLE',
            fixInstructions: hasIssues ? reviewResult.actionItems.join('\n') : undefined,
            issues: toStructuredReviewIssues(reviewResult.issues),
            recommendations: reviewResult.recommendations,
            actionItems: reviewResult.actionItems,
          });

          if (tunnelActive || isPrintMode) {
            console.log(formattedOutput);
            await Bun.sleep(500);
          }

          if (hasIssues && !isPrintMode) {
            const didAutofix = await runPlanlessAutofix({
              context: planlessContext,
              reviewResult,
              reviewExecutorName,
              options,
              isInteractiveEnv,
              isPrintMode,
              sharedExecutorOptions,
              config,
              notifyReviewInput,
            });
            if (!didAutofix) {
              reviewLog(
                chalk.yellow(
                  'Review issues were found. Planless review findings are ephemeral and were not saved to a plan.'
                )
              );
            }
          }

          reviewLog(chalk.green('\nCode review completed successfully!'));
          completionMessage = 'Review completed successfully.';
          completionStatus = 'success';
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          const contextualError = `Review execution failed: ${errorMessage}`;
          if (err instanceof Error && err.stack) {
            log(chalk.gray(`Stack trace: ${err.stack}`));
          }
          completionMessage = `Review failed: ${errorMessage}`;
          completionStatus = 'error';
          completionErrorMessage = errorMessage;
          throw new Error(contextualError, { cause: err });
        }
        return;
      }

      if (!planTarget || reviewPlanId === undefined) {
        throw new Error('Plan-backed review target is missing plan metadata.');
      }

      const originalRepoRoot = await resolveRepoRoot(globalOpts.config, options.cwd);
      const workspaceMode = options.workspace !== undefined || options.autoWorkspace === true;
      if (workspaceMode) {
        const resolvedPlanForWorkspace =
          initialResolvedPlan ??
          (await resolveReviewPlanForWriteById(reviewPlanId, originalRepoRoot));
        const workspaceResult = await setupWorkspace(
          {
            workspace: options.workspace,
            autoWorkspace: options.autoWorkspace,
            nonInteractive: options.nonInteractive,
            planId: resolvedPlanForWorkspace.plan.id,
            planUuid: resolvedPlanForWorkspace.plan.uuid,
            allowPrimaryWorkspaceWhenLocked: true,
          },
          originalRepoRoot,
          resolvedPlanForWorkspace.planPath ?? undefined,
          config,
          'tim review'
        );

        options.cwd = workspaceResult.baseDir;
        resolvedPlanFilePath = workspaceResult.planFile;
        notifyPlanFile = workspaceResult.planFile;
        updateHeadlessSessionInfo({ workspacePath: workspaceResult.baseDir });
      }

      // Gather plan context using the shared utility
      const context = await withReviewLogger(() =>
        gatherPlanContext(reviewPlanId, options, globalOpts)
      );

      // Extract context for use in the rest of the function
      const {
        resolvedPlanFile: contextPlanFile,
        planData,
        repoRoot,
        gitRoot,
        parentChain,
        completedChildren,
        diffResult,
      } = context;
      if (typeof planData.id !== 'number') {
        throw new Error('Plan must have a numeric ID.');
      }
      const contextPlanId = planData.id;
      notifyPlan = planData;

      // Check if no changes were detected and early return for review
      if (!options.issues && context.noChangesDetected) {
        const nothingMessage =
          options.incremental || options.sinceLastReview
            ? 'No changes detected since last review. Nothing new to review.'
            : 'No changes detected compared to trunk branch. Nothing to review.';
        reviewLog(chalk.yellow(nothingMessage));
        skipNotification = true;
        return;
      }

      reviewLog(chalk.green(`Reviewing plan: ${planData.id} - ${planData.title}`));

      // Use gitRoot from context (derived from resolved repoRoot, not CWD)
      notifyCwd = gitRoot;

      const { customInstructions, previousReviewResponse } = await resolveReviewPromptContext({
        options,
        config,
        baseDir: gitRoot,
        reviewLog,
      });

      const sharedExecutorOptions: ExecutorCommonOptions = {
        baseDir: gitRoot,
        model: options.model,
        noninteractive: isPrintMode, // Disable permissions prompts in print mode
        timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
          config,
          gitRoot,
          {
            planId: planData.id,
            planUuid: planData.uuid,
            planFilePath: contextPlanFile,
            branch: planData.branch,
          },
          originalRepoRoot
        ),
      };

      const notifyReviewInput = async (message: string): Promise<void> => {
        if (!isInteractiveEnv) {
          return;
        }
        await sendNotification(config, {
          command: 'review',
          event: 'review_input',
          status: 'input',
          message,
          cwd: gitRoot,
          plan: planData,
          planFile: await getExecutablePlanFile(),
        });
      };

      const {
        planData: scopedPlanData,
        taskScopeNote,
        isScoped,
        remainingTasks,
      } = resolveReviewTaskScope(planData, {
        taskIndex: options.taskIndex,
        taskTitle: options.taskTitle,
      });
      const resolvedTaskIndexes = getResolvedTaskIndexesForScope(scopedPlanData, isScoped);
      let previousReviewContext: string | undefined;
      try {
        previousReviewContext = await loadPreviousReviewContext(
          gitRoot,
          planData,
          resolvedTaskIndexes,
          taskScopeNote
        );
      } catch (cacheErr) {
        reviewLog(chalk.yellow(`Warning: Could not read batch review cache: ${cacheErr as Error}`));
      }
      let executablePlanFilePromise: Promise<string> | undefined;
      const getExecutablePlanFile = () => {
        executablePlanFilePromise ??= ensureReviewPlanFilePath(contextPlanFile, planData, repoRoot);
        return executablePlanFilePromise;
      };

      if (options.issues) {
        const savedIssues = Array.isArray(planData.reviewIssues) ? planData.reviewIssues : [];
        if (savedIssues.length === 0) {
          reviewLog(chalk.yellow('No saved review issues found for this plan.'));
          completionMessage = 'No saved review issues found.';
          skipNotification = true;
          return;
        }

        reviewLog(chalk.cyan(`Using saved review issues: ${summarizeReviewIssues(savedIssues)}`));

        if (isPrintMode) {
          console.log(JSON.stringify(savedIssues, null, 2));
          await Bun.sleep(500);
          completionMessage = 'Saved review issues printed.';
          skipNotification = true;
          return;
        }

        const executablePlanFile = await getExecutablePlanFile();
        notifyPlanFile = executablePlanFile;
        const savedReviewResult = createReviewResultFromSavedIssues(
          scopedPlanData,
          diffResult,
          savedIssues
        );
        const actionResult = await handleReviewIssueActions({
          issues: savedIssues,
          reviewResult: savedReviewResult,
          reviewExecutorName: normalizeReviewExecutorName(
            options.executor ?? config.defaultExecutor
          ),
          planData,
          scopedPlanData,
          diffResult,
          planRefForWrite: contextPlanId,
          planFileForWrite: contextPlanFile,
          executionPlanFile: executablePlanFile,
          options,
          isInteractiveEnv,
          isPrintMode,
          taskScopeNote,
          isScoped,
          sharedExecutorOptions,
          config,
          globalOpts,
          notifyReviewInput,
        });

        appendedTaskCount += actionResult.appendedTaskCount;
        skipNotification ||= actionResult.skipNotification || !actionResult.actionCompleted;
        completionMessage = actionResult.actionCompleted
          ? 'Processed saved review issues.'
          : 'Saved review issues left unchanged.';
        return;
      }

      const buildPrompt: ReviewPromptBuilder = ({ includeDiff, useSubagents }) =>
        buildReviewPrompt(
          scopedPlanData,
          diffResult,
          includeDiff,
          useSubagents,
          parentChain,
          completedChildren,
          customInstructions,
          taskScopeNote,
          previousReviewContext,
          remainingTasks,
          previousReviewResponse
        );
      const reviewUsesJj = await getUsingJj(gitRoot);
      const reviewHeadRef = planData.branch ?? (await getCurrentBranchName(gitRoot)) ?? 'HEAD';
      const buildStructuralPrompt: StructuralReviewPromptBuilder | undefined = !isScoped
        ? () =>
            buildStandaloneSimplificationReviewPrompt({
              metadata: buildPlanReviewMetadata({
                planData,
                parentChain,
                completedChildren,
                baseBranch: diffResult.baseBranch,
                headRef: reviewHeadRef,
              }),
              useJj: reviewUsesJj,
              customInstructions: customInstructions || undefined,
            })
        : undefined;

      // Execute the review
      if (options.dryRun) {
        const prepared = await prepareReviewExecutors({
          executorSelection: options.executor,
          config,
          sharedExecutorOptions,
          buildPrompt,
        });

        log(chalk.cyan('\n## Dry Run - Generated Review Prompt\n'));
        for (const preparedExecutor of prepared) {
          if (prepared.length > 1) {
            log(chalk.cyan(`\n### Executor: ${preparedExecutor.name}\n`));
          }
          log(preparedExecutor.prompt);
        }
        if (buildStructuralPrompt && prepared.some((entry) => entry.name === 'codex-cli')) {
          log(chalk.cyan(`\n### Executor: codex-cli structural simplification\n`));
          log(buildStructuralPrompt({ executorName: 'codex-cli' }));
        }
        log('\n--dry-run mode: Would execute the above prompt');
        skipNotification = true;
        return;
      }

      sendStructured({
        type: 'review_start',
        timestamp: timestamp(),
        executor: options.executor || config.defaultExecutor,
        planId: planData.id,
      });

      // Execute the review with output capture enabled
      try {
        const executablePlanFile = await getExecutablePlanFile();
        notifyPlanFile = executablePlanFile;
        const planInfo = {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: executablePlanFile,
          baseBranch: diffResult.baseBranch,
          changedFiles: diffResult.changedFiles,
          isTaskScoped: isScoped,
        };

        const runReviewCall = () =>
          runReview({
            executorSelection: options.executor,
            serialBoth: options.serialBoth,
            config,
            sharedExecutorOptions,
            buildPrompt,
            buildStructuralPrompt,
            planInfo,
          });

        const reviewOutput = isPrintMode
          ? await withReviewLogger(runReviewCall)
          : await runReviewCall();

        if (reviewOutput.warnings.length > 0) {
          for (const warning of reviewOutput.warnings) {
            warn(chalk.yellow(warning));
          }
        }

        const reviewResult = reviewOutput.reviewResult;
        const rawOutput = reviewOutput.rawOutput;
        const reviewExecutorName = reviewOutput.usedExecutors[0];
        if (!reviewExecutorName) {
          throw new Error('Review completed without a usable executor result.');
        }

        const { formattedOutput, hasIssues, currentCommitHash } =
          await formatAndPersistReviewResult({
            reviewResult,
            rawOutput,
            baseDir: gitRoot,
            baseBranch: diffResult.baseBranch,
            changedFiles: diffResult.changedFiles,
            targetId: planData.id?.toString() ?? 'unknown',
            targetTitle: planData.title ?? 'Untitled Plan',
            historyId: planData.id?.toString() ?? 'unknown',
            options,
            config,
            isPrintMode,
            reviewLog,
            gitNoteSummary: (metadata) =>
              `Code review completed for plan ${metadata.planId}: ${metadata.planTitle}`,
          });

        if (!hasIssues && planData.reviewIssues) {
          await clearSavedReviewIssues(contextPlanId, gitRoot);
        }

        try {
          const cacheKey = getPlanCacheKey(planData);
          if (cacheKey !== 'unknown') {
            if (hasIssues) {
              await writeBatchReviewCache(gitRoot, cacheKey, resolvedTaskIndexes, {
                gitSha: currentCommitHash,
                issues: reviewResult.issues,
                timestamp: new Date().toISOString(),
                planId: cacheKey,
              });
            } else {
              await deleteBatchReviewCache(gitRoot, cacheKey, resolvedTaskIndexes);
            }
          }
        } catch (cacheErr) {
          reviewLog(
            chalk.yellow(`Warning: Could not update batch review cache: ${cacheErr as Error}`)
          );
        }

        sendStructured({
          type: 'review_result',
          timestamp: timestamp(),
          verdict: hasIssues ? 'NEEDS_FIXES' : 'ACCEPTABLE',
          fixInstructions: hasIssues ? reviewResult.actionItems.join('\n') : undefined,
          issues: toStructuredReviewIssues(reviewResult.issues),
          recommendations: reviewResult.recommendations,
          actionItems: reviewResult.actionItems,
        });

        if (tunnelActive || isPrintMode) {
          // In print mode, write formatted output to stdout so the caller gets
          // machine-readable JSON regardless of tunnel state.
          // In tunnel mode, stdout output allows the parent executor to capture
          // the formatted review output from this child process.
          // The parent receives review data via sendStructured() above.
          console.log(formattedOutput);
          // Wait so that output flushes, this seems necessary in recent versions of Claude Code
          await Bun.sleep(500);
        }

        if (hasIssues && !isPrintMode) {
          const executablePlanFile = await getExecutablePlanFile();
          const actionResult = await handleReviewIssueActions({
            issues: reviewResult.issues,
            reviewResult,
            reviewExecutorName,
            planData,
            scopedPlanData,
            diffResult,
            planRefForWrite: contextPlanId,
            planFileForWrite: contextPlanFile,
            executionPlanFile: executablePlanFile,
            options,
            isInteractiveEnv,
            isPrintMode,
            taskScopeNote,
            isScoped,
            sharedExecutorOptions,
            config,
            globalOpts,
            notifyReviewInput,
          });
          appendedTaskCount += actionResult.appendedTaskCount;
          skipNotification ||= actionResult.skipNotification;

          if (
            options.saveIssues === true &&
            !actionResult.actionCompleted &&
            !actionResult.savedIssuesForLater
          ) {
            await saveReviewIssuesToPlan(contextPlanId, reviewResult.issues, gitRoot);
            issuesSavedCount = reviewResult.issues.length;
            skipNotification = true;
            reviewLog(
              chalk.green(
                `Saved ${reviewResult.issues.length} review issue${reviewResult.issues.length === 1 ? '' : 's'} for later.`
              )
            );
          }
        }

        // Store incremental review metadata after successful review
        if (planData.id) {
          try {
            const currentCommitHash = await getCurrentCommitHash(gitRoot);
            if (currentCommitHash) {
              const incrementalMetadata: IncrementalReviewMetadata = {
                lastReviewCommit: currentCommitHash,
                lastReviewTimestamp: new Date(),
                planId: planData.id.toString(),
                baseBranch: diffResult.baseBranch,
                reviewedFiles: diffResult.changedFiles,
                changeCount: diffResult.changedFiles.length,
              };

              await storeLastReviewMetadata(gitRoot, planData.id.toString(), incrementalMetadata);
              if (options.incremental || options.sinceLastReview) {
                reviewLog(chalk.gray('Incremental review metadata updated for future reviews'));
              }
            }
          } catch (metadataErr) {
            const metadataErrorMessage =
              metadataErr instanceof Error ? metadataErr.message : String(metadataErr);
            reviewLog(
              chalk.yellow(
                `Warning: Could not store incremental review metadata: ${metadataErrorMessage}`
              )
            );
          }
        }

        reviewLog(chalk.green('\nCode review completed successfully!'));
        completionMessage = 'Review completed successfully.';
        completionStatus = 'success';
      } catch (err) {
        // Enhanced error handling with better context preservation
        const errorMessage = err instanceof Error ? err.message : String(err);
        const contextualError = `Review execution failed: ${errorMessage}`;

        // Log additional context for debugging
        if (err instanceof Error) {
          if (err.stack) {
            log(chalk.gray(`Stack trace: ${err.stack}`));
          }

          // Provide specific guidance based on error type
          if (err.message.includes('timeout')) {
            log(
              chalk.yellow(
                'Hint: Consider using a different model or reducing the scope of the review.'
              )
            );
          } else if (err.message.includes('permission')) {
            log(
              chalk.yellow(
                'Hint: Check file permissions and ensure you have access to the repository.'
              )
            );
          } else if (err.message.includes('network')) {
            log(chalk.yellow('Hint: Check your internet connection and API credentials.'));
          }
        }

        completionMessage = `Review failed: ${errorMessage}`;
        completionStatus = 'error';
        completionErrorMessage = errorMessage;
        throw new Error(contextualError, { cause: err });
      }
    };

    if (headlessAdapter) {
      await runWithLogger(headlessAdapter, executeReviewFlow);
    } else {
      await executeReviewFlow();
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!completionMessage) {
      completionMessage = `Review failed: ${errorMessage}`;
    }
    completionStatus = 'error';
    completionErrorMessage = errorMessage;
    throw err;
  } finally {
    if (headlessAdapter) {
      try {
        await headlessAdapter.destroy();
      } catch {
        // Headless cleanup should not prevent notifications or mask prior errors.
      }
    }

    if (!skipNotification && completionMessage) {
      await notifyReviewDone(completionMessage, completionStatus, completionErrorMessage);
    }
  }

  return { tasksAppended: appendedTaskCount, issuesSaved: issuesSavedCount };
}

export function sanitizeBranchName(branch: string): string {
  // Only allow alphanumeric characters, hyphens, underscores, forward slashes, and dots
  // This is a conservative approach for git/jj branch names
  if (!/^[a-zA-Z0-9._/-]+$/.test(branch)) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  // Additional security check: prevent path traversal attempts
  if (branch.includes('..') || branch.startsWith('/') || branch.includes('\\')) {
    throw new Error(`Invalid branch name format: ${branch}`);
  }

  return branch;
}

/**
 * Validates and sanitizes focus areas to prevent injection attacks
 */
export function validateFocusAreas(focusAreas: string[]): string[] {
  if (!Array.isArray(focusAreas)) {
    throw new Error('Focus areas must be an array');
  }

  const allowedFocusPattern = /^[a-zA-Z0-9\s._-]+$/;
  const maxFocusAreaLength = 50;
  const maxFocusAreas = 10;

  if (focusAreas.length > maxFocusAreas) {
    throw new Error(`Too many focus areas specified (max ${maxFocusAreas})`);
  }

  const sanitizedAreas = focusAreas
    .map((area) => area.trim())
    .filter((area) => {
      if (!area) return false;
      if (area.length > maxFocusAreaLength) {
        throw new Error(`Focus area too long (max ${maxFocusAreaLength} characters): ${area}`);
      }
      if (!allowedFocusPattern.test(area)) {
        throw new Error(`Focus area contains invalid characters: ${area}`);
      }
      return true;
    });

  return sanitizedAreas;
}

type ReviewTaskFilterOptions = {
  taskIndex?: string | string[];
  taskTitle?: string | string[];
};

type RemainingTask = { index: number; title: string };

type ReviewTaskScope = {
  planData: PlanSchema;
  taskScopeNote?: string;
  isScoped: boolean;
  remainingTasks: RemainingTask[];
};

function normalizeTaskFilterInput(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseTaskIndexes(value: string | string[] | undefined): {
  indexes: number[];
  invalidTokens: string[];
} {
  const tokens = normalizeTaskFilterInput(value);
  const indexes: number[] = [];
  const invalidTokens: string[] = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed < 1) {
      invalidTokens.push(token);
      continue;
    }
    indexes.push(parsed - 1); // Convert 1-based input to 0-based internal index
  }

  return { indexes, invalidTokens };
}

export function resolveReviewTaskScope(
  planData: PlanSchema,
  options: ReviewTaskFilterOptions
): ReviewTaskScope {
  const { indexes: taskIndexes, invalidTokens } = parseTaskIndexes(options.taskIndex);
  const taskTitles = normalizeTaskFilterInput(options.taskTitle);

  if (taskIndexes.length === 0 && taskTitles.length === 0 && invalidTokens.length === 0) {
    return { planData, isScoped: false, remainingTasks: [] };
  }

  const tasks = planData.tasks ?? [];
  const matchedIndexes = new Set<number>();
  const unknownIndexes: number[] = [];
  const unknownTitles: string[] = [];

  for (const index of taskIndexes) {
    if (index < 0 || index >= tasks.length) {
      unknownIndexes.push(index);
    } else {
      matchedIndexes.add(index);
    }
  }

  const taskTitleMap = tasks.map((task, index) => ({
    index,
    title: task.title.trim().toLowerCase(),
  }));

  for (const title of taskTitles) {
    const normalizedTitle = title.trim().toLowerCase();
    if (!normalizedTitle) {
      continue;
    }

    const matches = taskTitleMap
      .filter((task) => task.title === normalizedTitle)
      .map((task) => task.index);

    if (matches.length === 0) {
      unknownTitles.push(title);
      continue;
    }

    for (const matchIndex of matches) {
      matchedIndexes.add(matchIndex);
    }
  }

  const uniqueUnknownIndexes = Array.from(new Set(unknownIndexes));
  const uniqueInvalidTokens = Array.from(new Set(invalidTokens));
  const uniqueUnknownTitles = Array.from(new Set(unknownTitles));

  if (
    uniqueInvalidTokens.length > 0 ||
    uniqueUnknownIndexes.length > 0 ||
    uniqueUnknownTitles.length > 0
  ) {
    const parts: string[] = [];
    if (uniqueInvalidTokens.length > 0) {
      parts.push(`Invalid task indexes: ${uniqueInvalidTokens.join(', ')}`);
    }
    if (uniqueUnknownIndexes.length > 0) {
      // Convert back to 1-based for user display
      parts.push(`Unknown task indexes: ${uniqueUnknownIndexes.map((i) => i + 1).join(', ')}`);
    }
    if (uniqueUnknownTitles.length > 0) {
      parts.push(`Unknown task titles: ${uniqueUnknownTitles.join(', ')}`);
    }
    throw new Error(parts.join('; '));
  }

  // Preserve original 1-based indexes when filtering tasks
  const filteredTasks: PlanTaskWithIndex[] = tasks
    .map((task, index) => ({ ...task, originalIndex: index + 1 }))
    .filter((_, index) => matchedIndexes.has(index));
  const totalTasks = tasks.length;
  const taskScopeNote = `This review is limited to the tasks listed below (${filteredTasks.length} of ${totalTasks}). Other plan tasks are out of scope.`;

  // Compute remaining unfinished tasks outside the review scope
  const remainingTasks: RemainingTask[] = tasks
    .map((task, index) => ({ index: index + 1, title: task.title, done: task.done }))
    .filter((task) => !matchedIndexes.has(task.index - 1) && !task.done)
    .map(({ index, title }) => ({ index, title }));

  return {
    planData: {
      ...planData,
      tasks: filteredTasks,
    },
    taskScopeNote,
    isScoped: true,
    remainingTasks,
  };
}

/**
 * Prompts the user to select which issues to address from the review results
 * (issues can be either fixed immediately or included in a cleanup plan)
 */
async function selectIssuesToFix(
  issues: ReviewIssue[],
  purpose: string = 'fix',
  notifyInput?: () => Promise<void>
): Promise<ReviewIssue[]> {
  const actionableIssues = filterActionableReviewIssues(issues);
  const isInteractiveEnv = process.env.TIM_INTERACTIVE !== '0';
  if (!isInteractiveEnv) {
    return actionableIssues;
  }
  if (notifyInput) {
    await notifyInput();
  }
  sendStructured({
    type: 'input_required',
    timestamp: timestamp(),
    prompt: `Select issues to ${purpose}`,
  });
  // Group issues by severity for better organization
  const groupedIssues = actionableIssues.reduce(
    (acc, issue) => {
      if (!acc[issue.severity]) acc[issue.severity] = [];
      acc[issue.severity].push(issue);
      return acc;
    },
    {} as Record<string, ReviewIssue[]>
  );

  // Create checkbox options with severity indicators
  const options: Array<{
    name: string;
    description: string;
    value: number;
    checked: boolean;
  }> = [];
  const severityOrder = ['critical', 'major', 'minor', 'info'] as const;
  const severityIcons: Record<string, string> = {
    critical: '!!',
    major: '!',
    minor: '-',
    info: 'i',
  };

  const issueLookup: ReviewIssue[] = [];
  for (const severity of severityOrder) {
    const severityIssues = groupedIssues[severity] || [];
    for (const issue of severityIssues) {
      const fileInfo = issue.file ? ` (${issue.file}${issue.line ? ':' + issue.line : ''})` : '';

      const firstLine = issue.content.split('\n')[0];
      let fullDesc = issue.content + fileInfo;
      if (issue.suggestion) {
        fullDesc += `\n\nSuggestion: ${issue.suggestion}`;
      }

      options.push({
        name: `${severityIcons[severity]} [${severity.toUpperCase()}] ${firstLine}`,
        description: fullDesc,
        value: issueLookup.length,
        checked: severity === 'critical' || severity === 'major', // Pre-select critical and major issues
      });
      issueLookup.push(issue);
    }
  }

  const selectedIssueIndexes = await promptCheckbox({
    message: `Select issues to ${purpose}:`,
    choices: options,
    pageSize: 15,
  });

  return selectedIssueIndexes
    .map((index) => issueLookup[index])
    .filter((issue): issue is ReviewIssue => issue != null);
}

type PlanTask = PlanSchema['tasks'][number];

/** A task with its original 1-based index preserved when filtering */
type PlanTaskWithIndex = PlanTask & { originalIndex?: number };

export function getResolvedTaskIndexesForScope(
  scopedPlanData: PlanSchema,
  isScoped: boolean
): number[] | undefined {
  if (!isScoped) {
    return undefined;
  }

  const resolvedTaskIndexes =
    scopedPlanData.tasks
      ?.map((task) => (task as PlanTaskWithIndex).originalIndex)
      .filter((taskIndex): taskIndex is number => taskIndex != null) ?? [];

  return resolvedTaskIndexes.length > 0 ? resolvedTaskIndexes : undefined;
}

export function formatReviewIssueForPrompt(issue: ReviewIssue, index: number): string {
  const location = issue.file
    ? issue.line
      ? `${issue.file}:${issue.line}`
      : issue.file
    : 'No file specified';

  const parts = [
    `${index}. [${issue.severity.toUpperCase()}] ${issue.category}`,
    `Location: ${location}`,
    `Issue: ${issue.content.trim()}`,
  ];

  if (issue.suggestion?.trim()) {
    parts.push(`Suggestion: ${issue.suggestion.trim()}`);
  }

  return parts.join('\n');
}

export function formatPreviousReviewContext(
  gitSha: string,
  issues: ReviewIssue[],
  taskScopeNote?: string
): string {
  const scopeLine = taskScopeNote
    ? `This prior review covered the same scoped tasks: ${taskScopeNote}`
    : `This prior review covered the full plan.`;
  const issueLines = issues.map((issue, index) => formatReviewIssueForPrompt(issue, index + 1));

  return [
    `# Previous Review Results`,
    ``,
    `This was the result of the previous review round.`,
    `Previous review Git SHA: ${gitSha}`,
    scopeLine,
    `Use that SHA to judge what changed since the prior review before raising new concerns.`,
    ``,
    `Prior issues:`,
    ``,
    ...issueLines.flatMap((issue) => [issue, ``]),
    `## Instructions for this review`,
    ``,
    `- Focus on resolution of the existing issues and any new issues caused by the most recent work.`,
    `- Issues are expected to have been fixed or intentionally ignored as not relevant.`,
    `- Do a perfunctory check if an issue appears to have been addressed, and verify the fix is correct.`,
    `- Do not provide review issues that contradict the previous review's findings.`,
  ]
    .join('\n')
    .trim();
}

function getPlanCacheKey(planData: PlanSchema): string {
  return planData.id?.toString() ?? planData.uuid ?? 'unknown';
}

function buildPlanReviewMetadata(options: {
  planData: PlanSchema;
  parentChain: PlanSchema[];
  completedChildren: PlanSchema[];
  baseBranch: string;
  headRef: string;
}): PlanReviewMetadata {
  if (typeof options.planData.id !== 'number') {
    throw new Error('Plan must have a numeric ID for structural review metadata.');
  }

  return {
    kind: 'plan',
    planId: options.planData.id,
    planUuid: options.planData.uuid ?? '',
    title: options.planData.title ?? 'Untitled Plan',
    goal: options.planData.goal ?? null,
    details: options.planData.details ?? null,
    tasks:
      options.planData.tasks?.map((task) => ({
        title: task.title,
        status: task.done ? 'done' : null,
      })) ?? [],
    parentChain: options.parentChain
      .filter((plan) => typeof plan.id === 'number')
      .map((plan) => ({
        planId: plan.id as number,
        title: plan.title ?? 'Untitled Plan',
      })),
    completedChildren: options.completedChildren
      .filter((plan) => typeof plan.id === 'number')
      .map((plan) => ({
        planId: plan.id as number,
        title: plan.title ?? 'Untitled Plan',
      })),
    baseBranch: options.baseBranch,
    headRef: options.headRef,
  };
}

async function loadPreviousReviewContext(
  gitRoot: string,
  planData: PlanSchema,
  resolvedTaskIndexes: number[] | undefined,
  taskScopeNote?: string
): Promise<string | undefined> {
  const cacheKey = getPlanCacheKey(planData);
  if (cacheKey === 'unknown') return undefined;
  const cache = await readBatchReviewCache(gitRoot, cacheKey, resolvedTaskIndexes);
  if (!cache) return undefined;
  return formatPreviousReviewContext(cache.gitSha, cache.issues, taskScopeNote);
}

export function buildTaskTitleFromIssue(issue: ReviewIssue): string {
  // Normalize whitespace and get content as a single string
  const normalized = issue.content.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return 'Address Review Feedback: Review feedback';
  }

  // Extract the first sentence (ends with . ! or ? followed by space or end of string)
  const sentenceMatch = normalized.match(/^(.+?[.!?])(?:\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[1] : normalized;

  return `Address Review Feedback: ${firstSentence}`;
}

export function createTaskFromIssue(issue: ReviewIssue): PlanTask {
  const title = buildTaskTitleFromIssue(issue);

  const descriptionSegments: string[] = [];
  const trimmedContent = issue.content.trim();
  if (trimmedContent) {
    descriptionSegments.push(trimmedContent);
  } else {
    descriptionSegments.push('Follow up on review feedback.');
  }

  if (issue.suggestion) {
    descriptionSegments.push('', `Suggestion: ${issue.suggestion}`);
  }

  if (issue.file) {
    const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
    descriptionSegments.push('', `Related file: ${location}`);
  }

  const description = descriptionSegments.join('\n').trim();

  const task: PlanTask = {
    title,
    description,
    done: false,
  };

  return task;
}

export function getReviewThreadDisplayLine(thread: PrReviewThreadDetail): number | null {
  return (
    thread.thread.line ??
    thread.thread.original_line ??
    thread.thread.start_line ??
    thread.thread.original_start_line
  );
}

export function createTaskFromReviewThread(thread: PrReviewThreadDetail, prUrl: string): PlanTask {
  const displayLine = getReviewThreadDisplayLine(thread);
  const location =
    displayLine != null ? `${thread.thread.path}:${displayLine}` : thread.thread.path;

  const title = `Address review: ${location}`;

  const descriptionSegments: string[] = [];
  const commentBodies = thread.comments
    .map((comment) => comment.body?.trim() ?? '')
    .filter((body) => body.length > 0);

  if (commentBodies.length > 0) {
    descriptionSegments.push(commentBodies.join('\n\n'));
  } else {
    descriptionSegments.push(`Address the unresolved review feedback in ${location}.`);
  }

  const diffHunk = thread.comments.find((comment) => comment.diff_hunk?.trim())?.diff_hunk?.trim();
  if (diffHunk) {
    descriptionSegments.push('', `Diff context:\n${diffHunk}`);
  }

  const databaseId = thread.comments.find((comment) => comment.database_id != null)?.database_id;
  if (databaseId != null) {
    descriptionSegments.push('', `GitHub discussion: ${prUrl}#discussion_r${databaseId}`);
  } else {
    descriptionSegments.push('', `Pull request: ${prUrl}`);
  }

  return {
    title,
    description: descriptionSegments.join('\n').trim(),
    done: false,
  };
}

export async function appendIssuesToPlanTasks(
  planId: number,
  issues: ReviewIssue[],
  repoRoot: string
): Promise<number> {
  // Re-read the plan to get the latest state (handles parallel reviews)
  const { plan: planData, planPath } = await resolveReviewPlanForWriteById(planId, repoRoot);

  if (!Array.isArray(planData.tasks)) {
    planData.tasks = [];
  }

  const existingTitles = new Set(planData.tasks.map((task) => task.title));
  let appendedCount = 0;

  for (const issue of issues) {
    const task = createTaskFromIssue(issue);
    if (existingTitles.has(task.title)) {
      continue;
    }

    planData.tasks.push(task);
    existingTitles.add(task.title);
    appendedCount++;
  }

  if (appendedCount > 0) {
    if (isReopenableCompletedStatus(planData.status)) {
      planData.status = 'in_progress';
    }
    await writePlanFile(planPath, planData, { cwdForIdentity: repoRoot });
  }

  return appendedCount;
}

export async function reopenParentForAppendedReviewTasks(
  planData: Pick<PlanSchema, 'parent' | 'status'>,
  repoRoot: string
): Promise<void> {
  if (!planData.parent || !isReopenableCompletedStatus(planData.status)) {
    return;
  }
  const parentId = planData.parent;

  await withPlanAutoSync(parentId, repoRoot, async () => {
    const { plan: parentPlan } = await resolveReviewPlanForWriteById(parentId, repoRoot);
    if (!isReopenableCompletedStatus(parentPlan.status)) {
      return;
    }

    parentPlan.status = 'in_progress';
    const parentPlanPath = await ensureReviewPlanFilePathById(parentId, parentPlan, repoRoot);
    await writePlanFile(parentPlanPath, parentPlan, { cwdForIdentity: repoRoot });
  });
}

async function resolveReviewPlanForWriteById(
  planId: number,
  repoRoot: string
): Promise<{
  plan: PlanSchema;
  planPath: string | null;
  repoRoot: string;
}> {
  const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
  return {
    plan: resolvedPlan.plan,
    planPath: resolvedPlan.planPath,
    repoRoot,
  };
}

async function ensureReviewPlanFilePath(
  planFilePath: string,
  planData: PlanSchema,
  repoRoot: string
): Promise<string> {
  try {
    await access(planFilePath, constants.F_OK);
    return planFilePath;
  } catch {
    if (!planData.id) {
      throw new Error('Plan must have an ID before it can be materialized for review execution.');
    }

    return materializePlan(planData.id, repoRoot);
  }
}

async function ensureReviewPlanFilePathById(
  planId: number,
  planData: PlanSchema,
  repoRoot: string
): Promise<string> {
  if (planData.id !== planId) {
    throw new Error(`Resolved plan ID ${planData.id} does not match expected plan ID ${planId}.`);
  }

  const existingMaterializedPath = await materializedPlanFileExists(repoRoot, planId);
  if (existingMaterializedPath) {
    return existingMaterializedPath;
  }

  return materializePlan(planId, repoRoot);
}

async function materializedPlanFileExists(
  repoRoot: string,
  planId: number
): Promise<string | null> {
  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  try {
    await access(materializedPath, constants.F_OK);
    return materializedPath;
  } catch {
    return null;
  }
}

/**
 * Builds a review prompt from command-line options, similar to handleReviewCommand
 * but without executing the review. This is used by the prompts command to show
 * what prompt would be generated.
 *
 * @param planFile - Plan ID
 * @param options - Review command options including task filters, instructions, etc.
 * @param globalOpts - Global CLI options including config path
 * @returns Promise<string> containing the generated prompt
 */
export async function buildReviewPromptFromOptions(
  planId: number,
  options: {
    taskIndex?: string | string[];
    taskTitle?: string | string[];
    instructions?: string;
    instructionsFile?: string;
    input?: string;
    inputFile?: string | string[];
    focus?: string;
    incremental?: boolean;
    sinceLastReview?: boolean;
    since?: string;
    base?: string;
    previousResponse?: string;
  },
  globalOpts: {
    config?: string;
  }
): Promise<string> {
  // Load config
  const config = await loadEffectiveConfig(globalOpts.config);

  // Gather plan context using the shared utility
  const context = await gatherPlanContext(planId, options, globalOpts);

  // Extract context — use gitRoot from context (derived from resolved repoRoot, not CWD)
  const { planData, gitRoot, parentChain, completedChildren, diffResult } = context;

  // Load custom instructions
  let customInstructions = '';
  let previousReviewResponse: string | undefined;

  // First try CLI options (CLI takes precedence)
  if (options.instructions) {
    customInstructions = options.instructions;
  } else if (options.instructionsFile) {
    try {
      const instructionsPath = validateInstructionsFilePath(options.instructionsFile, gitRoot);
      customInstructions = await readFile(instructionsPath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read instructions file from CLI: ${options.instructionsFile}. ${errorMessage}`
      );
    }
  } else if (config.review?.customInstructionsPath) {
    // Fall back to config file instructions
    try {
      const instructionsPath = validateInstructionsFilePath(
        config.review.customInstructionsPath,
        gitRoot
      );
      customInstructions = await readFile(instructionsPath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read instructions file from config: ${config.review.customInstructionsPath}. ${errorMessage}`
      );
    }
  } else {
    // Fall back to agents.reviewer.instructions
    customInstructions = (await loadAgentInstructionsFor('reviewer', gitRoot, config)) ?? '';
  }

  if (options.previousResponse) {
    try {
      const previousResponsePath = validateInstructionsFilePath(options.previousResponse, gitRoot);
      previousReviewResponse = await readFile(previousResponsePath, 'utf-8');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(
        `Warning: Could not read previous review response file: ${options.previousResponse}. ${errorMessage}`
      );
    }
  }

  // Resolve orchestrator-provided input (--input / --input-file)
  const orchestratorInput = await resolveOrchestratorInput(options);
  if (orchestratorInput?.trim()) {
    customInstructions = customInstructions
      ? `${customInstructions}\n\n## Additional Context from Orchestrator\n\n${orchestratorInput}`
      : `## Additional Context from Orchestrator\n\n${orchestratorInput}`;
  }

  // Handle focus areas
  let focusAreas: string[] = [];
  if (options.focus) {
    // CLI focus areas override config
    const rawFocusAreas = options.focus
      .split(',')
      .map((area: string) => area.trim())
      .filter(Boolean);
    try {
      focusAreas = validateFocusAreas(rawFocusAreas);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(`Warning: Invalid focus areas from CLI: ${errorMessage}`);
      focusAreas = [];
    }
  } else if (config.review?.focusAreas && config.review.focusAreas.length > 0) {
    try {
      focusAreas = validateFocusAreas(config.review.focusAreas);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      warn(`Warning: Invalid focus areas from config: ${errorMessage}`);
      focusAreas = [];
    }
  }

  // Add focus areas to custom instructions if provided
  if (focusAreas.length > 0) {
    const focusInstruction = `Focus on: ${focusAreas.join(', ')}`;
    customInstructions = customInstructions
      ? `${customInstructions}\n\n${focusInstruction}`
      : focusInstruction;
  }

  // Resolve task scope
  const {
    planData: scopedPlanData,
    taskScopeNote,
    isScoped,
    remainingTasks,
  } = resolveReviewTaskScope(planData, {
    taskIndex: options.taskIndex,
    taskTitle: options.taskTitle,
  });

  // Load previous batch review cache for prompt context
  const resolvedTaskIndexes = getResolvedTaskIndexesForScope(scopedPlanData, isScoped);
  let previousReviewContext: string | undefined;
  try {
    previousReviewContext = await loadPreviousReviewContext(
      gitRoot,
      planData,
      resolvedTaskIndexes,
      taskScopeNote
    );
  } catch {
    // Best-effort: skip cache context if read fails
  }

  // Build and return the prompt
  return buildReviewPrompt(
    scopedPlanData,
    diffResult,
    false, // includeDiff - not needed for prompt viewing
    false, // useSubagents - not needed for prompt viewing
    parentChain,
    completedChildren,
    customInstructions,
    taskScopeNote,
    previousReviewContext,
    remainingTasks,
    previousReviewResponse
  );
}

export function buildReviewPrompt(
  planData: PlanSchema,
  diffResult: DiffResult,
  includeDiff: boolean = false,
  useSubagents: boolean = false,
  parentChain: PlanSchema[] = [],
  completedChildren: PlanSchema[] = [],
  customInstructions?: string,
  taskScopeNote?: string,
  additionalContext?: string,
  remainingTasks?: RemainingTask[],
  previousReviewResponse?: string
): string {
  // Build parent plan context section if available
  const parentContext: string[] = [];
  if (parentChain.length > 0) {
    parentContext.push(`# Parent Plan Context`, ``);

    // Include all parents in the chain, starting with immediate parent
    parentChain.forEach((parent, index) => {
      const level = index === 0 ? 'Parent' : `Grandparent (Level ${index + 1})`;
      parentContext.push(
        `**${level} Plan ID:** ${parent.id}`,
        `**${level} Title:** ${parent.title}`,
        `**${level} Goal:** ${parent.goal}`,
        ``
      );

      if (parent.details) {
        parentContext.push(`**${level} Details:** ${parent.details}`, ``);
      }

      if (index < parentChain.length - 1) {
        parentContext.push(`---`, ``);
      }
    });

    parentContext.push(
      `*Note: This review is for a child plan implementing part of the parent plan${parentChain.length > 1 ? 's' : ''} above.*`,
      ``,
      ``
    );
  }

  // Build completed children context section if available
  const childrenContext: string[] = [];
  if (completedChildren.length > 0) {
    childrenContext.push(
      `# Completed Child Plans`,
      ``,
      `The following child plans have been completed as part of this parent plan:`,
      ``
    );

    completedChildren.forEach((child) => {
      childrenContext.push(
        `**Child Plan ID:** ${child.id}`,
        `**Child Title:** ${child.title}`,
        `**Child Goal:** ${child.goal}`,
        ``
      );

      if (child.details) {
        childrenContext.push(`**Child Details:** ${child.details}`, ``);
      }
    });

    childrenContext.push(
      `*Note: When reviewing this parent plan, consider how these completed children contribute to the overall goals.*`,
      ``,
      ``
    );
  }

  // Build plan context section
  const planContext = [
    `# Plan Context`,
    ``,
    `**Plan ID:** ${planData.id}`,
    `**Title:** ${planData.title}`,
    `**Goal:** ${planData.goal}`,
    ``,
  ];

  if (planData.details) {
    planContext.push(`**Details:**`, planData.details, ``);
  }

  if (taskScopeNote) {
    planContext.push(`**Review Scope:** ${taskScopeNote}`, ``);
  }

  if (remainingTasks && remainingTasks.length > 0) {
    planContext.push(`**Remaining Unfinished Tasks:**`);
    for (const task of remainingTasks) {
      planContext.push(`- ${task.index}. ${task.title}`);
    }
    planContext.push(
      ``,
      `*Note: The tasks listed above are not yet implemented. Do not flag issues that are clearly expected to be addressed by these remaining tasks.*`,
      ``
    );
  }

  const hasSpecificTasks = planData.tasks?.length;
  if (hasSpecificTasks) {
    planContext.push(`**Tasks:**`);
    planData.tasks.forEach((task, index) => {
      const status = task.done ? '✓' : '○';
      // Use originalIndex if present (for filtered/scoped tasks), otherwise use array index
      const displayIndex = (task as PlanTaskWithIndex).originalIndex ?? index + 1;
      planContext.push(`${status} ${displayIndex}. **${task.title}**`);
      if (task.description) {
        planContext.push(`   ${task.description}`);
      }
      planContext.push(``);
    });
  }

  // Build changed files section
  const changedFilesSection = [
    `# Code Changes to Review`,
    ``,
    `**Diff Base:** ${diffResult.mergeBaseCommit ?? diffResult.baseBranch}`,
    `**Changed Files (${diffResult.changedFiles.length}):**`,
  ];

  diffResult.changedFiles.forEach((file) => {
    changedFilesSection.push(`- ${file}`);
  });

  if (includeDiff) {
    changedFilesSection.push(``, `**Full Diff:**`, ``, '```diff', diffResult.diffContent, '```');
  }

  const planScope = hasSpecificTasks ? ' of the specified tasks' : '';

  // Combine everything into the final prompt
  const contextContent = [
    ...parentContext,
    ...childrenContext,
    ...planContext,
    ``,
    ...changedFilesSection,
    ``,
    ...buildAutoreviewReviewPromptGuidance(),
    ...(additionalContext?.trim() ? [additionalContext.trim(), ``] : []),
    ...(previousReviewResponse?.trim()
      ? [
          `# Previous Fixer Response`,
          ``,
          `We just ran a round of fixing in response to a previous review. The final output from the fixing work is below. Please conduct a general review${planScope}, taking this fixer output into account:`,
          ``,
          previousReviewResponse.trim(),
          ``,
        ]
      : []),
    `# Review Instructions`,
    ``,
    `Please review the code changes above in the context of the plan requirements. Focus on:`,
    `1. **Compliance with Plan Requirements:** Do the changes fulfill the goals and tasks outlined in the plan?`,
    `2. **Code Quality:** Look for bugs, logic errors, security issues, and performance problems`,
    `3. **Implementation Completeness:** Are all required features implemented according to the plan?`,
    `4. **Error Handling:** Are edge cases and error conditions properly handled?`,
    `5. **Testing:** Are the changes adequately tested?`,
    ``,
    `**Pre-existing Issues:** If you notice concerns in code that was not modified by these changes, they may still be worth noting. However, any pre-existing issues MUST be labeled as "info" severity. Only issues introduced or affected by the current changes should receive higher severity ratings.`,
    ``,
  ].join('\n');

  // Use the reviewer agent template with our context and custom instructions
  const reviewerPromptWithContext = getReviewerPrompt(
    contextContent,
    planData.id,
    customInstructions,
    undefined,
    useSubagents,
    false,
    undefined,
    false
  );

  return reviewerPromptWithContext.prompt;
}

/**
 * Determine if issues exist in the review result
 */
export function detectIssuesInReview(
  reviewResult: ReturnType<typeof createReviewResult>,
  rawOutput: string
): boolean {
  // Primary method: check totalIssues count
  if (reviewResult?.summary?.totalIssues > 0) {
    return true;
  }

  // Secondary method: check if issues array has content
  if (
    reviewResult?.issues &&
    Array.isArray(reviewResult.issues) &&
    reviewResult.issues.length > 0
  ) {
    return true;
  }

  // Fallback method: semantic analysis of review output
  // This is almost never needed now that we are using real structured output
  // in the review commands.
  if (rawOutput && rawOutput.includes('NEEDS_FIXES')) {
    return true;
  }

  return false;
}

/**
 * Creates an autofix prompt that includes the plan context, review findings, and instructions to fix all identified issues
 */
export function buildAutofixPrompt(
  planData: PlanSchema,
  reviewResult: ReturnType<typeof createReviewResult>,
  diffResult: DiffResult,
  selectedIssues?: ReviewIssue[] | null
): string {
  // Input validation
  if (!planData) {
    throw new Error('planData is required for autofix prompt generation');
  }
  if (!reviewResult) {
    throw new Error('reviewResult is required for autofix prompt generation');
  }
  if (!diffResult) {
    throw new Error('diffResult is required for autofix prompt generation');
  }
  const prompt = [
    `# Autofix Request`,
    ``,
    `## Plan Context`,
    ``,
    `**Plan ID:** ${planData.id}`,
    `**Title:** ${planData.title}`,
    `**Goal:** ${planData.goal}`,
    ``,
  ];

  if (planData.details) {
    prompt.push(`**Details:**`, planData.details, ``);
  }

  if (planData.tasks && planData.tasks.length > 0) {
    prompt.push(`**Tasks:**`);
    planData.tasks.forEach((task, index) => {
      // Use originalIndex if present (for filtered/scoped tasks), otherwise use array index
      const displayIndex = (task as PlanTaskWithIndex).originalIndex ?? index + 1;
      prompt.push(`${displayIndex}. **${task.title}**`);
      if (task.description) {
        prompt.push(`   ${task.description}`);
      }
      prompt.push(``);
    });
  }

  prompt.push(
    `## Review Findings`,
    ``,
    `A code review has identified the following issues that need to be fixed:`,
    ``
  );

  // Add issues from the review result
  const issuesToFix = filterActionableReviewIssues(selectedIssues || reviewResult.issues);

  if (issuesToFix && issuesToFix.length > 0) {
    // Add note if subset selected
    if (
      selectedIssues &&
      reviewResult.issues &&
      selectedIssues.length < reviewResult.issues.length
    ) {
      prompt.push(
        `Note: ${selectedIssues.length} of ${reviewResult.issues.length} issues selected for fixing.`,
        ``
      );
    }

    issuesToFix.forEach((issue, index) => {
      prompt.push(`### Issue ${index + 1}: ${issue.content || 'Unnamed Issue'}`);
      if (issue.file) {
        prompt.push(`**File:** ${issue.file}`);
      }
      if (issue.severity) {
        prompt.push(`**Severity:** ${issue.severity}`);
      }
      prompt.push(``);
    });
  } else {
    // Fallback if structured issues aren't available - include the raw review output
    prompt.push(`**Review Output:**`);
    prompt.push(reviewResult.rawOutput || 'No specific issues identified in structured format.');
    prompt.push(``);
  }

  prompt.push(
    `## Files to Fix`,
    ``,
    `**Diff Base:** ${diffResult.mergeBaseCommit ?? diffResult.baseBranch}`,
    `**Changed Files:**`
  );

  diffResult.changedFiles.forEach((file) => {
    prompt.push(`- ${file}`);
  });

  prompt.push(
    ``,
    `## Instructions`,
    ``,
    `Please fix all the issues identified in the review while maintaining the plan requirements. Ensure that:`,
    ``,
    `1. All identified bugs and issues are resolved`,
    `2. The code still fulfills the plan's goals and tasks`,
    `3. Code quality is improved according to the review feedback`,
    `4. All existing functionality is preserved`,
    `5. Proper error handling is maintained or improved`,
    `6. Tests are updated if necessary`,
    ``,
    `Focus on making targeted fixes that address the specific issues found during the review.`
  );

  return prompt.join('\n');
}
