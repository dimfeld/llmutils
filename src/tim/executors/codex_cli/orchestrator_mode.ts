import { getGitRoot, getUsingJj } from '../../../common/git.js';
import type { TimConfig } from '../../configSchema.js';
import {
  detectFailedLineAnywhere,
  inferFailedAgent,
  parseFailedReportAnywhere,
} from '../failure_detection.js';
import { CodexCliExecutorName, type CodexReasoningLevel } from '../schemas.js';
import type { ExecutorCommonOptions, ExecutePlanInfo, ExecutorOutput } from '../types.js';
import {
  wrapWithOrchestration,
  wrapWithOrchestrationSimple,
  wrapWithOrchestrationTdd,
} from '../shared/orchestrator_prompt.ts';
import { executeCodexStep } from './codex_runner.js';

export async function executeOrchestratorMode(
  contextContent: string,
  planInfo: ExecutePlanInfo,
  baseDir: string,
  model: string | undefined,
  timConfig: TimConfig,
  sharedOptions: ExecutorCommonOptions,
  reasoningLevel?: CodexReasoningLevel
): Promise<void | ExecutorOutput> {
  const gitRoot = await getGitRoot(baseDir);
  const defaultReasoning: CodexReasoningLevel =
    reasoningLevel ?? timConfig.executors?.[CodexCliExecutorName]?.reasoning?.default ?? 'medium';

  let promptContent = contextContent;
  const planId = planInfo.planId;
  const planFilePath = planInfo.planFilePath;
  const planContextAvailable = planId.trim().length > 0 && planFilePath.trim().length > 0;

  if (planContextAvailable) {
    const useJj = await getUsingJj(baseDir);
    // Codex does not use Claude's `@` file-prefix semantics, so plan file references
    // must be passed as raw paths.
    const useAtPrefix = false;
    const simpleMode = sharedOptions.simpleMode === true;

    if (planInfo.executionMode === 'tdd') {
      promptContent = wrapWithOrchestrationTdd(promptContent, planId, {
        batchMode: planInfo.batchMode,
        planFilePath,
        simpleMode,
        reviewExecutor: sharedOptions.reviewExecutor,
        subagentExecutor: sharedOptions.subagentExecutor,
        dynamicSubagentInstructions: sharedOptions.dynamicSubagentInstructions,
        useJj,
        useAtPrefix,
      });
    } else if (planInfo.executionMode === 'simple' || simpleMode) {
      // Preserve the old Codex routing semantics: normal execution with simple mode
      // enabled (via executor options or shared options) uses the simple wrapper.
      promptContent = wrapWithOrchestrationSimple(promptContent, planId, {
        batchMode: planInfo.batchMode,
        planFilePath,
        subagentExecutor: sharedOptions.subagentExecutor,
        dynamicSubagentInstructions: sharedOptions.dynamicSubagentInstructions,
        useJj,
        useAtPrefix,
      });
    } else {
      promptContent = wrapWithOrchestration(promptContent, planId, {
        batchMode: planInfo.batchMode,
        planFilePath,
        reviewExecutor: sharedOptions.reviewExecutor,
        subagentExecutor: sharedOptions.subagentExecutor,
        dynamicSubagentInstructions: sharedOptions.dynamicSubagentInstructions,
        useJj,
        useAtPrefix,
      });
    }
  }

  const output = await executeCodexStep(promptContent, gitRoot, timConfig, {
    model,
    reasoningLevel: defaultReasoning,
    appServerMode: 'single-turn-with-steering',
    terminalInput: sharedOptions.terminalInput,
  });

  const parsed = parseFailedReportAnywhere(output);
  if (parsed.failed) {
    const failedLine = detectFailedLineAnywhere(output);
    const sourceAgent = inferFailedAgent(
      failedLine.failed ? failedLine.summary : undefined,
      output
    );

    return {
      content: output,
      metadata: { phase: 'orchestrator' },
      success: false,
      failureDetails: parsed.details
        ? { ...parsed.details, sourceAgent }
        : {
            requirements: '',
            problems: parsed.summary || 'FAILED',
            sourceAgent,
          },
    };
  }

  if (planInfo.captureOutput === 'all' || planInfo.captureOutput === 'result') {
    return {
      content: output,
      metadata: { phase: 'orchestrator' },
    };
  }
}
