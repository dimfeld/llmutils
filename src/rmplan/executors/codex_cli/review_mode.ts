import type { ExecutePlanInfo, ExecutorOutput } from '../types';
import type { RmplanConfig } from '../../configSchema';
import { getGitRoot } from '../../../common/git';
import { log } from '../../../logging';
import { parseFailedReport } from '../failure_detection';
import { executeCodexStep } from './codex_runner';

export async function executeReviewMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  _model: string | undefined,
  rmplanConfig: RmplanConfig,
  codexStep: typeof executeCodexStep = executeCodexStep
): Promise<ExecutorOutput | void> {
  const gitRoot = await getGitRoot(baseDir);

  log('Running reviewer step (review-only mode)...');
  const reviewerOutput = await codexStep(contextContent, gitRoot, rmplanConfig);
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
