import type { TimConfig } from './configSchema.js';
import type { ExecutorCommonOptions, Executor } from './executors/types.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from './executors/index.js';
import { getParentExecutor, type TimExecutorType } from '../common/process.js';
import { getGitRoot } from '../common/git.js';
import {
  createReviewResult,
  parseJsonReviewOutput,
  type ReviewIssue,
  type ReviewResult,
} from './formatters/review_formatter.js';
import {
  ReviewOutputSchema,
  type ReviewOutput,
  type ReviewIssueOutput,
} from './formatters/review_output_schema.js';
import { log } from '../logging.js';
import { getReviewGuidePath } from './review_guide.js';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const REVIEW_EXECUTOR_NAMES = ['claude-code', 'codex-cli'] as const;
export type ReviewExecutorName = (typeof REVIEW_EXECUTOR_NAMES)[number];
export type ReviewExecutorSelection = ReviewExecutorName | 'both';

export type ReviewPromptBuilder = (options: {
  executorName: ReviewExecutorName;
  includeDiff: boolean;
  useSubagents: boolean;
  reviewGuidePath?: string;
}) => string;

export type AnalysisPromptBuilder = () => Promise<string>;

export interface ReviewPlanInfo {
  planId: string;
  planTitle: string;
  planFilePath: string;
  baseBranch: string;
  changedFiles: string[];
  /** When true, this review is scoped to specific tasks (not the full plan) */
  isTaskScoped?: boolean;
}

export interface PreparedReviewExecutor {
  name: ReviewExecutorName;
  executor: Executor;
  prompt: string;
}

export interface PrepareReviewExecutorsOptions {
  executorSelection?: string;
  config: TimConfig;
  sharedExecutorOptions: ExecutorCommonOptions;
  buildPrompt: ReviewPromptBuilder;
}

export interface ReviewRunOptions extends PrepareReviewExecutorsOptions {
  buildAnalysisPrompt: AnalysisPromptBuilder;
  planInfo: ReviewPlanInfo;
  allowPartialFailures?: boolean;
}

export interface ReviewRunResult {
  reviewResult: ReviewResult;
  rawOutput: string;
  executorOutputs: Partial<Record<ReviewExecutorName, string>>;
  usedExecutors: ReviewExecutorName[];
  warnings: string[];
}

/** Maps the parent executor type to the corresponding review executor name */
const PARENT_EXECUTOR_TO_REVIEW_EXECUTOR: Record<TimExecutorType, ReviewExecutorName> = {
  claude: 'claude-code',
  codex: 'codex-cli',
};

export function resolveReviewExecutorSelection(
  executorSelection: string | undefined,
  config: TimConfig
): ReviewExecutorSelection {
  // Check CLI option and config settings first
  let resolved =
    executorSelection || config.review?.defaultExecutor || config.defaultExecutor || undefined;

  // If no explicit config, check if we're running under an executor and use that
  if (!resolved) {
    const parentExecutor = getParentExecutor();
    if (parentExecutor) {
      resolved = PARENT_EXECUTOR_TO_REVIEW_EXECUTOR[parentExecutor];
    }
  }

  // Fall back to default executor
  resolved = resolved || DEFAULT_EXECUTOR;

  if (resolved === 'both') {
    return 'both';
  }

  if (!REVIEW_EXECUTOR_NAMES.includes(resolved as ReviewExecutorName)) {
    throw new Error(
      `Unsupported review executor '${resolved}'. Supported executors: ${[...REVIEW_EXECUTOR_NAMES, 'both'].join(', ')}`
    );
  }

  return resolved as ReviewExecutorName;
}

