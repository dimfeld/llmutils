import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { createLineSplitter } from '../../../common/process';
import {
  buildWorkspaceCommandEnv,
  type TimWorkspaceCommandEnvironmentOptions,
} from '../../../common/env.js';
import { debugLog, writeStderr } from '../../../logging';

export const TIM_CODEX_APP_SERVER_SOCKET = 'TIM_CODEX_APP_SERVER_SOCKET';

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
  timEnvironment?: TimWorkspaceCommandEnvironmentOptions;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, id: number, params: unknown) => Promise<unknown>;
  onExit?: (info: { exitCode: number; signal?: NodeJS.Signals }) => void;
}

interface PendingRequest {
  method: string;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

type AppServerOwner =
  | {
      kind: 'spawned';
      proc: Bun.Subprocess<'ignore', 'ignore', 'pipe'>;
      socketTempDir: string;
      closing: boolean;
      stderrTask: Promise<void>;
      exitTask: Promise<void>;
    }
  | {
      kind: 'external';
    };

type CodexProcessWithStderr = Bun.Subprocess<any, any, 'pipe'>;

interface AppServerTransport {
  readonly incoming: AsyncIterable<Uint8Array>;
  write(line: string): void;
  end(): Promise<void>;
  kill(): void;
}

class UnixWebSocketTransport extends EventEmitter implements AppServerTransport {
  readonly incoming: AsyncIterable<Uint8Array>;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private pendingMessages: Uint8Array[] = [];
  private pendingResolvers: Array<(result: IteratorResult<Uint8Array>) => void> = [];

  private constructor(private readonly socket: Socket) {
    super();
    this.incoming = this.createIncomingIterable();
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processFrames();
    });
    socket.on('close', () => {
      this.markClosed();
    });
    socket.on('error', (err) => {
      this.emit('transportError', err);
      this.markClosed();
    });
  }

  static async connect(socketPath: string): Promise<UnixWebSocketTransport> {
    const socket = createConnection(socketPath);
    const key = randomBytes(16).toString('base64');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error(`Timed out connecting to Codex app-server socket: ${socketPath}`));
      }, 5000);
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        socket.destroy();
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });
    socket.write(
      [
        'GET / HTTP/1.1',
        'Host: localhost',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        '',
        '',
      ].join('\r\n')
    );
    const response = await readHttpUpgradeResponse(socket);
    validateWebSocketUpgrade(response, key);
    return new UnixWebSocketTransport(socket);
  }

  write(line: string): void {
    if (this.closed) {
      return;
    }
    this.socket.write(encodeWebSocketFrame(Buffer.from(line.trimEnd()), 0x1));
  }

  async end(): Promise<void> {
    if (!this.closed) {
      this.socket.write(encodeWebSocketFrame(Buffer.alloc(0), 0x8));
      this.socket.end();
    }
  }

  kill(): void {
    this.socket.destroy();
  }

  private createIncomingIterable(): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Uint8Array>> => {
          const nextMessage = this.pendingMessages.shift();
          if (nextMessage) {
            return { done: false, value: nextMessage };
          }
          if (this.closed) {
            return { done: true, value: undefined };
          }
          return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
            this.pendingResolvers.push(resolve);
          });
        },
      }),
    };
  }

  private pushMessage(message: Uint8Array): void {
    const resolver = this.pendingResolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
      return;
    }
    this.pendingMessages.push(message);
  }

  private markClosed(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolver of this.pendingResolvers) {
      resolver({ done: true, value: undefined });
    }
    this.pendingResolvers = [];
  }

  private processFrames(): void {
    while (true) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.consumedBytes);
      if (frame.opcode === 0x1) {
        this.pushMessage(Buffer.concat([frame.payload, Buffer.from('\n')]));
      } else if (frame.opcode === 0x8) {
        this.socket.end();
        this.markClosed();
      } else if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, 0xa));
      }
    }
  }
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function getInheritedAppServerSocket(env: Record<string, string> | undefined): string | undefined {
  const socketPath = env?.[TIM_CODEX_APP_SERVER_SOCKET] ?? process.env[TIM_CODEX_APP_SERVER_SOCKET];
  return socketPath && socketPath.trim().length > 0 ? socketPath : undefined;
}

