import { error, log } from '../../logging.ts';
import type { RmplanConfig } from '../configSchema.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CopyOnlyExecutor } from './copy_only.ts';
import { CopyOnlyStateMachineExecutor } from './copy_only_statemachine.ts';
import { CopyPasteExecutor } from './copy_paste.ts';
import { OneCallExecutor } from './one-call';
import type { ExecutorCommonOptions, Executor, ExecutorFactory } from './types';

/**
 * A map of available executors, keyed by their names.
 */
export const executors = new Map<string, ExecutorFactory<any>>([
  [OneCallExecutor.name, OneCallExecutor],
  [ClaudeCodeExecutor.name, ClaudeCodeExecutor],
  [CopyPasteExecutor.name, CopyPasteExecutor],
  [CopyOnlyExecutor.name, CopyOnlyExecutor],
  [CopyOnlyStateMachineExecutor.name, CopyOnlyStateMachineExecutor],
]);

// Optionally, export individual executors if they need to be imported directly elsewhere.
export { OneCallExecutor };

export function createExecutor(
  name: string,
  options: any,
  sharedOptions: ExecutorCommonOptions,
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

export function buildExecutorAndLog(
  executorName: string,
  sharedOptions: ExecutorCommonOptions,
  config: RmplanConfig
) {
  const buildExecutorResult = createExecutor(
    executorName,
    // TODO load options from the various config files and CLI
    {},
    sharedOptions,
    config
  );

  if ('error' in buildExecutorResult) {
    error(buildExecutorResult.error);
    process.exit(1);
  }
  const { factory: executorFactory, executor } = buildExecutorResult;
  log(`Using executor: ${executorFactory.name}`);

  return executor;
}
