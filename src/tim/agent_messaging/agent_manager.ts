import { randomUUID } from 'node:crypto';

import {
  MAX_AGENT_MESSAGE_BYTES,
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
  agentExecutorSchema,
  isNonterminalAgentLifecycleState,
  sendAgentMessageArgumentsSchema,
  startAgentArgumentsSchema,
  type AgentSummary,
  type SendAgentMessageResult,
  type StartAgentResult,
  type AgentExecutor,
  type NonterminalAgentLifecycleState,
  utf8ByteLength,
} from './contracts.js';
import {
  buildGeneratedAgentName,
  createDefaultAgentId,
  createDefaultAgentSlug,
  DEFAULT_MAX_AGENT_ID_GENERATION_ATTEMPTS,
  DEFAULT_MAX_AGENT_NAME_GENERATION_ATTEMPTS,
  parseAgentAddress,
  parseAgentId,
  parseSubagentName,
  type AgentId,
  type AgentIdGenerator,
  type AgentName,
  type AgentSlugGenerator,
} from './agent_names.js';
import {
  AgentManagerError,
  type AgentCallerIdentity,
  type AgentIdentity,
  type AgentInputActivity,
  type AgentPreparationRequest,
  type AgentManagerOptions,
  type AgentInputAdapter,
  type AgentRecord,
  type AgentRecordSnapshot,
  type AgentReservation,
  type AgentReservationRequest,
  type OrchestratorAgentRecord,
  type OrchestratorIdentity,
  type SubagentAgentRecord,
  type SubagentIdentity,
} from './agent_manager_types.js';
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
import type { MailboxDeliveryCallback, MailboxDeliveryResult } from './mailbox_server.js';
import type { AgentRegistration } from './runtime_dir.js';

interface NormalizedManagerOptions {
  readonly orchestratorExecutor: AgentExecutor;
  readonly agentIdGenerator: AgentIdGenerator;
  readonly slugGenerator: AgentSlugGenerator;
  readonly maxAgentIdGenerationAttempts: number;
  readonly maxAgentNameGenerationAttempts: number;
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

function validateAgentInputAdapter(
  value: unknown,
  label: string
): asserts value is AgentInputAdapter {
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

  const executor = options.orchestratorExecutor ?? 'claude-code';
  if (!agentExecutorSchema.safeParse(executor).success) {
    throw new AgentManagerError(
      'invalid_options',
      `Unsupported orchestrator executor: ${String(executor)}`
    );
  }

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
    validateAgentInputAdapter(options.orchestratorInputAdapter, 'orchestratorInputAdapter');
  }

  return {
    orchestratorExecutor: executor as AgentExecutor,
    agentIdGenerator: (options.agentIdGenerator ?? createDefaultAgentId) as AgentIdGenerator,
    slugGenerator: (options.slugGenerator ?? createDefaultAgentSlug) as AgentSlugGenerator,
    maxAgentIdGenerationAttempts: validateAttempts(
      options.maxAgentIdGenerationAttempts,
      'maxAgentIdGenerationAttempts',
      DEFAULT_MAX_AGENT_ID_GENERATION_ATTEMPTS
    ),
    maxAgentNameGenerationAttempts: validateAttempts(
      options.maxAgentNameGenerationAttempts,
      'maxAgentNameGenerationAttempts',
      DEFAULT_MAX_AGENT_NAME_GENERATION_ATTEMPTS
    ),
    agentPreparer: options.agentPreparer,
    agentLauncher: options.agentLauncher,
    orchestratorInputAdapter: options.orchestratorInputAdapter,
  };
}

function snapshotIdentity(record: AgentRecord): AgentIdentity {
  if (record.role === 'orchestrator') {
    return Object.freeze({
      id: record.id,
      name: record.name,
      role: record.role,
      executor: record.executor,
    });
  }
  return Object.freeze({
    id: record.id,
    name: record.name,
    role: record.role,
    type: record.type,
    executor: record.executor,
  });
}

function snapshotRecord(record: AgentRecord): AgentRecordSnapshot {
  return Object.freeze({
    identity: snapshotIdentity(record),
    state: record.state,
    inputActivity: record.inputActivity,
    creationSequence: record.creationSequence,
    ...(record.role === 'subagent' && record.processControlId !== undefined
      ? { processControlId: record.processControlId }
      : {}),
    ...(record.role === 'subagent' && record.providerThreadId !== undefined
      ? { providerThreadId: record.providerThreadId }
      : {}),
  });
}