async function consumeCodexProcessStderr(proc: CodexProcessWithStderr): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of proc.stderr) {
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

async function monitorCodexProcessExit(
  proc: CodexProcessWithStderr,
  options: ConnectionOptions,
  isClosing: () => boolean
): Promise<void> {
  const exitCode = await proc.exited;
  const signal = proc.signalCode;
  if (!isClosing()) {
    options.onExit?.({ exitCode, signal: signal ?? undefined });
  }
}

async function waitForSocketPath(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(socketPath);
      if (stat.isSocket()) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(25);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for Codex app-server socket: ${socketPath}`);
}

async function readHttpUpgradeResponse(socket: Socket): Promise<string> {
  let buffer = Buffer.alloc(0);
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      cleanup();
      const response = buffer.subarray(0, headerEnd + 4).toString('utf8');
      const remaining = buffer.subarray(headerEnd + 4);
      if (remaining.length > 0) {
        socket.unshift(remaining);
      }
      resolve(response);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Codex app-server websocket closed during handshake.'));
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function validateWebSocketUpgrade(response: string, key: string): void {
  const lines = response.split('\r\n');
  const statusLine = lines.shift() ?? '';
  if (!/^HTTP\/1\.[01] 101\b/i.test(statusLine)) {
    throw new Error(`Codex app-server websocket upgrade failed: ${statusLine}`);
  }

  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }

  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  if (headers.get('sec-websocket-accept') !== expectedAccept) {
    throw new Error('Codex app-server websocket upgrade returned an invalid accept key.');
  }
}

function encodeWebSocketFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const headerLength = payload.length < 126 ? 6 : payload.length <= 0xffff ? 8 : 14;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    writeMaskedPayload(payload, mask, frame, 6);
  } else if (payload.length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(payload.length, 2);
    mask.copy(frame, 4);
    writeMaskedPayload(payload, mask, frame, 8);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
    mask.copy(frame, 10);
    writeMaskedPayload(payload, mask, frame, 14);
  }
  return frame;
}

function writeMaskedPayload(payload: Buffer, mask: Buffer, frame: Buffer, offset: number): void {
  for (let index = 0; index < payload.length; index++) {
    frame[offset + index] = payload[index] ^ mask[index % 4];
  }
}

function decodeWebSocketFrame(
  buffer: Buffer
): { opcode: number; payload: Buffer; consumedBytes: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < offset + 2) return undefined;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.length < offset + 8) return undefined;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Codex app-server websocket frame is too large.');
    }
    payloadLength = Number(bigLength);
    offset += 8;
  }
  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return undefined;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLength) return undefined;
  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (mask) {
    for (let index = 0; index < payload.length; index++) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, consumedBytes: offset + payloadLength };
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
  private readonly owner: AppServerOwner;
  private readonly transport: AppServerTransport;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private nextRequestId = 1;
  private closing = false;
  private alive = true;
  private incomingTask: Promise<void>;

  private constructor(
    options: ConnectionOptions,
    owner: AppServerOwner,
    transport: AppServerTransport
  ) {
    this.options = options;
    this.owner = owner;
    this.transport = transport;
    this.incomingTask = this.consumeIncoming();
  }

  static async create(options: ConnectionOptions): Promise<CodexAppServerConnection> {
    const env = await buildWorkspaceCommandEnv(options.cwd, options.env, {
      timEnvironment: options.timEnvironment,
    });
    const inheritedSocketPath = getInheritedAppServerSocket(env);
    const owner =
      inheritedSocketPath == null ? await CodexAppServerConnection.spawnOwner(options, env) : null;
    const socketPath = inheritedSocketPath ?? owner?.socketPath;
    if (!socketPath) {
      throw new Error('Codex app-server socket path was not available.');
    }
    const connectionEnv =
      inheritedSocketPath == null ? { ...env, [TIM_CODEX_APP_SERVER_SOCKET]: socketPath } : env;

    let transport: AppServerTransport;
    try {
      await waitForSocketPath(socketPath);
      transport = await UnixWebSocketTransport.connect(socketPath);
    } catch (err) {
      if (owner?.owner.kind === 'spawned') {
        owner.owner.closing = true;
        owner.owner.proc.kill();
        await Promise.allSettled([owner.owner.stderrTask, owner.owner.exitTask]);
        await fs.rm(owner.owner.socketTempDir, { recursive: true, force: true }).catch(() => {});
      }
      throw err;
    }
    const connection = new CodexAppServerConnection(
      {
        ...options,
        env: connectionEnv,
      },
      owner?.owner ?? { kind: 'external' },
      transport
    );
    if (transport instanceof UnixWebSocketTransport) {
      transport.on('transportError', (err) => {
        debugLog('Codex app-server websocket transport error:', err);
      });
    }
    try {
      await connection.initialize();
    } catch (err) {
      await connection.close();
      throw err;
    }
    return connection;
  }

  private static async spawnOwner(
    options: ConnectionOptions,
    env: Record<string, string>
  ): Promise<{ owner: AppServerOwner; socketPath: string }> {
    const socketTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-codex-app-server-'));
    const socketPath = path.join(socketTempDir, 'codex.sock');
    const spawnEnv = {
      ...env,
      [TIM_CODEX_APP_SERVER_SOCKET]: socketPath,
    };
    const proc = Bun.spawn(['codex', 'app-server', '--listen', `unix://${socketPath}`], {
      cwd: options.cwd,
      env: spawnEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const owner = {
      kind: 'spawned' as const,
      proc,
      socketTempDir,
      closing: false,
      stderrTask: CodexAppServerConnection.consumeProcessStderr(proc),
      exitTask: Promise.resolve(),
    };
    owner.exitTask = CodexAppServerConnection.monitorProcessExit(
      proc,
      options,
      () => owner.closing
    );
    return { owner, socketPath };
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get pid(): number | undefined {
    return this.owner.kind === 'spawned' ? this.owner.proc.pid : undefined;
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

  async readRateLimits(): Promise<unknown> {
    return await this.sendRequest('account/rateLimits/read');
  }

  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    if (this.owner.kind === 'spawned') {
      this.owner.closing = true;
    }

    try {
      await this.transport.end();
    } catch {
      // ignore
    }

    if (this.owner.kind === 'spawned') {
      this.owner.proc.kill();
    }

    const ownerTasks =
      this.owner.kind === 'spawned' ? [this.owner.stderrTask, this.owner.exitTask] : [];
    await Promise.allSettled([this.incomingTask, ...ownerTasks]);
    if (this.owner.kind === 'spawned') {
      await fs.rm(this.owner.socketTempDir, { recursive: true, force: true }).catch(() => {});
    }
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
    this.transport.write(line);
  }

  private async consumeIncoming(): Promise<void> {
    const decoder = new TextDecoder();
    const splitLines = createLineSplitter();

    try {
      for await (const chunk of this.transport.incoming) {
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
      debugLog('Failed while reading codex app-server socket:', err);
    } finally {
      this.handleConnectionClosed();
    }
  }

  private static async consumeProcessStderr(proc: CodexProcessWithStderr): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stderr) {
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

  private static async monitorProcessExit(
    proc: CodexProcessWithStderr,
    options: ConnectionOptions,
    isClosing: () => boolean
  ): Promise<void> {
    const exitCode = await proc.exited;
    const signal = proc.signalCode;
    if (!isClosing()) {
      options.onExit?.({ exitCode, signal: signal ?? undefined });
    }
  }

  private handleConnectionClosed(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;

    if (!this.closing) {
      if (this.owner.kind === 'external') {
        this.options.onExit?.({ exitCode: 1 });
      }
      this.rejectAllPending(new Error('Codex app-server connection closed.'));
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

    if (pending.method === 'account/rateLimits/read' && isObjectRecord(message.result)) {
      const rateLimits = message.result.rateLimits;
      if (isObjectRecord(rateLimits)) {
        try {
          this.options.onNotification?.('account/rateLimits/updated', { rateLimits });
        } catch (err) {
          debugLog('Notification handler error:', err);
        }
      }
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
