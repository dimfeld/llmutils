import type { ExecutePlanInfo, ExecutorOutput } from '../types.js';
import type { TimConfig } from '../../configSchema.js';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas.js';
import { getGitRoot } from '../../../common/git.js';
import { log } from '../../../logging.js';
import { parseFailedReport } from '../failure_detection.js';
import { executeCodexStep, type CodexAppServerMode } from './codex_runner.js';

/**
 * Execute bare mode: single prompt with no orchestration or subagents.
 * This mode runs the provided prompt directly without any additional workflow.
 * Includes failure detection for consistency with other modes.
 */
export async function executeBareMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  timConfig: TimConfig,
  options?: {
    appServerMode?: CodexAppServerMode;
    terminalInput?: boolean;
    reasoningLevel?: CodexReasoningLevel;
  }
): Promise<void | ExecutorOutput> {
  const gitRoot = await getGitRoot(baseDir);

  // Get default reasoning level from config
  const codexOptions = timConfig.executors?.[CodexCliExecutorName];
  const defaultReasoningLevel: CodexReasoningLevel =
    options?.reasoningLevel ?? codexOptions?.reasoning?.default ?? 'medium';

  const codexStepOptions = {
    model,
    reasoningLevel: defaultReasoningLevel,
    ...(options?.appServerMode ? { appServerMode: options.appServerMode } : {}),
    ...(options?.terminalInput !== undefined ? { terminalInput: options.terminalInput } : {}),
  } as const;

  const output = await executeCodexStep(contextContent, gitRoot, timConfig, codexStepOptions);

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
}
