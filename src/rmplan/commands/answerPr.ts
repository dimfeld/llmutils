// Command handler for 'rmplan answer-pr'
// Addresses Pull Request (PR) review comments using an LLM

import { loadEffectiveConfig } from '../configLoader.js';
import { handleRmprCommand } from '../../rmpr/main.js';
import { DEFAULT_EXECUTOR } from '../constants.js';
import type { Command } from 'commander';

export async function handleAnswerPrCommand(
  prIdentifier: string | undefined,
  options: any,
  command: Command
) {
  // Pass global options (like --debug) along with command-specific options
  const globalOpts = command.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Use executor from CLI options, fallback to config defaultExecutor, or fallback to the default executor
  if (!options.executor) {
    options.executor = config.defaultExecutor || DEFAULT_EXECUTOR;
  }

  // Apply answer-pr config defaults if not specified in CLI options
  if (config.answerPr) {
    if (options.mode === undefined && config.answerPr.mode !== undefined) {
      options.mode = config.answerPr.mode;
    }
    if (options.comment === undefined && config.answerPr.comment !== undefined) {
      options.comment = config.answerPr.comment;
    }
    if (options.commit === undefined && config.answerPr.commit !== undefined) {
      options.commit = config.answerPr.commit;
    }
  }

  options.mode ??= 'hybrid';

  await handleRmprCommand(prIdentifier, options, globalOpts, config);
}
