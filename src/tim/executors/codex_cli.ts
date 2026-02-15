import { z } from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo, ExecutorOutput } from './types';
import type { TimConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { executeNormalMode } from './codex_cli/normal_mode';
import { executeSimpleMode } from './codex_cli/simple_mode';
import { executeReviewMode } from './codex_cli/review_mode';
import { executeBareMode } from './codex_cli/bare_mode';
import { parseReviewerVerdict } from './codex_cli/verdict_parser';

export type CodexCliExecutorOptions = z.infer<typeof codexCliOptionsSchema>;

/**
 * Executor that runs the tim-generated context through the OpenAI Codex CLI.
 * It composes a single prompt that encapsulates the implement → test → review loop,
 * then invokes `codex exec` with that prompt.
 */
export class CodexCliExecutor implements Executor {
  static name = CodexCliExecutorName;
  static description = 'Executes the plan using OpenAI Codex CLI (codex exec)';
  static optionsSchema = codexCliOptionsSchema;
  static defaultModel = {
    execution: 'auto',
    answerPr: 'auto',
  };

  constructor(
    public options: CodexCliExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public timConfig: TimConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    // Use rmfilter to provide repo context; omit boilerplate instructions to reduce token usage
    return {
      rmfilter: false,
      // This is currently ignored
      model: 'gpt5-codex',
    } satisfies Partial<PrepareNextStepOptions>;
  }

  async execute(
    contextContent: string | undefined,
    planInfo: ExecutePlanInfo
  ): Promise<void | ExecutorOutput> {
    if (contextContent == null) {
      throw new Error('Prompt content is required for codex-cli executor');
    }

    const simpleModeEnabled = this.sharedOptions.simpleMode || this.options.simpleMode;

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
        this.timConfig
      );
    }

    if (planInfo.executionMode === 'tdd') {
      if (simpleModeEnabled) {
        return executeSimpleMode(
          contextContent,
          planInfo,
          this.sharedOptions.baseDir,
          this.sharedOptions.model,
          this.timConfig,
          this.sharedOptions.reviewExecutor
        );
      }

      return executeNormalMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        this.sharedOptions.model,
        this.timConfig,
        this.sharedOptions.reviewExecutor
      );
    }

    if (
      planInfo.executionMode === 'simple' ||
      (planInfo.executionMode === 'normal' && simpleModeEnabled)
    ) {
      return executeSimpleMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        this.sharedOptions.model,
        this.timConfig,
        this.sharedOptions.reviewExecutor
      );
    }
    return executeNormalMode(
      contextContent,
      planInfo,
      this.sharedOptions.baseDir,
      this.sharedOptions.model,
      this.timConfig,
      this.sharedOptions.reviewExecutor
    );
  }
}

// Re-export the verdict parser for backward compatibility
export { parseReviewerVerdict };
