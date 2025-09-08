import { z } from 'zod/v4';
import type { Executor, ExecutorCommonOptions, ExecutePlanInfo } from './types';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step';
import { getGitRoot } from '../../common/git';
import { spawnAndLogOutput } from '../../common/process';
import { log, error } from '../../logging';
import { buildCodexOrchestrationPrompt } from './codex_cli/prompt';
import { CodexCliExecutorName, codexCliOptionsSchema } from './schemas.js';

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

  constructor(
    public options: CodexCliExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    // Use rmfilter to provide repo context; omit boilerplate instructions to reduce token usage
    return {
      rmfilter: true,
      rmfilterArgs: ['--omit-top-instructions'],
      // Model is not used by Codex CLI directly; it reads its own configuration
    } satisfies Partial<PrepareNextStepOptions>;
  }

  async execute(contextContent: string, planInfo: ExecutePlanInfo): Promise<void | string> {
    // If caller wants to capture what we would send, just return the composed prompt
    if (planInfo.captureOutput && planInfo.captureOutput !== 'none') {
      return buildCodexOrchestrationPrompt(contextContent, {
        planId: planInfo.planId,
        planTitle: planInfo.planTitle,
        planFilePath: planInfo.planFilePath,
        batchMode: planInfo.batchMode === true,
      });
    }

    const cwd = await getGitRoot(this.sharedOptions.baseDir);
    const prompt = buildCodexOrchestrationPrompt(contextContent, {
      planId: planInfo.planId,
      planTitle: planInfo.planTitle,
      planFilePath: planInfo.planFilePath,
      batchMode: planInfo.batchMode === true,
    });

    // Run `codex exec "<prompt>"` and stream output to the user
    const { exitCode } = await spawnAndLogOutput(
      [
        'codex',
        'exec',
        // We don't have interactive mode for permissions yet
        '--ask-for-approval',
        'never',
        // Defaults to read-only in exec mode, so allow writing to the workspace
        '--sandbox',
        '--workspace-write',
        prompt,
      ],
      {
        cwd,
      }
    );

    if (exitCode !== 0) {
      error(`codex exec exited with code ${exitCode}`);
    } else {
      log('codex exec completed');
    }
  }
}
