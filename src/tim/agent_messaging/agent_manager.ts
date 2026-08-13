import { randomUUID } from 'node:crypto';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import {
  MAX_AGENT_MESSAGE_BYTES,
  ORCHESTRATOR_AGENT_NAME,
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
  type AgentCallerIdentity,
  type AgentIdentity,
  type AgentInputAdapter,
  type AgentManagerOptions,
  type AgentManagerScheduler,
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
  AgentLifecycleController,
  type AgentLifecycleControllerOptions,
} from './agent_lifecycle_controller.js';
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
  /** One lifecycle owner and shared terminal promise for each subagent. */
  private readonly lifecycleControllers = new Map<string, AgentLifecycleController>();
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
    this.startupTracker = new AgentStartupTracker(directory, options.scheduler);
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
    const controller = this.createLifecycleController(record, binding);
    this.lifecycleControllers.set(record.id, controller);
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
      controller.bindProvider(handle);
      binding.bindInputAdapter(handle.input);
      await operation.awaitBoundary(handle.ready);
      operation.ensureActive();
      if (controller.providerExitInfo !== undefined) {
        throw new AgentManagerError(
          'launch_failed',
          `Agent ${record.name} exited before launch readiness${
            controller.providerExitInfo.error === undefined
              ? ''
              : `: ${controller.providerExitInfo.error.message}`
          }`
        );
      }
      binding.markLaunchReady();
      controller.providerReady();

      return Object.freeze({
        name: record.name,
        id: record.id,
        type: record.type,
        executor: record.executor,
        state: record.state,
      });
    } catch (error) {
      controller.cancelBeforeLaunch();
      binding.dispose();
      this.mailboxBindings.delete(record.id);
      await operation.rollback();
      this.lifecycleControllers.delete(record.id);
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

    const controller = this.lifecycleControllers.get(callerRecord.id);
    if (controller === undefined) {
      throw new AgentManagerError(
        'finish_not_available',
        'The provider lifecycle is not ready for FinishAgent'
      );
    }
    return controller.finish(parsed.data.message);
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
    const controller = this.lifecycleControllers.get(record.id);
    if (controller === undefined) {
      throw new AgentManagerError(
        'unknown_target',
        `Unknown or inactive target agent: ${targetName}`
      );
    }
    return controller.stop(parsed.data.force === true, parsed.data.message);
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
      : (this.lifecycleControllers.get(parsedId)?.terminalPromise ?? Promise.resolve());
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
        for (const controller of this.lifecycleControllers.values()) controller.dispose();
        this.lifecycleControllers.clear();
        for (const binding of this.mailboxBindings.values()) binding.dispose();
        this.mailboxBindings.clear();
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
    return this.lifecycleControllers.get(record.id)?.requestRootTeardown() ?? Promise.resolve();
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

  private createLifecycleController(
    record: Extract<import('./agent_directory.js').DirectoryRecord, { role: 'subagent' }>,
    binding: AgentMailboxBinding
  ): AgentLifecycleController {
    const controllerOptions: AgentLifecycleControllerOptions = {
      record,
      directory: this.directory,
      scheduler: this.options.scheduler,
      sessionRuntime: this.sessionRuntime,
      rootRegistration: this.rootRegistration,
      cleanup: {
        disposeMailbox: (): void => {
          binding.dispose();
          this.mailboxBindings.delete(record.id);
        },
        removeDirectoryRecord: (): void => {
          this.directory.removeTerminal(record.id);
        },
        onRemoved: (): void => {
          this.lifecycleControllers.delete(record.id);
        },
      },
      nextOutboundSequence: (): number => ++this.nextOutboundSequence,
      onStartupExit: (exit): void => {
        this.startupTracker
          .findByRecord(record)
          ?.cancel(
            new AgentManagerError(
              'launch_failed',
              `Agent ${record.name} exited before launch readiness${
                exit.error === undefined ? '' : `: ${exit.error.message}`
              }`
            )
          );
      },
    };
    return new AgentLifecycleController(controllerOptions);
  }

  private isTerminalClaimed(agentId: string): boolean {
    return this.lifecycleControllers.get(agentId)?.isTerminalClaimed === true;
  }

  private recordSuccessfulOutbound(
    sourceRecord: import('./agent_directory.js').DirectoryRecord,
    target: AgentName,
    content: string
  ): void {
    this.lifecycleControllers.get(sourceRecord.id)?.recordSuccessfulOutbound(target, content);
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
