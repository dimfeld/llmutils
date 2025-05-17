import { z } from 'zod';
import type { AgentCommandSharedOptions, Executor, ExecutorFactory } from './types';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../../common/run_and_apply';
import { applyLlmEdits, type ApplyLlmEditsOptions } from '../../apply-llm-edits/apply';
import { log } from '../../logging';
import { createRetryRequester } from '../../apply-llm-edits/retry.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { getGitRoot } from '../../rmfilter/utils.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import clipboard from 'clipboardy';
import { waitForEnter } from '../../common/terminal.ts';
import chalk from 'chalk';

/**
 * Schema for the 'direct-call' executor's options.
 * It expects a model string for the LLM.
 */
const copyPasteOptionsSchema = z.object({
  executionModel: z
    .string()
    .describe("The model string for LLM execution, e.g., 'google/gemini-2.5-pro-preview-05-23'.")
    .optional(),
});

export type CopyPasteExecutorOptions = z.infer<typeof copyPasteOptionsSchema>;

/**
 * The 'direct-call' executor.
 * This executor generates context using `rmfilter` and then directly calls an LLM
 * with that context. The LLM's response is then processed by `applyLlmEdits`.
 */
export class CopyPasteExecutor implements Executor {
  static name = 'copy-paste';
  static description =
    'Copies the prompt into the clipboard and then applies the edits you copy back';
  static optionsSchema = copyPasteOptionsSchema;

  constructor(
    public options: CopyPasteExecutorOptions,
    public sharedOptions: AgentCommandSharedOptions,
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
        '\nPlease paste the prompt into the chat interface and copy the response. Press Enter to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.'
      )
    );
    await waitForEnter();

    const llmOutput = await clipboard.read();

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
            `Retry prompt was copied to clipboard. Please paste it into the chat interface and copy the result back.`
          )
        );
        await waitForEnter();
        const llmOutput = await clipboard.read();
        return llmOutput;
      },
      content: llmOutput,
    });
  }
}
