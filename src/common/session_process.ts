import { randomUUID } from 'node:crypto';

/** The session ID propagated to nested tim processes. */
export const TIM_SESSION_ID = 'TIM_SESSION_ID';

/** The opaque ID of the process represented by the current environment. */
export const TIM_PROCESS_ID = 'TIM_PROCESS_ID';

/** The opaque ID of the process that is the tree parent of the current process. */
export const TIM_PARENT_PROCESS_ID = 'TIM_PARENT_PROCESS_ID';

/** The opaque ID of the tim process that owns the current process. */
export const TIM_OWNER_PROCESS_ID = 'TIM_OWNER_PROCESS_ID';

// These aliases make the relationship clear at call sites that use a
// process-prefixed naming convention. Keep one wire-level name for each value.
export const TIM_PROCESS_SESSION_ID = TIM_SESSION_ID;
export const TIM_PROCESS_PARENT_ID = TIM_PARENT_PROCESS_ID;
export const TIM_PROCESS_OWNER_ID = TIM_OWNER_PROCESS_ID;

const TIM_OUTPUT_SOCKET_ENV = 'TIM_OUTPUT_SOCKET';
const PROCESS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_PROCESS_LABEL_LENGTH = 512;
/**
 * Command lines are diagnostic metadata. Provider prompts can make them much
 * longer than an ordinary shell command, so keep a generous transport bound.
 * This value is not used for process-control identity checks.
 */
const MAX_PROCESS_COMMAND_LENGTH = 64 * 1024;
const MAX_PROCESS_START_IDENTITY_LENGTH = 2048;
const SESSION_PROCESS_COMMAND_TRUNCATION_MARKER = ' …[truncated]';

declare const processIdBrand: unique symbol;

/** An opaque, session-scoped process ID. It must not be treated as an OS PID. */
export type ProcessId = string & { readonly [processIdBrand]: true };

export type SessionProcessKind = 'tim' | 'executor';

export type SessionProcessState = 'starting' | 'running' | 'exited' | 'orphaned';

/** Results returned by a safe, opaque process-control request. */
export type SessionProcessTerminationResult =
  | 'terminated'
  | 'requested'
  | 'already_exited'
  | 'not_owned'
  | 'not_executor'
  | 'stale_target'
  | 'unknown_process_state'
  | 'signal_failed'
  | 'unknown_executor'
  | 'owner_not_registered'
  | 'owner_not_connected'
  | 'send_failed'
  | 'request_timeout';

export const SESSION_PROCESS_TERMINATION_RESULTS = new Set<SessionProcessTerminationResult>([
  'terminated',
  'requested',
  'already_exited',
  'not_owned',
  'not_executor',
  'stale_target',
  'unknown_process_state',
  'signal_failed',
  'unknown_executor',
  'owner_not_registered',
  'owner_not_connected',
  'send_failed',
  'request_timeout',
]);

export function isSessionProcessTerminationResult(
  value: unknown
): value is SessionProcessTerminationResult {
  return (
    typeof value === 'string' &&
    SESSION_PROCESS_TERMINATION_RESULTS.has(value as SessionProcessTerminationResult)
  );
}

export interface SessionProcessTerminationResultEvent {
  executorId: ProcessId;
  requestId: string;
  result: SessionProcessTerminationResult;
  error?: string;
}

/** Sends a targeted control request to one connected tim owner channel. */
export type SessionProcessOwnerChannelSender = (
  executorId: ProcessId,
  requestId?: string
) => boolean;

export type SessionProcessOwnerChannelRouteResult = 'sent' | 'owner_not_connected' | 'send_failed';

export interface SessionProcessNode {
  processId: ProcessId;
  parentProcessId?: ProcessId;
  kind: SessionProcessKind;
  label: string;
  ownerProcessId?: ProcessId;
  pid?: number;
  command?: string;
  /** An opaque OS start identity, such as the output of `ps lstart`. */
  startIdentity?: string;
  startedAt: string;
  state: SessionProcessState;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
}

export interface SessionProcessRegistration {
  processId?: ProcessId;
  parentProcessId?: ProcessId;
  kind: SessionProcessKind;
  label: string;
  ownerProcessId?: ProcessId;
  pid?: number;
  command?: string;
  startIdentity?: string;
  startedAt?: string;
  state?: Extract<SessionProcessState, 'starting' | 'running'>;
}

export interface SessionProcessUpdate {
  label?: string;
  parentProcessId?: ProcessId;
  ownerProcessId?: ProcessId;
  pid?: number | null;
  command?: string | null;
  startIdentity?: string | null;
  state?: SessionProcessState;
}

