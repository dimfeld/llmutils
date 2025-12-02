import type { ExecutePlanInfo, ExecutorOutput } from '../types.js';
import type { RmplanConfig } from '../../configSchema.js';
import { getGitRoot } from '../../../common/git.js';
import { log } from '../../../logging.js';
import { parseFailedReport } from '../failure_detection.js';
import { executeCodexStep } from './codex_runner.js';

/**
 * Execute bare mode: single prompt with no orchestration or subagents.
 * This mode runs the provided prompt directly without any additional workflow.
 * Includes failure detection for consistency with other modes.
 */
export async function executeBareMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  _model: string | undefined,
  rmplanConfig: RmplanConfig
): Promise<void | ExecutorOutput> {
  const gitRoot = await getGitRoot(baseDir);

  log('Running bare mode (single prompt, no orchestration)...');
  const output = await executeCodexStep(contextContent, gitRoot, rmplanConfig);

  log('Bare mode execution complete.');

  // Parse for failures (included for consistency with other modes)
  const parsed = parseFailedReport(output);

  // Handle output capture
  if (planInfo.captureOutput === 'all' || planInfo.captureOutput === 'result') {
    const result: ExecutorOutput = {
      content: output,
      metadata: { phase: 'bare' },
    };

    if (parsed.failed) {
      result.success = false;
      result.failureDetails = parsed.details
        ? { ...parsed.details, sourceAgent: 'bare' }
        : {
            requirements: '',
            problems: parsed.summary || 'FAILED',
            sourceAgent: 'bare',
          };
    }

    return result;
  }

  // For 'none' capture mode, return void
  return;
}
