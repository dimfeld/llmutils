import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { TimConfig } from '../../configSchema';
import type { TimWorkspaceCommandEnvironmentOptions } from '../../../common/env.js';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas';
import { getGitRoot } from '../../../common/git';
import { log } from '../../../logging';
import { parseFailedReport } from '../failure_detection';
import { getReviewOutputJsonSchema } from '../../formatters/review_output_schema';
import { executeCodexStep } from './codex_runner';

/**
 * Options for executing review mode with testable dependencies.
 */
export interface ExecuteReviewModeOptions {
  /** Override the review execution function for testing */
  reviewExecutor?: (
    prompt: string,
    cwd: string,
    config: TimConfig,
    isTaskScoped?: boolean,
    model?: string,
    timEnvironment?: TimWorkspaceCommandEnvironmentOptions,
    reasoningLevel?: CodexReasoningLevel
  ) => Promise<string>;
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  /** Reasoning effort parsed from a model suffix, which takes precedence over config. */
  reasoningLevel?: CodexReasoningLevel;
}

export async function executeReviewMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  timConfig: TimConfig,
  options?: ExecuteReviewModeOptions
): Promise<ExecutorOutput | void> {
  const gitRoot = await getGitRoot(baseDir);

  log('Running Codex reviewer step in review-only mode with JSON schema output...');

  // Use the injected executor for testing, or the default JSON schema executor
  const executor = options?.reviewExecutor ?? executeCodexReviewWithSchema;
  const reviewerOutput =
    options?.reasoningLevel === undefined
      ? await executor(
          contextContent,
          gitRoot,
          timConfig,
          planInfo.isTaskScoped,
          model,
          options?.timEnvironment
        )
      : await executor(
          contextContent,
          gitRoot,
          timConfig,
          planInfo.isTaskScoped,
          model,
          options.timEnvironment,
          options.reasoningLevel
        );

  log('Reviewer output captured.');

  const parsed = parseFailedReport(reviewerOutput);
  const aggregated = buildAggregatedOutput(reviewerOutput, planInfo, parsed);

  if (parsed.failed) {
    return (
      aggregated ?? {
        content: reviewerOutput,
        success: false,
        failureDetails: parsed.details
          ? { ...parsed.details, sourceAgent: 'reviewer' }
          : {
              requirements: '',
              problems: parsed.summary || 'FAILED',
              sourceAgent: 'reviewer',
            },
      }
    );
  }

  return aggregated;
}

// 30-minute timeout for review mode
const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Executes a Codex review step with a JSON schema for structured output.
 */
async function executeCodexReviewWithSchema(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  isTaskScoped?: boolean,
  model?: string,
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions,
  reasoningLevel?: CodexReasoningLevel
): Promise<string> {
  const jsonSchema = getReviewOutputJsonSchema();
  // Codex requires this or else it throws an error
  jsonSchema.additionalProperties = false;

  // Get reasoning level from config, with defaults: medium for scoped, high for full
  const codexOptions = timConfig.executors?.[CodexCliExecutorName];
  const resolvedReasoningLevel: CodexReasoningLevel =
    reasoningLevel ??
    (isTaskScoped
      ? (codexOptions?.reasoning?.scopedReview ?? 'medium')
      : (codexOptions?.reasoning?.fullReview ?? 'high'));

  return await executeCodexStep(prompt, cwd, timConfig, {
    model,
    outputSchema: jsonSchema,
    inactivityTimeoutMs: REVIEW_TIMEOUT_MS,
    reasoningLevel: resolvedReasoningLevel,
    timEnvironment,
  });
}

function buildAggregatedOutput(
  reviewerOutput: string,
  planInfo: ExecutePlanInfo,
  parsed: ReturnType<typeof parseFailedReport>
): ExecutorOutput | undefined {
  if (planInfo.captureOutput !== 'all' && planInfo.captureOutput !== 'result') {
    return undefined;
  }

  const trimmed = reviewerOutput.trim();
  const output: ExecutorOutput = {
    content: trimmed,
    steps: [{ title: 'Codex Reviewer', body: trimmed }],
    metadata: { phase: 'review', jsonOutput: true },
  };

  if (parsed.failed) {
    output.success = false;
    output.failureDetails = parsed.details
      ? { ...parsed.details, sourceAgent: 'reviewer' }
      : {
          requirements: '',
          problems: parsed.summary || 'FAILED',
          sourceAgent: 'reviewer',
        };
  }

  return output;
}
