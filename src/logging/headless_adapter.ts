import type { LoggerAdapter } from './adapter.js';
import { ConsoleAdapter } from './console.js';
import type {
  HeadlessOutputMessage,
  HeadlessServerMessage,
  HeadlessSessionInfo,
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

interface HistoryEntry {
  payload: string;
  outputBytes: number;
}

interface HeadlessAdapterOptions {
  maxBufferBytes?: number;
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

export class HeadlessAdapter implements LoggerAdapter {
  private sessionInfo: HeadlessSessionInfo;
  private readonly wrappedAdapter: LoggerAdapter;
  private readonly maxBufferBytes: number;
  private readonly bearerToken?: string;
  private readonly serverHostname?: string;
  private readonly serverSessionId?: string;
  private readonly serverStartedAt?: string;

  private sessionServer: EmbeddedServerHandle | undefined;
  private history: HistoryEntry[] = [];
  private historyOutputBytes = 0;
  private destroyed = false;
  private nextOutputSequence = 1;
  private pendingPrompts: Map<string, PendingPromptRequest> = new Map();
  private userInputHandler?: (content: string) => void;
  private endSessionHandler?: () => void;

  constructor(
    sessionInfo: HeadlessSessionInfo,
    wrappedAdapter: LoggerAdapter = new ConsoleAdapter(),
    options?: HeadlessAdapterOptions
  ) {
    this.sessionInfo = sessionInfo;
    this.wrappedAdapter = wrappedAdapter;
    this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.bearerToken = options?.bearerToken;
    this.serverHostname = options?.serverHostname;

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
    this.rejectAllPending();
    this.stopSessionServer();
  }

  updateSessionInfo(patch: Partial<HeadlessSessionInfo>): void {
    Object.assign(this.sessionInfo, patch);
    this.broadcastSessionInfo();
    this.writeSessionInfoFile();
  }

  hasConnectedClients(): boolean {
    return (this.sessionServer?.connectedClients.size ?? 0) > 0;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.rejectAllPending();

    const sessionServer = this.sessionServer;
    if (sessionServer && this.hasConnectedClients()) {
      sessionServer.broadcast({ type: 'session_ended' });
      await sessionServer.drain();
    }

    this.stopSessionServer();
  }

  /**
   * Handles an incoming server→client message from the websocket.
   */
  private handleServerMessage(message: HeadlessServerMessage): void {
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
        this.rejectAllPending('Session ended');
        try {
          this.endSessionHandler?.();
        } catch (err) {
          this.wrappedAdapter.warn(`Headless end session handler error: ${err as Error}`);
        }
        break;
    }
  }

  setUserInputHandler(callback: ((content: string) => void) | undefined): void {
    this.userInputHandler = callback;
  }

  setEndSessionHandler(callback: (() => void) | undefined): void {
    this.endSessionHandler = callback;
  }

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
      hostname: this.serverHostname,
      command: this.sessionInfo.command,
      workspacePath: this.sessionInfo.workspacePath,
      planId: this.sessionInfo.planId,
      planUuid: this.sessionInfo.planUuid,
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
      ...this.sessionInfo,
      type: 'session_info',
      sessionId: this.serverSessionId,
    });
  }
}