function toSummary(record: AgentRecord): AgentSummary {
  if (record.role === 'orchestrator') {
    return Object.freeze({
      name: ORCHESTRATOR_AGENT_NAME,
      id: record.id,
      role: record.role,
      executor: record.executor,
      state: record.state,
    });
  }
  return Object.freeze({
    name: record.name,
    id: record.id,
    role: record.role,
    type: record.type,
    executor: record.executor,
    state: record.state,
  });
}

function matchesTrustedSource(
  record: AgentRecord | undefined,
  registration: AgentRegistration
): boolean {
  if (
    record === undefined ||
    record.id !== registration.id ||
    record.name !== registration.name ||
    record.role !== registration.role ||
    record.executor !== registration.executor
  ) {
    return false;
  }
  if (record.role === 'orchestrator') {
    return !Object.hasOwn(registration, 'type');
  }
  return registration.role === 'subagent' && record.type === registration.type;
}

function identityFromTrustedRegistration(registration: AgentRegistration): AgentIdentity {
  if (registration.role === 'orchestrator') {
    return Object.freeze({
      id: registration.id as AgentId,
      name: registration.name as AgentName,
      role: registration.role,
      executor: registration.executor,
    });
  }
  return Object.freeze({
    id: registration.id as AgentId,
    name: registration.name as AgentName,
    role: registration.role,
    type: registration.type,
    executor: registration.executor,
  });
}

/**
 * Owns the root identity, startup boundary, synchronous identity/capacity
 * reservation, and public list snapshots. Message routing and terminal
 * lifecycle operations belong to adjacent manager layers.
 */
export class AgentManager {
  public readonly sessionRuntime: AgentMessagingSessionRuntime;
  public readonly orchestratorIdentity: OrchestratorIdentity;

