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
  /**
   * When true, executors should run in the streamlined implement → verify flow.
   */
  simpleMode?: boolean;
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
  /** Whether batch mode is enabled for processing multiple tasks */
  batchMode?: boolean;
  /**
   * Output capture mode:
   * - 'none': No output capture (default)
   * - 'all': Capture all output like the original boolean true behavior
   * - 'result': Capture only the final "result" block from the executor
   */
  captureOutput?: 'none' | 'all' | 'result';
  /**
   * Execution mode for the executor.
   * - 'normal': Uses full multi-agent orchestration workflow
   * - 'review': Bypasses orchestration and runs prompts directly for review operations
   * - 'planning': Bypasses orchestration and runs prompts directly for planning operations
   */
  executionMode: 'normal' | 'review' | 'planning';
}

/**
 * Structured output from an executor when output capture is enabled.
 * This lets summary code format results without parsing ad-hoc strings.
 */
export interface ExecutorOutput {
  /** Primary textual content to display (if any). */
  content: string;
  /**
   * Optional structured steps to display. When present, summary functionality
   * should prefer rendering these over raw `content`.
   */
  steps?: Array<{ title: string; body: string }>;
  /** Optional structured metadata for rich summary formatting. */
  metadata?: Record<string, unknown>;
  /** Optional success indicator; defaults to true when absent for backward compatibility. */
  success?: boolean;
  /** Optional structured failure details when success === false. */
  failureDetails?: {
    requirements: string;
    problems: string;
    solutions?: string;
    /** Optional agent identifier/source of failure, e.g., implementer/tester/reviewer/fixer/orchestrator */
    sourceAgent?: string;
  };
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

  /** Indicates whether the executor supports orchestrating sub-agents. */
  supportsSubagents?: boolean;

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

  /** Indicates whether the executor can orchestrate sub-agent workflows. */
  supportsSubagents?: boolean;

  /**
   * Prefix to use when listing file paths in prompts.
   * For example, '@' for Claude Code to enable automatic file reading.
   */
  filePathPrefix?: string;

  /**
   * The asynchronous function that executes the generated context.
   * @param contextContent - The string content for execution (output from `rmfilter` or direct prompt).
   * @param planInfo - Plan information containing planId, planTitle, and planFilePath.
   * @returns Promise<void> for normal execution, or Promise<ExecutorOutput> when captureOutput is 'all' or 'result'.
   */
  execute: (contextContent: string, planInfo: ExecutePlanInfo) => Promise<ExecutorOutput | void>;
}
