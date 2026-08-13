import {
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
  agentExecutorSchema,
  isNonterminalAgentLifecycleState,
  startAgentArgumentsSchema,
  type AgentSummary,
  type StartAgentResult,
  type AgentExecutor,
  type NonterminalAgentLifecycleState,
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
  type AgentPreparationRequest,
  type AgentManagerOptions,
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
import type { MailboxMessageRequest } from './mailbox_protocol.js';
import type { AgentRegistration } from './runtime_dir.js';

interface NormalizedManagerOptions {
  readonly orchestratorExecutor: AgentExecutor;
  readonly agentIdGenerator: AgentIdGenerator;
  readonly slugGenerator: AgentSlugGenerator;
  readonly maxAgentIdGenerationAttempts: number;
  readonly maxAgentNameGenerationAttempts: number;
  readonly agentPreparer: AgentManagerOptions['agentPreparer'];
  readonly agentLauncher: AgentManagerOptions['agentLauncher'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * Owns the root identity, startup boundary, synchronous identity/capacity
 * reservation, and public list snapshots. Message routing and terminal
 * lifecycle operations belong to adjacent manager layers.
 */
export class AgentManager {
  public readonly sessionRuntime: AgentMessagingSessionRuntime;
  public readonly orchestratorIdentity: OrchestratorIdentity;

  private readonly options: NormalizedManagerOptions;
  private readonly byId = new Map<AgentId, AgentRecord>();
  private readonly byName = new Map<AgentName, AgentId>();
  private nextCreationSequence = 0;
  private readonly rootRegistration: SessionRegistrationHandle;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    sessionRuntime: AgentMessagingSessionRuntime,
    options: NormalizedManagerOptions,
    rootRegistration: SessionRegistrationHandle,
    rootRecord: OrchestratorAgentRecord
  ) {
    this.sessionRuntime = sessionRuntime;
    this.options = options;
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
  }

  /** Create and initialize a manager with a ready reserved root mailbox. */
  public static async create(options: AgentManagerOptions = {}): Promise<AgentManager> {
    const normalizedOptions = normalizeOptions(options);
    const ownsSessionRuntime = options.sessionRuntime === undefined;
    const sessionRuntime = options.sessionRuntime ?? (await createAgentMessagingSessionRuntime());

    let rootRegistration: SessionRegistrationHandle | undefined;
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
        deliver: async (): Promise<'temporarily-unavailable'> => 'temporarily-unavailable',
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

      return new AgentManager(sessionRuntime, normalizedOptions, rootRegistration, rootRecord);
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
      this.watchInputReadiness(record, handle);

      // A launch handle's readiness is the provider-neutral establishment
      // boundary. It is separate from the input adapter's readiness and from
      // the completion promise.
      await handle.ready;
      record.launchReady = true;
      this.updateRecordInputState(record, handle.input);

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

  /** Close the root mailbox and the manager-owned session runtime. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async (): Promise<void> => {
      let firstError: unknown;
      try {
        await this.rootRegistration.deregister();
      } catch (error) {
        firstError = error;
      }
      try {
        await this.sessionRuntime.close();
      } catch (error) {
        firstError ??= error;
      } finally {
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

  private async deliverToAgent(
    record: SubagentAgentRecord,
    message: MailboxMessageRequest,
    sourceRegistration: AgentRegistration
  ): Promise<import('./mailbox_server.js').MailboxDeliveryResult> {
    if (this.byId.get(record.id) !== record || !isNonterminalAgentLifecycleState(record.state)) {
      return 'temporarily-unavailable';
    }
    const sourceId = parseAgentId(sourceRegistration.id);
    const sourceRecord = sourceId === undefined ? undefined : this.byId.get(sourceId);
    if (sourceRecord === undefined || sourceRecord.name !== sourceRegistration.name) {
      throw new AgentManagerError('unknown_sender', 'The message source is not an active agent');
    }
    const input = record.launchHandle?.input;
    if (!record.launchReady || input === undefined || !input.isReady) {
      return 'temporarily-unavailable';
    }

    const delivery = await input.deliver({
      messageId: message.requestId,
      source: snapshotIdentity(sourceRecord),
      content: message.content,
    });
    this.updateRecordInputState(record, input);
    return delivery;
  }

  private watchInputReadiness(
    record: SubagentAgentRecord,
    handle: import('./agent_manager_types.js').AgentLaunchHandle
  ): void {
    void handle.input.ready
      .then(() => {
        if (this.byId.get(record.id) === record && record.launchHandle === handle) {
          record.inputActivity = handle.input.activity;
          if (record.launchReady) {
            this.updateRecordInputState(record, handle.input);
          }
        }
      })
      .catch(() => undefined);
  }

  private updateRecordInputState(
    record: SubagentAgentRecord,
    input: import('./agent_manager_types.js').AgentInputAdapter
  ): void {
    record.inputActivity = input.activity;
    if (
      record.launchReady &&
      input.isReady &&
      (record.state === 'starting' ||
        record.state === 'running-active' ||
        record.state === 'running-idle')
    ) {
      record.state = input.activity === 'active' ? 'running-active' : 'running-idle';
    }
  }

  private async rollbackStart(
    record: SubagentAgentRecord,
    reservation: AgentReservation,
    mailbox: SessionRegistrationHandle | undefined,
    handle: import('./agent_manager_types.js').AgentLaunchHandle | undefined
  ): Promise<void> {
    const cleanup = new Array<Promise<void>>();
    if (handle?.release !== undefined) {
      cleanup.push(handle.release().catch(() => undefined));
    }
    if (mailbox !== undefined) {
      cleanup.push(mailbox.deregister().catch(() => undefined));
    }
    await Promise.all(cleanup);
    // The identity check in releaseReservation makes this safe even if a
    // later lifecycle owner has reused the human name.
    reservation.release();
    record.launchHandle = undefined;
    record.launchReady = false;
    record.mailbox = undefined;
    record.registration = undefined;
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
