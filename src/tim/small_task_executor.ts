import type { TimConfig } from './configSchema.js';
import { LATEST_GPT5_MINI_MODEL } from './constants.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from './executors/schemas.js';

export const DEFAULT_SMALL_TASK_EXECUTOR = CodexCliExecutorName;
export const DEFAULT_SMALL_TASK_MODEL = `${LATEST_GPT5_MINI_MODEL}:medium`;

export type SmallTaskExecutorName = typeof ClaudeCodeExecutorName | typeof CodexCliExecutorName;

export interface SmallTaskExecutorSelection {
  executorName: SmallTaskExecutorName;
  model: string | undefined;
}

export interface SmallTaskExecutorOverrides {
  executor?: SmallTaskExecutorName;
  model?: string;
}

/**
 * Resolve the lightweight executor shared by small, self-contained helper tasks.
 * Keeping this policy in one place makes provider/model swaps consistent across commands.
 */
export function resolveSmallTaskExecutor(
  config: TimConfig,
  overrides: SmallTaskExecutorOverrides = {}
): SmallTaskExecutorSelection {
  const configuredExecutor = config.smallTasks?.executor ?? DEFAULT_SMALL_TASK_EXECUTOR;
  const executorName = overrides.executor ?? configuredExecutor;
  const configuredModel =
    executorName === configuredExecutor
      ? (config.smallTasks?.model ??
        (configuredExecutor === DEFAULT_SMALL_TASK_EXECUTOR ? DEFAULT_SMALL_TASK_MODEL : undefined))
      : undefined;

  return {
    executorName,
    model: overrides.model ?? configuredModel,
  };
}
