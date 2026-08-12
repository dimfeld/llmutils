import type { LoggerAdapter } from './adapter.js';
import { ConsoleAdapter } from './console.js';
import type {
  HeadlessOutputMessage,
  HeadlessPlanContentMessage,
  HeadlessPlanTask,
  HeadlessPtyOutputMessage,
  HeadlessServerMessage,
  HeadlessSessionInfo,
} from './headless_protocol.js';
import { serializeArgs } from './tunnel_protocol.js';
import type { TunnelMessage, WriteOptions } from './tunnel_protocol.js';
import { debug } from '../common/process_state.js';
import {
  registerSessionProcessOwner,
  SessionProcessOwner,
  unregisterSessionProcessOwner,
  type SessionProcessTerminationResult,
} from '../common/session_process_control.js';
import {
  createProcessId,
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  type ProcessId,
  type SessionProcessControlOperation,
  type SessionProcessChange,
} from '../common/session_process.js';
import type { StructuredMessage } from './structured_messages.js';
import {
  startEmbeddedServer,
  type EmbeddedServerHandle,
} from '../tim/session_server/embedded_server.js';
import {
  writeSessionInfoFile,
  removeSessionInfoFile,
  type SessionInfoFile,
} from '../tim/session_server/runtime_dir.js';

interface HistoryEntry {
  payload: string;
  outputBytes: number;
}

interface HeadlessAdapterOptions {
  maxBufferBytes?: number;
  maxPtyBufferBytes?: number;
  serverPort?: number;
  serverHostname?: string;
  bearerToken?: string;
  /**
   * Invoked exactly once when the adapter is torn down (via `destroy()` or
   * `destroySync()`). Used to record the end of a tracked session/job. Errors
   * thrown by the hook are swallowed so teardown is never blocked.
   */
  onDestroy?: () => void;
}

/** Pending prompt request entry tracked by the HeadlessAdapter. */
interface PendingPromptRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PTY_BUFFER_BYTES = 512 * 1024;

export class HeadlessAdapter implements LoggerAdapter {
  private sessionInfo: HeadlessSessionInfo;
  private readonly wrappedAdapter: LoggerAdapter;
  private readonly maxBufferBytes: number;
  private readonly maxPtyBufferBytes: number;
  private readonly bearerToken?: string;
  private readonly serverHostname?: string;
  private readonly serverSessionId?: string;
  private readonly serverStartedAt?: string;
  private readonly onDestroy?: () => void;
  private readonly agentName: string;
  private readonly processRegistry?: SessionProcessRegistry;
  private readonly processOwner?: SessionProcessOwner;
  private readonly processEnvironmentBefore: Record<string, string | undefined> = {};
  private sessionInfoFilePath?: string;
  private processRegistryUnsubscribe?: () => void;
  private processTerminationResultUnsubscribe?: () => void;
  private destroyHookFired = false;

