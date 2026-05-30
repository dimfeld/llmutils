import * as z from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo, ExecutorOutput } from './types';
import type { TimConfig } from '../configSchema';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { executeReviewMode } from './codex_cli/review_mode';
import { executeBareMode } from './codex_cli/bare_mode';
import { executeOrchestratorMode } from './codex_cli/orchestrator_mode';
import { parseReviewerVerdict } from './codex_cli/verdict_parser';

export type CodexCliExecutorOptions = z.infer<typeof codexCliOptionsSchema>;

/**
 * Executor that runs the tim-generated context through the OpenAI Codex CLI.
 * For plan-backed normal/simple/TDD execution it sends one orchestration prompt to a
 * single Codex process, which coordinates the work by delegating to `tim subagent` and
 * `tim review` commands. Review, planning, and bare modes use their dedicated paths.
 */
export class CodexCliExecutor implements Executor {
  static name = CodexCliExecutorName;
  static description = 'Executes the plan using OpenAI Codex CLI (codex exec)';
  static optionsSchema = codexCliOptionsSchema;
  static defaultModel = {
    execution: 'gpt-5.5',
    answerPr: 'gpt-5.5',
  };
  static supportsSubagents = true;
  readonly supportsSubagents = true;

  constructor(
    public options: CodexCliExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public timConfig: TimConfig
  ) {}

  async execute(
    contextContent: string | undefined,
    planInfo: ExecutePlanInfo
  ): Promise<void | ExecutorOutput> {
    if (contextContent == null) {
      throw new Error('Prompt content is required for codex-cli executor');
    }

    if (planInfo.executionMode === 'review') {
      return executeReviewMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        this.sharedOptions.model,
        this.timConfig
      );
    }

    // Route both 'bare' and 'planning' to bare mode handler
    // This fixes the bug where 'planning' was falling through to normal mode
    if (planInfo.executionMode === 'bare' || planInfo.executionMode === 'planning') {
      return executeBareMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        this.sharedOptions.model,
        this.timConfig,
        {
          appServerMode:
            planInfo.planId === 'chat' || planInfo.executionMode === 'planning'
              ? 'chat-session'
              : 'single-turn',
          terminalInput: this.sharedOptions.terminalInput,
          reasoningLevel:
            planInfo.executionMode === 'planning'
              ? (this.timConfig.executors?.[CodexCliExecutorName]?.reasoning?.generate ?? 'high')
              : undefined,
        }
      );
    }

    const orchestratorSharedOptions =
      this.options.simpleMode === true && this.sharedOptions.simpleMode !== true
        ? { ...this.sharedOptions, simpleMode: true }
        : this.sharedOptions;

    // Resolve the orchestrator reasoning level. The orchestrator effort override
    // (config.orchestrator.effort.codex) is merged into the executor options by
    // agent.ts, so it lives on this.options.reasoning.default — prefer that over the
    // raw config default.
    const reasoningLevel =
      this.options.reasoning?.default ??
      this.timConfig.executors?.[CodexCliExecutorName]?.reasoning?.default ??
      'medium';

    return executeOrchestratorMode(
      contextContent,
      planInfo,
      this.sharedOptions.baseDir,
      this.sharedOptions.model,
      this.timConfig,
      orchestratorSharedOptions,
      reasoningLevel
    );
  }
}

// Re-export the verdict parser for backward compatibility
export { parseReviewerVerdict };
