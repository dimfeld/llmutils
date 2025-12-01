import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { RmplanConfig } from '../../configSchema';
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
  reviewExecutor?: (prompt: string, cwd: string, config: RmplanConfig) => Promise<string>;
}

export async function executeReviewMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  _model: string | undefined,
  rmplanConfig: RmplanConfig,
  options?: ExecuteReviewModeOptions
): Promise<ExecutorOutput | void> {
  const gitRoot = await getGitRoot(baseDir);

  log('Running reviewer step with JSON schema output (review-only mode)...');

  // Use the injected executor for testing, or the default JSON schema executor
  const executor = options?.reviewExecutor ?? executeCodexReviewWithSchema;
  const reviewerOutput = await executor(contextContent, gitRoot, rmplanConfig);

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

/**
 * Executes a Codex review step with JSON schema for structured output.
 * Writes the schema to a temporary file and passes it via --output-schema flag.
 */
async function executeCodexReviewWithSchema(
  prompt: string,
  cwd: string,
  rmplanConfig: RmplanConfig
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

    // Use executeCodexStep with the schema file path
    return await executeCodexStep(prompt, cwd, rmplanConfig, schemaFilePath);
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
