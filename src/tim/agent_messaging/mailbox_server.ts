import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { debugLog } from '../../logging.js';
import { MailboxConnectionFramePolicy, MailboxJsonlDecoder } from './mailbox_framing.js';
import {
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  MailboxProtocolError,
  buildMailboxFailureAcknowledgement,
  buildMailboxSuccessAcknowledgement,
  encodeMailboxFrame,
  parseMailboxFrame,
  parseMailboxMessageRequest,
  type MailboxAcknowledgement,
  type MailboxMessageRequest,
} from './mailbox_protocol.js';
import {
  AgentMessagingRuntimeDirectory,
  AgentMessagingRuntimeDirectoryError,
  parseAgentRegistration,
  type AgentRegistration,
} from './runtime_dir.js';
import type { SendAgentMessageAcknowledgement } from './contracts.js';

const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_RECENT_REQUEST_ID_LIMIT = 256;
const MAX_RECENT_REQUEST_ID_LIMIT = 4096;

/** A delivery result that lets the provider layer report temporary backpressure. */
export type MailboxDeliveryResult =
  | Exclude<SendAgentMessageAcknowledgement, 'queued'>
  | 'temporarily-unavailable';

/** Resolves a source against the authoritative active session registrations. */
export type MailboxSourceRegistrationResolver = (
  sourceId: string,
  sourceName: string
) => AgentRegistration | undefined | Promise<AgentRegistration | undefined>;

/** Receives one validated request and reports whether immediate delivery is possible. */
export type MailboxDeliveryCallback = (
  request: MailboxMessageRequest,
  sourceRegistration: AgentRegistration
) => MailboxDeliveryResult | Promise<MailboxDeliveryResult>;

export interface MailboxPendingMessage {
  readonly request: MailboxMessageRequest;
  readonly sourceRegistration: AgentRegistration;
}

export interface MailboxReceiverOptions {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly registration: AgentRegistration;
  readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  readonly deliver: MailboxDeliveryCallback;
  readonly maxConnections?: number;
  readonly recentRequestIdLimit?: number;
}

export type MailboxReceiverErrorCode =
  | 'invalid_options'
  | 'socket_in_use'
  | 'receiver_closed'
  | 'receiver_not_ready';

export class MailboxReceiverError extends Error {
  public readonly code: MailboxReceiverErrorCode;

  public constructor(code: MailboxReceiverErrorCode, message: string) {
    super(message);
    this.name = 'MailboxReceiverError';
    this.code = code;
  }
}

interface ValidatedMailboxReceiverOptions {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly registration: AgentRegistration;
  readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  readonly deliver: MailboxDeliveryCallback;
  readonly maxConnections: number;
  readonly recentRequestIdLimit: number;
}

interface ConnectionState {
  readonly socket: net.Socket;
  readonly decoder: MailboxJsonlDecoder;
  readonly framePolicy: MailboxConnectionFramePolicy;
  frameReceived: boolean;
  responseSent: boolean;
}

interface RecentRequest {
  readonly fingerprint: string;
  readonly completion: Promise<MailboxAcknowledgement>;
  completed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function validationErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  let safe = '';
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
  }
  return safe.slice(0, 512) || fallback;
}

function validateIntegerOption(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new MailboxReceiverError(
      'invalid_options',
      `${label} must be a safe integer from 1 through ${maximum}`
    );
  }
  return value as number;
}

