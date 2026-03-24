import type { LoggerAdapter } from './adapter.js';
import { ConsoleAdapter } from './console.js';
import type {
  HeadlessMessage,
  HeadlessOutputMessage,
  HeadlessServerMessage,
  HeadlessSessionInfo,
  HeadlessSessionInfoMessage,
} from './headless_protocol.js';
import { parseHeadlessServerMessage } from './headless_message_utils.js';
import { serializeArgs } from './tunnel_protocol.js';
import type { TunnelMessage } from './tunnel_protocol.js';
import { debug } from '../common/process_state.js';
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

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'draining';

interface QueuedMessage {
  payload: string;
  outputBytes: number;
}

interface HeadlessAdapterOptions {
  maxBufferBytes?: number;
  reconnectIntervalMs?: number;
  connectWhenSuppressed?: boolean;
  serverPort?: number;
  serverHostname?: string;
  bearerToken?: string;
}

/** Pending prompt request entry tracked by the HeadlessAdapter. */
interface PendingPromptRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_RECONNECT_INTERVAL_MS = 5000;

export class HeadlessAdapter implements LoggerAdapter {
  private readonly url: string;
  private sessionInfo: HeadlessSessionInfo;
  private readonly wrappedAdapter: LoggerAdapter;
  private readonly maxBufferBytes: number;
  private readonly reconnectIntervalMs: number;
  private readonly connectWhenSuppressed: boolean;
  private readonly bearerToken?: string;
  private readonly serverSessionId?: string;
  private readonly serverStartedAt?: string;

  private state: ConnectionState = 'disconnected';
  private socket: WebSocket | undefined;
  private sessionServer: EmbeddedServerHandle | undefined;
  private queue: QueuedMessage[] = [];
  private history: QueuedMessage[] = [];
  private bufferedOutputBytes: number = 0;
  private historyOutputBytes: number = 0;
  private lastConnectAttemptAt = 0;
  private drainPromise: Promise<void> | undefined;
  private drainGeneration = 0;
  private destroyed = false;
  private nextOutputSequence = 1;
  private pendingPrompts: Map<string, PendingPromptRequest> = new Map();
  private userInputHandler?: (content: string) => void;
  private endSessionHandler?: () => void;

  constructor(
    url: string,
    sessionInfo: HeadlessSessionInfo,
    wrappedAdapter: LoggerAdapter = new ConsoleAdapter(),
    options?: HeadlessAdapterOptions
  ) {
    this.url = url;
    this.sessionInfo = sessionInfo;
    this.wrappedAdapter = wrappedAdapter;
    this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.reconnectIntervalMs = options?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.connectWhenSuppressed = options?.connectWhenSuppressed ?? false;
    this.bearerToken = options?.bearerToken;

    if (options && 'serverPort' in options && options.serverPort != null) {
      this.serverSessionId = crypto.randomUUID();
      this.serverStartedAt = new Date().toISOString();
      this.sessionServer = startEmbeddedServer({
        port: options.serverPort,
        hostname: options.serverHostname,
        bearerToken: options.bearerToken,
        onConnect: (connectionId) => this.sendReplayToServerClient(connectionId),
        onMessage: (_connectionId, message) => this.handleServerMessage(message),
      });
      this.writeSessionInfoFile();
    }
  }

  log(...args: any[]): void {
    this.wrappedAdapter.log(...args);
    this.enqueueTunnelMessage({ type: 'log', args: serializeArgs(args) });
  }

  error(...args: any[]): void {
    this.wrappedAdapter.error(...args);
    this.enqueueTunnelMessage({ type: 'error', args: serializeArgs(args) });
  }

  warn(...args: any[]): void {
    this.wrappedAdapter.warn(...args);
    this.enqueueTunnelMessage({ type: 'warn', args: serializeArgs(args) });
  }

  writeStdout(data: string): void {
    this.wrappedAdapter.writeStdout(data);
    this.enqueueTunnelMessage({ type: 'stdout', data });
  }

  writeStderr(data: string): void {
    this.wrappedAdapter.writeStderr(data);
    this.enqueueTunnelMessage({ type: 'stderr', data });
  }

  debugLog(...args: any[]): void {
    this.wrappedAdapter.debugLog(...args);
    if (!debug) {
      return;
    }

    this.enqueueTunnelMessage({ type: 'debug', args: serializeArgs(args) });
  }

  sendStructured(message: StructuredMessage): void {
    this.wrappedAdapter.sendStructured(message);
    this.enqueueTunnelMessage({ type: 'structured', message });
  }

  destroySync(): void {
    this.destroyed = true;
    this.drainGeneration += 1;
    this.rejectAllPending();
    this.stopSessionServer();

    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    ) {
      try {
        this.socket.close();
      } catch {
        // No-op
      }
    }

