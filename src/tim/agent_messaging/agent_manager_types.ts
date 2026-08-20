import type { AgentExecutor, AgentLifecycleState, AgentType } from './contracts.js';
import type { PreparedSubagentExecution, SubagentPromptContext } from '../subagents/types.js';
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

/** The clock and timer boundary used by AgentManager lifecycle policies. */
export interface AgentManagerScheduler {
  /** Return a monotonic timestamp in milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type AgentInputDelivery =
  | Exclude<import('./contracts.js').SendAgentMessageAcknowledgement, 'queued'>
  | 'temporarily-unavailable';

export interface AgentInputMessage {
  readonly messageId: string;
  readonly source: AgentIdentity;
  readonly content: string;
}

export type AgentProviderExitClassification = 'natural' | 'graceful' | 'forced' | 'failed';

/** The result of one provider lifecycle control request. */
export type AgentProviderControlResult = 'accepted' | 'already-exited';

export interface AgentProviderExit {
  readonly classification: AgentProviderExitClassification;
  readonly error?: Error;
}

/** Observer for one provider handle. The handle already owns agent identity. */
export interface AgentProviderLifecycleObserver {
  outputActivity(): void;
  /** The exact complete assistant message, including boundary whitespace. */
  completedAssistantMessage(message: string): void;
  turnComplete(): void;
  exit(classification: AgentProviderExitClassification, error?: Error): void;
}

/**
 * Provider-neutral controls and events for one launched agent.
 *
 * The handle is bound to one opaque agent identity. The manager captures the
 * matching directory record when it subscribes, so stale callbacks cannot
 * affect a later agent that reuses the same name.
 */
export interface AgentProviderLifecycleControls {
  requestGracefulShutdown(instruction: string): Promise<AgentProviderControlResult>;
  requestCloseAfterCurrentTurn(): Promise<AgentProviderControlResult>;
  requestForcedShutdown(): Promise<AgentProviderControlResult>;
  subscribe(observer: AgentProviderLifecycleObserver): () => void;
}

/** A typed provider lifecycle control failure with its operation attached. */
export class AgentProviderControlError extends Error {
  public readonly operation: 'graceful-shutdown' | 'close-after-current-turn' | 'forced-shutdown';
  public constructor(
    operation: 'graceful-shutdown' | 'close-after-current-turn' | 'forced-shutdown',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AgentProviderControlError';
    this.operation = operation;
  }
}

/** A forced shutdown failure that guarantees the provider did not accept it. */
export class AgentProviderForceNotAcceptedError extends AgentProviderControlError {
  public readonly notAccepted = true;

  public constructor(message: string, options?: ErrorOptions) {
    super('forced-shutdown', message, options);
    this.name = 'AgentProviderForceNotAcceptedError';
  }
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

/**
 * Validate the provider-neutral input boundary before it is bound to a
 * manager or launch handle.
 *
 * Keep this check in one place. Orchestrator adapters and provider launch
 * handles must have identical runtime validation, including optional release
 * cleanup.
 */
export function validateAgentInputAdapter(value: unknown): asserts value is AgentInputAdapter {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Agent input adapter must be an object');
  }
  const adapter = value as Record<string, unknown>;
  const ready = adapter.ready;
  if (
    typeof ready !== 'object' ||
    ready === null ||
    typeof (ready as { readonly then?: unknown }).then !== 'function'
  ) {
    throw new TypeError('Agent input adapter ready must be a promise');
  }
  if (typeof adapter.isReady !== 'boolean') {
    throw new TypeError('Agent input adapter isReady must be boolean');
  }
  if (
    adapter.activity !== 'not-ready' &&
    adapter.activity !== 'active' &&
    adapter.activity !== 'temporarily-unavailable' &&
    adapter.activity !== 'idle'
  ) {
    throw new TypeError('Agent input adapter activity is invalid');
  }
  if (typeof adapter.deliver !== 'function') {
    throw new TypeError('Agent input adapter deliver must be a function');
  }
  if (typeof adapter.onAvailabilityChange !== 'function') {
    throw new TypeError('Agent input adapter onAvailabilityChange must be a function');
  }
  if (adapter.release !== undefined && typeof adapter.release !== 'function') {
    throw new TypeError('Agent input adapter release must be a function when provided');
  }
}

export function validateAgentProviderLifecycleControls(
  value: unknown
): asserts value is AgentProviderLifecycleControls {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Agent provider lifecycle controls must be an object');
  }
  const controls = value as Record<string, unknown>;
  for (const method of [
    'requestGracefulShutdown',
    'requestCloseAfterCurrentTurn',
    'requestForcedShutdown',
    'subscribe',
  ]) {
    if (typeof controls[method] !== 'function') {
      throw new TypeError(`Agent provider lifecycle control ${method} must be a function`);
    }
  }
}

export interface AgentLaunchCompletion {
  readonly finalMessage?: string;
  readonly error?: Error;
}

/**
 * A provider-neutral launch handle. `completion` is intentionally passive;
 * lifecycle and shutdown policy belong to AgentManager.
 */
export interface AgentLaunchHandle {
  readonly executor: AgentExecutor;
  readonly processLabel: AgentProcessLabel;
  readonly input: AgentInputAdapter;
  readonly ready: Promise<void>;
  readonly completion: Promise<AgentLaunchCompletion>;
  readonly lifecycle: AgentProviderLifecycleControls;
  readonly processControlId?: ProcessControlId;
  readonly providerThreadId?: ProviderThreadId;
  release?(): Promise<void>;
}

/**
 * Prepared provider input for any named agent.
 *
 * The reusable preparation service supports the same role set as AgentManager,
 * including the read-only collaborative reviewer, while preserving every
 * other prepared execution field.
 */
export type PreparedAgentExecution = Omit<PreparedSubagentExecution, 'agentType'> & {
  readonly agentType: AgentType;
};

export interface AgentLaunchRequest {
  readonly identity: SubagentIdentity;
  readonly initialMessage: string;
  readonly preparedExecution: PreparedAgentExecution;
  readonly processLabel: AgentProcessLabel;
  /** Observer installed before provider startup begins. */
  readonly lifecycleObserver: AgentProviderLifecycleObserver;
}

/** Input needed by the provider-neutral plan 414 preparation boundary. */
export interface AgentPreparationRequest {
  readonly identity: SubagentIdentity;
  readonly initialMessage: string;
  /** Explicit context for prompts prepared for this persistent agent launch. */
  readonly promptContext?: SubagentPromptContext;
}

/**
 * Prepares one named agent without starting a provider.
 *
 * Implementations should delegate to `prepareSubagentExecution()` and pass
 * the explicit persistent-agent context when the provider installs messaging
 * tools. Collaborative reviewers use the same preparation service with their
 * read-only role prompt; formal review remains a separate one-shot path.
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
  | 'unknown_agent'
  | 'finish_not_available'
  | 'force_failed';

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
  /** Clock and timer functions used by graceful StopAgent inactivity control. */
  readonly scheduler?: AgentManagerScheduler;
  /** Provider-neutral input boundary for messages addressed to orchestrator. */
  readonly orchestratorInputAdapter?: AgentInputAdapter;
}
