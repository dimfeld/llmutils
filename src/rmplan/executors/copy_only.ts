import chalk from 'chalk';
import { z } from 'zod/v4';
import * as clipboard from '../../common/clipboard.ts';
import { waitForEnter } from '../../common/terminal.ts';
import { log } from '../../logging';
import type { PrepareNextStepOptions } from '../plans/prepare_step.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { ExecutorCommonOptions, Executor, ExecutePlanInfo } from './types';
import { copyOnlyOptionsSchema, CopyOnlyExecutorName } from './schemas.js';

export type CopyOnlyExecutorOptions = z.infer<typeof copyOnlyOptionsSchema>;

/**
 * The 'copy-only' executor.
 * This executor copies the prompt to the clipboard, for pasting into an agent.
 */
export class CopyOnlyExecutor implements Executor {
  static name = CopyOnlyExecutorName;
  static description = 'Copies the prompt into the clipboard for you to send to an agent';
  static optionsSchema = copyOnlyOptionsSchema;

  // readonly forceReviewCommentsMode = 'separate-context';

  constructor(
    public options: CopyOnlyExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return { rmfilter: false };
  }

  async execute(contextContent: string, _planInfo: ExecutePlanInfo) {
    // This executor doesn't use plan information
    while (true) {
      await clipboard.write(contextContent);
      log(
        chalk.bold(
          '\nPlease paste the prompt into your agent and when it is done, press Enter to continue or `c` to copy again.'
        )
      );
      const pressed = await waitForEnter();

      if (pressed !== 'c') {
        break;
      }
    }
  }
}
