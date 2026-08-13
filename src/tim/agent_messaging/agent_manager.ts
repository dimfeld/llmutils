import { randomUUID } from 'node:crypto';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import {
  MAX_AGENT_MESSAGE_BYTES,
  ORCHESTRATOR_AGENT_NAME,
  STOP_AGENT_INACTIVITY_TIMEOUT_MS,
  finishAgentArgumentsSchema,
  isNonterminalAgentLifecycleState,
  sendAgentMessageArgumentsSchema,
  stopAgentArgumentsSchema,
  type FinishAgentResult,
  type ListAgentsResult,
  type NonterminalAgentLifecycleState,
  type SendAgentMessageResult,
  type StartAgentResult,
  type StopAgentResult,
  utf8ByteLength,
} from './contracts.js';
import {
  AgentManagerError,
  AgentProviderControlError,
  type AgentCallerIdentity,
  type AgentIdentity,
  type AgentInputAdapter,
  type AgentManagerOptions,
  type AgentManagerScheduler,
  type AgentOutboundMessageSnapshot,
  type AgentProviderExitEvent,
  type AgentProviderLifecycleControls,
  type AgentRecordSnapshot,
  type OrchestratorIdentity,
  validateAgentProviderLifecycleControls,
  validateAgentInputAdapter,
} from './agent_manager_types.js';
import { DEFAULT_AGENT_MANAGER_SCHEDULER } from './lifecycle_scheduler.js';
import {
  AgentDirectory,
  createRootAgentId,
  createDefaultAgentDirectoryOptions,
  validateAgentReservationRequest,
  type AgentDirectoryOptions,
} from './agent_directory.js';
import { parseAgentAddress, parseAgentId, type AgentName } from './agent_names.js';
import { AgentMailboxBinding } from './agent_mailbox_binding.js';
import { AgentStartupTracker } from './agent_startup.js';
import {
  createAgentMessagingSessionRuntime,
  type AgentMessagingSessionRuntime,
  type SessionRegistrationHandle,
} from './session_runtime.js';
import { formatAgentProcessLabel } from './agent_process_labels.js';
import {
  MailboxProtocolError,
  type MailboxErrorCode,
  type MailboxMessageRequest,
} from './mailbox_protocol.js';
import type { MailboxDeliveryResult } from './mailbox_server.js';
import type { AgentRegistration } from './runtime_dir.js';
import {
  formatTerminalNotification,
  type TerminalNotificationCause,
  type TerminalNotificationInput,
} from './terminal_notifications.js';

interface TerminalLifecycleState {
  readonly terminalPromise: Promise<void>;
  readonly resolveTerminal: () => void;
  terminalClaimed: boolean;
  cause: TerminalNotificationCause | undefined;
  finishRequested: boolean;
  closeAfterTurnRequested: boolean;
  closeAfterTurnPromise?: Promise<unknown>;
  closeAfterTurnError?: unknown;
  notificationAttempt?: Promise<void>;
  diagnostics: unknown[];
}

type StopLifecycleCause = 'none' | 'graceful-stop' | 'self-finish' | 'forced-stop';

interface StopLifecycleState {
  cause: StopLifecycleCause;
  gracefulAttempted: boolean;
  gracefulRequested: boolean;
  gracefulRequestInFlight: boolean;
  gracefulAccepted: boolean;
  inactivityTimerEnabled: boolean;
  gracefulInstruction: string;
  lastActivityAt: number | undefined;
  activityGeneration: number;
  timerGeneration: number;
  timerHandle: unknown;
  forceInFlight: boolean;
  forceAccepted: boolean;
  forceOutcomeUnknown: boolean;
  forceOperationPromise: Promise<StopAgentResult> | undefined;
  lastGracefulError: unknown;
  lastForceError: unknown;
}

function createStopLifecycleState(): StopLifecycleState {
  return {
    cause: 'none',
    gracefulAttempted: false,
    gracefulRequested: false,
    gracefulRequestInFlight: false,
    gracefulAccepted: false,
    inactivityTimerEnabled: false,
    gracefulInstruction: '',
    lastActivityAt: undefined,
    activityGeneration: 0,
    timerGeneration: 0,
    timerHandle: undefined,
    forceInFlight: false,
    forceAccepted: false,
    forceOutcomeUnknown: false,
    forceOperationPromise: undefined,
    lastGracefulError: undefined,
    lastForceError: undefined,
  };
}

function createTerminalLifecycleState(): TerminalLifecycleState {
  let resolveTerminal: (() => void) | undefined;
  const terminalPromise = new Promise<void>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    terminalPromise,
    resolveTerminal: (): void => resolveTerminal?.(),
    terminalClaimed: false,
    cause: undefined,
    finishRequested: false,
    closeAfterTurnRequested: false,
    diagnostics: [],
  };
}

interface NormalizedManagerOptions extends AgentDirectoryOptions {
  readonly agentPreparer: AgentManagerOptions['agentPreparer'];
  readonly agentLauncher: AgentManagerOptions['agentLauncher'];
  readonly orchestratorInputAdapter: AgentInputAdapter | undefined;
  readonly scheduler: AgentManagerScheduler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateInputAdapter(value: unknown, label: string): asserts value is AgentInputAdapter {
  try {
    validateAgentInputAdapter(value);
  } catch (error) {
    throw new AgentManagerError(
      'invalid_options',
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function validateAttempts(value: unknown, label: string, fallback: number): number {
  const attempts = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(attempts) || (attempts as number) < 1) {
    throw new AgentManagerError('invalid_options', `${label} must be a positive safe integer`);
  }
  return attempts as number;
}

const STANDARD_GRACEFUL_STOP_INSTRUCTION =
  'The orchestrator has requested a graceful shutdown. Complete your current work, then provide your final status update or result before ending your session.';

function buildGracefulStopInstruction(message: string | undefined): string {
  if (message === undefined || message.length === 0) return STANDARD_GRACEFUL_STOP_INSTRUCTION;
  return `${STANDARD_GRACEFUL_STOP_INSTRUCTION}\n\nAdditional shutdown context:\n---\n${message}\n---`;
}

function normalizeOptions(options: AgentManagerOptions): NormalizedManagerOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new AgentManagerError('invalid_options', 'Agent manager options must be an object');
  }
  const directoryDefaults = createDefaultAgentDirectoryOptions({
    orchestratorExecutor: options.orchestratorExecutor,
    agentIdGenerator: options.agentIdGenerator,
    slugGenerator: options.slugGenerator,
    maxAgentIdGenerationAttempts: validateAttempts(
      options.maxAgentIdGenerationAttempts,
      'maxAgentIdGenerationAttempts',
      32
    ),
    maxAgentNameGenerationAttempts: validateAttempts(
      options.maxAgentNameGenerationAttempts,
      'maxAgentNameGenerationAttempts',
      32
    ),
  });
  if (options.agentIdGenerator !== undefined && typeof options.agentIdGenerator !== 'function') {
    throw new AgentManagerError('invalid_options', 'agentIdGenerator must be a function');
  }
  if (options.slugGenerator !== undefined && typeof options.slugGenerator !== 'function') {
    throw new AgentManagerError('invalid_options', 'slugGenerator must be a function');
  }
  if (
    options.agentPreparer !== undefined &&
    (!isRecord(options.agentPreparer) || typeof options.agentPreparer.prepare !== 'function')
  ) {
    throw new AgentManagerError('invalid_options', 'agentPreparer must provide a prepare function');
  }
  if (
    options.agentLauncher !== undefined &&
    (!isRecord(options.agentLauncher) || typeof options.agentLauncher.launch !== 'function')
  ) {
    throw new AgentManagerError('invalid_options', 'agentLauncher must provide a launch function');
  }
  if (options.orchestratorInputAdapter !== undefined) {
    validateInputAdapter(options.orchestratorInputAdapter, 'orchestratorInputAdapter');
  }
  const scheduler = options.scheduler ?? DEFAULT_AGENT_MANAGER_SCHEDULER;
  if (!isRecord(scheduler)) {
    throw new AgentManagerError('invalid_options', 'scheduler must be an object');
  }
  for (const method of ['now', 'setTimeout', 'clearTimeout']) {
    if (typeof scheduler[method] !== 'function') {
      throw new AgentManagerError('invalid_options', `scheduler.${method} must be a function`);
    }
  }
  return {
    ...directoryDefaults,
    agentPreparer: options.agentPreparer,
    agentLauncher: options.agentLauncher,
    orchestratorInputAdapter: options.orchestratorInputAdapter,
    scheduler,
  };
}

/** Owns provider-neutral agent routing and terminal lifecycle convergence. */
export class AgentManager {
  public readonly sessionRuntime: AgentMessagingSessionRuntime;
  public readonly orchestratorIdentity: OrchestratorIdentity;