export async function prepareReviewExecutors(
  options: PrepareReviewExecutorsOptions
): Promise<PreparedReviewExecutor[]> {
  const selection = resolveReviewExecutorSelection(options.executorSelection, options.config);
  const executorNames = selection === 'both' ? [...REVIEW_EXECUTOR_NAMES] : [selection];

  return executorNames.map((executorName) => {
    const executor = buildExecutorAndLog(
      executorName,
      options.sharedExecutorOptions,
      options.config
    );
    const prompt = options.buildPrompt({ executorName, includeDiff: false, useSubagents: true });

    return {
      name: executorName,
      executor,
      prompt,
    };
  });
}

// Maximum retry attempts on timeout (1 = retry once, so 2 total attempts)
const MAX_TIMEOUT_RETRIES = 1;

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // Claude Code uses "timed out", Codex uses "terminated after inactivity"
  return (
    error.message.includes('timed out') || error.message.includes('terminated after inactivity')
  );
}

async function executeWithRetry(
  prepared: PreparedReviewExecutor,
  planInfo: ReviewPlanInfo
): Promise<
  { name: ReviewExecutorName; rawOutput: string } | { name: ReviewExecutorName; error: unknown }
> {
  const maxAttempts = MAX_TIMEOUT_RETRIES + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const executorOutput = await prepared.executor.execute(prepared.prompt, {
        planId: planInfo.planId,
        planTitle: planInfo.planTitle,
        planFilePath: planInfo.planFilePath,
        captureOutput: 'result',
        executionMode: 'review',
        isTaskScoped: planInfo.isTaskScoped,
      });

      log(`${prepared.name} review finished`);
      const rawOutput = normalizeReviewOutput(executorOutput);
      return { name: prepared.name, rawOutput };
    } catch (error) {
      if (isTimeoutError(error) && attempt < maxAttempts) {
        log(
          `${prepared.name} review timed out, retrying (attempt ${attempt + 1}/${maxAttempts})...`
        );
        continue;
      }
      return { name: prepared.name, error };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return { name: prepared.name, error: new Error('Max retry attempts exceeded') };
}

function createExecutePlanInfo(planInfo: ReviewPlanInfo) {
  return {
    planId: planInfo.planId,
    planTitle: planInfo.planTitle,
    planFilePath: planInfo.planFilePath,
    captureOutput: 'result' as const,
    executionMode: 'review' as const,
    isTaskScoped: planInfo.isTaskScoped,
  };
}

async function executeAnalysisPhase(
  executorName: ReviewExecutorName,
  executor: Executor,
  prompt: string,
  planInfo: ReviewPlanInfo
): Promise<{ sessionId?: string }> {
  if (!executor.executeAnalysisPhase) {
    log(
      `Review executor '${executorName}' does not expose analysis mode; skipping analysis phase.`
    );
    return {};
  }

  const result = await executor.executeAnalysisPhase(prompt, createExecutePlanInfo(planInfo));
  if (
    executorName === 'claude-code' &&
    (!result || typeof result !== 'object' || !('sessionId' in result) || !result.sessionId)
  ) {
    throw new Error('Claude review analysis completed without a session id.');
  }

  return result && typeof result === 'object' && 'sessionId' in result
    ? { sessionId: result.sessionId }
    : {};
}

async function executeClaudeReviewWithResume(
  prompt: string,
  executor: Executor,
  planInfo: ReviewPlanInfo,
  sessionId: string
): Promise<
  { name: ReviewExecutorName; rawOutput: string } | { name: ReviewExecutorName; error: unknown }
> {
  const maxAttempts = MAX_TIMEOUT_RETRIES + 1;

  if (!executor.executeReviewModeWithResume) {
    return executeWithRetry(
      {
        name: 'claude-code',
        executor,
        prompt,
      },
      planInfo
    );
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const executorOutput = await executor.executeReviewModeWithResume(
        prompt,
        createExecutePlanInfo(planInfo),
        sessionId
      );

      log(`claude-code review finished`);
      const rawOutput = normalizeReviewOutput(executorOutput);
      return { name: 'claude-code', rawOutput };
    } catch (error) {
      if (isTimeoutError(error) && attempt < maxAttempts) {
        log(`claude-code review timed out, retrying (attempt ${attempt + 1}/${maxAttempts})...`);
        continue;
      }
      return { name: 'claude-code', error };
    }
  }

  return { name: 'claude-code', error: new Error('Max retry attempts exceeded') };
}