  private sessionServer: EmbeddedServerHandle | undefined;
  private history: HistoryEntry[] = [];
  private historyOutputBytes = 0;
  private ptyBuffer: Uint8Array[] = [];
  private ptyBufferBytes = 0;
  private destroyed = false;
  private nextOutputSequence = 1;
  private latestPlanContent: string | null = null;
  private latestPlanTasks: HeadlessPlanTask[] = [];
  private pendingPrompts: Map<string, PendingPromptRequest> = new Map();
  private userInputHandler?: (content: string) => void;
  private ptyInputHandler?: (bytes: Uint8Array) => void;
  private ptyResizeHandler?: (cols: number, rows: number) => void;
  private endSessionHandler?: () => void;
  private forceEndSessionHandler?: () => void;
  private hasBrowserNotificationSubscribers = false;
  private readonly pendingTerminationRequests = new Map<
    string,
    {
      connectionId: string;
      executorId: ProcessId;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    sessionInfo: HeadlessSessionInfo,
    wrappedAdapter: LoggerAdapter = new ConsoleAdapter(),
    options?: HeadlessAdapterOptions
  ) {
    this.sessionInfo = sessionInfo;
    this.wrappedAdapter = wrappedAdapter;
    this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxPtyBufferBytes = options?.maxPtyBufferBytes ?? DEFAULT_MAX_PTY_BUFFER_BYTES;
    this.bearerToken = options?.bearerToken;
    this.serverHostname = options?.serverHostname;
    this.onDestroy = options?.onDestroy;
    this.agentName = process.env.TIM_AGENT_NAME ?? 'orchestrator';

    if (options && 'serverPort' in options && options.serverPort != null) {
      this.serverSessionId = crypto.randomUUID();
      this.serverStartedAt = new Date().toISOString();
      this.processRegistry = new SessionProcessRegistry({ sessionId: this.serverSessionId });
      const rootProcessId = createProcessId();
      this.processRegistry.register({
        processId: rootProcessId,
        kind: 'tim',
        label: `tim ${sessionInfo.command}`,
        pid: process.pid,
        command: process.argv.join(' '),
        startedAt: this.serverStartedAt,
        state: 'running',
      });
      this.processOwner = new SessionProcessOwner({
        sessionId: this.serverSessionId,
        ownerProcessId: rootProcessId,
        lifecycleSink: new SessionProcessRegistryLifecycleSink(this.processRegistry),
        onTerminationResult: (executorId, result, error) => {
          if (
            result === 'signal_failed' ||
            result === 'unknown_process_state' ||
            result === 'end_failed' ||
            result === 'end_not_supported'
          ) {
            const detail = error instanceof Error ? `: ${error.message}` : '';
            this.wrappedAdapter.warn(`Could not control executor ${executorId}${detail}`);
          }
        },
      });
      this.setRootProcessEnvironment(this.serverSessionId, rootProcessId);
      this.processRegistryUnsubscribe = this.processRegistry.subscribe((change) => {
        this.broadcastProcessTreeUpdate();
        this.handleProcessRegistryChange(change);
      });
      this.processTerminationResultUnsubscribe = this.processRegistry.subscribeTerminationResults(
        (event) => {
          this.handleProcessTerminationResult(event);
        }
      );
      registerSessionProcessOwner(this, this.processOwner);
      try {
        this.sessionServer = startEmbeddedServer({
          port: options.serverPort,
          hostname: options.serverHostname,
          bearerToken: options.bearerToken,
          onConnect: (connectionId) => this.sendReplayToServerClient(connectionId),
          onMessage: (connectionId, message) => this.handleServerMessage(connectionId, message),
          onDisconnect: (connectionId) => {
            this.clearPendingTerminationRequests(connectionId);
            if (!this.hasConnectedClients()) {
              this.hasBrowserNotificationSubscribers = false;
            }
          },
        });
        this.writeSessionInfoFile();
      } catch (error) {
        try {
          this.stopSessionServer();
        } finally {
          this.disposeProcessTracking();
        }
        throw error;
      }
    }
  }

  log(...args: any[]): void {
    this.wrappedAdapter.log(...args);
    this.enqueueTunnelMessage({
      type: 'log',
      args: serializeArgs(args),
      agentName: this.agentName,
    });
  }

  error(...args: any[]): void {
    this.wrappedAdapter.error(...args);
    this.enqueueTunnelMessage({
      type: 'error',
      args: serializeArgs(args),
      agentName: this.agentName,
    });
  }

  warn(...args: any[]): void {
    this.wrappedAdapter.warn(...args);
    this.enqueueTunnelMessage({
      type: 'warn',
      args: serializeArgs(args),
      agentName: this.agentName,
    });
  }

  writeStdout(data: string, options?: WriteOptions): void {
    this.wrappedAdapter.writeStdout(data, options);
    this.enqueueTunnelMessage({
      type: 'stdout',
      data,
      origin: options?.origin,
      agentName: this.agentName,
    });
  }

  writeStderr(data: string, options?: WriteOptions): void {
    this.wrappedAdapter.writeStderr(data, options);
    this.enqueueTunnelMessage({
      type: 'stderr',
      data,
      origin: options?.origin,
      agentName: this.agentName,
    });
  }

