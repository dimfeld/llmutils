import { randomUUID } from 'node:crypto';

import {
  MAX_AGENT_MESSAGE_BYTES,
  ORCHESTRATOR_AGENT_NAME,
  isNonterminalAgentLifecycleState,
  sendAgentMessageArgumentsSchema,
  type ListAgentsResult,
  type NonterminalAgentLifecycleState,
  type SendAgentMessageResult,
  type StartAgentResult,
  utf8ByteLength,
} from './contracts.js';
import {
  AgentManagerError,
  type AgentCallerIdentity,
  type AgentIdentity,
  type AgentInputAdapter,
  type AgentManagerOptions,
  type AgentRecordSnapshot,
  type OrchestratorIdentity,
} from './agent_manager_types.js';
import type { AgentInputActivity } from './agent_manager_types.js';
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

interface NormalizedManagerOptions extends AgentDirectoryOptions {
  readonly agentPreparer: AgentManagerOptions['agentPreparer'];
  readonly agentLauncher: AgentManagerOptions['agentLauncher'];
  readonly orchestratorInputAdapter: AgentInputAdapter | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentInputActivity(value: unknown): value is AgentInputActivity {
  return (
    value === 'not-ready' ||
    value === 'active' ||
    value === 'temporarily-unavailable' ||
    value === 'idle'
  );
}

function validateInputAdapter(value: unknown, label: string): asserts value is AgentInputAdapter {
  if (!isRecord(value)) {
    throw new AgentManagerError('invalid_options', `${label} must be an input adapter object`);
  }
  const ready = value.ready as { readonly then?: unknown };
  if (typeof ready !== 'object' || ready === null || typeof ready.then !== 'function') {
    throw new AgentManagerError('invalid_options', `${label}.ready must be a promise`);
  }
  if (typeof value.isReady !== 'boolean' || !isAgentInputActivity(value.activity)) {
    throw new AgentManagerError(
      'invalid_options',
      `${label} must provide boolean isReady and a valid activity`
    );
  }
  if (typeof value.deliver !== 'function' || typeof value.onAvailabilityChange !== 'function') {
    throw new AgentManagerError(
      'invalid_options',
      `${label} must provide deliver and onAvailabilityChange functions`
    );
  }
  if (value.release !== undefined && typeof value.release !== 'function') {
    throw new AgentManagerError(
      'invalid_options',
      `${label}.release must be a function when provided`
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
  return {
    ...directoryDefaults,
    agentPreparer: options.agentPreparer,
    agentLauncher: options.agentLauncher,
    orchestratorInputAdapter: options.orchestratorInputAdapter,
  };
}

/** Facade for the provider-neutral Start/List/Send manager core. */
export class AgentManager {
  public readonly sessionRuntime: AgentMessagingSessionRuntime;
  public readonly orchestratorIdentity: OrchestratorIdentity;

  private readonly directory: AgentDirectory;
  private readonly startupTracker: AgentStartupTracker;
  private readonly mailboxBindings = new Map<string, AgentMailboxBinding>();
  private readonly ownsSessionRuntime: boolean;
  private readonly rootRegistration: SessionRegistrationHandle;
  private readonly options: NormalizedManagerOptions;
  private closed = false;
  private closePromise: Promise<void> | undefined;

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
      const rootBinding = manager.mailboxBindings.get(rootId);
      if (rootBinding === undefined) {
        throw new AgentManagerError(
          'root_registration_failed',
          'The root mailbox binding is missing'
        );
      }
      rootDelivery = (message, sourceRegistration): Promise<MailboxDeliveryResult> =>
        rootBinding.deliver(message, sourceRegistration);
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
      binding.bindInputAdapter(handle.input);
      await operation.awaitBoundary(handle.ready);
      operation.ensureActive();
      binding.markLaunchReady();

      return Object.freeze({
        name: record.name,
        id: record.id,
        type: record.type,
        executor: record.executor,
        state: record.state,
      });
    } catch (error) {
      binding.dispose();
      this.mailboxBindings.delete(record.id);
      await operation.rollback();
      if (error instanceof AgentManagerError && error.code === 'manager_closed') throw error;
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
    const targetName = this.parseTargetName(validated.name);
    const targetRecord = this.directory.getRecordByName(targetName);
    if (targetRecord === undefined || !isNonterminalAgentLifecycleState(targetRecord.state)) {
      throw new AgentManagerError(
        'unknown_target',
        `Unknown or inactive target agent: ${validated.name}`
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

  public getAgentSnapshot(agentId: string): AgentRecordSnapshot | undefined {
    const parsedId = parseAgentId(agentId);
    const record = parsedId === undefined ? undefined : this.directory.getRecord(parsedId);
    return record === undefined ? undefined : this.directory.snapshot(record);
  }

  public getIdentityByName(name: string): AgentIdentity | undefined {
    return this.directory.getIdentityByName(name);
  }

  /** Narrow successor-plan state seam; it does not perform completion or stop logic. */
  public setAgentLifecycleState(agentId: string, state: NonterminalAgentLifecycleState): void {
    this.ensureOpen();
    const parsedId = parseAgentId(agentId);
    if (parsedId === undefined) {
      throw new AgentManagerError('unknown_agent', `Unknown agent ID: ${agentId}`);
    }
    this.directory.setLifecycleState(parsedId, state);
  }

  /** Remove only authoritative state after a successor lifecycle owner cleans resources. */
  public removeTerminalAgent(agentId: string): void {
    this.ensureOpen();
    const parsedId = parseAgentId(agentId);
    if (parsedId === undefined) return;
    this.mailboxBindings.get(parsedId)?.dispose();
    this.mailboxBindings.delete(parsedId);
    this.directory.removeTerminal(parsedId);
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    const inFlight = this.startupTracker.values();
    const inFlightIds = new Set(inFlight.map((operation) => operation.record.id));
    const mailboxes = [
      this.rootRegistration,
      ...this.directory.records
        .filter((record) => !inFlightIds.has(record.id) && record.mailbox !== undefined)
        .map((record) => record.mailbox as SessionRegistrationHandle),
    ];
    this.closePromise = (async (): Promise<void> => {
      let firstError: unknown;
      const results = await Promise.allSettled([
        ...mailboxes.map((mailbox) => mailbox.deregister()),
        ...inFlight.map((operation) => operation.cleanupForClose()),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') firstError ??= result.reason;
      }
      try {
        if (this.ownsSessionRuntime) await this.sessionRuntime.close();
      } catch (error) {
        firstError ??= error;
      } finally {
        for (const binding of this.mailboxBindings.values()) binding.dispose();
        this.mailboxBindings.clear();
        this.directory.clear();
      }
      if (firstError !== undefined) throw firstError;
    })();
    return this.closePromise;
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
