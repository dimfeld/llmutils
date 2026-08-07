import { AsyncLocalStorage } from 'node:async_hooks';
import { listProcesses, type ProcessInfo } from './process_listing.js';
import {
  createChildSessionProcessEnvironment,
  createProcessId,
  readSessionProcessEnvironment,
  SessionProcessRegistry,
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  type ProcessId,
  type SessionProcessExit,
  type SessionProcessUpdate,
} from './session_process.js';
import type {
  TunnelProcessExitMessage,
  TunnelProcessRegisterMessage,
  TunnelProcessUpdateMessage,
  TunnelTerminateExecutorMessage,
} from '../logging/tunnel_protocol.js';

/** A process handle with the only operation an owner is allowed to perform. */
export interface SessionChildProcessHandle {
  readonly pid: number;
  kill: (signal?: NodeJS.Signals) => void;
}

/** The lifecycle methods needed by a parent tunnel or local session registry. */
export interface SessionProcessTransport {
  registerProcess(process: Omit<TunnelProcessRegisterMessage, 'type'>): boolean;
  updateProcess(
    processId: ProcessId,
    update: Omit<TunnelProcessUpdateMessage, 'type' | 'processId'>
  ): boolean;
  exitProcess(
    processId: ProcessId,
    details?: Omit<TunnelProcessExitMessage, 'type' | 'processId'>
  ): boolean;
  removeProcess(processId: ProcessId, subtree?: boolean): boolean;
}

export type SessionProcessTerminationResult =
  | 'terminated'
  | 'already_exited'
  | 'not_owned'
  | 'not_executor'
  | 'stale_target'
  | 'unknown_process_state'
  | 'signal_failed';

export interface SessionProcessOwnerOptions {
  sessionId: string;
  ownerProcessId: ProcessId;
  transport?: SessionProcessTransport;
  registry?: SessionProcessRegistry;
  processLister?: () => ProcessInfo[];
  now?: () => Date;
  onTerminationResult?: (
    executorId: ProcessId,
    result: SessionProcessTerminationResult,
    error?: unknown
  ) => void;
}

export interface PrepareSessionExecutorOptions {
  label: string;
  command: string;
}

export interface SessionExecutorLifecycle {
  readonly processId: ProcessId;
  /** Only the explicit process-control variables are returned to the child. */
  readonly environment: Record<string, string>;
  markSpawned(handle: SessionChildProcessHandle): void;
  markSpawnFailed(): void;
  markExited(details?: { exitCode?: number | null; signal?: NodeJS.Signals | null }): void;
}

interface TrackedExecutor extends SessionExecutorLifecycle {
  readonly label: string;
  readonly expectedCommand: string;
  handle?: SessionChildProcessHandle;
  pid?: number;
  command?: string;
  startIdentity?: string;
  processInfoCaptured: boolean;
  finished: boolean;
  terminationRequested: boolean;
}

function isEsrch(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ESRCH'
  );
}

