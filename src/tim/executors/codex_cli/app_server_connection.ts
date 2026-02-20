import type { FileSink } from 'bun';
import { createLineSplitter } from '../../../common/process';
import { debugLog, writeStderr } from '../../../logging';

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface ThreadStartParams {
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: 'workspace-write' | 'danger-full-access' | 'read-only';
  personality?: string;
}

export interface ThreadResult {
  threadId: string;
  [key: string]: unknown;
}

export interface TurnInputText {
  type: 'text';
  text: string;
}

export interface TurnStartParams {
  threadId: string;
  input: TurnInputText[];
  model?: string;
  effort?: string;
  outputSchema?: Record<string, unknown>;
  approvalPolicy?: string;
  sandboxPolicy?: Record<string, unknown>;
}

export interface TurnResult {
  turnId: string;
  [key: string]: unknown;
}

export interface TurnSteerParams {
  threadId: string;
  input: TurnInputText[];
  expectedTurnId?: string;
}

export interface ConnectionOptions {
  cwd: string;
  env?: Record<string, string>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, id: number, params: unknown) => Promise<unknown>;
}

interface PendingRequest {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

function makeIdKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

function summarizeRequestForError(method: string, params: unknown): string {
  const MAX_LEN = 2000;
  let serializedParams = '[unserializable]';
  try {
    const json = JSON.stringify(params);
    if (typeof json === 'string') {
      serializedParams = json.length > MAX_LEN ? `${json.slice(0, MAX_LEN)}...` : json;
    }
  } catch {
    // fall back to placeholder
  }

  return `request method=${method} params=${serializedParams}`;
}

function extractNestedId(
  payload: unknown,
  key: 'thread' | 'turn',
  fallbackKey: 'threadId' | 'turnId'
): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const directId = record[fallbackKey];
  if (typeof directId === 'string' && directId.length > 0) {
    return directId;
  }

  const nested = record[key];
  if (!nested || typeof nested !== 'object') {
    return undefined;
  }

  const nestedId = (nested as Record<string, unknown>).id;
  if (typeof nestedId === 'string' && nestedId.length > 0) {
    return nestedId;
  }

  return undefined;
}

export class AppServerRequestError extends Error {
  constructor(
    message: string,
    public readonly code: number,
    public readonly data?: unknown
  ) {
    super(message);
  }
}

export class CodexAppServerConnection {
  private readonly options: ConnectionOptions;
  private readonly proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  private readonly stdinSink: FileSink;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private closing = false;
  private alive = true;
  private stdoutTask: Promise<void>;
  private stderrTask: Promise<void>;
  private exitTask: Promise<void>;

  private constructor(options: ConnectionOptions) {
    this.options = options;
    this.proc = Bun.spawn(['codex', 'app-server'], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stdinSink = this.proc.stdin;
    this.stdoutTask = this.consumeStdout();
    this.stderrTask = this.consumeStderr();
    this.exitTask = this.monitorExit();
  }

  static async create(options: ConnectionOptions): Promise<CodexAppServerConnection> {
    const connection = new CodexAppServerConnection(options);
    try {
      await connection.initialize();
    } catch (err) {
      await connection.close();
      throw err;
    }
    return connection;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async threadStart(params: ThreadStartParams): Promise<ThreadResult> {
    const raw = await this.sendRequest('thread/start', params);
    const threadId = extractNestedId(raw, 'thread', 'threadId');
    if (!threadId) {
      throw new Error(
        `thread/start response did not include a thread id: ${JSON.stringify(raw ?? null)}`
      );
    }

    return { ...(raw as Record<string, unknown>), threadId };
  }

  async turnStart(params: TurnStartParams): Promise<TurnResult> {
    const raw = await this.sendRequest('turn/start', params);
    const turnId = extractNestedId(raw, 'turn', 'turnId');
    if (!turnId) {
      throw new Error(
        `turn/start response did not include a turn id: ${JSON.stringify(raw ?? null)}`
      );
    }

    return { ...(raw as Record<string, unknown>), turnId };
  }

  async turnSteer(params: TurnSteerParams): Promise<{ turnId: string }> {
    return (await this.sendRequest('turn/steer', params)) as { turnId: string };
  }

  async turnInterrupt(params: { threadId: string; turnId: string }): Promise<void> {
    await this.sendRequest('turn/interrupt', params);
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;

    try {
      await this.stdinSink.end();
    } catch {
      // ignore
    }

    if (this.alive) {
      this.proc.kill();
    }

    await Promise.allSettled([this.stdoutTask, this.stderrTask, this.exitTask]);
    this.rejectAllPending(new Error('Codex app-server connection closed.'));
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      clientInfo: {
        name: 'tim',
        title: 'tim',
        version: '1.0.0',
      },
    });
    this.sendNotification('initialized');
  }

