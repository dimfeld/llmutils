import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { TimConfig } from '../../configSchema';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas';
import { getGitRoot } from '../../../common/git';
import { log } from '../../../logging';
import { parseFailedReport } from '../failure_detection';
import { getReviewOutputJsonSchema } from '../../formatters/review_output_schema';
import { executeCodexStep } from './codex_runner';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/**
 * Options for executing review mode with testable dependencies.
 */
export interface ExecuteReviewModeOptions {
  /** Override the review execution function for testing */
  reviewExecutor?: (
    prompt: string,
    cwd: string,
    config: TimConfig,
    isTaskScoped?: boolean
  ) => Promise<string>;
}

export async function executeReviewMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  _model: string | undefined,
  timConfig: TimConfig,
  options?: ExecuteReviewModeOptions
): Promise<ExecutorOutput | void> {
  const gitRoot = await getGitRoot(baseDir);

  log('Running reviewer step with JSON schema output (review-only mode)...');

  // Use the injected executor for testing, or the default JSON schema executor
  const executor = options?.reviewExecutor ?? executeCodexReviewWithSchema;
  const reviewerOutput = await executor(contextContent, gitRoot, timConfig, planInfo.isTaskScoped);

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
 * Executes a Codex review step with JSON schema for structured output.
 * Writes the schema to a temporary file and passes it via --output-schema flag.
 */
async function executeCodexReviewWithSchema(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  isTaskScoped?: boolean
): Promise<string> {
  // Create a temporary file for the JSON schema
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-review-schema-'));
  const schemaFilePath = path.join(tempDir, 'review-schema.json');

  try {
    // Write the JSON schema to the temp file
    const jsonSchema = getReviewOutputJsonSchema();
    // Codex requires this or else it throws an error
    jsonSchema.additionalProperties = false;
    await fs.writeFile(schemaFilePath, JSON.stringify(jsonSchema, null, 2));

    // Get reasoning level from config, with defaults: medium for scoped, high for full
    const codexOptions = timConfig.executors?.[CodexCliExecutorName];
    const reasoningLevel: CodexReasoningLevel = isTaskScoped
      ? (codexOptions?.reasoning?.scopedReview ?? 'medium')
      : (codexOptions?.reasoning?.fullReview ?? 'high');

    // Use executeCodexStep with the schema file path and 30-minute timeout for reviews
    return await executeCodexStep(prompt, cwd, timConfig, {
      outputSchemaPath: schemaFilePath,
      inactivityTimeoutMs: REVIEW_TIMEOUT_MS,
      reasoningLevel,
    });
  } finally {
    // Clean up the temporary directory and schema file
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
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
