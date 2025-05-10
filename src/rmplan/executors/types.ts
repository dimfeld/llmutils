import type { z } from 'zod';
import type { RmplanConfig } from '../configSchema';
import type { RetryRequester } from '../../apply-llm-edits/retry';
import type { ApplyLlmEditsOptions } from '../../apply-llm-edits/apply';

/**
 * Shared options/state from the agent command, passed to the executor.
 */
export interface AgentCommandSharedOptions {
  planFile: string; // The plan file being executed
  // Potentially other shared things like baseDir, gitRoot if needed by all executors
}

/**
 * Defines the structure for an rmplan executor.
 * @template ExecutorSpecificOptionsSchema - Zod schema for executor-specific options.
 */
export interface Executor<ExecutorSpecificOptionsSchema extends z.ZodType = z.ZodType> {
  /** Unique name for the executor. */
  name: string;
  /** A brief description of what the executor does. */
  description: string;
  /** Zod schema for validating and parsing executor-specific options. */
  optionsSchema: ExecutorSpecificOptionsSchema;

  /** Configuration for how the execution context is generated. */
  contextConfig: {
    /**
     * If true, `rmfilter` is used to generate the context.
     * The prompt from `prepareNextStep` will be passed to `rmfilter` via `--instructions @file`.
     * If false, the prompt from `prepareNextStep` is used directly as the context content.
     */
    runRmfilter: boolean;
  };

  /**
   * The asynchronous function that executes the generated context.
   * @param contextContent - The string content for execution (output from `rmfilter` or direct prompt).
   * @param executorOptions - Parsed and validated options specific to this executor.
   * @param sharedOptions - Shared options/state from the agent command.
   * @param rmplanConfig - The loaded rmplan configuration.
   * @param retryRequester - Function to request LLM retries for `applyLlmEdits`.
   * @param baseApplyLlmEditsOptions - Base options for `applyLlmEdits`, which the executor can extend or override.
   *                                   Does not include `content` or `retryRequester`.
   */
  execute: (
    contextContent: string,
    executorOptions: z.infer<ExecutorSpecificOptionsSchema>,
    sharedOptions: AgentCommandSharedOptions,
    rmplanConfig: RmplanConfig,
    retryRequester: RetryRequester,
    baseApplyLlmEditsOptions: Omit<ApplyLlmEditsOptions, 'content' | 'retryRequester' | 'baseDir'> & { baseDir: string }
  ) => Promise<void>;
}
