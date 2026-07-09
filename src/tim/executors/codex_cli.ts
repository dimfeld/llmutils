import * as z from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo, ExecutorOutput } from './types';
import type { TimConfig } from '../configSchema';
import {
  CodexCliExecutorName,
  codexCliOptionsSchema,
  codexReasoningLevelSchema,
  type CodexReasoningLevel,
} from './schemas.js';
import { executeReviewMode } from './codex_cli/review_mode';
import { executeBareMode } from './codex_cli/bare_mode';
import { executeOrchestratorMode } from './codex_cli/orchestrator_mode';
import { parseReviewerVerdict } from './codex_cli/verdict_parser';

export type CodexCliExecutorOptions = z.infer<typeof codexCliOptionsSchema>;

/**
 * Separates an optional `:reasoning-effort` suffix from a Codex model name.
 * For example, `gpt-5.6-sol:high` runs `gpt-5.6-sol` with high reasoning.
 */
export function parseCodexModel(model: string | undefined): {
  model: string | undefined;
  reasoningLevel: CodexReasoningLevel | undefined;
} {
  if (!model) {
    return { model: undefined, reasoningLevel: undefined };
  }

  const separatorIndex = model.lastIndexOf(':');
  if (separatorIndex === -1) {
    return { model, reasoningLevel: undefined };
  }

  const modelName = model.slice(0, separatorIndex);
  const effort = model.slice(separatorIndex + 1);
  const parsedEffort = codexReasoningLevelSchema.safeParse(effort);
  if (!modelName || !parsedEffort.success) {
    throw new Error(
      `Invalid Codex model reasoning effort in "${model}". Use one of: low, medium, high, xhigh.`
    );
  }

  return { model: modelName, reasoningLevel: parsedEffort.data };
}

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
    execution: 'gpt-5.6-terra',
    answerPr: 'gpt-5.6-terra',
    stepGeneration: 'gpt-5.6-sol',
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

    const parsedModel = parseCodexModel(this.sharedOptions.model);

    if (planInfo.executionMode === 'review') {
      return executeReviewMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        parsedModel.model,
        this.timConfig,
        {
          timEnvironment: this.sharedOptions.timEnvironment,
          reasoningLevel: parsedModel.reasoningLevel,
        }
      );
    }

    // Route both 'bare' and 'planning' to bare mode handler
    // This fixes the bug where 'planning' was falling through to normal mode
    if (planInfo.executionMode === 'bare' || planInfo.executionMode === 'planning') {
      return executeBareMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        parsedModel.model,
        this.timConfig,
        {
          appServerMode:
            planInfo.interactiveSession === true ||
            planInfo.planId === 'chat' ||
            planInfo.executionMode === 'planning'
              ? 'chat-session'
              : 'single-turn',
          terminalInput: this.sharedOptions.terminalInput,
          timEnvironment: this.sharedOptions.timEnvironment,
          reasoningLevel:
            planInfo.executionMode === 'planning'
              ? (parsedModel.reasoningLevel ??
                this.options.reasoning?.default ??
                this.timConfig.executors?.[CodexCliExecutorName]?.reasoning?.generate ??
                'high')
              : parsedModel.reasoningLevel,
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
      parsedModel.reasoningLevel ??
      this.options.reasoning?.default ??
      this.timConfig.executors?.[CodexCliExecutorName]?.reasoning?.default ??
      'medium';

    return executeOrchestratorMode(
      contextContent,
      planInfo,
      this.sharedOptions.baseDir,
      parsedModel.model,
      this.timConfig,
      orchestratorSharedOptions,
      reasoningLevel
    );
  }
}

// Re-export the verdict parser for backward compatibility
export { parseReviewerVerdict };