  debugLog(...args: any[]): void {
    this.wrappedAdapter.debugLog(...args);
    if (!debug) {
      return;
    }

    this.enqueueTunnelMessage({
      type: 'debug',
      args: serializeArgs(args),
      agentName: this.agentName,
    });
  }

  sendStructured(message: StructuredMessage): void {
    this.wrappedAdapter.sendStructured(message);
    this.enqueueTunnelMessage({ type: 'structured', message, agentName: this.agentName });
  }

  sendPlanContent(content: string, tasks: HeadlessPlanTask[] = []): void {
    this.latestPlanContent = content;
    this.latestPlanTasks = tasks;
    if (this.destroyed || !this.sessionServer) {
      return;
    }

    const message: HeadlessPlanContentMessage = {
      type: 'plan_content',
      content,
      tasks,
    };
    this.sessionServer.broadcast(message);
  }

  broadcastPtyOutput(bytes: Uint8Array): void {
    if (this.destroyed) {
      return;
    }

    const storedBytes = new Uint8Array(bytes);
    this.enqueuePtyBytes(storedBytes);

    const message = this.ptyOutputFrame(bytes);
    this.sessionServer?.broadcastRaw(JSON.stringify(message));
  }

  destroySync(): void {
    this.destroyed = true;
    this.rejectAllPending();
    this.terminateAllRegisteredExecutors();
    this.disposeProcessTracking();
    this.stopSessionServer();
    this.fireDestroyHook();
  }

  private fireDestroyHook(): void {
    if (this.destroyHookFired || !this.onDestroy) {
      return;
    }
    this.destroyHookFired = true;
    try {
      this.onDestroy();
    } catch (err) {
      this.wrappedAdapter.warn(`Headless destroy hook error: ${err as Error}`);
    }
  }

  updateSessionInfo(patch: Partial<HeadlessSessionInfo>): void {
    Object.assign(this.sessionInfo, patch);
    this.broadcastSessionInfo();
    this.writeSessionInfoFile();
  }

  hasConnectedClients(): boolean {
    return (this.sessionServer?.connectedClients.size ?? 0) > 0;
  }

  hasNotificationSubscribers(): boolean {
    return this.hasBrowserNotificationSubscribers;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.rejectAllPending();
    this.terminateAllRegisteredExecutors();

    const sessionServer = this.sessionServer;
    if (sessionServer && this.hasConnectedClients()) {
      sessionServer.broadcast({ type: 'session_ended' });
      await sessionServer.drain();
    }

    this.disposeProcessTracking();
    this.stopSessionServer();
    this.fireDestroyHook();
  }

  /** Returns the local authoritative process registry for this root session. */
  getProcessRegistry(): SessionProcessRegistry | undefined {
    return this.processRegistry;
  }

  /** Routes a targeted control request to a direct executor child. */
  terminateExecutor(executorId: ProcessId): SessionProcessTerminationResult {
    const result = this.routeExecutorControl(executorId, 'terminate');
    return result === 'pending' ? 'requested' : result;
  }

  /** Routes a graceful end request to one live executor. */
  endExecutor(executorId: ProcessId): SessionProcessTerminationResult {
    const result = this.routeExecutorControl(executorId, 'end');
    return result === 'pending' ? 'requested' : result;
  }