export interface SessionProcessExit {
  endedAt?: string;
  exitCode?: number | null;
  signal?: string;
}

/**
 * Receives lifecycle events for one session process owner.
 *
 * The sink is deliberately expressed in domain types. Transport adapters can
 * serialize these events for a tunnel, while a local registry adapter can
 * apply them in memory without making the common process code depend on a
 * wire protocol.
 */
export interface SessionProcessLifecycleSink {
  /** The local registry when this is a registry-backed sink. */
  readonly registry?: SessionProcessRegistry;
  registerProcess(registration: SessionProcessRegistration): boolean;
  updateProcess(processId: ProcessId, update: SessionProcessUpdate): boolean;
  exitProcess(processId: ProcessId, details?: SessionProcessExit): boolean;
  removeProcess(processId: ProcessId, subtree?: boolean): boolean;
}

export type SessionProcessChange =
  | {
      type: 'registered';
      node: SessionProcessNode;
    }
  | {
      type: 'updated';
      node: SessionProcessNode;
    }
  | {
      type: 'exited';
      node: SessionProcessNode;
      orphanedProcessIds: ProcessId[];
    }
  | {
      type: 'removed';
      processIds: ProcessId[];
    }
  | {
      type: 'owner_lost';
      processIds: ProcessId[];
      nodes: SessionProcessNode[];
    };

export type SessionProcessListener = (change: SessionProcessChange) => void;

export interface SessionProcessRegistryOptions {
  /** The session identity used for this ephemeral registry. */
  sessionId?: string;
  /** Set false to make all operations no-ops. Defaults to whether sessionId exists. */
  active?: boolean;
  now?: () => Date;
  idGenerator?: () => ProcessId;
}

export interface CreateSessionProcessRegistryFromEnvironmentOptions extends Omit<
  SessionProcessRegistryOptions,
  'sessionId' | 'active'
> {
  /** True when the current process has an embedded headless session. */
  headlessSession?: boolean;
  /** Override detection of the inherited parent tunnel. */
  parentTunnelActive?: boolean;
  /** Use this session ID instead of the value in the environment. */
  sessionId?: string;
}

export function isProcessId(value: unknown): value is ProcessId {
  return typeof value === 'string' && PROCESS_ID_PATTERN.test(value);
}

export function toProcessId(value: string): ProcessId | undefined {
  return isProcessId(value) ? value : undefined;
}

export function createProcessId(idGenerator: () => string = randomUUID): ProcessId {
  const generated = idGenerator();
  if (!isProcessId(generated)) {
    throw new Error('The process ID generator returned an invalid opaque ID.');
  }
  return generated;
}

function isNonEmptyString(
  value: unknown,
  maxLength: number = Number.MAX_SAFE_INTEGER
): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isValidPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalString(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength);
}

function isOptionalNullableString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value.length <= maxLength)
  );
}

function isOptionalProcessId(value: unknown): boolean {
  return value === undefined || isProcessId(value);
}

function isOptionalNullablePid(value: unknown): boolean {
  return value === undefined || value === null || isValidPid(value);
}

/**
 * Bounds command metadata for display and transport without changing the
 * command kept privately by an executor owner for identity checks.
 */