  private readonly options: NormalizedManagerOptions;
  private readonly ownsSessionRuntime: boolean;
  private readonly byId = new Map<AgentId, AgentRecord>();
  private readonly byName = new Map<AgentName, AgentId>();
  private readonly inputAdapters = new Map<AgentId, AgentInputAdapter>();
  private nextCreationSequence = 0;
  private readonly rootRegistration: SessionRegistrationHandle;
  private readonly inputAvailabilityUnsubscribers = new Map<AgentId, () => void>();
  private readonly inputAvailabilityVersions = new Map<AgentId, number>();
  /** One retry is allowed at a later safe point for each unchanged activity version. */
  private readonly pendingDrainRetryVersions = new Map<AgentId, number>();
  private readonly pendingDrainPromises = new Map<AgentId, Promise<void>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    sessionRuntime: AgentMessagingSessionRuntime,
    options: NormalizedManagerOptions,
    ownsSessionRuntime: boolean,
    rootRegistration: SessionRegistrationHandle,
    rootRecord: OrchestratorAgentRecord
  ) {
    this.sessionRuntime = sessionRuntime;
    this.options = options;
    this.ownsSessionRuntime = ownsSessionRuntime;
    this.rootRegistration = rootRegistration;
    this.orchestratorIdentity = Object.freeze({
      id: rootRecord.id,
      name: rootRecord.name,
      role: rootRecord.role,
      executor: rootRecord.executor,
    });
    this.byId.set(rootRecord.id, rootRecord);
    this.byName.set(rootRecord.name, rootRecord.id);
    this.nextCreationSequence = 1;
    if (options.orchestratorInputAdapter !== undefined) {
      this.bindInputAdapter(rootRecord, options.orchestratorInputAdapter);
    }
  }

  /** Create and initialize a manager with a ready reserved root mailbox. */
  public static async create(options: AgentManagerOptions = {}): Promise<AgentManager> {
    const normalizedOptions = normalizeOptions(options);
    const ownsSessionRuntime = options.sessionRuntime === undefined;
    const sessionRuntime = options.sessionRuntime ?? (await createAgentMessagingSessionRuntime());

    let rootRegistration: SessionRegistrationHandle | undefined;
    let rootDelivery: MailboxDeliveryCallback = async (): Promise<MailboxDeliveryResult> =>
      'temporarily-unavailable';
    try {
      const rootId = allocateOpaqueId(
        normalizedOptions.agentIdGenerator,
        normalizedOptions.maxAgentIdGenerationAttempts,
        new Set<string>()
      );
      const rootName = parseAgentAddress(ORCHESTRATOR_AGENT_NAME);
      if (rootName === undefined) {
        throw new AgentManagerError(
          'root_registration_failed',
          'The reserved orchestrator name failed its shared validation'
        );
      }

      rootRegistration = await sessionRuntime.register({
        registration: {
          id: rootId,
          name: ORCHESTRATOR_AGENT_NAME,
          role: 'orchestrator',
          executor: normalizedOptions.orchestratorExecutor,
          state: 'running-idle',
        },
        deliver: async (message, sourceRegistration): Promise<MailboxDeliveryResult> =>
          rootDelivery(message, sourceRegistration),
      });
      await rootRegistration.ready;

      const rootRecord: OrchestratorAgentRecord = {
        id: rootId,
        name: rootName,
        role: 'orchestrator',
        executor: normalizedOptions.orchestratorExecutor,
        state: 'running-idle',
        inputActivity: 'idle',
        creationSequence: 0,
        registrationDraft: {
          id: rootId,
          name: ORCHESTRATOR_AGENT_NAME,
          role: 'orchestrator',
          executor: normalizedOptions.orchestratorExecutor,
          state: 'running-idle',
        },
        registration: rootRegistration.registration,
        mailbox: rootRegistration,
      };

      const manager = new AgentManager(
        sessionRuntime,
        normalizedOptions,
        ownsSessionRuntime,
        rootRegistration,
        rootRecord
      );
      rootDelivery = (
        message: MailboxMessageRequest,
        sourceRegistration: AgentRegistration
      ): Promise<MailboxDeliveryResult> =>
        manager.deliverToRecord(rootRecord, message, sourceRegistration);
      return manager;
    } catch (error) {
      await rootRegistration?.deregister().catch(() => undefined);
      if (ownsSessionRuntime) {
        await sessionRuntime.close().catch(() => undefined);
      }
      if (error instanceof AgentManagerError) {
        throw error;
      }
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

  /** Number of reserved nonterminal subagents, excluding the root. */
  public get subagentCount(): number {
    let count = 0;
    for (const record of this.byId.values()) {
      if (record.role === 'subagent' && isNonterminalAgentLifecycleState(record.state)) {
        count += 1;
      }
    }
    return count;
  }

  /** Return immutable public rows with the root first and creation order after it. */
  public listAgents(): import('./contracts.js').ListAgentsResult {
    const records = [...this.byId.values()]
      .filter((record) => isNonterminalAgentLifecycleState(record.state))
      .toSorted((left, right) => left.creationSequence - right.creationSequence);
    const agents = records.map(toSummary);
    return Object.freeze({
      agents: Object.freeze(agents),
    }) as import('./contracts.js').ListAgentsResult;
  }

  /**
   * Start one named provider-backed subagent after mailbox and handle
   * readiness. Provider completion and input readiness are deliberately not
   * awaited here.
   */
  public async startAgent(
    caller: AgentCallerIdentity,
    request: unknown
  ): Promise<StartAgentResult> {
    this.ensureOpen();
    this.assertOrchestratorCaller(caller);

    // Validate the complete request before checking or allocating any
    // per-agent resource. Caller authorization above must remain first.
    const validated = this.validateReservationRequest(request);
    if (this.options.agentPreparer === undefined) {
      throw new AgentManagerError(
        'launch_failed',
        'No provider-neutral agent preparation dependency is configured'
      );
    }
    if (this.options.agentLauncher === undefined) {
      throw new AgentManagerError(
        'launch_failed',
        'No provider-neutral agent launcher is configured'
      );
    }

    const reservation = this.reserveSubagent(validated);
    const record = this.byId.get(reservation.id);
    if (record === undefined || record.role !== 'subagent') {
      reservation.release();
      throw new AgentManagerError(
        'launch_failed',
        'The reserved agent record was not available for startup'
      );
    }

    let mailbox: SessionRegistrationHandle | undefined;
    let handle: import('./agent_manager_types.js').AgentLaunchHandle | undefined;
    try {
      const preparationRequest: AgentPreparationRequest = {
        identity: reservation.identity,
        initialMessage: validated.initialMessage,
      };
      const prepared = await this.options.agentPreparer.prepare(preparationRequest);
      if (prepared.agentType !== record.type || prepared.executor !== record.executor) {
        throw new Error('Agent preparation did not preserve the requested type and executor');
      }

      mailbox = await this.sessionRuntime.register({
        registration: record.registrationDraft,
        deliver: (
          message,
          sourceRegistration
        ): Promise<import('./mailbox_server.js').MailboxDeliveryResult> =>
          this.deliverToAgent(record, message, sourceRegistration),
      });
      record.registration = mailbox.registration;
      record.mailbox = mailbox;
      await mailbox.ready;

      handle = await this.options.agentLauncher.launch({
        identity: reservation.identity,
        initialMessage: validated.initialMessage,
        preparedExecution: prepared,
        processLabel: formatAgentProcessLabel(record.executor, record.name),
      });
      record.launchHandle = handle;
      record.processControlId = handle.processControlId;
      record.providerThreadId = handle.providerThreadId;
      this.bindInputAdapter(record, handle.input);

      // A launch handle's readiness is the provider-neutral establishment
      // boundary. It is separate from the input adapter's readiness and from
      // the completion promise.
      await handle.ready;
      record.launchReady = true;
      this.updateRecordInputState(record, handle.input);
      this.schedulePendingDrain(record);

      return Object.freeze({
        name: record.name,
        id: record.id,
        type: record.type,
        executor: record.executor,
        state: record.state,
      });
    } catch (error) {
      await this.rollbackStart(record, reservation, mailbox, handle);
      throw new AgentManagerError(
        'launch_failed',
        `Could not start agent ${record.name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  /**
   * Send one trusted message through the session mailbox transport. The
   * caller identity is resolved from the authoritative manager map; request
   * arguments never contain a source field.
   */
  public async sendAgentMessage(
    caller: AgentCallerIdentity,
    request: unknown
  ): Promise<SendAgentMessageResult> {
    this.ensureOpen();
    const validated = this.validateSendAgentMessageRequest(request);
    const sourceRecord = this.resolveCaller(caller);
    const targetName = parseAgentAddress(validated.name);
    if (targetName === undefined) {
      throw new AgentManagerError('invalid_name', `Invalid target agent name: ${validated.name}`);
    }

    const targetId = this.byName.get(targetName);
    const targetRecord = targetId === undefined ? undefined : this.byId.get(targetId);
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
        this.throwForMailboxFailure(
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
      if (error instanceof AgentManagerError) {
        throw error;
      }
      throw this.mapMailboxTransportError(error);
    }
  }

  /** Return an immutable internal snapshot for lifecycle composition. */
  public getAgentSnapshot(agentId: AgentId | string): AgentRecordSnapshot | undefined {
    const parsedId = parseAgentId(agentId);
    const record = parsedId === undefined ? undefined : this.byId.get(parsedId);
    return record === undefined ? undefined : snapshotRecord(record);
  }

  /** Return an immutable identity snapshot for a known active name. */
  public getIdentityByName(name: string): AgentIdentity | undefined {
    const parsedName = parseAgentAddress(name);
    if (parsedName === undefined) {
      return undefined;
    }
    const id = this.byName.get(parsedName);
    const record = id === undefined ? undefined : this.byId.get(id);
    return record === undefined ? undefined : snapshotIdentity(record);
  }

  /**
   * Reserve one subagent name, identity, and capacity slot synchronously.
   * This is the composition boundary used by the later StartAgent method.
   */
  public reserveSubagent(request: AgentReservationRequest): AgentReservation {
    this.ensureOpen();
    const validated = this.validateReservationRequest(request);
    if (this.subagentCount >= MAX_SUBAGENTS_PER_SESSION) {
      throw new AgentManagerError(
        'agent_limit_reached',
        `The session already has ${MAX_SUBAGENTS_PER_SESSION} nonterminal subagents`
      );
    }

    const name = this.selectSubagentName(validated.type, validated.name);
    const id = allocateOpaqueId(
      this.options.agentIdGenerator,
      this.options.maxAgentIdGenerationAttempts,
      new Set(this.byId.keys())
    );
    const identity: SubagentIdentity = Object.freeze({
      id,
      name,
      role: 'subagent',
      type: validated.type,
      executor: validated.executor,
    });
    const record: SubagentAgentRecord = {
      ...identity,
      state: 'starting',
      inputActivity: 'not-ready',
      launchReady: false,
      creationSequence: this.nextCreationSequence,
      registrationDraft: {
        id,
        name,
        role: 'subagent',
        type: validated.type,
        executor: validated.executor,
        state: 'starting',
      },
    };

    // Keep this insertion section synchronous. No await may be introduced
    // between the capacity check and both map insertions.
    this.nextCreationSequence += 1;
    this.byId.set(id, record);
    this.byName.set(name, id);

    let released = false;
    return Object.freeze({
      id,
      name,
      identity,
      snapshot: snapshotRecord(record),
      release: (): void => {
        if (released) {
          return;
        }
        released = true;
        this.releaseReservation(record);
      },
    });
  }

  /** Narrow successor-plan state seam; it does not perform completion or stop logic. */
  public setAgentLifecycleState(
    agentId: AgentId | string,
    state: NonterminalAgentLifecycleState
  ): void {
    this.ensureOpen();
    const parsedId = parseAgentId(agentId);
    const record = parsedId === undefined ? undefined : this.byId.get(parsedId);
    if (record === undefined) {
      throw new AgentManagerError('unknown_agent', `Unknown agent ID: ${agentId}`);
    }
    if (record.role !== 'subagent') {
      throw new AgentManagerError(
        'invalid_request',
        'Lifecycle state transitions are only available for subagent identities'
      );
    }
    record.state = state;
  }

  /**
   * Remove a subagent after a successor lifecycle owner has completed its
   * terminal cleanup. This seam only removes authoritative map entries; it
   * does not stop providers, close mailboxes, or send notifications.
   */
  public removeTerminalAgent(agentId: AgentId | string): void {
    this.ensureOpen();
    const parsedId = parseAgentId(agentId);
    const record = parsedId === undefined ? undefined : this.byId.get(parsedId);
    if (record === undefined) {
      return;
    }
    if (record.role !== 'subagent') {
      throw new AgentManagerError(
        'invalid_request',
        'Terminal removal is only available for subagent identities'
      );
    }
    this.releaseReservation(record);
  }

  /** Close the root mailbox and any session runtime created by this manager. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    const managerMailboxes = [
      this.rootRegistration,
      ...[...this.byId.values()]
        .filter((record): record is SubagentAgentRecord => record.role === 'subagent')
        .map((record) => record.mailbox)
        .filter((mailbox): mailbox is SessionRegistrationHandle => mailbox !== undefined),
    ];
    this.closePromise = (async (): Promise<void> => {
      let firstError: unknown;
      const mailboxResults = await Promise.allSettled(
        managerMailboxes.map((mailbox) => mailbox.deregister())
      );
      for (const result of mailboxResults) {
        if (result.status === 'rejected' && firstError === undefined) {
          firstError = result.reason;
        }
      }
      try {
        if (this.ownsSessionRuntime) {
          await this.sessionRuntime.close();
        }
      } catch (error) {
        firstError ??= error;
      } finally {
        for (const unsubscribe of this.inputAvailabilityUnsubscribers.values()) {
          unsubscribe();
        }
        this.inputAvailabilityUnsubscribers.clear();
        this.inputAvailabilityVersions.clear();
        this.pendingDrainRetryVersions.clear();
        this.inputAdapters.clear();
        this.pendingDrainPromises.clear();
        this.byId.clear();
        this.byName.clear();
      }
      if (firstError !== undefined) {
        throw firstError;
      }
    })();
    return this.closePromise;
  }

  private validateReservationRequest(request: unknown): AgentReservationRequest {
    if (!isRecord(request)) {
      throw new AgentManagerError('invalid_request', 'Agent reservation request must be an object');
    }
    if (request.name === ORCHESTRATOR_AGENT_NAME) {
      throw new AgentManagerError('reserved_name', 'The orchestrator name is reserved');
    }
    if (Object.hasOwn(request, 'name') && request.name !== undefined) {
      const parsedName = parseSubagentName(request.name);
      if (parsedName === undefined) {
        throw new AgentManagerError(
          'invalid_name',
          'Agent names must use lowercase ASCII letters, digits, and hyphens, with alphanumeric boundaries'
        );
      }
    }
    const result = startAgentArgumentsSchema.safeParse(request);
    if (!result.success) {
      throw new AgentManagerError('invalid_request', 'Agent reservation request is invalid');
    }
    return result.data;
  }

  private validateSendAgentMessageRequest(request: unknown): {
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

  private assertOrchestratorCaller(caller: unknown): void {
    if (!isRecord(caller)) {
      throw new AgentManagerError(
        'not_authorized',
        'Only the registered orchestrator identity may start agents'
      );
    }
    const callerId = parseAgentId(caller.id);
    const record = callerId === undefined ? undefined : this.byId.get(callerId);
    if (
      record === undefined ||
      record.role !== 'orchestrator' ||
      caller.role !== 'orchestrator' ||
      caller.name !== ORCHESTRATOR_AGENT_NAME ||
      caller.executor !== record.executor ||
      Object.hasOwn(caller, 'type')
    ) {
      throw new AgentManagerError(
        'not_authorized',
        'Only the registered orchestrator identity may start agents'
      );
    }
  }

  private resolveCaller(caller: unknown): AgentRecord {
    if (!isRecord(caller)) {
      throw new AgentManagerError('unknown_sender', 'The message sender is not an active agent');
    }
    const callerId = parseAgentId(caller.id);
    const record = callerId === undefined ? undefined : this.byId.get(callerId);
    const matchesIdentity =
      record !== undefined &&
      isNonterminalAgentLifecycleState(record.state) &&
      caller.name === record.name &&
      caller.role === record.role &&
      caller.executor === record.executor &&
      (record.role === 'orchestrator'
        ? !Object.hasOwn(caller, 'type')
        : caller.type === record.type);
    if (!matchesIdentity || record === undefined) {
      throw new AgentManagerError('unknown_sender', 'The message sender is not an active agent');
    }
    return record;
  }

  private async deliverToAgent(
    record: SubagentAgentRecord,
    message: MailboxMessageRequest,
    sourceRegistration: AgentRegistration
  ): Promise<MailboxDeliveryResult> {
    return this.deliverToRecord(record, message, sourceRegistration);
  }

  private async deliverToRecord(
    record: AgentRecord,
    message: MailboxMessageRequest,
    sourceRegistration: AgentRegistration
  ): Promise<MailboxDeliveryResult> {
    if (this.byId.get(record.id) !== record || !isNonterminalAgentLifecycleState(record.state)) {
      return 'temporarily-unavailable';
    }
    if (record.state === 'finishing' || record.state === 'stopping') {
      return 'temporarily-unavailable';
    }
    const sourceId = parseAgentId(sourceRegistration.id);
    const sourceRecord = sourceId === undefined ? undefined : this.byId.get(sourceId);
    if (sourceRecord === undefined || !matchesTrustedSource(sourceRecord, sourceRegistration)) {
      throw new AgentManagerError('unknown_sender', 'The message source is not an active agent');
    }
    const input = this.inputAdapters.get(record.id);
    if (
      !this.canDeliverNow(record, input) ||
      this.pendingDrainPromises.has(record.id) ||
      record.mailbox?.receiver.pendingCount !== 0
    ) {
      return 'temporarily-unavailable';
    }

    const delivery = await input.deliver({
      messageId: message.requestId,
      source: snapshotIdentity(sourceRecord),
      content: message.content,
    });
    this.updateRecordInputState(record, input);
    if (delivery === 'temporarily-unavailable') {
      this.schedulePendingDrainRetry(record);
    }
    return delivery;
  }

  private bindInputAdapter(record: AgentRecord, input: AgentInputAdapter): void {
    validateAgentInputAdapter(input, 'agent input adapter');
    this.inputAdapters.set(record.id, input);
    this.inputAvailabilityVersions.set(
      record.id,
      (this.inputAvailabilityVersions.get(record.id) ?? 0) + 1
    );
    const oldUnsubscribe = this.inputAvailabilityUnsubscribers.get(record.id);
    oldUnsubscribe?.();
    const unsubscribe = input.onAvailabilityChange(() => {
      if (this.byId.get(record.id) === record) {
        this.noteInputAvailabilityChange(record, input);
      }
    });
    if (unsubscribe !== undefined) {
      this.inputAvailabilityUnsubscribers.set(record.id, unsubscribe);
    }
    void input.ready
      .then(() => {
        if (this.byId.get(record.id) === record) {
          this.noteInputAvailabilityChange(record, input);
        }
      })
      .catch(() => undefined);
  }

  private noteInputAvailabilityChange(record: AgentRecord, input: AgentInputAdapter): void {
    this.inputAvailabilityVersions.set(
      record.id,
      (this.inputAvailabilityVersions.get(record.id) ?? 0) + 1
    );
    this.pendingDrainRetryVersions.delete(record.id);
    this.updateRecordInputState(record, input);
    this.schedulePendingDrain(record);
  }

  private updateRecordInputState(record: AgentRecord, input: AgentInputAdapter): void {
    record.inputActivity = input.activity;
    if (
      (record.role === 'orchestrator' || record.launchReady) &&
      input.isReady &&
      (record.state === 'starting' ||
        record.state === 'running-active' ||
        record.state === 'running-idle')
    ) {
      record.state = input.activity === 'active' ? 'running-active' : 'running-idle';
    }
  }

  private canDeliverNow(
    record: AgentRecord,
    input: AgentInputAdapter | undefined
  ): input is AgentInputAdapter {
    return (
      input !== undefined &&
      this.byId.get(record.id) === record &&
      isNonterminalAgentLifecycleState(record.state) &&
      record.state !== 'finishing' &&
      record.state !== 'stopping' &&
      input.isReady &&
      input.activity !== 'not-ready' &&
      input.activity !== 'temporarily-unavailable' &&
      (record.role !== 'subagent' || record.launchReady)
    );
  }

  private schedulePendingDrain(record: AgentRecord): void {
    if (record.mailbox?.receiver.pendingCount === 0) {
      return;
    }
    const input = this.inputAdapters.get(record.id);
    if (!this.canDeliverNow(record, input)) {
      return;
    }
    if (this.pendingDrainPromises.has(record.id)) {
      return;
    }
    let drainPromise: Promise<void>;
    const availabilityVersion = this.inputAvailabilityVersions.get(record.id) ?? 0;
    drainPromise = this.drainPending(record)
      .catch(() => undefined)
      .finally(() => {
        if (this.pendingDrainPromises.get(record.id) === drainPromise) {
          this.pendingDrainPromises.delete(record.id);
          if (
            this.inputAvailabilityVersions.get(record.id) !== availabilityVersion &&
            this.byId.get(record.id) === record
          ) {
            this.schedulePendingDrain(record);
          }
        }
      });
    this.pendingDrainPromises.set(record.id, drainPromise);
  }

  /**
   * Retry a temporary provider backpressure result once at a later event-loop
   * turn. The activity version gate prevents a permanently unavailable
   * provider from causing a busy loop; a real availability notification or a
   * successful delivery clears the gate.
   */
  private schedulePendingDrainRetry(record: AgentRecord): void {
    const availabilityVersion = this.inputAvailabilityVersions.get(record.id) ?? 0;
    if (this.pendingDrainRetryVersions.get(record.id) === availabilityVersion) {
      return;
    }
    this.pendingDrainRetryVersions.set(record.id, availabilityVersion);
    setImmediate(() => {
      if (
        this.pendingDrainRetryVersions.get(record.id) !== availabilityVersion ||
        this.byId.get(record.id) !== record
      ) {
        return;
      }
      if (record.mailbox?.receiver.pendingCount === 0) {
        this.pendingDrainRetryVersions.delete(record.id);
        return;
      }
      this.schedulePendingDrain(record);
    });
  }

  private async drainPending(record: AgentRecord): Promise<void> {
    const receiver = record.mailbox?.receiver;
    if (receiver === undefined) {
      return;
    }
    while (this.canDeliverNow(record, this.inputAdapters.get(record.id))) {
      const input = this.inputAdapters.get(record.id);
      if (!this.canDeliverNow(record, input)) return;
      const pending = receiver.takePendingForDelivery(1);
      const entry = pending[0];
      if (entry === undefined) {
        return;
      }
      const source = identityFromTrustedRegistration(entry.sourceRegistration);
      try {
        const delivery = await input.deliver({
          messageId: entry.request.requestId,
          source,
          content: entry.request.content,
        });
        if (delivery === 'temporarily-unavailable') {
          receiver.requeuePending(pending);
          this.schedulePendingDrainRetry(record);
          return;
        }
        receiver.acknowledgePending(pending);
        this.pendingDrainRetryVersions.delete(record.id);
        this.updateRecordInputState(record, input);
      } catch {
        receiver.requeuePending(pending);
        return;
      }
    }
  }

  private throwForMailboxFailure(code: MailboxErrorCode, message: string, cause?: Error): never {
    throw this.mapMailboxError(code, message, cause);
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

  private async rollbackStart(
    record: SubagentAgentRecord,
    reservation: AgentReservation,
    mailbox: SessionRegistrationHandle | undefined,
    handle: import('./agent_manager_types.js').AgentLaunchHandle | undefined
  ): Promise<void> {
    record.launchHandle = undefined;
    record.launchReady = false;
    record.mailbox = undefined;
    record.registration = undefined;

    // Start provider cleanup without making reservation reuse wait for it. The
    // mailbox must finish deregistering first, because its registration file
    // can otherwise race a later same-name startup in the shared runtime.
    if (handle?.release !== undefined) {
      void Promise.resolve()
        .then(() => handle.release?.())
        .catch(() => undefined);
    }
    if (mailbox !== undefined) {
      await mailbox.deregister().catch(() => undefined);
    }
    reservation.release();
  }

  private selectSubagentName(
    agentType: AgentReservationRequest['type'],
    requestedName: AgentReservationRequest['name']
  ): AgentName {
    if (requestedName !== undefined) {
      const name = parseSubagentName(requestedName);
      if (name === undefined) {
        throw new AgentManagerError('invalid_name', `Invalid agent name: ${requestedName}`);
      }
      if (this.byName.has(name)) {
        throw new AgentManagerError('name_in_use', `Agent name is already in use: ${name}`);
      }
      return name;
    }

    for (let attempt = 0; attempt < this.options.maxAgentNameGenerationAttempts; attempt += 1) {
      let candidate;
      try {
        candidate = buildGeneratedAgentName(agentType, this.options.slugGenerator(agentType));
      } catch {
        candidate = undefined;
      }
      if (
        candidate !== undefined &&
        candidate !== ORCHESTRATOR_AGENT_NAME &&
        !this.byName.has(candidate)
      ) {
        return candidate;
      }
    }
    throw new AgentManagerError(
      'name_generation_exhausted',
      `Could not generate a unique ${agentType} name after ${this.options.maxAgentNameGenerationAttempts} attempts`
    );
  }

  private releaseReservation(record: SubagentAgentRecord): void {
    if (this.byId.get(record.id) !== record) {
      return;
    }
    this.inputAvailabilityUnsubscribers.get(record.id)?.();
    this.inputAvailabilityUnsubscribers.delete(record.id);
    this.inputAvailabilityVersions.delete(record.id);
    this.pendingDrainRetryVersions.delete(record.id);
    this.inputAdapters.delete(record.id);
    this.pendingDrainPromises.delete(record.id);
    this.byId.delete(record.id);
    if (this.byName.get(record.name) === record.id) {
      this.byName.delete(record.name);
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new AgentManagerError('manager_closed', 'The agent manager is closed');
    }
  }
}

function allocateOpaqueId(
  generator: AgentIdGenerator,
  maxAttempts: number,
  occupied: ReadonlySet<string>
): AgentId {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let candidate: AgentId | undefined;
    try {
      candidate = parseAgentId(generator());
    } catch {
      candidate = undefined;
    }
    if (candidate !== undefined && !occupied.has(candidate)) {
      return candidate;
    }
  }
  throw new AgentManagerError(
    'identity_generation_exhausted',
    `Could not generate a unique opaque agent ID after ${maxAttempts} attempts`
  );
}

export async function createAgentManager(options: AgentManagerOptions = {}): Promise<AgentManager> {
  return AgentManager.create(options);
}
