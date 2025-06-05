import { buildExecutorAndLog } from './executors/index.js';
import { error } from '../logging.js';
import type { RmplanConfig } from './configSchema.js';
import type { ExecutorCommonOptions } from './executors/types.js';

/**
 * Runs a plan context with the specified executor.
 * This function encapsulates the logic for building and executing an executor,
 * providing a clean interface for external modules to trigger plan execution.
 *
 * @param executorName - Name of the executor to use
 * @param contextContent - The context content to execute (output from rmfilter or direct prompt)
 * @param commonOpts - Common options shared across executors
 * @param rmplanConfig - The rmplan configuration
 * @throws {Error} If executor execution fails
 */
export async function runPlanContextWithExecutor(
  executorName: string,
  contextContent: string,
  commonOpts: ExecutorCommonOptions,
  rmplanConfig: RmplanConfig
): Promise<void> {
  try {
    const executor = buildExecutorAndLog(executorName, commonOpts, rmplanConfig);
    await executor.execute(contextContent);
  } catch (err) {
    const errorMessage = `Failed to execute with executor ${executorName}: ${(err as Error).message}`;
    error(errorMessage);
    throw new Error(errorMessage);
  }
}
