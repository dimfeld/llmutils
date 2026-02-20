import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { TimConfig } from '../../configSchema';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas';
import { getGitRoot } from '../../../common/git';
import { log } from '../../../logging';
import { parseFailedReport } from '../failure_detection';
import { getReviewOutputJsonSchema } from '../../formatters/review_output_schema';
import { executeCodexStep } from './codex_runner';
import { isCodexAppServerEnabled } from './app_server_mode';
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
    isTaskScoped?: boolean,
    model?: string
  ) => Promise<string>;
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
  const reviewerOutput = await executor(
    contextContent,
    gitRoot,
    timConfig,
    planInfo.isTaskScoped,
    model
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
 * Executes a Codex review step with JSON schema for structured output.
 * Writes the schema to a temporary file and passes it via --output-schema flag.
 */
async function executeCodexReviewWithSchema(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  isTaskScoped?: boolean,
  model?: string
): Promise<string> {
  const useAppServer = isCodexAppServerEnabled();
  let tempDir: string | undefined;
  let schemaFilePath: string | undefined;

  try {
    const jsonSchema = getReviewOutputJsonSchema();
    // Codex requires this or else it throws an error
    jsonSchema.additionalProperties = false;

    if (!useAppServer) {
      // Create a temporary file for codex exec --output-schema
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-review-schema-'));
      schemaFilePath = path.join(tempDir, 'review-schema.json');
      await fs.writeFile(schemaFilePath, JSON.stringify(jsonSchema, null, 2));
    }

    // Get reasoning level from config, with defaults: medium for scoped, high for full
    const codexOptions = timConfig.executors?.[CodexCliExecutorName];
    const reasoningLevel: CodexReasoningLevel = isTaskScoped
      ? (codexOptions?.reasoning?.scopedReview ?? 'medium')
      : (codexOptions?.reasoning?.fullReview ?? 'high');

    // Use executeCodexStep with the schema file path and 30-minute timeout for reviews
    return await executeCodexStep(prompt, cwd, timConfig, {
      model,
      ...(schemaFilePath ? { outputSchemaPath: schemaFilePath } : {}),
      outputSchema: jsonSchema,
      inactivityTimeoutMs: REVIEW_TIMEOUT_MS,
      reasoningLevel,
    });
  } finally {
    // Clean up the temporary directory and schema file
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
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
