import chalk from 'chalk';
import clipboard from 'clipboardy';
import { z } from 'zod';
import { waitForEnter } from '../../common/terminal.ts';
import { log } from '../../logging';
import type { PrepareNextStepOptions } from '../actions.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { AgentCommandSharedOptions, Executor } from './types';

const copyOnlyOptionsSchema = z.object({});

export type CopyOnlyExecutorOptions = z.infer<typeof copyOnlyOptionsSchema>;

/**
 * The 'direct-call' executor.
 * This executor generates context using `rmfilter` and then directly calls an LLM
 * with that context. The LLM's response is then processed by `applyLlmEdits`.
 */
export class CopyOnlyExecutor implements Executor {
  static name = 'copy-only';
  static description =
    'Copies the prompt into the clipboard for you to send to an agent';
  static optionsSchema = copyOnlyOptionsSchema;

  constructor(
    public options: CopyOnlyExecutorOptions,
    public sharedOptions: AgentCommandSharedOptions,
    public rmplanConfig: RmplanConfig
  ) {}


  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return { rmfilter: true };
  }

  async execute(contextContent: string) {
    await clipboard.write(contextContent);
    log(
      chalk.bold(
        '\nPlease paste the prompt into your agent and when it is done, press Enter to continue'
      )
    );
    await waitForEnter();
  }
}