  /**
   * Handles an incoming server→client message from the websocket.
   */
  private handleServerMessage(connectionId: string, message: HeadlessServerMessage): void {
    switch (message.type) {
      case 'prompt_response': {
        const pending = this.pendingPrompts.get(message.requestId);
        if (!pending) {
          return;
        }
        if (message.error) {
          this.wrappedAdapter.warn(
            `Headless prompt error for ${message.requestId}: ${message.error}`
          );
          this.pendingPrompts.delete(message.requestId);
          pending.reject(new Error(message.error));
          return;
        }
        this.pendingPrompts.delete(message.requestId);
        pending.resolve(message.value);
        break;
      }
      case 'user_input':
        this.sendStructured({
          type: 'user_terminal_input',
          content: message.content,
          source: 'gui',
          timestamp: new Date().toISOString(),
        });
        try {
          this.userInputHandler?.(message.content);
        } catch (err) {
          this.wrappedAdapter.warn(`Headless user input handler error: ${err as Error}`);
        }
        break;
      case 'pty_input':
        try {
          this.ptyInputHandler?.(Buffer.from(message.data, 'base64'));
        } catch (err) {
          this.wrappedAdapter.warn(`Headless PTY input handler error: ${err as Error}`);
        }
        break;
      case 'pty_resize':
        try {
          this.ptyResizeHandler?.(message.cols, message.rows);
        } catch (err) {
          this.wrappedAdapter.warn(`Headless PTY resize handler error: ${err as Error}`);
        }
        break;
      case 'end_session':
        this.rejectAllPending('Session ended');
        try {
          this.endSessionHandler?.();
        } catch (err) {
          this.wrappedAdapter.warn(`Headless end session handler error: ${err as Error}`);
        }
        break;
      case 'force_end_session':
        this.rejectAllPending('Session force ended');
        this.terminateAllRegisteredExecutors();
        try {
          this.forceEndSessionHandler?.();
        } catch (err) {
          this.wrappedAdapter.warn(`Headless force end session handler error: ${err as Error}`);
        }
        break;
      case 'notification_subscribers_changed':
        this.hasBrowserNotificationSubscribers = message.hasSubscribers;
        break;
      case 'terminate_executor': {
        const result = this.requestExecutorTermination(
          connectionId,
          message.executorId,
          message.requestId,
          message.action ?? 'terminate'
        );
        if (result !== 'pending') {
          this.sendExecutorTerminationResult(
            connectionId,
            message.requestId,
            message.executorId,
            result
          );
        }
        break;
      }
    }
  }

  setUserInputHandler(callback: ((content: string) => void) | undefined): void {
    this.userInputHandler = callback;
  }

  setPtyInputHandler(callback: ((bytes: Uint8Array) => void) | undefined): void {
    this.ptyInputHandler = callback;
  }

  setPtyResizeHandler(callback: ((cols: number, rows: number) => void) | undefined): void {
    this.ptyResizeHandler = callback;
  }

  setEndSessionHandler(callback: (() => void) | undefined): void {
    this.endSessionHandler = callback;
  }

  setForceEndSessionHandler(callback: (() => void) | undefined): void {
    this.forceEndSessionHandler = callback;
  }