export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const selection = resolveReviewExecutorSelection(options.executorSelection, options.config);
  const executorNames = selection === 'both' ? [...REVIEW_EXECUTOR_NAMES] : [selection];
  const warnings: string[] = [];
  const executorOutputs: Partial<Record<ReviewExecutorName, string>> = {};
  const gitRoot = await getGitRoot(options.sharedExecutorOptions.baseDir);
  const reviewGuidePath = getReviewGuidePath(options.planInfo.planId);
  const reviewGuideAbsolutePath = join(gitRoot, reviewGuidePath);

  await mkdir(join(gitRoot, '.tim', 'tmp'), { recursive: true });
  await unlink(reviewGuideAbsolutePath).catch(() => {});

  let executionResults:
    | Array<
        | { name: ReviewExecutorName; rawOutput: string }
        | { name: ReviewExecutorName; error: unknown }
      >
    | undefined;

  try {
    const analysisExecutorName: ReviewExecutorName = executorNames.includes('claude-code')
      ? 'claude-code'
      : 'codex-cli';
    const analysisExecutor = buildExecutorAndLog(
      analysisExecutorName,
      options.sharedExecutorOptions,
      options.config
    );
    const analysisPrompt = await options.buildAnalysisPrompt();
    const analysisResult = await executeAnalysisPhase(
      analysisExecutorName,
      analysisExecutor,
      analysisPrompt,
      options.planInfo
    );
    const sessionId = analysisResult.sessionId;

    const preparedExecutors = executorNames.map((executorName) => {
      // Reuse the analysis executor for Claude to avoid duplicate construction
      const executor =
        executorName === analysisExecutorName
          ? analysisExecutor
          : buildExecutorAndLog(executorName, options.sharedExecutorOptions, options.config);
      const prompt = options.buildPrompt({
        executorName,
        includeDiff: false,
        useSubagents: true,
        reviewGuidePath,
      });

      return {
        name: executorName,
        executor,
        prompt,
      } satisfies PreparedReviewExecutor;
    });

    executionResults = await Promise.all(
      preparedExecutors.map((prepared) => {
        if (prepared.name === 'claude-code' && sessionId) {
          return executeClaudeReviewWithResume(
            prepared.prompt,
            prepared.executor,
            options.planInfo,
            sessionId
          );
        }

        return executeWithRetry(prepared, options.planInfo);
      })
    );
  } finally {
    await unlink(reviewGuideAbsolutePath).catch(() => {});
  }

  // Process results and parse outputs
  const results = (executionResults ?? []).map((result) => {
    if ('error' in result) {
      return result;
    }

    executorOutputs[result.name] = result.rawOutput;
    const parsed = parseJsonReviewOutput(result.rawOutput);
    return {
      name: result.name,
      parsed,
      rawOutput: result.rawOutput,
    };
  });

  const successfulResults = results.filter(
    (
      result
    ): result is {
      name: ReviewExecutorName;
      parsed: ReturnType<typeof parseJsonReviewOutput>;
      rawOutput: string;
    } => 'parsed' in result
  );

  for (const result of results) {
    if ('error' in result) {
      warnings.push(formatReviewExecutorError(result.name, result.error));
    }
  }

  if (successfulResults.length === 0) {
    if (results.length === 1 && 'error' in results[0]) {
      const error = results[0].error;
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(String(error));
    }

    const message =
      warnings.length > 0
        ? `Review failed. ${warnings.join(' ')}`
        : 'Review failed. No valid review output was produced.';
    throw new Error(message);
  }

  if (warnings.length > 0 && options.allowPartialFailures === false) {
    throw new Error(`Review failed due to executor errors. ${warnings.join(' ')}`);
  }

  const mergedOutput = mergeReviewOutputs(successfulResults);
  const rawOutput = JSON.stringify(mergedOutput, null, 2);
  const reviewResult = createReviewResult(
    options.planInfo.planId,
    options.planInfo.planTitle,
    options.planInfo.baseBranch,
    options.planInfo.changedFiles,
    rawOutput
  );

  return {
    reviewResult,
    rawOutput,
    executorOutputs,
    usedExecutors: successfulResults.map((result) => result.name),
    warnings,
  };
}

