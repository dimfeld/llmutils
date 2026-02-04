import type { ExecutePlanInfo } from '../executors/types.js';

/**
 * Execution mode for the agent run from the perspective of summary reporting
 */
export type SummaryExecutionMode = 'serial' | 'batch';

/**
 * Minimal normalized structure for executor output kept in summaries.
 * Output is truncated for memory safety.
 */
export interface NormalizedExecutorOutput {
  /** The raw textual content to display (already sanitized/truncated). */
  content: string;
  /** Optional structured steps; if present, preferred over `content`. */
  steps?: Array<{ title: string; body: string }>;
  /** Optional metadata from the executor (agent names, phases, etc). */
  metadata?: Record<string, unknown>;
  /** Optional standardized failure details when executor reports failure. */
  failureDetails?: {
    sourceAgent?: string;
    requirements?: string;
    problems?: string;
    solutions?: string;
  };
}

/**
 * Result of a single executed step/iteration.
 */
export interface StepResult {
  /** Short human-friendly label, e.g. "Task 1" or "Step 2" or "Batch Iteration 1" */
  title: string;
  /** Name of the executor that ran this step */
  executor: string;
  /** Optional executor type (e.g., 'interactive', 'cli') */
  executorType?: string;
  /** Optional executor phase label(s) (e.g., 'orchestrator' or 'implementer|tester|reviewer') */
  executorPhase?: string | string[];
  /** Whether the step finished without throwing from the executor */
  success: boolean;
  /** Optional error message when success is false */
  errorMessage?: string;
  /** Output captured from the executor when captureOutput was enabled */
  output?: NormalizedExecutorOutput;
  /** ISO timestamp when the step started */
  startedAt?: string;
  /** ISO timestamp when the step ended */
  endedAt?: string;
  /** Duration in milliseconds if timing is known */
  durationMs?: number;
  /** Optional batch iteration number (1-based) */
  iteration?: number;
}

/**
 * Additional execution-level metadata for the whole run.
 */
export interface ExecutionMetadata {
  /** Number of steps executed */
  totalSteps: number;
  /** Number of failed steps */
  failedSteps: number;
  /** Number of batch iterations (for batch mode) */
  batchIterations?: number;
}

/**
 * High-level summary of the overall execution.
 */
export interface ExecutionSummary {
  /** Plan metadata */
  planId: string;
  planTitle: string;
  planFilePath: string;

  /** Mode of execution from summary perspective */
  mode: SummaryExecutionMode;

  /** Overall timing */
  startedAt: string;
  endedAt?: string;
  durationMs?: number;

  /** Results */
  steps: StepResult[];

  /** Files changed during execution (relative paths) */
  changedFiles: string[];
  /** Optional lists for future enhancement */
  createdFiles?: string[];
  deletedFiles?: string[];

  /** Collected execution errors not tied to a specific step */
  errors: string[];

  /** Aggregate statistics */
  metadata: ExecutionMetadata;
  /** Original plan info for reference if available */
  planInfo?: Partial<ExecutePlanInfo>;
}