function requestFingerprint(request: MailboxMessageRequest): string {
  const canonical = JSON.stringify([
    request.protocolVersion,
    request.kind,
    request.requestId,
    request.sourceId,
    request.sourceName,
    request.targetId,
    request.targetName,
    request.content,
    request.timestamp,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function recoverRequestId(line: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }

  if (!isRecord(value) || typeof value.requestId !== 'string') {
    return undefined;
  }

  try {
    return buildMailboxFailureAcknowledgement(
      value.requestId,
      'invalid_message',
      'Mailbox request failed validation'
    ).requestId;
  } catch {
    return undefined;
  }
}

async function validateReceiverOptions(
  options: MailboxReceiverOptions
): Promise<ValidatedMailboxReceiverOptions> {
  if (!isRecord(options)) {
    throw new MailboxReceiverError('invalid_options', 'Mailbox receiver options must be an object');
  }
  if (!(options.runtime instanceof AgentMessagingRuntimeDirectory)) {
    throw new MailboxReceiverError(
      'invalid_options',
      'Mailbox receiver runtime must be an agent messaging runtime directory'
    );
  }
  if (typeof options.resolveSourceRegistration !== 'function') {
    throw new MailboxReceiverError(
      'invalid_options',
      'Mailbox receiver source resolver must be a function'
    );
  }
  if (typeof options.deliver !== 'function') {
    throw new MailboxReceiverError(
      'invalid_options',
      'Mailbox receiver delivery callback must be a function'
    );
  }

  let registration: AgentRegistration;
  try {
    registration = parseAgentRegistration(options.registration);
  } catch (error) {
    throw new MailboxReceiverError(
      'invalid_options',
      `Mailbox receiver registration is invalid: ${validationErrorMessage(
        error,
        'invalid registration'
      )}`
    );
  }

  const expectedSocketPath = options.runtime.socketPath(registration.id);
  if (registration.socketPath !== expectedSocketPath) {
    throw new MailboxReceiverError(
      'invalid_options',
      'Mailbox receiver registration socketPath must match the derived socket path'
    );
  }

  const maxConnections = validateIntegerOption(
    options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    'maxConnections',
    1024
  );
  const recentRequestIdLimit = validateIntegerOption(
    options.recentRequestIdLimit ?? DEFAULT_RECENT_REQUEST_ID_LIMIT,
    'recentRequestIdLimit',
    MAX_RECENT_REQUEST_ID_LIMIT
  );
  if (recentRequestIdLimit < maxConnections) {
    throw new MailboxReceiverError(
      'invalid_options',
      'recentRequestIdLimit must be at least maxConnections so in-flight requests remain deduplicated'
    );
  }

  await options.runtime.validateSocketPath(expectedSocketPath, {
    allowMissing: true,
    requireSocket: true,
  });
  try {
    await fs.lstat(expectedSocketPath);
    throw new MailboxReceiverError(
      'socket_in_use',
      `Mailbox socket path already exists: ${expectedSocketPath}`
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  return {
    runtime: options.runtime,
    registration,
    resolveSourceRegistration: options.resolveSourceRegistration,
    deliver: options.deliver,
    maxConnections,
    recentRequestIdLimit,
  };
}

/**
 * A single receiver for one registered identity.
 *
 * The receiver owns only its listening socket and in-memory pending mailbox.
 * Registration publication and removal remain the responsibility of the
 * session runtime.
 */
export class MailboxReceiver {
  public readonly registration: AgentRegistration;
  public readonly socketPath: string;
  public readonly ready: Promise<void>;

  private readonly runtime: AgentMessagingRuntimeDirectory;
  private readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  private readonly deliver: MailboxDeliveryCallback;
  private readonly maxConnections: number;
  private readonly recentRequestIdLimit: number;
  private readonly connections = new Set<net.Socket>();
  private readonly pending: MailboxPendingMessage[] = [];
  private readonly recentRequests = new Map<string, RecentRequest>();
  private server: net.Server | undefined;
  private listening = false;
  private socketOwned = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(options: ValidatedMailboxReceiverOptions) {
    this.registration = options.registration;
    this.socketPath = options.registration.socketPath;
    this.runtime = options.runtime;
    this.resolveSourceRegistration = options.resolveSourceRegistration;
    this.deliver = options.deliver;
    this.maxConnections = options.maxConnections;
    this.recentRequestIdLimit = options.recentRequestIdLimit;
    this.ready = this.start();
  }

  /** Bind and return a receiver only after the Unix socket is ready. */
  public static async create(options: MailboxReceiverOptions): Promise<MailboxReceiver> {
    const validatedOptions = await validateReceiverOptions(options);
    const receiver = new MailboxReceiver(validatedOptions);
    await receiver.ready;
    return receiver;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Remove up to `limit` messages from the FIFO in one synchronous operation.
   * Messages that arrive after this snapshot remain behind the returned batch.
   */
  public drainPending(limit?: number): MailboxPendingMessage[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
      throw new RangeError('Pending-message drain limit must be a non-negative safe integer');
    }
    const count = limit === undefined ? this.pending.length : Math.min(limit, this.pending.length);
    return this.pending.splice(0, count);
  }

  /** Stop accepting clients, close active connections, and unlink this socket. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async start(): Promise<void> {
    const server = net.createServer((socket: net.Socket) => {
      this.acceptConnection(socket);
    });
    this.server = server;
    server.maxConnections = this.maxConnections;
    server.on('error', (error: Error) => {
      if (this.listening) {
        debugLog('[agent mailbox] receiver server error:', error);
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(this.socketPath);
      });

      this.listening = true;
      this.socketOwned = true;
      await this.runtime.validateSocketPath(this.socketPath, {
        allowMissing: false,
        requireSocket: true,
      });
    } catch (error) {
      this.closed = true;
      await this.closeServerAndSocket().catch((cleanupError: unknown) => {
        debugLog('[agent mailbox] receiver startup cleanup failed:', cleanupError);
      });
      throw error;
    }
  }

  private acceptConnection(socket: net.Socket): void {
    if (this.closed || this.connections.size >= this.maxConnections) {
      socket.destroy();
      return;
    }

    const state: ConnectionState = {
      socket,
      decoder: new MailboxJsonlDecoder({ maxFrames: 1 }),
      framePolicy: new MailboxConnectionFramePolicy('message'),
      frameReceived: false,
      responseSent: false,
    };
    this.connections.add(socket);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      this.handleData(state, chunk);
    });
    socket.on('end', () => {
      this.handleEnd(state);
    });
    socket.on('error', (error: Error) => {
      debugLog('[agent mailbox] client socket error:', error);
    });
    socket.on('close', () => {
      this.connections.delete(socket);
    });
  }

  private handleData(state: ConnectionState, chunk: Buffer): void {
    if (state.responseSent || state.frameReceived) {
      state.socket.destroy();
      return;
    }

    let lines: string[];
    try {
      lines = state.decoder.push(chunk);
    } catch (error) {
      state.frameReceived = true;
      void this.sendProtocolFailure(state, error);
      return;
    }
    if (lines.length === 0) {
      return;
    }

    state.frameReceived = true;
    state.socket.pause();
    void this.processLine(state, lines[0] as string);
  }

  private handleEnd(state: ConnectionState): void {
    if (state.frameReceived || state.responseSent) {
      return;
    }

    let error: unknown;
    try {
      state.decoder.finish();
      error = new MailboxProtocolError(
        'incomplete_frame',
        'Mailbox connection closed without one complete request frame'
      );
    } catch (finishError) {
      error = finishError;
    }
    state.frameReceived = true;
    void this.sendProtocolFailure(state, error);
  }

  private async processLine(state: ConnectionState, line: string): Promise<void> {
    let request: MailboxMessageRequest;
    try {
      const frame = parseMailboxFrame(line);
      state.framePolicy.accept(frame);
      request = parseMailboxMessageRequest(frame);
    } catch (error) {
      await this.sendProtocolFailure(state, error, recoverRequestId(line));
      return;
    }

    const acknowledgement = await this.acceptRequest(request);
    await this.sendAcknowledgement(state, acknowledgement);
  }

  private async acceptRequest(request: MailboxMessageRequest): Promise<MailboxAcknowledgement> {
    const fingerprint = requestFingerprint(request);
    const existing = this.recentRequests.get(request.requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return buildMailboxFailureAcknowledgement(
          request.requestId,
          'duplicate_message_id',
          'Mailbox requestId was already used for a different message'
        );
      }
      return existing.completion;
    }

    const completion = this.deliverRequest(request).catch((error: unknown) =>
      buildMailboxFailureAcknowledgement(
        request.requestId,
        'connection_failed',
        `Mailbox delivery failed: ${validationErrorMessage(error, 'delivery callback failed')}`
      )
    );
    const recentRequest: RecentRequest = {
      fingerprint,
      completion,
      completed: false,
    };
    this.recentRequests.set(request.requestId, recentRequest);
    this.trimRecentRequests();

    const acknowledgement = await completion;
    recentRequest.completed = true;
    this.trimRecentRequests();
    return acknowledgement;
  }

  private async deliverRequest(request: MailboxMessageRequest): Promise<MailboxAcknowledgement> {
    if (this.closed) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'runtime_closed',
        'Mailbox receiver is closed'
      );
    }
    if (
      request.targetId !== this.registration.id ||
      request.targetName !== this.registration.name
    ) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'target_stale',
        'Mailbox request target does not match this receiver'
      );
    }

    let sourceRegistration: AgentRegistration | undefined;
    try {
      sourceRegistration = await this.resolveSourceRegistration(
        request.sourceId,
        request.sourceName
      );
    } catch (error) {
      debugLog('[agent mailbox] source registration resolver failed:', error);
    }
    if (sourceRegistration === undefined) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'unknown_source',
        'Mailbox source is not an active registered identity'
      );
    }

    try {
      sourceRegistration = parseAgentRegistration(sourceRegistration);
    } catch {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'unknown_source',
        'Mailbox source registration is invalid'
      );
    }
    if (
      sourceRegistration.id !== request.sourceId ||
      sourceRegistration.name !== request.sourceName
    ) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'unknown_source',
        'Mailbox source identity does not match its active registration'
      );
    }

    const trustedRequest = parseMailboxMessageRequest({
      ...request,
      sourceId: sourceRegistration.id,
      sourceName: sourceRegistration.name,
    });
    let delivery: MailboxDeliveryResult;
    try {
      delivery = await this.deliver(trustedRequest, sourceRegistration);
    } catch (error) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'connection_failed',
        `Mailbox delivery failed: ${validationErrorMessage(error, 'delivery callback failed')}`
      );
    }

    if (delivery === 'steered' || delivery === 'started-idle-turn') {
      return buildMailboxSuccessAcknowledgement(request.requestId, delivery);
    }
    if (delivery !== 'temporarily-unavailable') {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'connection_failed',
        'Mailbox delivery callback returned an invalid result'
      );
    }
    if (this.closed) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'runtime_closed',
        'Mailbox receiver is closed'
      );
    }
    if (this.pending.length >= MAX_PENDING_MESSAGES_PER_RECIPIENT) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'queue_full',
        `Mailbox pending queue is full at ${MAX_PENDING_MESSAGES_PER_RECIPIENT} messages`
      );
    }

    this.pending.push({ request: trustedRequest, sourceRegistration });
    return buildMailboxSuccessAcknowledgement(request.requestId, 'queued');
  }

  private trimRecentRequests(): void {
    if (this.recentRequests.size <= this.recentRequestIdLimit) {
      return;
    }

    for (const [requestId, request] of this.recentRequests) {
      if (!request.completed) {
        continue;
      }
      this.recentRequests.delete(requestId);
      if (this.recentRequests.size <= this.recentRequestIdLimit) {
        return;
      }
    }
  }

  private async processProtocolError(
    state: ConnectionState,
    error: unknown,
    requestId: string | undefined
  ): Promise<void> {
    if (requestId === undefined) {
      state.socket.end();
      return;
    }

    const code = error instanceof MailboxProtocolError ? error.code : 'invalid_message';
    const acknowledgement = buildMailboxFailureAcknowledgement(
      requestId,
      code,
      validationErrorMessage(error, 'Mailbox request failed')
    );
    await this.sendAcknowledgement(state, acknowledgement);
  }

  private async sendProtocolFailure(
    state: ConnectionState,
    error: unknown,
    requestId?: string
  ): Promise<void> {
    await this.processProtocolError(state, error, requestId);
  }

  private async sendAcknowledgement(
    state: ConnectionState,
    acknowledgement: MailboxAcknowledgement
  ): Promise<void> {
    if (state.responseSent) {
      return;
    }
    state.responseSent = true;
    let encoded: string;
    try {
      encoded = encodeMailboxFrame(acknowledgement);
    } catch (error) {
      debugLog('[agent mailbox] failed to encode acknowledgement:', error);
      state.socket.destroy();
      return;
    }
    if (!state.socket.destroyed) {
      state.socket.write(encoded, () => {
        if (!state.socket.destroyed) {
          state.socket.end();
        }
      });
    }
  }

  private async closeInternal(): Promise<void> {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.pending.length = 0;
    this.recentRequests.clear();
    await this.closeServerAndSocket();
  }

  private async closeServerAndSocket(): Promise<void> {
    const server = this.server;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error !== undefined) {
            reject(error);
          } else {
            resolve();
          }
        });
      }).catch((error: unknown) => {
        debugLog('[agent mailbox] receiver server close failed:', error);
      });
    }
    this.listening = false;

    if (this.socketOwned) {
      this.socketOwned = false;
      try {
        await this.runtime.removeSocket(this.registration.id);
      } catch (error) {
        if (
          !(error instanceof AgentMessagingRuntimeDirectoryError) ||
          error.code !== 'runtime_closed'
        ) {
          throw error;
        }
      }
    }
  }
}

export async function createMailboxReceiver(
  options: MailboxReceiverOptions
): Promise<MailboxReceiver> {
  return MailboxReceiver.create(options);
}
