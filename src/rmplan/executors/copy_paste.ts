import chalk from 'chalk';
import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import { applyLlmEdits } from '../../apply-llm-edits/apply';
import { DEFAULT_RUN_MODEL } from '../llm_utils/run_and_apply.js';
import { waitForEnter } from '../../common/terminal.ts';
import { log } from '../../logging';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { ExecutorCommonOptions, Executor } from './types';
import { sshAwarePasteAction } from '../../common/ssh_detection.ts';
import { copyPasteOptionsSchema, CopyPasteExecutorName } from './schemas.js';

export type CopyPasteExecutorOptions = z.infer<typeof copyPasteOptionsSchema>;

/**
 * The 'direct-call' executor.
 * This executor generates context using `rmfilter` and then directly calls an LLM
 * with that context. The LLM's response is then processed by `applyLlmEdits`.
 */
export class CopyPasteExecutor implements Executor {
  static name = CopyPasteExecutorName;
  static description =
    'Copies the prompt into the clipboard and then applies the edits you copy back';
  static optionsSchema = copyPasteOptionsSchema;

  constructor(
    public options: CopyPasteExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  get executionModel() {
    return (
      this.rmplanConfig.models?.execution ??
      this.options.executionModel ??
      this.sharedOptions.model ??
      DEFAULT_RUN_MODEL
    );
  }

  prepareStepOptions() {
    const options: Partial<PrepareNextStepOptions> = {
      rmfilter: true,
      model: this.executionModel,
    };

    return options;
  }

  async execute(contextContent: string) {
    await clipboard.write(contextContent);

    log(
      chalk.bold(
        `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to apply the changes, or Ctrl+C to exit.`
      )
    );
    const llmOutput = await waitForEnter(true);

    await applyLlmEdits({
      interactive: true,
      baseDir: await getGitRoot(this.sharedOptions.baseDir),
      originalPrompt: contextContent,
      retryRequester: async (prompt) => {
        // We know the last message is the new context, so just use that.
        // Better to have a separate specific place in the argument containing it though.
        await clipboard.write(prompt.at(-1)!.content);
        log(
          chalk.bold(
            `Retry prompt was copied to clipboard. Please put it into the chat interface and ${sshAwarePasteAction()}.`
          )
        );
        const llmOutput = await waitForEnter(true);
        return llmOutput;
      },
      content: llmOutput,
    });
  }
}