  private readonly directory: AgentDirectory;
  private readonly startupTracker: AgentStartupTracker;
  private readonly mailboxBindings = new Map<string, AgentMailboxBinding>();
  private readonly ownsSessionRuntime: boolean;
  private readonly rootRegistration: SessionRegistrationHandle;
  private readonly options: NormalizedManagerOptions;
  private readonly lifecycleUnsubscribers = new Map<string, readonly (() => void)[]>();
  /** One shared terminal authority and promise for each active agent. */
  private readonly terminalLifecycles = new Map<string, TerminalLifecycleState>();
  private readonly stopLifecycles = new Map<string, StopLifecycleState>();
  private nextOutboundSequence = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private unregisterCleanupHandler: (() => void) | undefined;

  private constructor(
    sessionRuntime: AgentMessagingSessionRuntime,
    directory: AgentDirectory,
    options: NormalizedManagerOptions,
    ownsSessionRuntime: boolean,
    rootRegistration: SessionRegistrationHandle
  ) {
    this.sessionRuntime = sessionRuntime;
    this.directory = directory;
    this.startupTracker = new AgentStartupTracker(directory);
    this.options = options;
    this.ownsSessionRuntime = ownsSessionRuntime;
    this.rootRegistration = rootRegistration;
    this.orchestratorIdentity = directory.orchestratorIdentity;
    const rootRecord = directory.getRecord(this.orchestratorIdentity.id);
    if (rootRecord === undefined) {
      throw new AgentManagerError('root_registration_failed', 'The orchestrator record is missing');
    }
    const rootBinding = new AgentMailboxBinding(directory, rootRecord);
    rootBinding.attachMailbox(rootRegistration);
    this.mailboxBindings.set(rootRecord.id, rootBinding);
    if (options.orchestratorInputAdapter !== undefined) {
      rootBinding.bindInputAdapter(options.orchestratorInputAdapter);
    }
  }

