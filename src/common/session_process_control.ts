import { AsyncLocalStorage } from 'node:async_hooks';
import { listProcesses, type ProcessInfo } from './process_listing.js';
import {
  createChildSessionProcessEnvironment,
  createProcessId,
  readSessionProcessEnvironment,
  normalizeSessionProcessCommand,
  NOOP_SESSION_PROCESS_LIFECYCLE_SINK,
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  type ProcessId,
  type SessionProcessExit,
  type SessionProcessControl,
  type SessionProcessLifecycleSink,
  type SessionProcessRegistry,
  type SessionProcessRegistration,
  type SessionProcessTerminationResult,
  type SessionProcessUpdate,
} from './session_process.js';

/** A process handle with the only operation an owner is allowed to perform. */
export interface SessionChildProcessHandle {
  readonly pid: number;
  kill: (signal?: NodeJS.Signals) => void;
}

export type { SessionProcessTerminationResult } from './session_process.js';

export interface SessionProcessOwnerOptions {
  sessionId: string;
  ownerProcessId: ProcessId;
  lifecycleSink?: SessionProcessLifecycleSink;
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
  control?: Exclude<SessionProcessControl, 'end'>;
}

export interface SessionExecutorLifecycle {
  readonly processId: ProcessId;
  /** Only the explicit process-control variables are returned to the child. */
  readonly environment: Record<string, string>;
  setGracefulEndHandler(handler: (() => void) | undefined): void;
  updateMetadata(update: SessionProcessUpdate): void;
  markSpawned(handle: SessionChildProcessHandle): void;
  markSpawnFailed(): void;
  markExited(details?: { exitCode?: number | null; signal?: NodeJS.Signals | null }): void;
}

export interface PrepareLogicalSessionExecutorOptions {
  label: string;
  command?: string;
  threadId?: string;
}

export interface SessionLogicalExecutorLifecycle {
  readonly processId: ProcessId;
  setGracefulEndHandler(handler: (() => void) | undefined): void;
  updateMetadata(update: SessionProcessUpdate): void;
  markStarted(): void;
  markExited(details?: { exitCode?: number | null; signal?: NodeJS.Signals | null }): void;
}

interface TrackedExecutor extends SessionExecutorLifecycle {
  readonly label: string;
  /** Full producer command used only for the owner-side identity comparison. */
  readonly expectedCommand?: string;
  readonly control: SessionProcessControl;
  handle?: SessionChildProcessHandle;
  pid?: number;
  /** Full command captured from the process list; never use a display value here. */
  capturedCommand?: string;
  startIdentity?: string;
  processInfoCaptured: boolean;
  finished: boolean;
  terminationRequested: boolean;
  endRequested: boolean;
  gracefulEndHandler?: () => void;
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
): SessionProcessExit {
  return {
    ...(details?.exitCode !== undefined ? { exitCode: details.exitCode } : {}),
    ...(details?.signal ? { signal: details.signal } : {}),
  };
}

/**
 * Owns only the direct executor children of one tim process.
 *
 * The lifecycle sink receives domain events. The direct-child map is
 * deliberately separate: it is the capability which prevents a control
 * request from becoming an arbitrary PID signal API.
 */
export class SessionProcessOwner {
  private readonly children = new Map<ProcessId, TrackedExecutor>();
  private readonly processLister: () => ProcessInfo[];
  private readonly now: () => Date;
  private readonly onTerminationResult?: SessionProcessOwnerOptions['onTerminationResult'];
  readonly lifecycleSink: SessionProcessLifecycleSink;
  private disposed = false;

  readonly sessionId: string;
  readonly ownerProcessId: ProcessId;

