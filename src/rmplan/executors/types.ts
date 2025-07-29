import type { z } from 'zod/v4';
import type { RmplanConfig } from '../configSchema';
import type { PrepareNextStepOptions } from '../plans/prepare_step.ts';

/**
 * Shared options/state from the agent command, passed to the executor.
 */
export interface ExecutorCommonOptions {
  baseDir: string;
  interactive?: boolean;
  model?: string;
}

/**
 * Plan information passed to the executor during execution.
 */
export interface ExecutePlanInfo {
  /** The plan ID */
  planId: string;
  /** The plan title */
  planTitle: string;
  /** The path to the plan file */
  planFilePath: string;
}

export interface ExecutorFactory<E extends Executor, SCHEMA extends z.ZodType = z.ZodType> {
  new (
    executorOptions: z.infer<SCHEMA>,
    sharedOptions: ExecutorCommonOptions,
    rmplanConfig: RmplanConfig
  ): E | Promise<E>;

  /** Unique name for the executor. */
  name: string;
  /** A brief description of what the executor does. */
  description: string;

  optionsSchema: SCHEMA;

  defaultModel?: {
    execution?: string;
    answerPr?: string;
  };
}

/**
 * Defines the structure for an rmplan executor.
 * @template ExecutorSpecificOptionsSchema - Zod schema for executor-specific options.
 */
export interface Executor {
  prepareStepOptions?: () => Partial<PrepareNextStepOptions>;

  forceReviewCommentsMode?: 'inline-edits' | 'separate-context';
  todoDirections?: string;

  /**
   * Prefix to use when listing file paths in prompts.
   * For example, '@' for Claude Code to enable automatic file reading.
   */
  filePathPrefix?: string;

  /**
   * The asynchronous function that executes the generated context.
   * @param contextContent - The string content for execution (output from `rmfilter` or direct prompt).
   * @param planInfo - Plan information containing planId, planTitle, and planFilePath.
   */
  execute: (contextContent: string, planInfo: ExecutePlanInfo) => Promise<void>;
}