    this.socket = undefined;
    this.state = 'disconnected';
  }

  updateSessionInfo(patch: Partial<HeadlessSessionInfo>): void {
    Object.assign(this.sessionInfo, patch);
    this.broadcastSessionInfo();
    this.writeSessionInfoFile();

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const sessionMessage: HeadlessSessionInfoMessage = {
      type: 'session_info',
      ...this.sessionInfo,
    };
    this.enqueueControlPayload(JSON.stringify(sessionMessage as HeadlessMessage));
    this.startDrainLoop();
  }

  async destroy(timeoutMs: number = 2000): Promise<void> {
    this.destroyed = true;
    this.state = 'draining';
    this.rejectAllPending();
    this.stopSessionServer();
    const deadline = Date.now() + timeoutMs;
    const connectWaitMs = Math.max(0, Math.floor(timeoutMs / 2));

    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      await this.waitForSocketConnect(connectWaitMs);
    }

    if (this.socket && this.socket.readyState !== WebSocket.OPEN) {
      try {
        this.socket.close();
      } catch {
        // No-op
      }
    }

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      // If a disconnect happened during draining, handleDisconnect() clears this.socket while
      // preserving state='draining'. In that case we intentionally skip draining and finish cleanup.
      this.startDrainLoop();
      const remainingMs = Math.max(0, deadline - Date.now());
      await this.waitForDrain(remainingMs);
      try {
        this.socket.close();
      } catch {
        // No-op
      }
    }

    this.socket = undefined;
    this.state = 'disconnected';
  }

  /**
   * Handles an incoming server→client message from the websocket.
   */
  private handleServerMessage(message: HeadlessServerMessage): void {
    switch (message.type) {
      case 'prompt_response': {
        const pending = this.pendingPrompts.get(message.requestId);
        if (!pending) {
          // Unknown requestId -- silently ignore (may have already been cancelled)
          return;
        }
        if (message.error) {
          // Error responses are logged and the pending entry is removed, but the promise
          // is NOT rejected -- terminal continues as the fallback input source.
          this.wrappedAdapter.warn(
            `Headless prompt error for ${message.requestId}: ${message.error}`
          );
          this.pendingPrompts.delete(message.requestId);
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
      case 'end_session':
        // Reject any pending prompts so the process doesn't hang waiting for a response.
        this.rejectAllPending('Session ended');
        try {
          this.endSessionHandler?.();
        } catch (err) {
          this.wrappedAdapter.warn(`Headless end session handler error: ${err as Error}`);
        }
        break;
    }
  }

  /**
   * Registers the single active user-input handler.
   * Calling this again replaces the previous handler.
   */
  setUserInputHandler(callback: ((content: string) => void) | undefined): void {
    this.userInputHandler = callback;
  }

  /**
   * Registers the single active end-session handler.
   * Calling this again replaces the previous handler.
   */
  setEndSessionHandler(callback: (() => void) | undefined): void {
    this.endSessionHandler = callback;
  }

  /**
   * Registers a pending prompt and returns a promise that resolves when
   * a matching prompt_response arrives over the websocket.
   *
   * The returned `cancel()` removes the entry and rejects the promise.
   * Callers should add `.catch(() => {})` to the returned promise to
   * suppress unhandled rejections when cancel is called.
   */
  waitForPromptResponse(requestId: string): { promise: Promise<unknown>; cancel: () => void } {
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.pendingPrompts.set(requestId, { resolve, reject });

    const cancel = () => {
      if (this.pendingPrompts.delete(requestId)) {
        reject(new Error('Prompt cancelled'));
      }
    };

    return { promise, cancel };
  }

  /**
   * Rejects all pending prompt requests. Called from destroy()/destroySync()
   * and end_session handling. NOT on websocket disconnect (pending prompts survive disconnects).
   */
  private rejectAllPending(reason = 'HeadlessAdapter destroyed'): void {
    const error = new Error(reason);
    for (const [requestId, pending] of this.pendingPrompts) {
      pending.reject(error);
      this.pendingPrompts.delete(requestId);
    }
  }

  private enqueueTunnelMessage(message: TunnelMessage): void {
    if (this.destroyed && this.state !== 'draining') {
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

    this.maybeConnect();
    this.startDrainLoop();
  }

  private enqueueOutputPayload(payload: string): void {
    const bytes = Buffer.byteLength(payload, 'utf8');
    const entry: QueuedMessage = { payload, outputBytes: bytes };
    this.queue.push(entry);
    this.bufferedOutputBytes += bytes;
    this.history.push(entry);
    this.historyOutputBytes += bytes;
    this.enforceBufferLimit();
  }

  private enqueueControlPayload(payload: string): void {
    this.queue.push({ payload, outputBytes: 0 });
  }

  private enforceBufferLimit(): void {
    if (this.historyOutputBytes <= this.maxBufferBytes) {
      return;
    }

    // queue and history intentionally share the same QueuedMessage object references for
    // output entries so capped-history evictions can remove the matching pending queue entry.
    while (this.historyOutputBytes > this.maxBufferBytes && this.history.length > 0) {
      const dropped = this.history.shift();
      if (!dropped) {
        break;
      }
      this.historyOutputBytes -= dropped.outputBytes;

      const queueIndex = this.queue.findIndex((entry) => entry === dropped);
      if (queueIndex >= 0) {
        const [removed] = this.queue.splice(queueIndex, 1);
        this.bufferedOutputBytes -= removed.outputBytes;
      }
    }
  }

  private maybeConnect(): void {
    if (process.env.TIM_NOTIFY_SUPPRESS_INNER && !this.connectWhenSuppressed) {
      return;
    }

    if (this.destroyed || this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    const now = Date.now();
    if (now - this.lastConnectAttemptAt < this.reconnectIntervalMs) {
      return;
    }

    this.lastConnectAttemptAt = now;
    this.state = 'connecting';

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.state = 'disconnected';
      return;
    }

    this.socket = socket;

    socket.onmessage = (event) => {
      const data =
        typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
      const parsed = parseHeadlessServerMessage(data);
      if (parsed) {
        this.handleServerMessage(parsed);
      }
    };

    socket.onopen = () => {
      if (this.socket !== socket || (this.destroyed && this.state !== 'draining')) {
        return;
      }

      if (this.state === 'draining') {
        this.prependHandshakeMessages();
        this.startDrainLoop();
        return;
      }

      this.state = 'connected';
      this.prependHandshakeMessages();
      this.startDrainLoop();
    };

    socket.onerror = () => {
      this.handleDisconnect(socket);
    };

    socket.onclose = () => {
      this.handleDisconnect(socket);
    };
  }

  private handleDisconnect(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }

    this.socket = undefined;
    if (this.state !== 'draining') {
      this.state = 'disconnected';
    }
  }

  private prependHandshakeMessages(): void {
    this.drainGeneration += 1;

    const sessionMessage: HeadlessSessionInfoMessage = {
      type: 'session_info',
      ...this.sessionInfo,
    };

    this.queue = [];
    this.bufferedOutputBytes = 0;
    this.enqueueControlPayload(JSON.stringify(sessionMessage as HeadlessMessage));
    this.enqueueControlPayload(JSON.stringify({ type: 'replay_start' } as HeadlessMessage));
    for (const entry of this.history) {
      this.queue.push(entry);
      this.bufferedOutputBytes += entry.outputBytes;
    }
    this.enqueueControlPayload(JSON.stringify({ type: 'replay_end' } as HeadlessMessage));
  }

  private sendReplayToServerClient(connectionId: string): void {
    const server = this.sessionServer;
    if (!server) {
      return;
    }

    server.sendTo(connectionId, {
      type: 'session_info',
      ...this.sessionInfo,
    });
    server.sendTo(connectionId, { type: 'replay_start' });
    for (const entry of this.history) {
      server.sendToRaw(connectionId, entry.payload);
    }
    server.sendTo(connectionId, { type: 'replay_end' });
  }

  private buildSessionInfoFile(): SessionInfoFile | undefined {
    if (!this.sessionServer || !this.serverSessionId || !this.serverStartedAt) {
      return undefined;
    }

    return {
      sessionId: this.serverSessionId,
      pid: process.pid,
      port: this.sessionServer.port,
      command: this.sessionInfo.command,
      workspacePath: this.sessionInfo.workspacePath,
      planId: this.sessionInfo.planId,
      planTitle: this.sessionInfo.planTitle,
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

    writeSessionInfoFile(info);
  }

  private stopSessionServer(): void {
    if (!this.sessionServer) {
      return;
    }
    this.sessionServer.stop();
    this.sessionServer = undefined;
    removeSessionInfoFile(process.pid);
  }

  private broadcastSessionInfo(): void {
    if (!this.sessionServer) {
      return;
    }

    this.sessionServer.broadcast({
      type: 'session_info',
      ...this.sessionInfo,
    });
  }

  private startDrainLoop(): void {
    if (this.drainPromise || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const socket = this.socket;
    const generation = this.drainGeneration;
    this.drainPromise = this.drainQueue(socket, generation).finally(() => {
      this.drainPromise = undefined;
      if (this.socket && this.socket.readyState === WebSocket.OPEN && this.queue.length > 0) {
        this.startDrainLoop();
      }
    });
  }

  private async drainQueue(socket: WebSocket, generation: number): Promise<void> {
    while (
      this.socket === socket &&
      socket.readyState === WebSocket.OPEN &&
      this.queue.length > 0 &&
      this.drainGeneration === generation
    ) {
      const entry = this.queue[0];
      try {
        socket.send(entry.payload);
      } catch {
        this.handleDisconnect(socket);
        return;
      }

      // Keep queue.shift() immediately after send(). Awaiting before this point can
      // break queue/history identity assumptions used by capped-history eviction.
      this.queue.shift();
      this.bufferedOutputBytes -= entry.outputBytes;
      await Promise.resolve();
    }
  }

  private async waitForDrain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (this.queue.length === 0 && !this.drainPromise) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private async waitForSocketConnect(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      if (Date.now() > deadline) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
