import type { AgentExecutor, AgentLifecycleState, AgentType } from './contracts.js';
import type { PreparedSubagentExecution } from '../subagents/types.js';
import type { AgentId, AgentName } from './agent_names.js';
import type { AgentProcessLabel } from './agent_process_labels.js';

declare const processControlIdBrand: unique symbol;
declare const providerThreadIdBrand: unique symbol;

/** An OS process-registry identity, separate from the agent identity. */
export type ProcessControlId = string & {
  readonly [processControlIdBrand]: 'ProcessControlId';
};

/** A provider-level logical thread identity, separate from the agent identity. */
export type ProviderThreadId = string & {
  readonly [providerThreadIdBrand]: 'ProviderThreadId';
};

/** Provider input availability is distinct from lifecycle state. */
export type AgentInputActivity = 'not-ready' | 'active' | 'temporarily-unavailable' | 'idle';

export type AgentInputDelivery =
  | Exclude<import('./contracts.js').SendAgentMessageAcknowledgement, 'queued'>
  | 'temporarily-unavailable';

export interface AgentInputMessage {
  readonly messageId: string;
  readonly source: AgentIdentity;
  readonly content: string;
}

/**
 * The provider-neutral input boundary used by a future manager launch path.
 * It describes input capability only; it does not own a persistent provider
 * loop or expose lifecycle controls.
 */
export interface AgentInputAdapter {
  readonly ready: Promise<void>;
  readonly isReady: boolean;
  readonly activity: AgentInputActivity;
  deliver(message: AgentInputMessage): AgentInputDelivery | Promise<AgentInputDelivery>;
  /**
   * Notify the manager when input availability changes. Providers must emit a
   * notification after transient unavailability if it lasts beyond the
   * manager's one safe retry.
   */
  onAvailabilityChange(listener: () => void): () => void;
  release?(): Promise<void>;
}

export interface AgentLaunchCompletion {
  readonly finalMessage?: string;
  readonly error?: Error;
}

/**
 * A provider-neutral launch handle. `completion` is intentionally passive;
 * lifecycle and shutdown policy belong to the successor plan.
 */
export interface AgentLaunchHandle {
  readonly executor: AgentExecutor;
  readonly processLabel: AgentProcessLabel;
  readonly input: AgentInputAdapter;
  readonly ready: Promise<void>;
  readonly completion: Promise<AgentLaunchCompletion>;
  readonly processControlId?: ProcessControlId;
  readonly providerThreadId?: ProviderThreadId;
  release?(): Promise<void>;
}

/**
 * Prepared provider input for any named agent.
 *
 * The reusable one-shot preparation service currently narrows `agentType` to
 * its legacy roles. AgentManager launch requests also support collaborative
 * reviewers, while preserving every other prepared-execution field.
 */
export type PreparedAgentExecution = Omit<PreparedSubagentExecution, 'agentType'> & {
  readonly agentType: AgentType;
};

export interface AgentLaunchRequest {
  readonly identity: SubagentIdentity;
  readonly initialMessage: string;
  readonly preparedExecution: PreparedAgentExecution;
  readonly processLabel: AgentProcessLabel;
}

/** Input needed by the provider-neutral plan 414 preparation boundary. */
export interface AgentPreparationRequest {
  readonly identity: SubagentIdentity;
  readonly initialMessage: string;
}

/**
 * Prepares one named agent without starting a provider.
 *
 * Implementations for the three established roles should delegate to
 * `prepareSubagentExecution()`. A caller may provide a narrow reviewer
 * implementation that prepares collaborative, read-only review context.
 */
export interface AgentPreparation {
  prepare(request: AgentPreparationRequest): Promise<PreparedAgentExecution>;
}

export interface AgentLauncher {
  launch(request: AgentLaunchRequest): Promise<AgentLaunchHandle>;
}

export interface OrchestratorIdentity {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly role: 'orchestrator';
  readonly executor: AgentExecutor;
}

export interface SubagentIdentity {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly role: 'subagent';
  readonly type: AgentType;
  readonly executor: AgentExecutor;
}

export type AgentIdentity = OrchestratorIdentity | SubagentIdentity;
/** The only caller data trusted by manager operations. */
export interface AgentCallerIdentity {
  readonly id: AgentId;
  readonly role: 'orchestrator' | 'subagent';
}

export interface AgentRecordSnapshot {
  readonly identity: AgentIdentity;
  readonly state: AgentLifecycleState;
  readonly inputActivity: AgentInputActivity;
  readonly creationSequence: number;
  readonly processControlId?: ProcessControlId;
  readonly providerThreadId?: ProviderThreadId;
}

export type AgentManagerErrorCode =
  | 'invalid_options'
  | 'invalid_request'
  | 'manager_closed'
  | 'not_authorized'
  | 'invalid_name'
  | 'reserved_name'
  | 'name_in_use'
  | 'name_generation_exhausted'
  | 'identity_generation_exhausted'
  | 'agent_limit_reached'
  | 'launch_failed'
  | 'unknown_sender'
  | 'unknown_target'
  | 'target_not_accepting_messages'
  | 'transport_error'
  | 'root_registration_failed'
  | 'unknown_agent';

export class AgentManagerError extends Error {
  public readonly code: AgentManagerErrorCode;
  public readonly transportCode?: import('./mailbox_protocol.js').MailboxErrorCode;

  public constructor(
    code: AgentManagerErrorCode,
    message: string,
    options?: ErrorOptions,
    transportCode?: import('./mailbox_protocol.js').MailboxErrorCode
  ) {
    super(message, options);
    this.name = 'AgentManagerError';
    this.code = code;
    this.transportCode = transportCode;
  }
}

export interface AgentManagerOptions {
  readonly sessionRuntime?: import('./session_runtime.js').AgentMessagingSessionRuntime;
  readonly orchestratorExecutor?: AgentExecutor;
  readonly agentIdGenerator?: import('./agent_names.js').AgentIdGenerator;
  readonly slugGenerator?: import('./agent_names.js').AgentSlugGenerator;
  readonly maxAgentIdGenerationAttempts?: number;
  readonly maxAgentNameGenerationAttempts?: number;
  readonly agentPreparer?: AgentPreparation;
  readonly agentLauncher?: AgentLauncher;
  /** Provider-neutral input boundary for messages addressed to orchestrator. */
  readonly orchestratorInputAdapter?: AgentInputAdapter;
}
