import type { TimWorkspaceCommandEnvironmentOptions } from '../../common/env.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';

export type SubagentType = 'implementer' | 'tester' | 'tdd-tests' | 'advisor';
export type PreparedSubagentType = SubagentType | 'reviewer';
export type SubagentExecutor = 'codex-cli' | 'claude-code';

/**
 * Explicit prompt context for a provider-backed persistent agent.
 *
 * The AgentManager preparation boundary supplies this value. A missing value
 * keeps the legacy one-shot prompt contract, including for direct
 * `tim subagent` and formal review execution.
 */
export interface SubagentPromptContext {
  readonly mode: 'persistent-agent';
  /** Canonical model-facing name assigned by AgentManager. */
  readonly agentName: string;
}

export type SubagentInputPolicy =
  | {
      readonly type: 'resolved';
      readonly initialMessage?: string;
    }
  | {
      readonly type: 'orchestrator';
      readonly input?: string;
      readonly inputFile?: string | string[];
      readonly fallbackToStdin: boolean;
    };

/**
 * Input and context used to prepare one one-shot subagent execution.
 *
 * Resolved input is used by in-process callers. Orchestrator input preserves
 * the legacy input-file, inline-input, and optional stdin fallback behavior.
 */
export interface SubagentPreparationRequest {
  agentType: PreparedSubagentType;
  planId: number;
  executor?: string;
  model?: string;
  difficulty?: 'low' | 'high';
  taskIndex?: string | string[];
  configPath?: string;
  inputPolicy: SubagentInputPolicy;
  repositoryRoot?: string;
  /** Optional context supplied only by the persistent-agent launch boundary. */
  promptContext?: SubagentPromptContext;
}

/**
 * Input used to prepare one advisor consultation that has no plan behind it.
 *
 * This is the planning-time shape of the advisor role: the question and the
 * repository are the entire context, so there is no plan, no task scope, and no
 * plan file to materialize.
 */
export interface PlanlessAdvisorPreparationRequest {
  executor?: string;
  model?: string;
  difficulty?: 'low' | 'high';
  configPath?: string;
  inputPolicy: SubagentInputPolicy;
  repositoryRoot?: string;
}

/**
 * Everything a provider launch needs that does not come from a plan.
 *
 * `launchPreparedSubagent()` accepts this base type so a plan-less advisor
 * consultation launches through exactly the same path as a plan-bound run.
 */
export interface PreparedSubagentExecutionBase {
  readonly agentType: PreparedSubagentType;
  readonly executor: SubagentExecutor;
  readonly model: string | undefined;
  readonly gitRoot: string;
  readonly useJj: boolean;
  readonly prompt: string;
  readonly config: TimConfig;
  readonly timEnvironment: TimWorkspaceCommandEnvironmentOptions;
}

/**
 * All validated data needed to start one plan-bound provider run.
 *
 * Callers should treat this value as immutable after preparation.
 */
export interface PreparedSubagentExecution extends PreparedSubagentExecutionBase {
  readonly plan: PlanSchema;
  readonly planId: number;
  readonly planPath: string;
}

/**
 * A prepared advisor consultation that is not attached to a plan.
 *
 * The advisor is the only role that can run this way: it is read-only and
 * answers questions about the repository itself, so a question that arises
 * before a plan exists (during planning, for instance) still has a way to
 * reach it. The plan fields are declared as `undefined` rather than omitted so
 * a value of this type never passes where a plan-bound execution is required.
 */
export interface PreparedPlanlessSubagentExecution extends PreparedSubagentExecutionBase {
  readonly agentType: 'advisor';
  readonly plan?: undefined;
  readonly planId?: undefined;
  readonly planPath?: undefined;
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