  /** Create and initialize a manager with a ready reserved root mailbox. */
  public static async create(options: AgentManagerOptions = {}): Promise<AgentManager> {
    const normalizedOptions = normalizeOptions(options);
    const ownsSessionRuntime = options.sessionRuntime === undefined;
    const sessionRuntime = options.sessionRuntime ?? (await createAgentMessagingSessionRuntime());
    let rootRegistration: SessionRegistrationHandle | undefined;
    let rootDelivery: (
      message: MailboxMessageRequest,
      sourceRegistration: AgentRegistration
    ) => Promise<MailboxDeliveryResult> = async (): Promise<MailboxDeliveryResult> =>
      'temporarily-unavailable';
    let rootBinding: AgentMailboxBinding | undefined;
    try {
      const rootId = createRootAgentId(normalizedOptions);
      const rootRegistrationDraft = {
        id: rootId,
        name: ORCHESTRATOR_AGENT_NAME,
        role: 'orchestrator' as const,
        executor: normalizedOptions.orchestratorExecutor,
        state: 'running-idle' as const,
      };
      rootRegistration = await sessionRuntime.register({
        registration: rootRegistrationDraft,
        deliver: async (message, sourceRegistration): Promise<MailboxDeliveryResult> =>
          rootDelivery(message, sourceRegistration),
        onMessageQueued: (): void => {
          rootBinding?.notifyMailboxMessageQueued();
        },
      });
      await rootRegistration.ready;
      const rootName = rootRegistration.registration.name as AgentName;
      const rootRecord = {
        id: rootId,
        name: rootName,
        role: 'orchestrator' as const,
        executor: normalizedOptions.orchestratorExecutor,
        state: 'running-idle' as const,
        inputActivity: 'idle' as const,
        creationSequence: 0,
        providerOutputActivityCount: 0,
        providerTurnCompletionCount: 0,
        registrationDraft: rootRegistrationDraft,
        registration: rootRegistration.registration,
        mailbox: rootRegistration,
      };
      const directory = new AgentDirectory(normalizedOptions, rootRecord);
      const manager = new AgentManager(
        sessionRuntime,
        directory,
        normalizedOptions,
        ownsSessionRuntime,
        rootRegistration
      );
      rootBinding = manager.mailboxBindings.get(rootId);
      if (rootBinding === undefined) {
        throw new AgentManagerError(
          'root_registration_failed',
          'The root mailbox binding is missing'
        );
      }
      const registeredRootBinding = rootBinding;
      rootDelivery = (message, sourceRegistration): Promise<MailboxDeliveryResult> =>
        registeredRootBinding.deliver(message, sourceRegistration);
      manager.unregisterCleanupHandler = CleanupRegistry.getInstance().register(() =>
        manager.close()
      );
      return manager;
    } catch (error) {
      await rootRegistration?.deregister().catch(() => undefined);
      if (ownsSessionRuntime) await sessionRuntime.close().catch(() => undefined);
      if (error instanceof AgentManagerError) throw error;
      throw new AgentManagerError(
        'root_registration_failed',
        `Could not register the orchestrator mailbox: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get subagentCount(): number {
    return this.directory.subagentCount;
  }

  public listAgents(): ListAgentsResult {
    return this.directory.listAgents();
  }

  public async startAgent(
    caller: AgentCallerIdentity,
    request: unknown
  ): Promise<StartAgentResult> {
    this.ensureOpen();
    this.directory.assertOrchestrator(caller);
    const validated = validateAgentReservationRequest(request);
    if (this.options.agentPreparer === undefined || this.options.agentLauncher === undefined) {
      throw new AgentManagerError(
        'launch_failed',
        'Provider-neutral agent preparation and launch dependencies are required'
      );
    }

    const reservation = this.directory.reserve(validated);
    const record = reservation.record;
    const binding = new AgentMailboxBinding(this.directory, record);
    this.mailboxBindings.set(record.id, binding);
    this.terminalLifecycles.set(record.id, createTerminalLifecycleState());
    const operation = this.startupTracker.create(record, reservation);
    try {
      const prepared = await operation.awaitBoundary(
        this.options.agentPreparer.prepare({
          identity: reservation.identity,
          initialMessage: validated.initialMessage,
        })
      );
      operation.ensureActive();
      if (prepared.agentType !== record.type || prepared.executor !== record.executor) {
        throw new Error('Agent preparation did not preserve the requested type and executor');
      }

      const mailbox = await operation.awaitResource(
        this.sessionRuntime.register({
          registration: record.registrationDraft,
          deliver: (message, sourceRegistration): Promise<MailboxDeliveryResult> =>
            binding.deliver(message, sourceRegistration),
          onMessageQueued: (): void => binding.notifyMailboxMessageQueued(),
        }),
        (value): void => {
          operation.attachMailbox(value);
          binding.attachMailbox(value);
        },
        (value): void => {
          operation.pendingMailboxRegistration = value;
        }
      );
      operation.ensureActive();
      await operation.awaitBoundary(mailbox.ready);
      operation.ensureActive();

      const handle = await operation.awaitResource(
        this.options.agentLauncher.launch({
          identity: reservation.identity,
          initialMessage: validated.initialMessage,
          preparedExecution: prepared,
          processLabel: formatAgentProcessLabel(record.executor, record.name),
        }),
        (value): void => operation.attachHandle(value),
        (value): void => {
          operation.pendingHandleLaunch = value;
        }
      );
      operation.ensureActive();
      validateAgentProviderLifecycleControls(handle.lifecycle);
      this.bindProviderLifecycle(record, handle.lifecycle);
      binding.bindInputAdapter(handle.input);
      await operation.awaitBoundary(handle.ready);
      operation.ensureActive();
      if (record.providerExit !== undefined) {
        throw new AgentManagerError(
          'launch_failed',
          `Agent ${record.name} exited before launch readiness${
            record.providerExit.error === undefined ? '' : `: ${record.providerExit.error.message}`
          }`
        );
      }
      binding.markLaunchReady();
      this.maybeRequestProviderStop(record);

      return Object.freeze({
        name: record.name,
        id: record.id,
        type: record.type,
        executor: record.executor,
        state: record.state,
      });
    } catch (error) {
      const terminalLifecycle = this.terminalLifecycles.get(record.id);
      this.disposeStopLifecycle(record.id);
      this.unbindProviderLifecycle(record.id);
      binding.dispose();
      this.mailboxBindings.delete(record.id);
      await operation.rollback();
      if (this.closePromise === undefined) {
        this.terminalLifecycles.delete(record.id);
      } else {
        // Root teardown may already be waiting for this startup generation.
        // A failed start has no provider exit event, so resolve its shared
        // terminal wait after the normal rollback has completed.
        terminalLifecycle?.resolveTerminal();
      }
      if (
        error instanceof AgentManagerError &&
        (error.code === 'manager_closed' || error.code === 'launch_failed')
      )
        throw error;
      throw new AgentManagerError(
        'launch_failed',
        `Could not start agent ${record.name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    } finally {
      this.startupTracker.finish(operation);
    }
  }

  public async sendAgentMessage(
    caller: AgentCallerIdentity,
    request: unknown
  ): Promise<SendAgentMessageResult> {
    this.ensureOpen();
    const validated = this.validateSendRequest(request);
    const sourceRecord = this.directory.resolveCaller(caller);
    if (this.isTerminalClaimed(sourceRecord.id)) {
      throw new AgentManagerError('unknown_sender', 'The message sender is not an active agent');
    }
    const targetName = this.parseTargetName(validated.name);
    const targetRecord = this.directory.getRecordByName(targetName);
    if (targetRecord === undefined || !isNonterminalAgentLifecycleState(targetRecord.state)) {
      throw new AgentManagerError(
        'unknown_target',
        `Unknown or inactive target agent: ${validated.name}`
      );
    }
    if (this.isTerminalClaimed(targetRecord.id)) {
      throw new AgentManagerError(
        'target_not_accepting_messages',
        `Agent ${targetRecord.name} is not accepting new messages because it is completing`
      );
    }
    if (targetRecord.state === 'finishing' || targetRecord.state === 'stopping') {
      throw new AgentManagerError(
        'target_not_accepting_messages',
        `Agent ${targetRecord.name} is not accepting new messages while ${targetRecord.state}`
      );
    }
    if (targetRecord.registration === undefined || targetRecord.mailbox === undefined) {
      throw new AgentManagerError(
        'target_not_accepting_messages',
        `Agent ${targetRecord.name} does not have a ready mailbox`
      );
    }

    const messageId = randomUUID();
    try {
      const acknowledgement = await this.sessionRuntime.sendMessage(
        { id: sourceRecord.id, name: sourceRecord.name },
        { id: targetRecord.id, name: targetRecord.name },
        { requestId: messageId, content: validated.message }
      );
      if (!acknowledgement.success) {
        throw this.mapMailboxError(
          acknowledgement.error.code,
          acknowledgement.error.message,
          acknowledgement.error.code === 'unknown_source'
            ? undefined
            : new MailboxProtocolError(acknowledgement.error.code, acknowledgement.error.message)
        );
      }
      this.recordSuccessfulOutbound(sourceRecord, targetRecord.name, validated.message);
      return Object.freeze({
        name: targetRecord.name,
        messageId: acknowledgement.requestId,
        delivery: acknowledgement.delivery,
      });
    } catch (error) {
      if (error instanceof AgentManagerError) throw error;
      throw this.mapMailboxTransportError(error);
    }
  }

  /** Request that the bound subagent close after its current provider turn. */
  public async finishAgent(
    caller: AgentCallerIdentity,
    request: unknown
  ): Promise<FinishAgentResult> {
    this.ensureOpen();
    const callerRecord = this.directory.resolveCaller(caller);
    if (callerRecord.role !== 'subagent') {
      throw new AgentManagerError(
        'not_authorized',
        'Only a subagent may finish its own current turn'
      );
    }

    const parsed = finishAgentArgumentsSchema.safeParse(request);
    if (!parsed.success) {
      throw new AgentManagerError('invalid_request', 'FinishAgent request is invalid');
    }

    const record = callerRecord;
    const terminalLifecycle = this.getOrCreateTerminalLifecycle(record.id);
    if (record.providerExit !== undefined || terminalLifecycle.terminalClaimed) {
      throw new AgentManagerError(
        'finish_not_available',
        'FinishAgent is not available after the provider has exited'
      );
    }
    if (record.state === 'finishing') {
      if (terminalLifecycle.finishRequested) {
        if (
          parsed.data.message !== undefined &&
          parsed.data.message.trim().length > 0 &&
          record.finishFallbackMessage === undefined
        ) {
          record.finishFallbackMessage = parsed.data.message;
        }
        return Object.freeze({ state: 'finishing' });
      }
      throw new AgentManagerError(
        'finish_not_available',
        'FinishAgent was not the operation that started this finishing transition'
      );
    }
    if (record.state !== 'running-active') {
      throw new AgentManagerError(
        'finish_not_available',
        'FinishAgent is only available during an active provider turn'
      );
    }
    if (record.launchHandle?.lifecycle === undefined) {
      throw new AgentManagerError(
        'finish_not_available',
        'The provider lifecycle is not ready for FinishAgent'
      );
    }

    // This transition is synchronous. It must be visible before any later
    // message or lifecycle callback can observe the request.
    record.state = 'finishing';
    if (
      parsed.data.message !== undefined &&
      parsed.data.message.trim().length > 0 &&
      record.finishFallbackMessage === undefined
    ) {
      record.finishFallbackMessage = parsed.data.message;
    }
    terminalLifecycle.finishRequested = true;

    return Object.freeze({ state: 'finishing' });
  }

  /**
   * Request a provider-neutral graceful or forced stop for one subagent.
   * Graceful requests acknowledge immediately; explicit force requests wait
   * only for the provider control to report accepted/already-exited or a
   * guaranteed-unaccepted failure.
   */
  public async stopAgent(caller: AgentCallerIdentity, request: unknown): Promise<StopAgentResult> {
    this.ensureOpen();
    this.directory.assertOrchestrator(caller);

    const parsed = stopAgentArgumentsSchema.safeParse(request);
    if (!parsed.success) {
      if (isRecord(request) && typeof request.name === 'string') {
        if (request.name === ORCHESTRATOR_AGENT_NAME) {
          throw new AgentManagerError(
            'reserved_name',
            `The reserved ${ORCHESTRATOR_AGENT_NAME} identity cannot be stopped`
          );
        }
        if (parseAgentAddress(request.name) === undefined) {
          throw new AgentManagerError('invalid_name', 'The target agent name is invalid');
        }
      }
      throw new AgentManagerError('invalid_request', 'StopAgent request is invalid');
    }

    const targetName = this.parseTargetName(parsed.data.name);
    const record = this.directory.getRecordByName(targetName);
    if (
      record === undefined ||
      record.role !== 'subagent' ||
      !isNonterminalAgentLifecycleState(record.state)
    ) {
      throw new AgentManagerError(
        'unknown_target',
        `Unknown or inactive target agent: ${targetName}`
      );
    }
    if (this.isTerminalClaimed(record.id)) {
      return Object.freeze({ name: record.name, mode: 'already-stopping', state: record.state });
    }

    // A provider exit is authoritative while terminal cleanup is in progress.
    // Never turn a proven natural exit into a forced one because a late
    // StopAgent call arrived.
    if (record.providerExit !== undefined) {
      return Object.freeze({ name: record.name, mode: 'already-stopping', state: record.state });
    }

    const stopState = this.stopLifecycles.get(record.id);
    if (parsed.data.force === true) {
      return this.requestForcedStop(record, stopState);
    }

    if (
      record.state === 'finishing' ||
      record.state === 'stopping' ||
      stopState?.gracefulRequested
    ) {
      return Object.freeze({ name: record.name, mode: 'already-stopping', state: record.state });
    }

    // Make the state transition visible before provider work starts. This
    // synchronously rejects ordinary sends and serializes duplicate stops.
    record.state = 'stopping';
    const lifecycle = this.getOrCreateStopLifecycle(record);
    lifecycle.cause = 'graceful-stop';
    lifecycle.gracefulRequested = true;
    lifecycle.gracefulInstruction = buildGracefulStopInstruction(parsed.data.message);
    lifecycle.lastActivityAt = this.options.scheduler.now();
    lifecycle.activityGeneration += 1;
    lifecycle.inactivityTimerEnabled = true;
    this.maybeRequestGracefulStop(record);

    return Object.freeze({ name: record.name, mode: 'graceful-requested', state: record.state });
  }

  public getAgentSnapshot(agentId: string): AgentRecordSnapshot | undefined {
    const parsedId = parseAgentId(agentId);
    const record = parsedId === undefined ? undefined : this.directory.getRecord(parsedId);
    return record === undefined ? undefined : this.directory.snapshot(record);
  }

  /** Join the one terminal cleanup promise for an agent, if it is still known. */
  public waitForAgentTerminal(agentId: string): Promise<void> {
    const parsedId = parseAgentId(agentId);
    return parsedId === undefined
      ? Promise.resolve()
      : (this.terminalLifecycles.get(parsedId)?.terminalPromise ?? Promise.resolve());
  }

  public getIdentityByName(name: string): AgentIdentity | undefined {
    return this.directory.getIdentityByName(name);
  }

  /** Narrow lifecycle test seam for changing an observable nonterminal state. */
  public setAgentLifecycleState(agentId: string, state: NonterminalAgentLifecycleState): void {
    this.ensureOpen();
    const parsedId = parseAgentId(agentId);
    if (parsedId === undefined) {
      throw new AgentManagerError('unknown_agent', `Unknown agent ID: ${agentId}`);
    }
    this.directory.setLifecycleState(parsedId, state);
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const startupOperations = [...this.startupTracker.values()];
    const startupCleanupPromises = startupOperations.map((operation) => {
      const cleanupPromise = operation.cleanupForClose();
      // Keep the original promise for allSettled diagnostics, but attach a
      // rejection handler in this same turn. Terminal teardown can take long
      // enough that a rejected startup cleanup must not become unhandled first.
      void cleanupPromise.catch(() => undefined);
      return cleanupPromise;
    });
    const snapshot = this.directory.records.filter(
      (
        record
      ): record is Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }> =>
        record.role === 'subagent' && isNonterminalAgentLifecycleState(record.state)
    );
    // Claim the shutdown intent for every agent before awaiting any terminal
    // promise. This is the parallel fan-out point for root teardown.
    const terminalPromises = snapshot.map((record) => this.requestRootTeardown(record));
    this.closePromise = (async (): Promise<void> => {
      let firstError: unknown;
      const terminalResults = await Promise.allSettled(terminalPromises);
      for (const result of terminalResults) {
        if (result.status === 'rejected') firstError ??= result.reason;
      }
      const startupResults = await Promise.allSettled(startupCleanupPromises);
      for (const result of startupResults) {
        if (result.status === 'rejected') firstError ??= result.reason;
      }
      const lateCleanupResults = await Promise.allSettled(
        startupOperations.map((operation) => operation.waitForLateCleanup())
      );
      for (const result of lateCleanupResults) {
        if (result.status === 'rejected') firstError ??= result.reason;
      }

      // Terminal notifications use the orchestrator mailbox, so root
      // resources stay open until every subagent terminal attempt settles.
      const rootCleanup = await Promise.allSettled([this.rootRegistration.deregister()]);
      for (const result of rootCleanup) {
        if (result.status === 'rejected') firstError ??= result.reason;
      }

      try {
        if (this.ownsSessionRuntime) await this.sessionRuntime.close();
      } catch (error) {
        firstError ??= error;
      } finally {
        for (const agentId of this.stopLifecycles.keys()) {
          this.disposeStopLifecycle(agentId);
        }
        this.stopLifecycles.clear();
        for (const agentId of this.lifecycleUnsubscribers.keys()) {
          this.unbindProviderLifecycle(agentId);
        }
        for (const binding of this.mailboxBindings.values()) binding.dispose();
        this.mailboxBindings.clear();
        this.terminalLifecycles.clear();
        this.directory.clear();
        this.unregisterCleanupHandler?.();
        this.unregisterCleanupHandler = undefined;
      }
      if (firstError !== undefined) throw firstError;
    })();
    return this.closePromise;
  }

  /** Start or join one graceful shutdown for a root-teardown snapshot entry. */
  private requestRootTeardown(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>
  ): Promise<void> {
    const terminalLifecycle = this.getOrCreateTerminalLifecycle(record.id);
    if (terminalLifecycle.terminalClaimed) return terminalLifecycle.terminalPromise;

    const wasStarting = record.state === 'starting';
    const stopState = this.getOrCreateStopLifecycle(record);
    if (record.state === 'finishing' && !stopState.inactivityTimerEnabled) {
      // Root teardown owns an independent deadline for a self-finishing
      // provider. It must not send a second graceful instruction.
      stopState.lastActivityAt = this.options.scheduler.now();
      stopState.activityGeneration += 1;
      stopState.inactivityTimerEnabled = true;
      this.armStopInactivityTimer(record, stopState);
    }
    if (
      record.state !== 'finishing' &&
      !stopState.gracefulRequested &&
      !stopState.forceInFlight &&
      !stopState.forceAccepted &&
      !stopState.forceOutcomeUnknown
    ) {
      record.state = 'stopping';
      stopState.cause = 'graceful-stop';
      stopState.gracefulRequested = true;
      stopState.gracefulInstruction = buildGracefulStopInstruction(undefined);
      stopState.lastActivityAt = this.options.scheduler.now();
      stopState.activityGeneration += 1;
      stopState.inactivityTimerEnabled = true;
    }

    const startupOperation = this.startupTracker
      .values()
      .find((operation) => operation.record === record);
    if (wasStarting && record.launchHandle?.lifecycle === undefined) {
      // There is no provider control to call yet. Keep the stop intent on the
      // record. The startup path will call maybeRequestProviderStop as soon
      // as it binds the provider lifecycle, or its normal failure rollback
      // will resolve this terminal wait if startup fails first.
      if (startupOperation !== undefined) {
        return terminalLifecycle.terminalPromise;
      } else {
        terminalLifecycle.resolveTerminal();
      }
      return terminalLifecycle.terminalPromise;
    }

    if (
      record.launchHandle?.lifecycle !== undefined &&
      !this.lifecycleUnsubscribers.has(record.id)
    ) {
      // A launch handle can be attached while startAgent is between the
      // launch and readiness awaits. Bind it now so exit and output events
      // remain observable during teardown.
      this.bindProviderLifecycle(record, record.launchHandle.lifecycle);
    }

    // This call performs provider control synchronously up to its first
    // promise boundary. Calling it for every snapshot entry above means all
    // graceful requests start before this method awaits any terminal result.
    this.maybeRequestProviderStop(record);
    return terminalLifecycle.terminalPromise;
  }

  private validateSendRequest(request: unknown): {
    readonly name: string;
    readonly message: string;
  } {
    if (
      isRecord(request) &&
      typeof request.message === 'string' &&
      utf8ByteLength(request.message) > MAX_AGENT_MESSAGE_BYTES
    ) {
      throw new AgentManagerError(
        'invalid_request',
        `Agent message content must be at most ${MAX_AGENT_MESSAGE_BYTES} UTF-8 bytes`,
        undefined,
        'message_too_large'
      );
    }
    const result = sendAgentMessageArgumentsSchema.safeParse(request);
    if (!result.success) {
      if (isRecord(request) && Object.hasOwn(request, 'name')) {
        if (parseAgentAddress(request.name) === undefined) {
          throw new AgentManagerError('invalid_name', 'The target agent name is invalid');
        }
      }
      throw new AgentManagerError('invalid_request', 'SendAgentMessage request is invalid');
    }
    return result.data;
  }

  private parseTargetName(name: string): AgentName {
    const parsed = parseAgentAddress(name);
    if (parsed === undefined)
      throw new AgentManagerError('invalid_name', `Invalid target agent name: ${name}`);
    return parsed;
  }

  private bindProviderLifecycle(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    lifecycle: AgentProviderLifecycleControls
  ): void {
    this.unbindProviderLifecycle(record.id);
    const isCurrentEvent = (agentId: string): boolean =>
      agentId === record.id && this.directory.getRecord(record.id) === record;
    const unsubscribers = [
      lifecycle.onOutputActivity((event): void => {
        if (
          !isCurrentEvent(event.agentId) ||
          record.providerExit !== undefined ||
          this.isTerminalClaimed(record.id)
        )
          return;
        record.providerOutputActivityCount += 1;
        this.noteStopOutputActivity(record);
      }),
      lifecycle.onCompletedAssistantMessage((event): void => {
        if (
          !isCurrentEvent(event.agentId) ||
          record.providerExit !== undefined ||
          this.isTerminalClaimed(record.id)
        )
          return;
        record.lastCompletedAssistantMessage = event.message;
        // A complete assistant result is also provider output activity. Keep
        // result capture separate from activity accounting, but do not let a
        // provider that reports only the complete event look inactive.
        this.noteStopOutputActivity(record);
      }),
      lifecycle.onTurnComplete((event): void => {
        if (
          !isCurrentEvent(event.agentId) ||
          record.providerExit !== undefined ||
          this.isTerminalClaimed(record.id)
        )
          return;
        record.providerTurnCompletionCount += 1;
        this.requestFinishCloseAfterTurn(record, lifecycle);
      }),
      lifecycle.onExit((event): void => {
        if (!isCurrentEvent(event.agentId) || record.providerExit !== undefined) return;
        record.providerExit = Object.freeze({ ...event });
        if (!record.launchReady) {
          this.startupTracker
            .findByRecord(record)
            ?.cancel(
              new AgentManagerError(
                'launch_failed',
                `Agent ${record.name} exited before launch readiness${
                  event.error === undefined ? '' : `: ${event.error.message}`
                }`
              )
            );
          return;
        }
        void this.beginTerminal(record, this.selectTerminalCause(record, event));
      }),
    ];
    this.lifecycleUnsubscribers.set(record.id, unsubscribers);
  }

  /**
   * Converge a provider control result that proves the provider already exited
   * even when that provider does not emit a separate exit callback.
   */
  private synthesizeProviderExit(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    classification: AgentProviderExitEvent['classification']
  ): void {
    if (record.providerExit !== undefined) return;
    const event: AgentProviderExitEvent = Object.freeze({
      agentId: record.id as AgentProviderExitEvent['agentId'],
      classification,
    });
    record.providerExit = event;
    if (!record.launchReady) {
      this.startupTracker
        .findByRecord(record)
        ?.cancel(
          new AgentManagerError(
            'launch_failed',
            `Agent ${record.name} exited before launch readiness`
          )
        );
      return;
    }
    void this.beginTerminal(record, this.selectTerminalCause(record, event));
  }

  private getOrCreateStopLifecycle(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>
  ): StopLifecycleState {
    const existing = this.stopLifecycles.get(record.id);
    if (existing !== undefined) return existing;
    const created = createStopLifecycleState();
    if (this.getOrCreateTerminalLifecycle(record.id).finishRequested) {
      created.cause = 'self-finish';
    }
    this.stopLifecycles.set(record.id, created);
    return created;
  }

  private maybeRequestProviderStop(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>
  ): void {
    const stopState = this.stopLifecycles.get(record.id);
    if (
      stopState === undefined ||
      record.providerExit !== undefined ||
      record.launchHandle?.lifecycle === undefined
    ) {
      return;
    }
    if (stopState.forceInFlight && !stopState.forceOperationPromise) {
      void this.startForcedStopOperation(record, stopState, false);
      return;
    }
    this.maybeRequestGracefulStop(record);
  }

  private maybeRequestGracefulStop(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>
  ): void {
    const stopState = this.stopLifecycles.get(record.id);
    const lifecycle = record.launchHandle?.lifecycle;
    if (
      stopState === undefined ||
      lifecycle === undefined ||
      record.providerExit !== undefined ||
      !stopState.gracefulRequested ||
      stopState.gracefulAttempted ||
      stopState.gracefulRequestInFlight ||
      stopState.gracefulAccepted ||
      stopState.forceInFlight ||
      stopState.forceAccepted
    ) {
      return;
    }

    stopState.gracefulRequestInFlight = true;
    stopState.gracefulAttempted = true;
    const requestGeneration = stopState.activityGeneration;
    let request: Promise<import('./agent_manager_types.js').AgentProviderControlResult>;
    try {
      request = lifecycle.requestGracefulShutdown(stopState.gracefulInstruction);
    } catch (error) {
      this.handleGracefulStopFailure(record, stopState, error);
      return;
    }
    void Promise.resolve(request).then(
      (result): void => this.handleGracefulStopResult(record, stopState, result, requestGeneration),
      (error: unknown): void => this.handleGracefulStopFailure(record, stopState, error)
    );
  }

  private handleGracefulStopResult(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    stopState: StopLifecycleState,
    result: import('./agent_manager_types.js').AgentProviderControlResult,
    requestGeneration: number
  ): void {
    if (this.directory.getRecord(record.id) !== record) return;
    stopState.gracefulRequestInFlight = false;
    if (result.accepted) {
      stopState.gracefulAccepted = true;
      stopState.inactivityTimerEnabled = true;
      if (stopState.activityGeneration === requestGeneration) {
        // No output arrived while acceptance was pending. The inactivity
        // window begins when the provider accepted the graceful request.
        stopState.lastActivityAt = this.options.scheduler.now();
        stopState.activityGeneration += 1;
      }
      if (
        record.providerExit === undefined &&
        !stopState.forceInFlight &&
        !stopState.forceAccepted
      ) {
        this.armStopInactivityTimer(record, stopState);
      }
      return;
    }

    // The provider contract allows an already-exited result without a second
    // exit callback. Synthesize the provider-neutral convergence event.
    stopState.gracefulAccepted = false;
    this.cancelStopTimer(record.id);
    this.synthesizeProviderExit(record, 'natural');
  }

  private handleGracefulStopFailure(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    stopState: StopLifecycleState,
    error: unknown
  ): void {
    if (this.directory.getRecord(record.id) !== record) return;
    stopState.gracefulRequestInFlight = false;
    stopState.lastGracefulError = error;
    stopState.inactivityTimerEnabled = true;
    stopState.lastActivityAt ??= this.options.scheduler.now();
    this.armStopInactivityTimer(record, stopState);
  }

  private noteStopOutputActivity(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>
  ): void {
    const stopState = this.stopLifecycles.get(record.id);
    if (
      stopState === undefined ||
      !stopState.inactivityTimerEnabled ||
      stopState.forceInFlight ||
      stopState.forceAccepted
    ) {
      return;
    }
    stopState.lastActivityAt = this.options.scheduler.now();
    stopState.activityGeneration += 1;
    if (!stopState.gracefulRequestInFlight) this.armStopInactivityTimer(record, stopState);
  }

  private armStopInactivityTimer(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    stopState: StopLifecycleState
  ): void {
    if (
      record.providerExit !== undefined ||
      !stopState.inactivityTimerEnabled ||
      stopState.forceInFlight ||
      stopState.forceAccepted ||
      stopState.lastActivityAt === undefined
    ) {
      return;
    }
    this.cancelStopTimer(record.id);
    const expectedActivityGeneration = stopState.activityGeneration;
    const expectedTimerGeneration = ++stopState.timerGeneration;
    const remaining = Math.max(
      0,
      stopState.lastActivityAt + STOP_AGENT_INACTIVITY_TIMEOUT_MS - this.options.scheduler.now()
    );
    const timerHandle = this.options.scheduler.setTimeout((): void => {
      if (
        this.directory.getRecord(record.id) !== record ||
        record.providerExit !== undefined ||
        stopState.timerGeneration !== expectedTimerGeneration ||
        stopState.activityGeneration !== expectedActivityGeneration
      ) {
        return;
      }
      stopState.timerHandle = undefined;
      const timeRemaining =
        (stopState.lastActivityAt ?? this.options.scheduler.now()) +
        STOP_AGENT_INACTIVITY_TIMEOUT_MS -
        this.options.scheduler.now();
      if (timeRemaining > 0) {
        this.armStopInactivityTimer(record, stopState);
        return;
      }
      void this.requestForcedStop(record, stopState, false).catch(() => undefined);
    }, remaining);
    stopState.timerHandle = timerHandle;
  }

  private cancelStopTimer(agentId: string): void {
    const stopState = this.stopLifecycles.get(agentId);
    if (stopState === undefined) return;
    stopState.timerGeneration += 1;
    if (stopState.timerHandle !== undefined) {
      this.options.scheduler.clearTimeout(stopState.timerHandle);
      stopState.timerHandle = undefined;
    }
  }

  private disposeStopLifecycle(agentId: string): void {
    this.cancelStopTimer(agentId);
    this.stopLifecycles.delete(agentId);
  }

  private getOrCreateTerminalLifecycle(agentId: string): TerminalLifecycleState {
    const existing = this.terminalLifecycles.get(agentId);
    if (existing !== undefined) return existing;
    const created = createTerminalLifecycleState();
    this.terminalLifecycles.set(agentId, created);
    return created;
  }

  private isTerminalClaimed(agentId: string): boolean {
    return this.terminalLifecycles.get(agentId)?.terminalClaimed === true;
  }

  private selectTerminalCause(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    event: AgentProviderExitEvent
  ): TerminalNotificationCause {
    if (event.classification === 'failed') return 'provider-failure';
    const terminalLifecycle = this.getOrCreateTerminalLifecycle(record.id);
    const stopState = this.stopLifecycles.get(record.id);

    if (event.classification === 'natural') {
      // A proven natural exit remains natural even when a force request was
      // already in flight. The provider classification is stronger than the
      // manager's pending control intent for this race.
      if (
        terminalLifecycle.finishRequested &&
        stopState?.forceAccepted !== true &&
        stopState?.forceInFlight !== true
      ) {
        return 'self-finish';
      }
      return 'natural';
    }
    if (event.classification === 'forced') return 'forced-stop';
    // An in-flight force request has not yet proved that the provider accepted
    // the control. A classified graceful exit therefore remains graceful; a
    // later already-exited control result must not rewrite the terminal cause.
    if (stopState?.forceAccepted === true) {
      return 'forced-stop';
    }
    if (terminalLifecycle.finishRequested) {
      return 'self-finish';
    }
    return event.classification === 'graceful' ? 'graceful-stop' : 'natural';
  }

  /**
   * Claim the one terminal transition before starting any asynchronous work.
   * The record stays list-visible until cleanup removes its registration and
   * directory entry, while the claim rejects all new manager work immediately.
   */
  private beginTerminal(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    cause: TerminalNotificationCause
  ): Promise<void> {
    const terminalLifecycle = this.getOrCreateTerminalLifecycle(record.id);
    if (terminalLifecycle.terminalClaimed) return terminalLifecycle.terminalPromise;

    terminalLifecycle.terminalClaimed = true;
    terminalLifecycle.cause = cause;
    this.cancelStopTimer(record.id);
    this.unbindProviderLifecycle(record.id);

    const notificationInput: TerminalNotificationInput = Object.freeze({
      agentName: record.name,
      cause,
      ...(record.lastCompletedAssistantMessage === undefined
        ? {}
        : { lastCompletedAssistantMessage: record.lastCompletedAssistantMessage }),
      ...(record.finishFallbackMessage === undefined
        ? {}
        : { finishFallbackMessage: record.finishFallbackMessage }),
      ...(record.lastSuccessfulOutbound === undefined
        ? {}
        : {
            lastSuccessfulOutbound: Object.freeze({
              target: record.lastSuccessfulOutbound.target,
              content: record.lastSuccessfulOutbound.content,
            }),
          }),
    });
    const decision = formatTerminalNotification(notificationInput);
    terminalLifecycle.notificationAttempt =
      decision.suppressed || decision.content === undefined
        ? Promise.resolve()
        : this.deliverTerminalNotification(record, decision.content, terminalLifecycle);

    void this.cleanupTerminal(record, terminalLifecycle);
    return terminalLifecycle.terminalPromise;
  }

  private async deliverTerminalNotification(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    content: string,
    terminalLifecycle: TerminalLifecycleState
  ): Promise<void> {
    try {
      const acknowledgement = await this.sessionRuntime.sendMessage(
        { id: record.id, name: record.name },
        {
          id: this.rootRegistration.registration.id,
          name: this.rootRegistration.registration.name,
        },
        { requestId: randomUUID(), content }
      );
      if (!acknowledgement.success) {
        terminalLifecycle.diagnostics.push(
          new AgentManagerError(
            'transport_error',
            `Terminal notification delivery failed (${acknowledgement.error.code}): ${acknowledgement.error.message}`
          )
        );
      }
    } catch (error) {
      terminalLifecycle.diagnostics.push(error);
    }
  }

  private async cleanupTerminal(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    terminalLifecycle: TerminalLifecycleState
  ): Promise<void> {
    try {
      await terminalLifecycle.notificationAttempt;

      this.mailboxBindings.get(record.id)?.dispose();

      try {
        await record.launchHandle?.release?.();
      } catch (error) {
        terminalLifecycle.diagnostics.push(error);
      }

      try {
        await record.mailbox?.deregister();
      } catch (error) {
        terminalLifecycle.diagnostics.push(error);
      }
    } catch (error) {
      terminalLifecycle.diagnostics.push(error);
    } finally {
      this.mailboxBindings.delete(record.id);
      this.stopLifecycles.delete(record.id);
      try {
        this.directory.removeTerminal(record.id);
      } catch (error) {
        terminalLifecycle.diagnostics.push(error);
      } finally {
        terminalLifecycle.resolveTerminal();
      }
    }
  }

  private requestForcedStop(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    existingState: StopLifecycleState | undefined,
    explicit: boolean = true
  ): Promise<StopAgentResult> {
    const stopState = existingState ?? this.getOrCreateStopLifecycle(record);
    if (stopState.forceAccepted) {
      return Promise.resolve(
        Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' })
      );
    }
    if (stopState.forceOutcomeUnknown) {
      if (!explicit) {
        return Promise.resolve(
          Object.freeze({ name: record.name, mode: 'already-stopping', state: 'stopping' })
        );
      }
      return Promise.reject(this.createUnknownForceError(record, stopState.lastForceError));
    }
    if (stopState.forceInFlight) {
      return (
        stopState.forceOperationPromise ??
        Promise.resolve(Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' }))
      );
    }

    const priorCause = stopState.cause;
    record.state = 'stopping';
    stopState.cause = 'forced-stop';
    stopState.forceInFlight = true;
    this.cancelStopTimer(record.id);

    const lifecycle = record.launchHandle?.lifecycle;
    if (!record.launchReady || lifecycle === undefined) {
      // Startup will call maybeRequestProviderStop after the provider control
      // becomes ready. The public force acknowledgement remains state-based.
      return Promise.resolve(
        Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' })
      );
    }
    return this.startForcedStopOperation(record, stopState, explicit, priorCause);
  }

  private startForcedStopOperation(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    stopState: StopLifecycleState,
    explicit: boolean,
    priorCause: StopLifecycleCause = stopState.cause
  ): Promise<StopAgentResult> {
    const lifecycle = record.launchHandle?.lifecycle;
    if (lifecycle === undefined) {
      return Promise.resolve(
        Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' })
      );
    }
    let request: Promise<import('./agent_manager_types.js').AgentProviderControlResult>;
    try {
      request = lifecycle.requestForcedShutdown();
    } catch (error) {
      return Promise.resolve().then(() =>
        this.handleForcedStopFailure(record, stopState, priorCause, explicit, error)
      );
    }

    const operation = Promise.resolve(request).then(
      (result): StopAgentResult => {
        if (this.directory.getRecord(record.id) !== record) {
          return Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' });
        }
        stopState.forceInFlight = false;
        if (result.accepted) {
          stopState.forceAccepted = true;
          stopState.cause = 'forced-stop';
        } else {
          stopState.cause = priorCause;
          this.synthesizeProviderExit(record, 'natural');
        }
        return Object.freeze({ name: record.name, mode: 'forced', state: 'stopping' });
      },
      (error: unknown): StopAgentResult =>
        this.handleForcedStopFailure(record, stopState, priorCause, explicit, error)
    );
    stopState.forceOperationPromise = operation;
    void operation.then(
      (): void => {
        if (stopState.forceOperationPromise === operation)
          stopState.forceOperationPromise = undefined;
      },
      (): void => {
        if (stopState.forceOperationPromise === operation)
          stopState.forceOperationPromise = undefined;
      }
    );
    return operation;
  }

  private handleForcedStopFailure(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    stopState: StopLifecycleState,
    priorCause: StopLifecycleCause,
    explicit: boolean,
    error: unknown
  ): StopAgentResult {
    stopState.lastForceError = error;
    if (
      error instanceof AgentProviderControlError &&
      error.operation === 'forced-shutdown' &&
      error.accepted === false
    ) {
      stopState.forceInFlight = false;
      stopState.forceAccepted = false;
      stopState.cause = priorCause;
      if (!explicit) {
        return Object.freeze({ name: record.name, mode: 'already-stopping', state: 'stopping' });
      }
      throw new AgentManagerError(
        'force_failed',
        `Forced shutdown was not accepted for agent ${record.name}: ${error.message}`,
        { cause: error }
      );
    }

    // A non-typed rejection does not prove that the provider ignored the
    // force request. Preserve that unknown outcome so a later call cannot
    // issue a second potentially unsafe operation.
    stopState.forceInFlight = false;
    stopState.forceAccepted = false;
    stopState.forceOutcomeUnknown = true;
    stopState.cause = priorCause;
    if (explicit) {
      throw new AgentManagerError(
        'force_failed',
        `Forced shutdown status is unknown for agent ${record.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    return Object.freeze({ name: record.name, mode: 'already-stopping', state: 'stopping' });
  }

  private createUnknownForceError(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    error: unknown
  ): AgentManagerError {
    return new AgentManagerError(
      'force_failed',
      'Forced shutdown status is unknown for agent ' +
        record.name +
        ': ' +
        (error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }

  private unbindProviderLifecycle(agentId: string): void {
    const unsubscribers = this.lifecycleUnsubscribers.get(agentId);
    if (unsubscribers === undefined) return;
    this.lifecycleUnsubscribers.delete(agentId);
    for (const unsubscribe of unsubscribers) unsubscribe();
  }

  private requestFinishCloseAfterTurn(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    lifecycle: AgentProviderLifecycleControls
  ): void {
    if (record.state !== 'finishing' || record.providerExit !== undefined) return;
    const finishLifecycle = this.getOrCreateTerminalLifecycle(record.id);
    if (
      finishLifecycle.terminalClaimed ||
      !finishLifecycle.finishRequested ||
      finishLifecycle.closeAfterTurnRequested
    )
      return;

    // Claim before calling provider code. A provider can synchronously emit
    // another turn-complete or exit event from the request itself.
    finishLifecycle.closeAfterTurnRequested = true;
    record.finishCloseAfterTurnRequested = true;
    try {
      finishLifecycle.closeAfterTurnPromise = Promise.resolve(
        lifecycle.requestCloseAfterCurrentTurn()
      )
        .then((result): undefined => {
          if (!result.accepted) this.synthesizeProviderExit(record, 'natural');
          return undefined;
        })
        .catch((error: unknown): undefined => {
          finishLifecycle.closeAfterTurnError = error;
          return undefined;
        });
    } catch (error) {
      finishLifecycle.closeAfterTurnError = error;
    }
  }

  private recordSuccessfulOutbound(
    sourceRecord: import('./agent_directory.js').DirectoryRecord,
    target: AgentName,
    content: string
  ): void {
    if (
      this.directory.getRecord(sourceRecord.id) !== sourceRecord ||
      this.isTerminalClaimed(sourceRecord.id)
    ) {
      return;
    }
    const snapshot: AgentOutboundMessageSnapshot = Object.freeze({
      sequence: ++this.nextOutboundSequence,
      target,
      content,
    });
    sourceRecord.lastSuccessfulOutbound = snapshot;
  }

  private mapMailboxTransportError(error: unknown): AgentManagerError {
    if (error instanceof MailboxProtocolError) {
      return this.mapMailboxError(error.code, error.message, error);
    }
    return new AgentManagerError(
      'transport_error',
      `Agent message delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  private mapMailboxError(
    code: MailboxErrorCode,
    message: string,
    cause?: Error
  ): AgentManagerError {
    const managerCode: AgentManagerError['code'] =
      code === 'unknown_source'
        ? 'unknown_sender'
        : code === 'unknown_target' || code === 'target_stale'
          ? 'unknown_target'
          : 'transport_error';
    return new AgentManagerError(
      managerCode,
      `Agent message delivery failed (${code}): ${message}`,
      { cause },
      code
    );
  }

  private ensureOpen(): void {
    if (this.closed) throw new AgentManagerError('manager_closed', 'The agent manager is closed');
  }
}

export async function createAgentManager(options: AgentManagerOptions = {}): Promise<AgentManager> {
  return AgentManager.create(options);
}
