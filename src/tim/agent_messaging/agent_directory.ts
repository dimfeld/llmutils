import {
  MAX_SUBAGENTS_PER_SESSION,
  ORCHESTRATOR_AGENT_NAME,
  agentExecutorSchema,
  isNonterminalAgentLifecycleState,
  nonterminalAgentLifecycleStateSchema,
  startAgentArgumentsSchema,
  type AgentExecutor,
  type AgentSummary,
  type AgentType,
  type ListAgentsResult,
  type NonterminalAgentLifecycleState,
  type StartAgentArguments,
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
  type AgentOutboundMessageSnapshot,
  type AgentProviderExitEvent,
  type AgentRecordSnapshot,
  type OrchestratorIdentity,
  type SubagentIdentity,
} from './agent_manager_types.js';
import type {
  AgentLaunchHandle,
  ProcessControlId,
  ProviderThreadId,
} from './agent_manager_types.js';
import type { AgentRegistration, AgentRegistrationDraft } from './runtime_dir.js';
import type { SessionRegistrationHandle } from './session_runtime.js';

export interface AgentDirectoryOptions {
  readonly orchestratorExecutor: AgentExecutor;
  readonly agentIdGenerator: AgentIdGenerator;
  readonly slugGenerator: AgentSlugGenerator;
  readonly maxAgentIdGenerationAttempts: number;
  readonly maxAgentNameGenerationAttempts: number;
}

export interface OrchestratorDirectoryRecord extends OrchestratorIdentity {
  readonly role: 'orchestrator';
  state: NonterminalAgentLifecycleState;
  inputActivity: AgentInputActivity;
  readonly creationSequence: number;
  readonly registrationDraft: AgentRegistrationDraft;
  providerOutputActivityCount: number;
  providerTurnCompletionCount: number;
  lastCompletedAssistantMessage?: string;
  lastSuccessfulOutbound?: AgentOutboundMessageSnapshot;
  providerExit?: AgentProviderExitEvent;
  registration?: AgentRegistration;
  mailbox?: SessionRegistrationHandle;
}

export interface SubagentDirectoryRecord extends SubagentIdentity {
  readonly role: 'subagent';
  state: NonterminalAgentLifecycleState;
  inputActivity: AgentInputActivity;
  launchReady: boolean;
  readonly creationSequence: number;
  readonly registrationDraft: AgentRegistrationDraft;
  providerOutputActivityCount: number;
  providerTurnCompletionCount: number;
  lastCompletedAssistantMessage?: string;
  lastSuccessfulOutbound?: AgentOutboundMessageSnapshot;
  providerExit?: AgentProviderExitEvent;
  registration?: AgentRegistration;
  mailbox?: SessionRegistrationHandle;
  launchHandle?: AgentLaunchHandle;
  processControlId?: ProcessControlId;
  providerThreadId?: ProviderThreadId;
}

export type DirectoryRecord = OrchestratorDirectoryRecord | SubagentDirectoryRecord;
export type AgentReservationRequest = StartAgentArguments;

export interface AgentReservation {
  readonly id: AgentId;
  readonly name: AgentName;
  readonly identity: SubagentIdentity;
  readonly snapshot: AgentRecordSnapshot;
  readonly record: SubagentDirectoryRecord;
  release(): void;
}

