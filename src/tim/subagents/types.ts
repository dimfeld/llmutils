import type { TimWorkspaceCommandEnvironmentOptions } from '../../common/env.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';

export type SubagentType = 'implementer' | 'tester' | 'tdd-tests';
export type SubagentExecutor = 'codex-cli' | 'claude-code';

export interface SubagentInputOptions {
  input?: string;
  inputFile?: string | string[];
}

/**
 * Input and context used to prepare one one-shot subagent execution.
 *
 * `initialMessage` is already-resolved input for in-process callers. When it
 * is present, no input files or stdin are read. Stdin fallback is disabled by
 * default and must be enabled explicitly by a CLI adapter.
 */
export interface SubagentPreparationRequest extends SubagentInputOptions {
  agentType: SubagentType;
  planId: number;
  executor?: string;
  model?: string;
  taskIndex?: string | string[];
  configPath?: string;
  initialMessage?: string;
  fallbackToStdin?: boolean;
  repositoryRoot?: string;
}

/**
 * All validated data needed to start one provider run.
 *
 * Callers should treat this value as immutable after preparation.
 */
export interface PreparedSubagentExecution {
  readonly agentType: SubagentType;
  readonly executor: SubagentExecutor;
  readonly model: string | undefined;
  readonly plan: PlanSchema;
  readonly planId: number;
  readonly planPath: string;
  readonly gitRoot: string;
  readonly useJj: boolean;
  readonly prompt: string;
  readonly config: TimConfig;
  readonly timEnvironment: TimWorkspaceCommandEnvironmentOptions;
}

export interface SubagentExecutionResult {
  readonly finalMessage: string;
  readonly executor: SubagentExecutor;
}

/**
 * Handle for one running, one-shot provider call.
 *
 * This is not a persistent agent session. It has no message, idle-turn, or
 * stop operations. The promise resolves only when the provider completes.
 */
export interface SubagentLaunchHandle {
  readonly executor: SubagentExecutor;
  readonly completion: Promise<SubagentExecutionResult>;
}
