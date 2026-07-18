import type { TimConfig } from './configSchema.js';
import type { ExecutorCommonOptions, Executor } from './executors/types.js';
import { buildExecutorAndLog, DEFAULT_EXECUTOR } from './executors/index.js';
import { getParentExecutor, type TimExecutorType } from '../common/process.js';
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

export const REVIEW_EXECUTOR_NAMES = ['claude-code', 'codex-cli'] as const;
export type ReviewExecutorName = (typeof REVIEW_EXECUTOR_NAMES)[number];
export type ReviewExecutorSelection = ReviewExecutorName | 'both';

export type ReviewPromptBuilder = (options: {
  executorName: ReviewExecutorName;
  includeDiff: boolean;
  useSubagents: boolean;
}) => string;

export type StructuralReviewPromptBuilder = (options: {
  executorName: Extract<ReviewExecutorName, 'codex-cli'>;
}) => string;

type ReviewExecutionPhase = 'primary-code-review' | 'structural-simplification-review';
type ReviewExecutionResult =
  | { name: ReviewExecutorName; phase: ReviewExecutionPhase; rawOutput: string }
  | { name: ReviewExecutorName; phase: ReviewExecutionPhase; error: unknown };

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
  phase: ReviewExecutionPhase;
}

export interface PrepareReviewExecutorsOptions {
  executorSelection?: string;
  config: TimConfig;
  sharedExecutorOptions: ExecutorCommonOptions;
  buildPrompt: ReviewPromptBuilder;
}

export interface ReviewRunOptions extends PrepareReviewExecutorsOptions {
  planInfo: ReviewPlanInfo;
  allowPartialFailures?: boolean;
  /** When true and both executors are selected, run Claude first then conditionally Codex. */
  serialBoth?: boolean;
  /** Optional Codex-only structural simplification review for full-plan runs. */
  buildStructuralPrompt?: StructuralReviewPromptBuilder;
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

  log(
    `Using executor "${resolved}" (CLI: ${executorSelection}, config: ${config.review?.defaultExecutor}, default: ${config.defaultExecutor})`
  );

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
    const useSubagents = executor.supportsSubagents === true;
    const prompt = options.buildPrompt({ executorName, includeDiff: false, useSubagents });

    return {
      name: executorName,
      executor,
      prompt,
      phase: 'primary-code-review',
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
): Promise<ReviewExecutionResult> {
  const maxAttempts = MAX_TIMEOUT_RETRIES + 1;
  const phaseLabel = formatReviewExecutionLabel(prepared);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      log(`Starting ${phaseLabel}...`);
      const executorOutput = await prepared.executor.execute(prepared.prompt, {
        planId: planInfo.planId,
        planTitle: planInfo.planTitle,
        planFilePath: planInfo.planFilePath,
        captureOutput: 'result',
        executionMode: 'review',
        isTaskScoped: planInfo.isTaskScoped,
      });

      log(`Finished ${phaseLabel}.`);
      const rawOutput = normalizeReviewOutput(executorOutput);
      return { name: prepared.name, phase: prepared.phase, rawOutput };
    } catch (error) {
      if (isTimeoutError(error) && attempt < maxAttempts) {
        log(`${phaseLabel} timed out, retrying (attempt ${attempt + 1}/${maxAttempts})...`);
        continue;
      }
      return { name: prepared.name, phase: prepared.phase, error };
    }
  }

  // Should not reach here, but satisfy TypeScript
  return {
    name: prepared.name,
    phase: prepared.phase,
    error: new Error('Max retry attempts exceeded'),
  };
}

function formatReviewExecutionLabel(
  prepared: Pick<PreparedReviewExecutor, 'name' | 'phase'>
): string {
  switch (prepared.phase) {
    case 'primary-code-review':
      return `${prepared.name} primary code review`;
    case 'structural-simplification-review':
      return `${prepared.name} structural simplification review`;
  }
}

export async function runReview(options: ReviewRunOptions): Promise<ReviewRunResult> {
  const preparedExecutors = await prepareReviewExecutors(options);
  const warnings: string[] = [];
  const executorOutputs: Partial<Record<ReviewExecutorName, string>> = {};
  const shouldRunSerial = options.serialBoth === true && preparedExecutors.length > 1;

  const structuralPreparedExecutor = options.buildStructuralPrompt
    ? {
        name: 'codex-cli' as const,
        executor: buildExecutorAndLog('codex-cli', options.sharedExecutorOptions, options.config),
        prompt: options.buildStructuralPrompt({ executorName: 'codex-cli' }),
        phase: 'structural-simplification-review' as const,
      }
    : null;
  if (structuralPreparedExecutor) {
    log('Queued codex-cli structural simplification review.');
  }

  const allPreparedExecutors = structuralPreparedExecutor
    ? [...preparedExecutors, structuralPreparedExecutor]
    : preparedExecutors;

  const executionResults = shouldRunSerial
    ? await runExecutorsSerially(allPreparedExecutors, options.planInfo)
    : await Promise.all(
        allPreparedExecutors.map((prepared) => executeWithRetry(prepared, options.planInfo))
      );

  // Process results and parse outputs
  const results = executionResults.map((result) => {
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
      warnings.push(formatReviewExecutorError(result.name, result.phase, result.error));
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
    usedExecutors: [...new Set(successfulResults.map((result) => result.name))],
    warnings,
  };
}

async function runExecutorsSerially(
  preparedExecutors: PreparedReviewExecutor[],
  planInfo: ReviewPlanInfo
): Promise<ReviewExecutionResult[]> {
  const results: ReviewExecutionResult[] = [];

  const primary = preparedExecutors.find((executor) => executor.name === 'claude-code');
  const fallbackPrimary = primary ?? preparedExecutors[0];
  const remainingExecutors = preparedExecutors.filter((executor) => executor !== fallbackPrimary);

  const firstResult = await executeWithRetry(fallbackPrimary, planInfo);
  results.push(firstResult);

  if ('rawOutput' in firstResult && remainingExecutors.length > 0) {
    const parsed = parseJsonReviewOutput(firstResult.rawOutput);
    const hasBlockingIssues = parsed.issues.some((issue) => issue.severity !== 'info');
    if (!hasBlockingIssues) {
      results.push(
        ...(await Promise.all(
          remainingExecutors.map((executor) => executeWithRetry(executor, planInfo))
        ))
      );
    }
  }

  return results;
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

function formatReviewExecutorError(
  name: ReviewExecutorName,
  phase: ReviewExecutionPhase,
  error: unknown
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Review executor '${name}' (${formatReviewExecutionLabel({ name, phase })}) failed: ${message}`;
}

function mergeReviewOutputs(
  results: Array<{ name: ReviewExecutorName; parsed: ReturnType<typeof parseJsonReviewOutput> }>
): ReviewOutput {
  const issues: ReviewIssue[] = results.flatMap((result) =>
    result.parsed.issues.map((issue) => ({ ...issue, source: result.name }))
  );
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