  private sendNotification(method: string, params?: unknown): void {
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.writeMessage(payload);
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.alive) {
      throw new Error('Codex app-server process is not running.');
    }

    const requestId = this.nextRequestId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(makeIdKey(requestId), {
        method,
        params,
        resolve,
        reject,
      });
    });

    this.writeMessage(payload);
    return await promise;
  }

  private writeMessage(payload: JsonRpcRequest | JsonRpcResponse): void {
    if (this.closing || !this.alive) {
      return;
    }
    const line = `${JSON.stringify(payload)}\n`;
    debugLog('Codex app-server send:', line.trimEnd());
    this.stdinSink.write(line);
  }

  private async consumeStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const splitLines = createLineSplitter();

    try {
      for await (const chunk of this.proc.stdout) {
        const text = decoder.decode(chunk, { stream: true });
        const lines = splitLines(text);
        for (const line of lines) {
          if (!line.trim()) continue;
          debugLog('Codex app-server recv:', line);
          this.handleStdoutLine(line);
        }
      }

      const remaining = decoder.decode();
      const flushedLines = splitLines(`${remaining}\n`);
      for (const line of flushedLines) {
        if (!line.trim()) continue;
        debugLog('Codex app-server recv:', line);
        this.handleStdoutLine(line);
      }
    } catch (err) {
      debugLog('Failed while reading codex app-server stdout:', err);
    }
  }

  private async consumeStderr(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.proc.stderr) {
        const text = decoder.decode(chunk, { stream: true });
        if (text.length > 0) {
          writeStderr(text);
        }
      }
      const remaining = decoder.decode();
      if (remaining.length > 0) {
        writeStderr(remaining);
      }
    } catch (err) {
      debugLog('Failed while reading codex app-server stderr:', err);
    }
  }

  private async monitorExit(): Promise<void> {
    const exitCode = await this.proc.exited;
    const signal = this.proc.signalCode;
    this.alive = false;

    if (!this.closing) {
      this.rejectAllPending(
        new Error(
          `Codex app-server exited unexpectedly with code ${exitCode}${signal ? ` (signal ${signal})` : ''}.`
        )
      );
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      debugLog('Failed to parse app-server JSON line:', err, line);
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    const message = parsed as JsonRpcRequest & JsonRpcResponse;
    const hasMethod = typeof message.method === 'string';
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    const messageId = hasId ? message.id : undefined;

    if (hasMethod && messageId !== undefined) {
      void this.handleServerRequest(message.method, messageId, message.params);
      return;
    }

    if (hasMethod) {
      try {
        this.options.onNotification?.(message.method, message.params);
      } catch (err) {
        debugLog('Notification handler error:', err);
      }
      return;
    }

    if (messageId !== undefined) {
      this.handleResponse(messageId, message);
    }
  }

  private handleResponse(id: JsonRpcId, message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(makeIdKey(id));
    if (!pending) {
      debugLog(`Received response for unknown id: ${String(id)}`);
      return;
    }
    this.pendingRequests.delete(makeIdKey(id));

    if (message.error) {
      const requestContext = summarizeRequestForError(pending.method, pending.params);
      pending.reject(
        new AppServerRequestError(
          `${message.error.message ?? 'JSON-RPC error'} (${requestContext})`,
          message.error.code ?? -32000,
          message.error.data
        )
      );
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(method: string, id: JsonRpcId, params: unknown): Promise<void> {
    if (this.closing) {
      return;
    }

    if (typeof id !== 'number') {
      const invalidIdResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid request id',
        },
      };
      this.writeMessage(invalidIdResponse);
      return;
    }

    try {
      const result = await this.options.onServerRequest?.(method, id, params);
      if (this.closing) {
        return;
      }
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        result: result ?? {},
      };
      this.writeMessage(response);
    } catch (err) {
      if (this.closing) {
        return;
      }
      const requestError =
        err instanceof AppServerRequestError
          ? err
          : new AppServerRequestError(toErrorMessage(err), -32000);
      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id,
        error: {
          code: requestError.code,
          message: requestError.message,
          ...(requestError.data !== undefined ? { data: requestError.data } : {}),
        },
      };
      this.writeMessage(response);
    }
  }
}