function normalizeReviewOutput(executorOutput: unknown): string {
  if (typeof executorOutput === 'string') {
    return executorOutput;
  }

  if (
    executorOutput &&
    typeof executorOutput === 'object' &&
    'structuredOutput' in executorOutput
  ) {
    const structuredOutput = executorOutput.structuredOutput;
    const validated = ReviewOutputSchema.safeParse(structuredOutput);
    if (validated.success) {
      return JSON.stringify(validated.data);
    }
  }

  if (executorOutput && typeof executorOutput === 'object' && 'content' in executorOutput) {
    const content = executorOutput.content;
    if (typeof content === 'string') {
      return content;
    }
  }

  throw new Error('Review executor returned no output.');
}

function formatReviewExecutorError(name: ReviewExecutorName, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Review executor '${name}' failed: ${message}`;
}

function mergeReviewOutputs(
  results: Array<{ name: ReviewExecutorName; parsed: ReturnType<typeof parseJsonReviewOutput> }>
): ReviewOutput {
  const issues: ReviewIssue[] = results.flatMap((result) => result.parsed.issues);
  const recommendations = results.flatMap((result) => result.parsed.recommendations);
  const actionItems = results.flatMap((result) => result.parsed.actionItems);

  const sortedIssues = sortIssuesByLocation(issues);

  return {
    issues: sortedIssues as ReviewIssueOutput[],
    recommendations,
    actionItems,
  };
}

function sortIssuesByLocation<T extends { file?: string; line?: string | number }>(
  issues: T[]
): T[] {
  const decorated = issues.map((issue, index) => ({ issue, index }));

  decorated.sort((a, b) => {
    const fileCompare = compareOptionalString(a.issue.file, b.issue.file);
    if (fileCompare !== 0) {
      return fileCompare;
    }

    const lineCompare = compareOptionalLine(a.issue.line, b.issue.line);
    if (lineCompare !== 0) {
      return lineCompare;
    }

    return a.index - b.index;
  });

  return decorated.map((entry) => entry.issue);
}

function compareOptionalString(a?: string, b?: string): number {
  const hasA = Boolean(a && a.length > 0);
  const hasB = Boolean(b && b.length > 0);

  if (hasA && !hasB) {
    return -1;
  }
  if (!hasA && hasB) {
    return 1;
  }
  if (!hasA && !hasB) {
    return 0;
  }

  return a!.localeCompare(b!);
}

function compareOptionalLine(a?: number | string, b?: number | string): number {
  const hasA = a !== undefined && a !== null && `${a}`.length > 0;
  const hasB = b !== undefined && b !== null && `${b}`.length > 0;

  if (hasA && !hasB) {
    return -1;
  }
  if (!hasA && hasB) {
    return 1;
  }
  if (!hasA && !hasB) {
    return 0;
  }

  const lineA = parseLineNumber(a!);
  const lineB = parseLineNumber(b!);

  if (Number.isFinite(lineA) && Number.isFinite(lineB) && lineA !== lineB) {
    return lineA - lineB;
  }

  return `${a}`.localeCompare(`${b}`);
}

function parseLineNumber(line: number | string): number {
  if (typeof line === 'number') {
    return line;
  }

  const match = line.match(/\d+/);
  if (!match) {
    return Number.NaN;
  }

  return Number.parseInt(match[0], 10);
}