function processControlEnvironment(
  values: Record<string, string | undefined>
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of [TIM_SESSION_ID, TIM_PROCESS_ID, TIM_PARENT_PROCESS_ID, TIM_OWNER_PROCESS_ID]) {
    const value = values[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
}

function exitDetails(
  details: { exitCode?: number | null; signal?: NodeJS.Signals | null } | undefined
): Omit<TunnelProcessExitMessage, 'type' | 'processId'> {
  return {
    ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
    ...(details?.signal ? { signal: details.signal } : {}),
  };
}

/**
 * Owns only the direct executor children of one tim process.
 *
 * The registry or tunnel is the lifecycle event sink. The direct-child map is
 * deliberately separate: it is the capability which prevents a control
 * request from becoming an arbitrary PID signal API.
 */
export class SessionProcessOwner {
  private readonly children = new Map<ProcessId, TrackedExecutor>();
  private readonly processLister: () => ProcessInfo[];
  private readonly now: () => Date;
  private readonly onTerminationResult?: SessionProcessOwnerOptions['onTerminationResult'];
  private disposed = false;

  readonly sessionId: string;
  readonly ownerProcessId: ProcessId;
  readonly transport?: SessionProcessTransport;
  readonly registry?: SessionProcessRegistry;

  constructor(options: SessionProcessOwnerOptions) {
    this.sessionId = options.sessionId;
    this.ownerProcessId = options.ownerProcessId;
    this.transport = options.transport;
    this.registry = options.registry;
    this.processLister = options.processLister ?? listProcesses;
    this.now = options.now ?? (() => new Date());
    this.onTerminationResult = options.onTerminationResult;
  }

  get childCount(): number {
    return this.children.size;
  }

  /** Pre-registers an executor before its OS process is created. */
  prepareExecutor(options: PrepareSessionExecutorOptions): SessionExecutorLifecycle | undefined {
    if (this.disposed || !options.label.trim() || !options.command.trim()) {
      return undefined;
    }

    const processId = createProcessId();
    const registration: Omit<TunnelProcessRegisterMessage, 'type'> = {
      processId,
      parentProcessId: this.ownerProcessId,
      ownerProcessId: this.ownerProcessId,
      kind: 'executor',
      label: options.label,
      command: options.command,
      startedAt: this.now().toISOString(),
      state: 'starting',
    };

    const transportRegistered = this.transport?.registerProcess(registration) ?? true;
    if (!transportRegistered) {
      return undefined;
    }

    const registryNode = this.registry?.register(registration);
    if (this.registry && !registryNode) {
      this.transport?.removeProcess(processId, true);
      return undefined;
    }

    const childEnvironment = createChildSessionProcessEnvironment(process.env, {
      sessionId: this.sessionId,
      parentProcessId: this.ownerProcessId,
      ownerProcessId: this.ownerProcessId,
      processId,
    });
    const tracked: TrackedExecutor = {
      processId,
      environment: processControlEnvironment(childEnvironment.env),
      label: options.label,
      expectedCommand: options.command,
      processInfoCaptured: false,
      finished: false,
      terminationRequested: false,
      markSpawned: (handle) => this.markSpawned(tracked, handle),
      markSpawnFailed: () => this.markExited(tracked),
      markExited: (details) => this.markExited(tracked, details),
    };
    this.children.set(processId, tracked);
    return tracked;
  }

  /** Handles one server-routed control request for this owner. */
  terminateExecutor(executorId: ProcessId): SessionProcessTerminationResult {
    const tracked = this.children.get(executorId);
    if (this.disposed || !tracked || tracked.finished) {
      return this.reportTermination(executorId, 'not_owned');
    }

    return this.terminateTrackedExecutor(tracked);
  }

  private terminateTrackedExecutor(tracked: TrackedExecutor): SessionProcessTerminationResult {
    if (
      !tracked.handle ||
      tracked.pid === undefined ||
      !tracked.processInfoCaptured ||
      !tracked.startIdentity ||
      !tracked.command
    ) {
      return this.reportTermination(tracked.processId, 'unknown_process_state');
    }

    let processInfo: ProcessInfo[];
    try {
      processInfo = this.processLister();
    } catch (error) {
      // A failed process listing is unknown, never permission to signal.
      return this.reportTermination(tracked.processId, 'unknown_process_state', error);
    }

    const current = processInfo.find((candidate) => candidate.pid === tracked.pid);
    if (!current) {
      this.markExited(tracked);
      return this.reportTermination(tracked.processId, 'already_exited');
    }

    if (
      current.ppid !== process.pid ||
      current.command !== tracked.command ||
      current.startTime !== tracked.startIdentity
    ) {
      this.markExited(tracked);
      return this.reportTermination(tracked.processId, 'stale_target');
    }

    if (tracked.terminationRequested) {
      return this.reportTermination(tracked.processId, 'terminated');
    }

    try {
      tracked.handle.kill('SIGTERM');
      tracked.terminationRequested = true;
      return this.reportTermination(tracked.processId, 'terminated');
    } catch (error) {
      if (isEsrch(error)) {
        this.markExited(tracked, { signal: 'SIGTERM' });
        return this.reportTermination(tracked.processId, 'already_exited');
      }
      // Keep the live handle and metadata so a later request can retry.
      return this.reportTermination(tracked.processId, 'signal_failed', error);
    }
  }

  /** Signals all direct live children during owner shutdown, when it is safe. */
  terminateAll(): void {
    for (const tracked of this.children.values()) {
      if (tracked.handle) {
        this.terminateExecutor(tracked.processId);
      }
    }
  }

  /** Completes the owner node and makes future control requests harmless. */
  dispose(details?: SessionProcessExit): void {
    if (this.disposed) {
      return;
    }
    this.terminateAll();
    this.disposed = true;
    this.transport?.exitProcess(this.ownerProcessId, details);
    this.registry?.exit(this.ownerProcessId, details);
  }

  private markSpawned(tracked: TrackedExecutor, handle: SessionChildProcessHandle): void {
    if (tracked.finished) {
      return;
    }

    tracked.handle = handle;
    tracked.pid = handle.pid;
    let processInfo: ProcessInfo | undefined;
    try {
      processInfo = this.processLister().find((candidate) => candidate.pid === handle.pid);
    } catch {
      // Keep the starting metadata. Safe termination will remain unavailable
      // because no birth identity was captured.
    }

    if (processInfo) {
      tracked.command = processInfo.command;
      tracked.startIdentity = processInfo.startTime;
      tracked.processInfoCaptured = true;
    } else {
      tracked.command = tracked.expectedCommand;
    }

    const update: SessionProcessUpdate = {
      pid: tracked.pid,
      command: tracked.command,
      state: 'running',
      ...(tracked.startIdentity ? { startIdentity: tracked.startIdentity } : {}),
    };
    this.transport?.updateProcess(tracked.processId, update);
    this.registry?.update(tracked.processId, update);

    if (this.disposed) {
      this.terminateTrackedExecutor(tracked);
    }
  }

  private markExited(
    tracked: TrackedExecutor,
    details?: { exitCode?: number | null; signal?: NodeJS.Signals | null }
  ): void {
    if (tracked.finished) {
      return;
    }
    tracked.finished = true;
    this.children.delete(tracked.processId);
    const exit = exitDetails(details);
    this.transport?.exitProcess(tracked.processId, exit);
    this.registry?.exit(tracked.processId, exit);
  }

  private reportTermination(
    executorId: ProcessId,
    result: SessionProcessTerminationResult,
    error?: unknown
  ): SessionProcessTerminationResult {
    try {
      this.onTerminationResult?.(executorId, result, error);
    } catch {
      // Diagnostics must not change signal safety or lifecycle behavior.
    }
    return result;
  }
}

export interface NestedTimProcessRuntime {
  readonly processId: ProcessId;
  readonly environment: Record<string, string>;
  readonly owner: SessionProcessOwner;
  dispose(): void;
}

/** Registers a tim process launched by an executor over that executor's tunnel. */
export function createNestedTimProcessRuntime(
  transport: SessionProcessTransport,
  label: string,
  onTerminationResult?: SessionProcessOwnerOptions['onTerminationResult']
): NestedTimProcessRuntime | undefined {
  const inherited = readSessionProcessEnvironment();
  if (!inherited?.ownerProcessId) {
    return undefined;
  }

  const processId = createProcessId();
  const registration: Omit<TunnelProcessRegisterMessage, 'type'> = {
    processId,
    parentProcessId: inherited.processId,
    ownerProcessId: inherited.processId,
    kind: 'tim',
    label: label.trim() || 'tim',
    startedAt: new Date().toISOString(),
    state: 'running',
  };
  if (!transport.registerProcess(registration)) {
    return undefined;
  }

  const childEnvironment = createChildSessionProcessEnvironment(process.env, {
    sessionId: inherited.sessionId,
    parentProcessId: inherited.processId,
    ownerProcessId: inherited.processId,
    processId,
  });
  const owner = new SessionProcessOwner({
    sessionId: inherited.sessionId,
    ownerProcessId: processId,
    transport,
    onTerminationResult,
  });
  const previousEnvironment = processControlEnvironment(process.env);
  const nextEnvironment = processControlEnvironment(childEnvironment.env);
  for (const key of [TIM_SESSION_ID, TIM_PROCESS_ID, TIM_PARENT_PROCESS_ID, TIM_OWNER_PROCESS_ID]) {
    if (nextEnvironment[key] !== undefined) {
      process.env[key] = nextEnvironment[key];
    } else {
      delete process.env[key];
    }
  }

  let disposed = false;
  return {
    processId,
    environment: nextEnvironment,
    owner,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      owner.dispose();
      for (const key of [
        TIM_SESSION_ID,
        TIM_PROCESS_ID,
        TIM_PARENT_PROCESS_ID,
        TIM_OWNER_PROCESS_ID,
      ]) {
        if (previousEnvironment[key] !== undefined) {
          process.env[key] = previousEnvironment[key];
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

const ownerStorage = new AsyncLocalStorage<SessionProcessOwner>();
const ownersByAdapter = new WeakMap<object, SessionProcessOwner>();

export function registerSessionProcessOwner(adapter: object, owner: SessionProcessOwner): void {
  ownersByAdapter.set(adapter, owner);
}

export function unregisterSessionProcessOwner(adapter: object): void {
  ownersByAdapter.delete(adapter);
}

export function getSessionProcessOwnerForAdapter(adapter: object): SessionProcessOwner | undefined {
  return ownersByAdapter.get(adapter);
}

export function getCurrentSessionProcessOwner(): SessionProcessOwner | undefined {
  return ownerStorage.getStore();
}

export function getCurrentSessionProcessRegistry(): SessionProcessRegistry | undefined {
  return ownerStorage.getStore()?.registry;
}

export function runWithSessionProcessOwner<T>(
  owner: SessionProcessOwner,
  callback: () => Promise<T>
): Promise<T> {
  return ownerStorage.run(owner, callback);
}

export function createExecutorControlHandler(
  owner: SessionProcessOwner
): (message: TunnelTerminateExecutorMessage) => void {
  return (message) => {
    owner.terminateExecutor(message.executorId);
  };
}
