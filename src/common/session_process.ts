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

declare const processIdBrand: unique symbol;

/** An opaque, session-scoped process ID. It must not be treated as an OS PID. */
export type ProcessId = string & { readonly [processIdBrand]: true };

export type SessionProcessKind = 'tim' | 'executor';

export type SessionProcessState = 'starting' | 'running' | 'exited' | 'orphaned';

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
  private readonly listeners = new Set<SessionProcessListener>();
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
    for (const processId of this.nodes.keys()) {
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
    if (!this.active) {
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
    if (!this.active) {
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
    return (
      (registration.processId === undefined || isProcessId(registration.processId)) &&
      (registration.parentProcessId === undefined || isProcessId(registration.parentProcessId)) &&
      (registration.ownerProcessId === undefined || isProcessId(registration.ownerProcessId)) &&
      (registration.kind === 'tim' || registration.kind === 'executor') &&
      isNonEmptyString(registration.label, MAX_PROCESS_LABEL_LENGTH) &&
      (registration.pid === undefined || isValidPid(registration.pid)) &&
      (registration.command === undefined || typeof registration.command === 'string') &&
      (registration.startIdentity === undefined ||
        typeof registration.startIdentity === 'string') &&
      (registration.startedAt === undefined || isNonEmptyString(registration.startedAt)) &&
      (registration.state === undefined ||
        registration.state === 'starting' ||
        registration.state === 'running')
    );
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
