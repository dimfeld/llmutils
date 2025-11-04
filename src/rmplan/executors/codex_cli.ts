import { z } from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo, ExecutorOutput } from './types';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';
import { executeNormalMode } from './codex_cli/normal_mode';
import { executeSimpleMode } from './codex_cli/simple_mode';
import { parseReviewerVerdict } from './codex_cli/verdict_parser';

export type CodexCliExecutorOptions = z.infer<typeof codexCliOptionsSchema>;

/**
 * Executor that runs the rmplan-generated context through the OpenAI Codex CLI.
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
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    // Use rmfilter to provide repo context; omit boilerplate instructions to reduce token usage
    return {
      rmfilter: false,
      // This is currently ignored
      model: 'gpt5-codex',
    } satisfies Partial<PrepareNextStepOptions>;
  }

  async execute(contextContent: string, planInfo: ExecutePlanInfo): Promise<void | ExecutorOutput> {
    if (
      planInfo.executionMode === 'simple' ||
      (planInfo.executionMode === 'normal' &&
        (this.sharedOptions.simpleMode || this.options.simpleMode))
    ) {
      return executeSimpleMode(
        contextContent,
        planInfo,
        this.sharedOptions.baseDir,
        this.sharedOptions.model,
        this.rmplanConfig
      );
    }
    return executeNormalMode(
      contextContent,
      planInfo,
      this.sharedOptions.baseDir,
      this.sharedOptions.model,
      this.rmplanConfig
    );
  }
}

// Re-export the verdict parser for backward compatibility
export { parseReviewerVerdict };