  private requestExecutorTermination(
    connectionId: string,
    executorId: ProcessId,
    requestId: string,
    operation: SessionProcessControlOperation
  ): SessionProcessTerminationResult | 'pending' {
    const existing = this.pendingTerminationRequests.get(requestId);
    if (existing) {
      return existing.connectionId === connectionId && existing.executorId === executorId
        ? 'pending'
        : 'send_failed';
    }

    const result = this.routeExecutorControl(executorId, operation, requestId, () => {
      const timer = setTimeout(() => {
        const pending = this.pendingTerminationRequests.get(requestId);
        if (!pending || pending.executorId !== executorId) {
          return;
        }
        this.pendingTerminationRequests.delete(requestId);
        this.sendExecutorTerminationResult(
          pending.connectionId,
          requestId,
          executorId,
          'request_timeout'
        );
      }, 10_000);
      timer.unref?.();
      this.pendingTerminationRequests.set(requestId, { connectionId, executorId, timer });
    });

    if (result !== 'pending') {
      const pending = this.pendingTerminationRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingTerminationRequests.delete(requestId);
      }
    }
    return result;
  }

  /** Validates one target, then performs local termination or remote owner routing. */
  private routeExecutorControl(
    executorId: ProcessId,
    operation: SessionProcessControlOperation,
    requestId?: string,
    prepareRemoteRoute?: () => void
  ): SessionProcessTerminationResult | 'pending' {
    const registry = this.processRegistry;
    if (!registry) {
      return 'unknown_executor';
    }

    const executor = registry.get(executorId);
    if (!executor) {
      return 'unknown_executor';
    }
    if (executor.kind !== 'executor') {
      return 'not_executor';
    }
    if (executor.state === 'exited' || executor.state === 'orphaned') {
      return 'stale_target';
    }

    const processOwner = this.processOwner;
    if (processOwner && executor.ownerProcessId === processOwner.ownerProcessId) {
      return operation === 'end'
        ? processOwner.endExecutor(executorId)
        : processOwner.terminateExecutor(executorId);
    }

    if (!executor.ownerProcessId || !registry.get(executor.ownerProcessId)) {
      return 'owner_not_registered';
    }

    prepareRemoteRoute?.();
    const route =
      operation === 'end'
        ? registry.sendEndToOwner(executorId, requestId)
        : registry.sendTerminationToOwner(executorId, requestId);
    if (route === 'sent') {
      return requestId ? 'pending' : 'requested';
    }
    return route;
  }

  private clearPendingTerminationRequests(connectionId?: string): void {
    for (const [requestId, pending] of this.pendingTerminationRequests) {
      if (connectionId !== undefined && pending.connectionId !== connectionId) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingTerminationRequests.delete(requestId);
    }
  }

  private sendExecutorTerminationResult(
    connectionId: string,
    requestId: string,
    executorId: ProcessId,
    result: SessionProcessTerminationResult,
    error?: string
  ): void {
    this.sessionServer?.sendTo(connectionId, {
      type: 'executor_termination_result',
      requestId,
      executorId,
      result,
      ...(error ? { error } : {}),
    });
  }

  private handleProcessTerminationResult(event: {
    executorId: ProcessId;
    requestId: string;
    result: SessionProcessTerminationResult;
    error?: string;
  }): void {
    if (!this.pendingTerminationRequests.has(event.requestId)) {
      return;
    }

    const pending = this.pendingTerminationRequests.get(event.requestId);
    if (!pending || pending.executorId !== event.executorId) {
      return;
    }

    this.completePendingTermination(event.requestId, event.result, event.error);
  }

  private handleProcessRegistryChange(change: SessionProcessChange): void {
    if (change.type === 'exited') {
      this.completePendingTerminationForExecutor(change.node.processId, 'already_exited');
      for (const processId of change.orphanedProcessIds) {
        this.completePendingTerminationForExecutor(processId, 'owner_not_connected');
      }
      return;
    }

    if (change.type === 'owner_lost') {
      for (const processId of change.processIds) {
        this.completePendingTerminationForExecutor(processId, 'owner_not_connected');
      }
      return;
    }

    if (change.type === 'removed') {
      for (const processId of change.processIds) {
        this.completePendingTerminationForExecutor(processId, 'unknown_executor');
      }
    }
  }

  private completePendingTerminationForExecutor(
    executorId: ProcessId,
    result: SessionProcessTerminationResult
  ): void {
    for (const [requestId, pending] of this.pendingTerminationRequests) {
      if (pending.executorId === executorId) {
        this.completePendingTermination(requestId, result);
      }
    }
  }

  private completePendingTermination(
    requestId: string,
    result: SessionProcessTerminationResult,
    error?: string
  ): void {
    const pending = this.pendingTerminationRequests.get(requestId);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTerminationRequests.delete(requestId);
    this.sendExecutorTerminationResult(
      pending.connectionId,
      requestId,
      pending.executorId,
      result,
      error
    );
  }

  /** Requests termination from every currently registered executor owner. */
  private terminateAllRegisteredExecutors(): void {
    const registry = this.processRegistry;
    if (!registry) {
      return;
    }

    for (const node of registry.getSnapshot()) {
      if (node.kind !== 'executor' || node.state === 'exited' || node.state === 'orphaned') {
        continue;
      }

      const result =
        node.control === 'end'
          ? this.endExecutor(node.processId)
          : this.terminateExecutor(node.processId);
      if (
        result === 'signal_failed' ||
        result === 'unknown_process_state' ||
        result === 'end_failed' ||
        result === 'end_not_supported' ||
        result === 'owner_not_connected' ||
        result === 'send_failed'
      ) {
        this.wrappedAdapter.warn(`Could not control executor ${node.processId}: ${result}`);
      }
    }
  }

  waitForPromptResponse(requestId: string): { promise: Promise<unknown>; cancel: () => void } {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const pending: PendingPromptRequest = { resolve, reject };
    this.pendingPrompts.set(requestId, pending);

    const cancel = () => {
      if (this.pendingPrompts.get(requestId) !== pending) return;
      this.pendingPrompts.delete(requestId);
      reject(new Error('Prompt cancelled'));
    };

    return { promise, cancel };
  }

  private rejectAllPending(reason = 'HeadlessAdapter destroyed'): void {
    const error = new Error(reason);
    for (const [requestId, pending] of this.pendingPrompts) {
      pending.reject(error);
      this.pendingPrompts.delete(requestId);
    }
  }

  private enqueueTunnelMessage(message: TunnelMessage): void {
    if (this.destroyed) {
      return;
    }

    const envelope: HeadlessOutputMessage = {
      type: 'output',
      seq: this.nextOutputSequence,
      message,
    };
    this.nextOutputSequence += 1;

    let payload: string;
    try {
      payload = JSON.stringify(envelope);
    } catch (err) {
      this.wrappedAdapter.error('Failed to serialize headless tunnel message:', err as Error);
      return;
    }

    this.enqueueOutputPayload(payload);
    this.sessionServer?.broadcastRaw(payload);
  }

  private enqueueOutputPayload(payload: string): void {
    const bytes = Buffer.byteLength(payload, 'utf8');
    this.history.push({ payload, outputBytes: bytes });
    this.historyOutputBytes += bytes;
    this.enforceBufferLimit();
  }

  private enforceBufferLimit(): void {
    while (this.historyOutputBytes > this.maxBufferBytes && this.history.length > 0) {
      const dropped = this.history.shift();
      if (!dropped) {
        break;
      }
      this.historyOutputBytes -= dropped.outputBytes;
    }
  }

  private enqueuePtyBytes(bytes: Uint8Array): void {
    if (this.maxPtyBufferBytes <= 0 || bytes.byteLength === 0) {
      return;
    }

    if (bytes.byteLength > this.maxPtyBufferBytes) {
      const start = bytes.byteLength - this.maxPtyBufferBytes;
      const sliced = bytes.slice(start);
      this.ptyBuffer = [sliced];
      this.ptyBufferBytes = sliced.byteLength;
      return;
    }

    this.ptyBuffer.push(bytes);
    this.ptyBufferBytes += bytes.byteLength;
    this.enforcePtyBufferLimit();
  }

  private enforcePtyBufferLimit(): void {
    while (this.ptyBufferBytes > this.maxPtyBufferBytes && this.ptyBuffer.length > 0) {
      const first = this.ptyBuffer[0];
      if (!first) {
        break;
      }
      const bytesToDrop = this.ptyBufferBytes - this.maxPtyBufferBytes;
      if (bytesToDrop >= first.byteLength) {
        this.ptyBuffer.shift();
        this.ptyBufferBytes -= first.byteLength;
        continue;
      }

      this.ptyBuffer[0] = first.slice(bytesToDrop);
      this.ptyBufferBytes -= bytesToDrop;
      break;
    }
  }

  private ptyOutputFrame(bytes: Uint8Array): HeadlessPtyOutputMessage {
    return {
      type: 'pty_output',
      data: Buffer.from(bytes).toString('base64'),
    };
  }

  private sendReplayToServerClient(connectionId: string): void {
    const server = this.sessionServer;
    if (!server) {
      return;
    }

    server.sendTo(connectionId, {
      ...this.sessionInfo,
      type: 'session_info',
      sessionId: this.serverSessionId,
    });
    server.sendTo(connectionId, {
      type: 'process_tree_snapshot',
      processes: this.processRegistry?.getSnapshot() ?? [],
    });
    if (this.sessionInfo.pty) {
      for (const entry of this.ptyBuffer) {
        server.sendTo(connectionId, this.ptyOutputFrame(entry));
      }
      return;
    }

    if (this.latestPlanContent != null) {
      server.sendTo(connectionId, {
        type: 'plan_content',
        content: this.latestPlanContent,
        tasks: this.latestPlanTasks,
      });
    }
    server.sendTo(connectionId, { type: 'replay_start' });
    for (const entry of this.history) {
      server.sendToRaw(connectionId, entry.payload);
    }
    server.sendTo(connectionId, { type: 'replay_end' });
  }

  private broadcastProcessTreeUpdate(): void {
    if (this.destroyed || !this.sessionServer || !this.processRegistry) {
      return;
    }

    this.sessionServer.broadcast({
      type: 'process_tree_update',
      processes: this.processRegistry.getSnapshot(),
    });
  }

  private buildSessionInfoFile(): SessionInfoFile | undefined {
    if (!this.sessionServer || !this.serverSessionId || !this.serverStartedAt) {
      return undefined;
    }

    return {
      sessionId: this.serverSessionId,
      pid: process.pid,
      port: this.sessionServer.port,
      hostname: this.serverHostname,
      command: this.sessionInfo.command,
      workspacePath: this.sessionInfo.workspacePath,
      hidePlanDetails: this.sessionInfo.hidePlanDetails,
      planId: this.sessionInfo.planId,
      planUuid: this.sessionInfo.planUuid,
      planTitle: this.sessionInfo.planTitle,
      linkedPlanId: this.sessionInfo.linkedPlanId,
      linkedPlanUuid: this.sessionInfo.linkedPlanUuid,
      linkedPlanTitle: this.sessionInfo.linkedPlanTitle,
      linkedPrUrl: this.sessionInfo.linkedPrUrl,
      linkedPrNumber: this.sessionInfo.linkedPrNumber,
      linkedPrTitle: this.sessionInfo.linkedPrTitle,
      gitRemote: this.sessionInfo.gitRemote,
      startedAt: this.serverStartedAt,
      token: this.bearerToken ? true : undefined,
    };
  }

  private writeSessionInfoFile(): void {
    const info = this.buildSessionInfoFile();
    if (!info) {
      return;
    }

    this.sessionInfoFilePath = writeSessionInfoFile(info);
  }

  private stopSessionServer(): void {
    if (!this.sessionServer) {
      return;
    }
    this.sessionServer.stop();
    this.sessionServer = undefined;
    removeSessionInfoFile(process.pid, this.sessionInfoFilePath);
  }

  private setRootProcessEnvironment(sessionId: string, processId: ProcessId): void {
    for (const key of [
      TIM_SESSION_ID,
      TIM_PROCESS_ID,
      TIM_PARENT_PROCESS_ID,
      TIM_OWNER_PROCESS_ID,
    ]) {
      this.processEnvironmentBefore[key] = process.env[key];
    }
    process.env[TIM_SESSION_ID] = sessionId;
    process.env[TIM_PROCESS_ID] = processId;
    delete process.env[TIM_PARENT_PROCESS_ID];
    delete process.env[TIM_OWNER_PROCESS_ID];
  }

  private disposeProcessTracking(): void {
    if (!this.processOwner) {
      return;
    }
    this.processRegistryUnsubscribe?.();
    this.processRegistryUnsubscribe = undefined;
    this.processTerminationResultUnsubscribe?.();
    this.processTerminationResultUnsubscribe = undefined;
    this.clearPendingTerminationRequests();
    this.processOwner.dispose();
    unregisterSessionProcessOwner(this);
    for (const key of [
      TIM_SESSION_ID,
      TIM_PROCESS_ID,
      TIM_PARENT_PROCESS_ID,
      TIM_OWNER_PROCESS_ID,
    ]) {
      const value = this.processEnvironmentBefore[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  private broadcastSessionInfo(): void {
    if (!this.sessionServer) {
      return;
    }

    this.sessionServer.broadcast({
      ...this.sessionInfo,
      type: 'session_info',
      sessionId: this.serverSessionId,
    });
  }
}
