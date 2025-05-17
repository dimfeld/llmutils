import type { RmplanConfig } from '../configSchema.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CopyPasteExecutor } from './copy_paste.ts';
import { OneCallExecutor } from './one-call';
import type { AgentCommandSharedOptions, Executor, ExecutorFactory } from './types';

/**
 * A map of available executors, keyed by their names.
 */
export const executors = new Map<string, ExecutorFactory<any>>([
  [OneCallExecutor.name, OneCallExecutor],
  [CopyPasteExecutor.name, CopyPasteExecutor],
  [ClaudeCodeExecutor.name, ClaudeCodeExecutor],
]);

// Optionally, export individual executors if they need to be imported directly elsewhere.
export { OneCallExecutor };

export function createExecutor(
  name: string,
  options: any,
  sharedOptions: AgentCommandSharedOptions,
  rmplanConfig: RmplanConfig
) {
  const executor = executors.get(name);
  if (!executor) {
    throw new Error(`Unknown executor: ${name}`);
  }

  if (!executor) {
    return { error: `Executor "${name}" not found.` };
  }

  // This part needs enhancement to allow specifying executor options on the CLI.
  const validationResult = executor.optionsSchema.safeParse(options);
  if (!validationResult.success) {
    return {
      error: `Executor "${executor.name}" has an options schema that could not be satisfied with default values. Complex options may need a dedicated --executor-options flag. Schema error:`,
      errorDetails: validationResult.error.format(),
    };
  }
  let parsedExecutorOptions = validationResult.data;

  return {
    factory: executor,
    executor: new executor(parsedExecutorOptions, sharedOptions, rmplanConfig) as Executor,
  };
}