  constructor(options: SessionProcessOwnerOptions) {
    this.sessionId = options.sessionId;
    this.ownerProcessId = options.ownerProcessId;
    this.lifecycleSink = options.lifecycleSink ?? NOOP_SESSION_PROCESS_LIFECYCLE_SINK;
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
    const registration: SessionProcessRegistration = {
      processId,
      parentProcessId: this.ownerProcessId,
      ownerProcessId: this.ownerProcessId,
      kind: 'executor',
      label: options.label,
      command: normalizeSessionProcessCommand(options.command),
      ...(options.control ? { control: options.control } : {}),
      startedAt: this.now().toISOString(),
      state: 'starting',
    };

    if (!this.lifecycleSink.registerProcess(registration)) {
      return undefined;
    }

    let childEnvironment: ReturnType<typeof createChildSessionProcessEnvironment>;
    try {
      childEnvironment = createChildSessionProcessEnvironment(process.env, {
        sessionId: this.sessionId,
        parentProcessId: this.ownerProcessId,
        ownerProcessId: this.ownerProcessId,
        processId,
      });
    } catch (error) {
      this.lifecycleSink.removeProcess(processId, true);
      throw error;
    }
    const tracked: TrackedExecutor = {
      processId,
      environment: processControlEnvironment(childEnvironment.env),
      label: options.label,
      expectedCommand: options.command,
      control: options.control ?? 'terminate',
      processInfoCaptured: false,
      finished: false,
      terminationRequested: false,
      endRequested: false,
      setGracefulEndHandler: (handler) => this.setGracefulEndHandler(tracked, handler),
      updateMetadata: (update) => this.updateMetadata(tracked, update),
      markSpawned: (handle) => this.markSpawned(tracked, handle),
      markSpawnFailed: () => this.markExited(tracked),
      markExited: (details) => this.markExited(tracked, details),
    };
    this.children.set(processId, tracked);
    return tracked;
  }

  /** Registers an executor represented by a logical provider session rather than an OS child. */
  prepareLogicalExecutor(
    options: PrepareLogicalSessionExecutorOptions
  ): SessionLogicalExecutorLifecycle | undefined {
    if (this.disposed || !options.label.trim()) {
      return undefined;
    }

    const processId = createProcessId();
    const registration: SessionProcessRegistration = {
      processId,
      parentProcessId: this.ownerProcessId,
      ownerProcessId: this.ownerProcessId,
      kind: 'executor',
      label: options.label,
      control: 'end',
      ...(options.threadId ? { threadId: options.threadId } : {}),
      ...(options.command ? { command: normalizeSessionProcessCommand(options.command) } : {}),
      startedAt: this.now().toISOString(),
      state: 'starting',
    };

    if (!this.lifecycleSink.registerProcess(registration)) {
      return undefined;
    }

    const tracked: TrackedExecutor = {
      processId,
      environment: {},
      label: options.label,
      expectedCommand: options.command,
      control: 'end',
      processInfoCaptured: false,
      finished: false,
      terminationRequested: false,
      endRequested: false,
      setGracefulEndHandler: (handler) => this.setGracefulEndHandler(tracked, handler),
      updateMetadata: (update) => this.updateMetadata(tracked, update),
      markSpawned: () => {},
      markSpawnFailed: () => this.markExited(tracked),
      markExited: (details) => this.markExited(tracked, details),
    };
    this.children.set(processId, tracked);

    return {
      processId,
      setGracefulEndHandler: (handler) => this.setGracefulEndHandler(tracked, handler),
      updateMetadata: (update) => this.updateMetadata(tracked, update),
      markStarted: () => {
        if (!tracked.finished) {
          this.lifecycleSink.updateProcess(processId, { state: 'running' });
        }
      },
      markExited: (details) => this.markExited(tracked, details),
    };
  }

  /** Handles one server-routed control request for this owner. */
  terminateExecutor(executorId: ProcessId): SessionProcessTerminationResult {
    const tracked = this.children.get(executorId);
    if (this.disposed || !tracked || tracked.finished) {
      return this.reportTermination(executorId, 'not_owned');
    }

    return this.terminateTrackedExecutor(tracked);
  }

