// Command handler for 'rmplan answer-pr'
// Addresses Pull Request (PR) review comments using an LLM

import { loadEffectiveConfig } from '../configLoader.js';
import { handleRmprCommand } from '../../rmpr/main.js';
import { DEFAULT_EXECUTOR } from '../constants.js';

export async function handleAnswerPrCommand(prIdentifier: string | undefined, options: any) {
  // Pass global options (like --debug) along with command-specific options
  const globalOpts = options.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Use executor from CLI options, fallback to config defaultExecutor, or fallback to the default executor
  if (!options.executor) {
    options.executor = config.defaultExecutor || DEFAULT_EXECUTOR;
  }

  await handleRmprCommand(prIdentifier, options, globalOpts, config);
}
