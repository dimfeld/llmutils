import { z } from 'zod/v4';
import { error, log } from '../../logging.ts';
import type { TimConfig } from '../configSchema.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CodexCliExecutor } from './codex_cli';
import type { ExecutorCommonOptions, Executor, ExecutorFactory } from './types';

/**
 * A map of available executors, keyed by their names.
 */
export const executors = new Map<string, ExecutorFactory<any, z.ZodType<any, any>>>([
  [ClaudeCodeExecutor.name, ClaudeCodeExecutor],
  [CodexCliExecutor.name, CodexCliExecutor],
]);

export function createExecutor(
  name: string,
  options: Record<string, unknown>,
  sharedOptions: ExecutorCommonOptions,
  timConfig: TimConfig
) {
  const executor = executors.get(name);
  if (!executor) {
    return { error: `Executor "${name}" not found.` };
  }

  // Retrieve executor-specific options from config if available
  // Using type assertion to handle dynamic key access
  const configExecutorOptions = (timConfig.executors as Record<string, any>)?.[name] ?? {};
  // Merge provided options with config options (provided options take precedence)
  const mergedOptions = { ...configExecutorOptions, ...options };

  // Validate the merged options with the executor's schema
  const validationResult = executor.optionsSchema.safeParse(mergedOptions);
  if (!validationResult.success) {
    return {
      error: `Executor "${executor.name}" has an options schema that could not be satisfied with default values. Complex options may need a dedicated --executor-options flag. Schema error:`,
      errorDetails: validationResult.error.format(),
    };
  }
  let parsedExecutorOptions = validationResult.data;

  return {
    factory: executor,
    executor: new executor(parsedExecutorOptions, sharedOptions, timConfig) as Executor,
  };
}

export function buildExecutorAndLog(
  executorName: string,
  sharedOptions: ExecutorCommonOptions,
  config: TimConfig,
  executorOptions: Record<string, unknown> = {}
) {
  const buildExecutorResult = createExecutor(executorName, executorOptions, sharedOptions, config);

  if ('error' in buildExecutorResult) {
    error(buildExecutorResult.error);
    process.exit(1);
  }
  const { factory: executorFactory, executor } = buildExecutorResult;
  log(`Using executor: ${executorFactory.name}`);

  return executor;
}