  /** Handles one graceful end request for an owned executor. */
  endExecutor(executorId: ProcessId): SessionProcessTerminationResult {
    const tracked = this.children.get(executorId);
    if (this.disposed || !tracked || tracked.finished) {
      return this.reportTermination(executorId, 'not_owned');
    }
    if ((tracked.control !== 'end' && tracked.control !== 'both') || !tracked.gracefulEndHandler) {
      return this.reportTermination(executorId, 'end_not_supported');
    }
    if (tracked.endRequested) {
      return this.reportTermination(executorId, 'ended');
    }

    try {
      tracked.endRequested = true;
      tracked.gracefulEndHandler();
      return this.reportTermination(executorId, 'ended');
    } catch (error) {
      tracked.endRequested = false;
      return this.reportTermination(executorId, 'end_failed', error);
    }
  }

  private terminateTrackedExecutor(tracked: TrackedExecutor): SessionProcessTerminationResult {
    if (
      !tracked.handle ||
      tracked.pid === undefined ||
      !tracked.processInfoCaptured ||
      !tracked.startIdentity ||
      !tracked.capturedCommand
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
      current.command !== tracked.capturedCommand ||
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
      } else if (tracked.gracefulEndHandler) {
        this.endExecutor(tracked.processId);
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
    this.lifecycleSink.exitProcess(this.ownerProcessId, details);
  }

  private setGracefulEndHandler(tracked: TrackedExecutor, handler: (() => void) | undefined): void {
    if (!tracked.finished) {
      tracked.gracefulEndHandler = handler;
    }
  }

  private updateMetadata(tracked: TrackedExecutor, update: SessionProcessUpdate): void {
    if (!tracked.finished) {
      this.lifecycleSink.updateProcess(tracked.processId, update);
    }
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
      tracked.capturedCommand = processInfo.command;
      tracked.startIdentity = processInfo.startTime;
      tracked.processInfoCaptured = true;
    }

    const update: SessionProcessUpdate = {
      pid: tracked.pid,
      command: normalizeSessionProcessCommand(
        tracked.capturedCommand ?? tracked.expectedCommand ?? ''
      ),
      state: 'running',
      ...(tracked.startIdentity ? { startIdentity: tracked.startIdentity } : {}),
    };
    this.lifecycleSink.updateProcess(tracked.processId, update);

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
    this.lifecycleSink.exitProcess(tracked.processId, exit);
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
  lifecycleSink: SessionProcessLifecycleSink,
  label: string,
  onTerminationResult?: SessionProcessOwnerOptions['onTerminationResult']
): NestedTimProcessRuntime | undefined {
  const inherited = readSessionProcessEnvironment();
  if (!inherited?.ownerProcessId) {
    return undefined;
  }

  const processId = createProcessId();
  const registration: SessionProcessRegistration = {
    processId,
    parentProcessId: inherited.processId,
    ownerProcessId: inherited.processId,
    kind: 'tim',
    label: label.trim() || 'tim',
    startedAt: new Date().toISOString(),
    state: 'running',
  };
  if (!lifecycleSink.registerProcess(registration)) {
    return undefined;
  }

  let childEnvironment: ReturnType<typeof createChildSessionProcessEnvironment>;
  try {
    childEnvironment = createChildSessionProcessEnvironment(process.env, {
      sessionId: inherited.sessionId,
      parentProcessId: inherited.processId,
      ownerProcessId: inherited.processId,
      processId,
    });
  } catch (error) {
    lifecycleSink.removeProcess(processId, true);
    throw error;
  }
  const owner = new SessionProcessOwner({
    sessionId: inherited.sessionId,
    ownerProcessId: processId,
    lifecycleSink,
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
  return ownerStorage.getStore()?.lifecycleSink.registry;
}

export function runWithSessionProcessOwner<T>(
  owner: SessionProcessOwner,
  callback: () => Promise<T>
): Promise<T> {
  return ownerStorage.run(owner, callback);
}

export function createExecutorControlHandler(
  owner: SessionProcessOwner
): (message: {
  executorId: ProcessId;
  action?: 'terminate' | 'end';
}) => SessionProcessTerminationResult {
  return (message) => {
    return message.action === 'end'
      ? owner.endExecutor(message.executorId)
      : owner.terminateExecutor(message.executorId);
  };
}