function snapshotIdentity(record: DirectoryRecord): AgentIdentity {
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

export function snapshotDirectoryRecord(record: DirectoryRecord): AgentRecordSnapshot {
  return Object.freeze({
    identity: snapshotIdentity(record),
    state: record.state,
    inputActivity: record.inputActivity,
    creationSequence: record.creationSequence,
    providerOutputActivityCount: record.providerOutputActivityCount,
    providerTurnCompletionCount: record.providerTurnCompletionCount,
    ...(record.lastCompletedAssistantMessage !== undefined
      ? { lastCompletedAssistantMessage: record.lastCompletedAssistantMessage }
      : {}),
    ...(record.lastSuccessfulOutbound !== undefined
      ? { lastSuccessfulOutbound: Object.freeze({ ...record.lastSuccessfulOutbound }) }
      : {}),
    ...(record.providerExit !== undefined
      ? { providerExit: Object.freeze({ ...record.providerExit }) }
      : {}),
    ...(record.role === 'subagent' && record.processControlId !== undefined
      ? { processControlId: record.processControlId }
      : {}),
    ...(record.role === 'subagent' && record.providerThreadId !== undefined
      ? { providerThreadId: record.providerThreadId }
      : {}),
  });
}

function toSummary(record: DirectoryRecord): AgentSummary {
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
  record: DirectoryRecord | undefined,
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

export function createRootAgentId(options: AgentDirectoryOptions): AgentId {
  return allocateOpaqueId(
    options.agentIdGenerator,
    options.maxAgentIdGenerationAttempts,
    new Set()
  );
}

/** Owns authoritative identity, name, capacity, and lifecycle directory state. */
export class AgentDirectory {
  private readonly byId = new Map<AgentId, DirectoryRecord>();
  private readonly byName = new Map<AgentName, AgentId>();
  private readonly rootId: AgentId;
  private nextCreationSequence = 1;

  public constructor(
    private readonly options: AgentDirectoryOptions,
    rootRecord: OrchestratorDirectoryRecord
  ) {
    this.rootId = rootRecord.id;
    this.byId.set(rootRecord.id, rootRecord);
    this.byName.set(rootRecord.name, rootRecord.id);
  }

  public get orchestratorIdentity(): OrchestratorIdentity {
    const record = this.getRootRecord();
    return Object.freeze({
      id: record.id,
      name: record.name,
      role: record.role,
      executor: record.executor,
    });
  }

  public get subagentCount(): number {
    let count = 0;
    for (const record of this.byId.values()) {
      if (record.role === 'subagent' && isNonterminalAgentLifecycleState(record.state)) {
        count += 1;
      }
    }
    return count;
  }

  public get records(): readonly DirectoryRecord[] {
    return [...this.byId.values()];
  }

  public getRecord(agentId: AgentId): DirectoryRecord | undefined {
    return this.byId.get(agentId);
  }

  public getRecordByName(name: AgentName): DirectoryRecord | undefined {
    const id = this.byName.get(name);
    return id === undefined ? undefined : this.byId.get(id);
  }

  public getIdentityByName(name: string): AgentIdentity | undefined {
    const parsedName = parseAgentAddress(name);
    if (parsedName === undefined) return undefined;
    const record = this.getRecordByName(parsedName);
    return record === undefined ? undefined : snapshotIdentity(record);
  }

  public listAgents(): ListAgentsResult {
    const agents = [...this.byId.values()]
      .filter((record) => isNonterminalAgentLifecycleState(record.state))
      .toSorted((left, right) => left.creationSequence - right.creationSequence)
      .map(toSummary);
    return Object.freeze({ agents: Object.freeze(agents) }) as ListAgentsResult;
  }

  public snapshot(record: DirectoryRecord): AgentRecordSnapshot {
    return snapshotDirectoryRecord(record);
  }

  public resolveCaller(caller: AgentCallerIdentity): DirectoryRecord {
    if (!isRecord(caller)) {
      throw new AgentManagerError('unknown_sender', 'The message sender is not an active agent');
    }
    const callerId = parseAgentId(caller.id);
    const record = callerId === undefined ? undefined : this.byId.get(callerId);
    if (
      record === undefined ||
      !isNonterminalAgentLifecycleState(record.state) ||
      caller.role !== record.role
    ) {
      throw new AgentManagerError('unknown_sender', 'The message sender is not an active agent');
    }
    return record;
  }

  public assertOrchestrator(caller: AgentCallerIdentity): OrchestratorDirectoryRecord {
    let record: DirectoryRecord;
    try {
      record = this.resolveCaller(caller);
    } catch (error) {
      if (error instanceof AgentManagerError && error.code === 'unknown_sender') {
        throw new AgentManagerError(
          'not_authorized',
          'Only the registered orchestrator identity may start agents'
        );
      }
      throw error;
    }
    if (record.role !== 'orchestrator') {
      throw new AgentManagerError(
        'not_authorized',
        'Only the registered orchestrator identity may start agents'
      );
    }
    return record;
  }

  public resolveTrustedSource(registration: AgentRegistration): AgentIdentity {
    const sourceId = parseAgentId(registration.id);
    const record = sourceId === undefined ? undefined : this.byId.get(sourceId);
    if (record === undefined || !matchesTrustedSource(record, registration)) {
      throw new AgentManagerError('unknown_sender', 'The message source is not an active agent');
    }
    return snapshotIdentity(record);
  }

  /** Return the identity captured by a receiver lease at enqueue time. */
  public identityFromRegistration(registration: AgentRegistration): AgentIdentity {
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

  /** Internal synchronous reservation. No async operation may enter this method. */
  public reserve(request: AgentReservationRequest): AgentReservation {
    if (this.subagentCount >= MAX_SUBAGENTS_PER_SESSION) {
      throw new AgentManagerError(
        'agent_limit_reached',
        `The session already has ${MAX_SUBAGENTS_PER_SESSION} nonterminal subagents`
      );
    }

    const name = this.selectSubagentName(request.type, request.name);
    const id = allocateOpaqueId(
      this.options.agentIdGenerator,
      this.options.maxAgentIdGenerationAttempts,
      new Set(this.byId.keys())
    );
    const identity: SubagentIdentity = Object.freeze({
      id,
      name,
      role: 'subagent',
      type: request.type,
      executor: request.executor,
    });
    const record: SubagentDirectoryRecord = {
      ...identity,
      state: 'starting',
      inputActivity: 'not-ready',
      launchReady: false,
      creationSequence: this.nextCreationSequence,
      providerOutputActivityCount: 0,
      providerTurnCompletionCount: 0,
      registrationDraft: {
        id,
        name,
        role: 'subagent',
        type: request.type,
        executor: request.executor,
        state: 'starting',
      },
    };

    // This is intentionally one synchronous critical section. Promise work
    // starts only after both maps contain the reservation.
    this.nextCreationSequence += 1;
    this.byId.set(id, record);
    this.byName.set(name, id);

    let released = false;
    return Object.freeze({
      id,
      name,
      identity,
      snapshot: snapshotDirectoryRecord(record),
      record,
      release: (): void => {
        if (released) return;
        released = true;
        this.removeRecordIfCurrent(record);
      },
    });
  }

  public setLifecycleState(agentId: AgentId, state: NonterminalAgentLifecycleState): void {
    const parsedState = nonterminalAgentLifecycleStateSchema.safeParse(state);
    if (!parsedState.success) {
      throw new AgentManagerError('invalid_request', `Invalid agent lifecycle state: ${state}`);
    }
    const record = this.byId.get(agentId);
    if (record === undefined) {
      throw new AgentManagerError('unknown_agent', `Unknown agent ID: ${agentId}`);
    }
    if (record.role !== 'subagent') {
      throw new AgentManagerError(
        'invalid_request',
        'Lifecycle state transitions are only available for subagent identities'
      );
    }
    record.state = parsedState.data;
  }

  public removeTerminal(agentId: AgentId): void {
    const record = this.byId.get(agentId);
    if (record === undefined) return;
    if (record.role !== 'subagent') {
      throw new AgentManagerError(
        'invalid_request',
        'Terminal removal is only available for subagent identities'
      );
    }
    this.removeRecordIfCurrent(record);
  }

  public clear(): void {
    this.byId.clear();
    this.byName.clear();
  }

  private getRootRecord(): OrchestratorDirectoryRecord {
    const record = this.byId.get(this.rootId);
    if (record === undefined || record.role !== 'orchestrator') {
      throw new AgentManagerError('root_registration_failed', 'The orchestrator record is missing');
    }
    return record;
  }

  private selectSubagentName(agentType: AgentType, requestedName: string | undefined): AgentName {
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
      let candidate: AgentName | undefined;
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

  private removeRecordIfCurrent(record: SubagentDirectoryRecord): void {
    if (this.byId.get(record.id) !== record) return;
    this.byId.delete(record.id);
    if (this.byName.get(record.name) === record.id) {
      this.byName.delete(record.name);
    }
  }
}

export function validateAgentReservationRequest(request: unknown): AgentReservationRequest {
  if (!isRecord(request)) {
    throw new AgentManagerError('invalid_request', 'Agent reservation request must be an object');
  }
  if (request.name === ORCHESTRATOR_AGENT_NAME) {
    throw new AgentManagerError('reserved_name', 'The orchestrator name is reserved');
  }
  if (Object.hasOwn(request, 'name') && request.name !== undefined) {
    if (parseSubagentName(request.name) === undefined) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createDefaultAgentDirectoryOptions(
  options: Partial<AgentDirectoryOptions> = {}
): AgentDirectoryOptions {
  const executor = options.orchestratorExecutor ?? 'claude-code';
  if (!agentExecutorSchema.safeParse(executor).success) {
    throw new AgentManagerError(
      'invalid_options',
      `Unsupported orchestrator executor: ${executor}`
    );
  }
  return {
    orchestratorExecutor: executor,
    agentIdGenerator: options.agentIdGenerator ?? createDefaultAgentId,
    slugGenerator: options.slugGenerator ?? createDefaultAgentSlug,
    maxAgentIdGenerationAttempts:
      options.maxAgentIdGenerationAttempts ?? DEFAULT_MAX_AGENT_ID_GENERATION_ATTEMPTS,
    maxAgentNameGenerationAttempts:
      options.maxAgentNameGenerationAttempts ?? DEFAULT_MAX_AGENT_NAME_GENERATION_ATTEMPTS,
  };
}