export function normalizeSessionProcessCommand(command: string): string {
  if (command.length <= MAX_PROCESS_COMMAND_LENGTH) {
    return command;
  }

  const prefixLength =
    MAX_PROCESS_COMMAND_LENGTH - SESSION_PROCESS_COMMAND_TRUNCATION_MARKER.length;
  return `${command.slice(0, prefixLength)}${SESSION_PROCESS_COMMAND_TRUNCATION_MARKER}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SessionProcessRegistrationValidationOptions {
  requireProcessId?: boolean;
}

/** Validates a process registration payload independently of tree relationships. */
export function isValidSessionProcessRegistration(
  value: unknown,
  options: SessionProcessRegistrationValidationOptions = {}
): value is SessionProcessRegistration {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (options.requireProcessId
      ? isProcessId(value.processId)
      : isOptionalProcessId(value.processId)) &&
    isOptionalProcessId(value.parentProcessId) &&
    isOptionalProcessId(value.ownerProcessId) &&
    (value.kind === 'tim' || value.kind === 'executor') &&
    isNonEmptyString(value.label, MAX_PROCESS_LABEL_LENGTH) &&
    (value.pid === undefined || isValidPid(value.pid)) &&
    isOptionalString(value.command, MAX_PROCESS_COMMAND_LENGTH) &&
    isOptionalString(value.startIdentity, MAX_PROCESS_START_IDENTITY_LENGTH) &&
    (value.startedAt === undefined || isNonEmptyString(value.startedAt, 512)) &&
    (value.state === undefined || value.state === 'starting' || value.state === 'running')
  );
}

/** Validates mutable process metadata sent after registration. */
export function isValidSessionProcessUpdate(
  value: unknown,
  options: { requireChange?: boolean } = {}
): value is SessionProcessUpdate {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOptionalProcessId(value.parentProcessId) &&
    isOptionalProcessId(value.ownerProcessId) &&
    (value.label === undefined || isNonEmptyString(value.label, MAX_PROCESS_LABEL_LENGTH)) &&
    isOptionalNullablePid(value.pid) &&
    isOptionalNullableString(value.command, MAX_PROCESS_COMMAND_LENGTH) &&
    isOptionalNullableString(value.startIdentity, MAX_PROCESS_START_IDENTITY_LENGTH) &&
    (value.state === undefined ||
      value.state === 'starting' ||
      value.state === 'running' ||
      value.state === 'exited' ||
      value.state === 'orphaned') &&
    (!options.requireChange || Object.keys(value).length > 0)
  );
}

/** Validates process exit details. */
export function isValidSessionProcessExit(value: unknown): value is SessionProcessExit {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.endedAt === undefined || isNonEmptyString(value.endedAt, 512)) &&
    (value.exitCode === undefined ||
      value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))) &&
    isOptionalString(value.signal, 128)
  );
}

/** Validates one complete process node received by a session client. */
export function isValidSessionProcessNode(value: unknown): value is SessionProcessNode {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isProcessId(value.processId) &&
    isOptionalProcessId(value.parentProcessId) &&
    isOptionalProcessId(value.ownerProcessId) &&
    (value.kind === 'tim' || value.kind === 'executor') &&
    isNonEmptyString(value.label, MAX_PROCESS_LABEL_LENGTH) &&
    (value.pid === undefined || isValidPid(value.pid)) &&
    isOptionalString(value.command, MAX_PROCESS_COMMAND_LENGTH) &&
    isOptionalString(value.startIdentity, MAX_PROCESS_START_IDENTITY_LENGTH) &&
    isNonEmptyString(value.startedAt, 512) &&
    (value.state === 'starting' ||
      value.state === 'running' ||
      value.state === 'exited' ||
      value.state === 'orphaned') &&
    isOptionalString(value.endedAt, 512) &&
    (value.exitCode === undefined ||
      value.exitCode === null ||
      (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode))) &&
    isOptionalString(value.signal, 128)
  );
}

/** Validates a correlated termination result event. */
export function isValidSessionProcessTerminationResultEvent(
  value: unknown
): value is SessionProcessTerminationResultEvent {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isProcessId(value.executorId) &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 256 &&
    isSessionProcessTerminationResult(value.result) &&
    isOptionalString(value.error, 4096)
  );
}

function cloneNode(node: SessionProcessNode): SessionProcessNode {
  return { ...node };
}

function isTerminalState(state: SessionProcessState): boolean {
  return state === 'exited' || state === 'orphaned';
}

function expectedParentKind(kind: SessionProcessKind): SessionProcessKind {
  return kind === 'tim' ? 'executor' : 'tim';
}

function expectedOwnerKind(kind: SessionProcessKind): SessionProcessKind {
  return kind === 'tim' ? 'executor' : 'tim';
}

function normalizeSessionId(value: string | undefined): string | undefined {
  return value && isNonEmptyString(value, 512) ? value : undefined;
}

function toIsoString(value: string | undefined, now: () => Date): string {
  if (value !== undefined && isNonEmptyString(value)) {
    return value;
  }
  return now().toISOString();
}

/**
 * Values which identify the current process to a nested tim command.
 * `processId` is the ID of the current node, not an OS PID.
 */
export interface SessionProcessEnvironment {
  sessionId: string;
  processId: ProcessId;
  parentProcessId?: ProcessId;
  ownerProcessId?: ProcessId;
}

export function readSessionProcessEnvironment(
  env: Record<string, string | undefined> = process.env
): SessionProcessEnvironment | undefined {
  const sessionId = normalizeSessionId(env[TIM_SESSION_ID]);
  const processIdValue = env[TIM_PROCESS_ID];
  if (!sessionId || !isProcessId(processIdValue)) {
    return undefined;
  }

  const parentValue = env[TIM_PARENT_PROCESS_ID];
  const ownerValue = env[TIM_OWNER_PROCESS_ID];
  if (
    (parentValue !== undefined && !isProcessId(parentValue)) ||
    (ownerValue !== undefined && !isProcessId(ownerValue))
  ) {
    return undefined;
  }

  return {
    sessionId,
    processId: processIdValue,
    parentProcessId: parentValue,
    ownerProcessId: ownerValue,
  };
}

/**
 * Returns a child environment with the explicit session process values set.
 * Undefined relationship values remove inherited values, which prevents a
 * root child from accidentally retaining a stale nested-process relationship.
 */
export function withSessionProcessEnvironment(
  inheritedEnv: Record<string, string | undefined>,
  values: SessionProcessEnvironment
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env[TIM_SESSION_ID] = values.sessionId;
  env[TIM_PROCESS_ID] = values.processId;
  delete env[TIM_PARENT_PROCESS_ID];
  delete env[TIM_OWNER_PROCESS_ID];
  if (values.parentProcessId) {
    env[TIM_PARENT_PROCESS_ID] = values.parentProcessId;
  }
  if (values.ownerProcessId) {
    env[TIM_OWNER_PROCESS_ID] = values.ownerProcessId;
  }
  return env;
}

export interface CreateChildSessionProcessEnvironmentOptions {
  sessionId: string;
  parentProcessId?: ProcessId;
  ownerProcessId?: ProcessId;
  processId?: ProcessId;
}

/** Creates a new opaque node ID and propagates its process relationship. */
export function createChildSessionProcessEnvironment(
  inheritedEnv: Record<string, string | undefined>,
  options: CreateChildSessionProcessEnvironmentOptions
): { processId: ProcessId; env: Record<string, string> } {
  const processId = options.processId ?? createProcessId();
  const sessionId = normalizeSessionId(options.sessionId);
  if (!sessionId) {
    throw new Error('A non-empty session ID is required for process tracking.');
  }

  return {
    processId,
    env: withSessionProcessEnvironment(inheritedEnv, {
      sessionId,
      processId,
      parentProcessId: options.parentProcessId,
      ownerProcessId: options.ownerProcessId,
    }),
  };
}

/**
 * Process tracking is active only when a live headless session or a parent
 * tunnel provides a transport for lifecycle events.
 */
export function isSessionProcessTrackingEnabled(
  env: Record<string, string | undefined> = process.env,
  options: {
    headlessSession?: boolean;
    parentTunnelActive?: boolean;
    sessionId?: string;
  } = {}
): boolean {
  const sessionId = normalizeSessionId(options.sessionId ?? env[TIM_SESSION_ID]);
  const hasHeadlessSession = options.headlessSession === true;
  const hasParentTunnel = options.parentTunnelActive ?? Boolean(env[TIM_OUTPUT_SOCKET_ENV]);
  return sessionId !== undefined && (hasHeadlessSession || hasParentTunnel);
}

export function createSessionProcessRegistryFromEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: CreateSessionProcessRegistryFromEnvironmentOptions = {}
): SessionProcessRegistry {
  const sessionId = normalizeSessionId(options.sessionId ?? env[TIM_SESSION_ID]);
  const active = isSessionProcessTrackingEnabled(env, {
    headlessSession: options.headlessSession,
    parentTunnelActive: options.parentTunnelActive,
    sessionId,
  });
  return new SessionProcessRegistry({
    ...options,
    sessionId,
    active,
  });
}

/**
 * An in-memory process tree for one live session. The registry has no database
 * or OS-process discovery side effects. Its node IDs and relationships are the
 * authoritative session state.
 */
export class SessionProcessRegistry {
  private readonly nodes = new Map<ProcessId, SessionProcessNode>();
  private readonly ownerChannels = new Map<ProcessId, string>();
  private readonly processIdsByChannel = new Map<string, Set<ProcessId>>();
  private readonly channelSenders = new Map<string, SessionProcessOwnerChannelSender>();
  private readonly listeners = new Set<SessionProcessListener>();
  private readonly terminationResultListeners = new Set<
    (event: SessionProcessTerminationResultEvent) => void
  >();
  private readonly now: () => Date;
  private readonly idGenerator: () => ProcessId;
  private readonly active: boolean;

  readonly sessionId?: string;

  constructor(options: SessionProcessRegistryOptions = {}) {
    this.sessionId = normalizeSessionId(options.sessionId);
    this.active = options.active ?? this.sessionId !== undefined;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => createProcessId());
  }

  get isActive(): boolean {
    return this.active;
  }

  get size(): number {
    return this.nodes.size;
  }

  subscribe(listener: SessionProcessListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeTerminationResults(
    listener: (event: SessionProcessTerminationResultEvent) => void
  ): () => void {
    this.terminationResultListeners.add(listener);
    return () => {
      this.terminationResultListeners.delete(listener);
    };
  }

  registerOwnerChannelSender(channelId: string, sender: SessionProcessOwnerChannelSender): boolean {
    if (!this.active || !isNonEmptyString(channelId, 512)) {
      return false;
    }

    this.channelSenders.set(channelId, sender);
    return true;
  }

  unregisterOwnerChannelSender(channelId: string): void {
    this.channelSenders.delete(channelId);
  }

  /** Routes a request using the channel bound to the executor's tim owner. */
  sendTerminationToOwner(
    executorId: ProcessId,
    requestId?: string
  ): SessionProcessOwnerChannelRouteResult {
    const channelId = this.getExecutorOwnerChannel(executorId);
    if (!channelId) {
      return 'owner_not_connected';
    }

    const sender = this.channelSenders.get(channelId);
    if (!sender) {
      return 'owner_not_connected';
    }

    try {
      return sender(executorId, requestId) ? 'sent' : 'send_failed';
    } catch {
      return 'send_failed';
    }
  }

  /** Delivers a result returned by a nested tim owner to headless listeners. */
  emitTerminationResult(event: SessionProcessTerminationResultEvent): void {
    if (!this.active || !isValidSessionProcessTerminationResultEvent(event)) {
      return;
    }

    for (const listener of this.terminationResultListeners) {
      try {
        listener({ ...event });
      } catch {
        // A result observer must not affect registry state or later observers.
      }
    }
  }

  get(processId: ProcessId): SessionProcessNode | undefined {
    const node = this.nodes.get(processId);
    return node ? cloneNode(node) : undefined;
  }

  has(processId: ProcessId): boolean {
    return this.nodes.has(processId);
  }

  /** Returns a stable parent-before-child snapshot for transport and UI use. */
  getSnapshot(): SessionProcessNode[] {
    if (!this.active) {
      return [];
    }

    const compareProcessIds = (left: ProcessId, right: ProcessId): number => {
      const leftNode = this.nodes.get(left);
      const rightNode = this.nodes.get(right);
      if (!leftNode || !rightNode) {
        return left.localeCompare(right);
      }

      return (
        leftNode.startedAt.localeCompare(rightNode.startedAt) ||
        leftNode.processId.localeCompare(rightNode.processId)
      );
    };

    const childrenByParent = new Map<ProcessId, ProcessId[]>();
    const roots: ProcessId[] = [];
    for (const node of this.nodes.values()) {
      if (node.parentProcessId && this.nodes.has(node.parentProcessId)) {
        const children = childrenByParent.get(node.parentProcessId) ?? [];
        children.push(node.processId);
        childrenByParent.set(node.parentProcessId, children);
      } else {
        roots.push(node.processId);
      }
    }

    roots.sort(compareProcessIds);
    for (const children of childrenByParent.values()) {
      children.sort(compareProcessIds);
    }

    const ordered: SessionProcessNode[] = [];
    const visited = new Set<ProcessId>();
    const visit = (processId: ProcessId): void => {
      if (visited.has(processId)) {
        return;
      }
      const node = this.nodes.get(processId);
      if (!node) {
        return;
      }
      visited.add(processId);
      ordered.push(cloneNode(node));
      for (const childId of childrenByParent.get(processId) ?? []) {
        visit(childId);
      }
    };

    for (const rootId of roots) {
      visit(rootId);
    }
    for (const processId of [...this.nodes.keys()].sort(compareProcessIds)) {
      visit(processId);
    }
    return ordered;
  }

  register(
    registration: SessionProcessRegistration,
    options: { ownerChannelId?: string } = {}
  ): SessionProcessNode | undefined {
    if (!this.active || !this.isValidRegistration(registration)) {
      return undefined;
    }

    const processId = registration.processId ?? this.newUniqueProcessId();
    const parentProcessId = registration.parentProcessId;
    const ownerProcessId = registration.ownerProcessId ?? parentProcessId;
    const existing = this.nodes.get(processId);
    if (existing) {
      if (
        existing.kind !== registration.kind ||
        existing.parentProcessId !== parentProcessId ||
        existing.ownerProcessId !== ownerProcessId ||
        existing.label !== registration.label
      ) {
        return undefined;
      }

      if (
        options.ownerChannelId &&
        existing.kind === 'tim' &&
        !this.bindOwnerToChannel(existing.processId, options.ownerChannelId)
      ) {
        return undefined;
      }
      if (!isTerminalState(existing.state)) {
        const updated = this.mergeRegistration(existing, registration);
        if (updated) {
          this.emit({ type: 'updated', node: cloneNode(updated) });
        }
      }
      return cloneNode(this.nodes.get(processId) ?? existing);
    }

    if (!this.relationshipsExist(parentProcessId, ownerProcessId, registration.kind)) {
      return undefined;
    }

    const node: SessionProcessNode = {
      processId,
      parentProcessId,
      kind: registration.kind,
      label: registration.label,
      ownerProcessId,
      pid: registration.pid,
      command: registration.command,
      startIdentity: registration.startIdentity,
      startedAt: toIsoString(registration.startedAt, this.now),
      state: registration.state ?? 'running',
    };
    this.nodes.set(processId, node);

    if (options.ownerChannelId && node.kind === 'tim') {
      if (!this.bindOwnerToChannel(node.processId, options.ownerChannelId)) {
        this.nodes.delete(processId);
        return undefined;
      }
    }

    this.emit({ type: 'registered', node: cloneNode(node) });
    return cloneNode(node);
  }

  update(processId: ProcessId, update: SessionProcessUpdate): SessionProcessNode | undefined {
    if (!this.active || !isValidSessionProcessUpdate(update)) {
      return undefined;
    }
    const current = this.nodes.get(processId);
    if (!current) {
      return undefined;
    }
    if (isTerminalState(current.state)) {
      return cloneNode(current);
    }

    const nextParentProcessId = update.parentProcessId ?? current.parentProcessId;
    const nextOwnerProcessId = update.ownerProcessId ?? current.ownerProcessId;
    const requestedState = update.state;
    const nextState =
      requestedState === 'starting' && current.state !== 'starting'
        ? current.state
        : (requestedState ?? current.state);
    if (
      ((update.parentProcessId !== undefined || update.ownerProcessId !== undefined) &&
        !this.relationshipsExist(nextParentProcessId, nextOwnerProcessId, current.kind, current)) ||
      (update.label !== undefined && !isNonEmptyString(update.label, MAX_PROCESS_LABEL_LENGTH)) ||
      (update.pid !== undefined && update.pid !== null && !isValidPid(update.pid)) ||
      (update.command !== undefined &&
        update.command !== null &&
        typeof update.command !== 'string') ||
      (update.startIdentity !== undefined &&
        update.startIdentity !== null &&
        typeof update.startIdentity !== 'string')
    ) {
      return undefined;
    }

    const next: SessionProcessNode = {
      ...current,
      ...update,
      parentProcessId: update.parentProcessId ?? current.parentProcessId,
      ownerProcessId: update.ownerProcessId ?? current.ownerProcessId,
      label: update.label ?? current.label,
      pid: update.pid === null ? undefined : (update.pid ?? current.pid),
      command: update.command === null ? undefined : (update.command ?? current.command),
      startIdentity:
        update.startIdentity === null ? undefined : (update.startIdentity ?? current.startIdentity),
      state: nextState,
    };
    if (next.state === 'exited') {
      return this.exit(processId, { endedAt: this.now().toISOString() });
    }
    if (next.state === 'orphaned') {
      this.markOwnerLost(processId);
      return this.get(processId);
    }

    if (JSON.stringify(next) === JSON.stringify(current)) {
      return cloneNode(current);
    }
    this.nodes.set(processId, next);
    this.emit({ type: 'updated', node: cloneNode(next) });
    return cloneNode(next);
  }

  exit(processId: ProcessId, details: SessionProcessExit = {}): SessionProcessNode | undefined {
    if (!this.active || !isValidSessionProcessExit(details)) {
      return undefined;
    }
    const current = this.nodes.get(processId);
    if (!current) {
      return undefined;
    }
    if (isTerminalState(current.state)) {
      return cloneNode(current);
    }

    const exited: SessionProcessNode = {
      ...current,
      state: 'exited',
      endedAt: details.endedAt ?? this.now().toISOString(),
      exitCode: details.exitCode,
      signal: details.signal,
    };
    this.nodes.set(processId, exited);
    if (exited.kind === 'tim') {
      this.removeChannelBinding(processId);
    }
    const orphanedProcessIds = this.markDescendantsOrphaned(processId);
    this.emit({
      type: 'exited',
      node: cloneNode(exited),
      orphanedProcessIds,
    });
    return cloneNode(exited);
  }

  remove(processId: ProcessId, removeSubtree: boolean = true): ProcessId[] {
    if (!this.active) {
      return [];
    }
    if (removeSubtree) {
      return this.removeSubtree(processId);
    }
    if (!this.nodes.delete(processId)) {
      return [];
    }
    this.removeChannelBinding(processId);
    this.emit({ type: 'removed', processIds: [processId] });
    return [processId];
  }

  removeSubtree(processId: ProcessId): ProcessId[] {
    if (!this.active || !this.nodes.has(processId)) {
      return [];
    }
    const removed: ProcessId[] = [];
    const visit = (candidate: ProcessId): void => {
      for (const child of this.nodes.values()) {
        if (child.parentProcessId === candidate) {
          visit(child.processId);
        }
      }
      if (this.nodes.delete(candidate)) {
        this.removeChannelBinding(candidate);
        removed.push(candidate);
      }
    };
    visit(processId);
    if (removed.length > 0) {
      this.emit({ type: 'removed', processIds: removed });
    }
    return removed;
  }

  markOwnerLost(processId: ProcessId): ProcessId[] {
    if (!this.active || !this.nodes.has(processId)) {
      return [];
    }
    const lost: ProcessId[] = [];
    const nodes: SessionProcessNode[] = [];
    const visit = (candidate: ProcessId): void => {
      const node = this.nodes.get(candidate);
      if (!node) {
        return;
      }
      if (!isTerminalState(node.state)) {
        const orphaned: SessionProcessNode = {
          ...node,
          state: 'orphaned',
          endedAt: node.endedAt ?? this.now().toISOString(),
        };
        this.nodes.set(candidate, orphaned);
        lost.push(candidate);
        nodes.push(cloneNode(orphaned));
      }
      for (const child of this.nodes.values()) {
        if (child.parentProcessId === candidate) {
          visit(child.processId);
        }
      }
    };
    visit(processId);
    for (const lostProcessId of lost) {
      this.removeChannelBinding(lostProcessId);
    }
    if (lost.length > 0) {
      this.emit({ type: 'owner_lost', processIds: lost, nodes });
    }
    return lost;
  }

  /** Removes or marks every tim owner associated with a tunnel client. */
  releaseChannel(channelId: string, mode: 'remove' | 'orphan' = 'remove'): ProcessId[] {
    if (!this.active || !isNonEmptyString(channelId, 512)) {
      return [];
    }
    const processIds = [...(this.processIdsByChannel.get(channelId) ?? [])];
    this.unregisterOwnerChannelSender(channelId);
    this.processIdsByChannel.delete(channelId);
    const affected: ProcessId[] = [];
    for (const processId of processIds) {
      if (mode === 'remove') {
        affected.push(...this.removeSubtree(processId));
      } else {
        affected.push(...this.markOwnerLost(processId));
      }
    }
    return affected;
  }

  bindOwnerToChannel(processId: ProcessId, channelId: string): boolean {
    if (!this.active || !isNonEmptyString(channelId, 512)) {
      return false;
    }
    const node = this.nodes.get(processId);
    if (!node || node.kind !== 'tim' || isTerminalState(node.state)) {
      return false;
    }
    const existingChannel = this.ownerChannels.get(processId);
    if (existingChannel && existingChannel !== channelId) {
      return false;
    }
    this.ownerChannels.set(processId, channelId);
    const processIds = this.processIdsByChannel.get(channelId) ?? new Set<ProcessId>();
    processIds.add(processId);
    this.processIdsByChannel.set(channelId, processIds);
    return true;
  }

  getOwnerChannel(processId: ProcessId): string | undefined {
    return this.ownerChannels.get(processId);
  }

  getExecutorOwnerChannel(processId: ProcessId): string | undefined {
    const executor = this.nodes.get(processId);
    if (!executor || executor.kind !== 'executor' || isTerminalState(executor.state)) {
      return undefined;
    }
    if (!executor.ownerProcessId) {
      return undefined;
    }
    const owner = this.nodes.get(executor.ownerProcessId);
    if (!owner || owner.kind !== 'tim' || isTerminalState(owner.state)) {
      return undefined;
    }
    return this.ownerChannels.get(executor.ownerProcessId);
  }

  private newUniqueProcessId(): ProcessId {
    for (;;) {
      const processId = this.idGenerator();
      if (!this.nodes.has(processId)) {
        return processId;
      }
    }
  }

  private isValidRegistration(registration: SessionProcessRegistration): boolean {
    return isValidSessionProcessRegistration(registration);
  }

  private relationshipsExist(
    parentProcessId: ProcessId | undefined,
    ownerProcessId: ProcessId | undefined,
    kind: SessionProcessKind,
    current?: SessionProcessNode
  ): boolean {
    const parent = parentProcessId ? this.nodes.get(parentProcessId) : undefined;
    const owner = ownerProcessId ? this.nodes.get(ownerProcessId) : undefined;

    if (
      !current &&
      kind === 'tim' &&
      parentProcessId === undefined &&
      ownerProcessId === undefined
    ) {
      return true;
    }
    if (current && parentProcessId === undefined && ownerProcessId === undefined) {
      return current.kind === 'tim' && current.parentProcessId === undefined;
    }
    if (!parent || !owner) {
      return false;
    }
    return (
      parent.kind === expectedParentKind(kind) &&
      owner.kind === expectedOwnerKind(kind) &&
      !isTerminalState(parent.state) &&
      !isTerminalState(owner.state)
    );
  }

  private mergeRegistration(
    current: SessionProcessNode,
    registration: SessionProcessRegistration
  ): SessionProcessNode | undefined {
    const next: SessionProcessNode = {
      ...current,
      label: registration.label,
      pid: registration.pid ?? current.pid,
      command: registration.command ?? current.command,
      startIdentity: registration.startIdentity ?? current.startIdentity,
      state: current.state === 'starting' ? (registration.state ?? current.state) : current.state,
    };
    if (JSON.stringify(next) === JSON.stringify(current)) {
      return undefined;
    }
    this.nodes.set(current.processId, next);
    return next;
  }

  private markDescendantsOrphaned(processId: ProcessId): ProcessId[] {
    const orphaned: ProcessId[] = [];
    const visit = (parentProcessId: ProcessId): void => {
      for (const child of this.nodes.values()) {
        if (child.parentProcessId !== parentProcessId) {
          continue;
        }
        if (!isTerminalState(child.state)) {
          this.nodes.set(child.processId, {
            ...child,
            state: 'orphaned',
            endedAt: child.endedAt ?? this.now().toISOString(),
          });
          if (child.kind === 'tim') {
            this.removeChannelBinding(child.processId);
          }
          orphaned.push(child.processId);
        }
        visit(child.processId);
      }
    };
    visit(processId);
    return orphaned;
  }

  private removeChannelBinding(processId: ProcessId): void {
    const channelId = this.ownerChannels.get(processId);
    if (!channelId) {
      return;
    }
    this.ownerChannels.delete(processId);
    const processIds = this.processIdsByChannel.get(channelId);
    processIds?.delete(processId);
    if (processIds?.size === 0) {
      this.processIdsByChannel.delete(channelId);
    }
  }

  private emit(change: SessionProcessChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // A subscriber must not corrupt registry state or stop later listeners.
      }
    }
  }
}

/** Adapts a local registry to the domain lifecycle sink contract. */
export class SessionProcessRegistryLifecycleSink implements SessionProcessLifecycleSink {
  readonly registry: SessionProcessRegistry;

  constructor(registry: SessionProcessRegistry) {
    this.registry = registry;
  }

  registerProcess(registration: SessionProcessRegistration): boolean {
    if (!this.registry.isActive) {
      return true;
    }
    const normalizedRegistration =
      typeof registration.command !== 'string'
        ? registration
        : { ...registration, command: normalizeSessionProcessCommand(registration.command) };
    return this.registry.register(normalizedRegistration) !== undefined;
  }

  updateProcess(processId: ProcessId, update: SessionProcessUpdate): boolean {
    if (!this.registry.isActive) {
      return true;
    }
    const normalizedUpdate =
      typeof update.command !== 'string'
        ? update
        : { ...update, command: normalizeSessionProcessCommand(update.command) };
    return this.registry.update(processId, normalizedUpdate) !== undefined;
  }

  exitProcess(processId: ProcessId, details: SessionProcessExit = {}): boolean {
    if (!this.registry.isActive) {
      return true;
    }
    return this.registry.exit(processId, details) !== undefined;
  }

  removeProcess(processId: ProcessId, subtree: boolean = true): boolean {
    if (!this.registry.isActive) {
      return true;
    }
    const removed = this.registry.remove(processId, subtree);
    return removed.length > 0 || !this.registry.has(processId);
  }
}

/** A safe no-op sink used when no live session transport is available. */
export const NOOP_SESSION_PROCESS_LIFECYCLE_SINK: SessionProcessLifecycleSink = {
  registerProcess: () => true,
  updateProcess: () => true,
  exitProcess: () => true,
  removeProcess: () => true,
};
