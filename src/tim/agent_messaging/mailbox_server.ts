import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { debugLog } from '../../logging.js';
import { MailboxConnection } from './mailbox_connection.js';
import { isRecord, isNotFoundError, sanitizeErrorMessage } from './mailbox_helpers.js';
import {
  MAX_PENDING_MESSAGES_PER_RECIPIENT,
  buildMailboxFailureAcknowledgement,
  buildMailboxSuccessAcknowledgement,
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
const MAX_RECEIVER_CONNECTIONS = 1024;
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

export interface NormalizedMailboxReceiverOptions {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly registration: AgentRegistration;
  readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  readonly deliver: MailboxDeliveryCallback;
  readonly maxConnections: number;
  readonly recentRequestIdLimit: number;
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

interface RecentRequest {
  readonly fingerprint: string;
  readonly completion: Promise<MailboxAcknowledgement | undefined>;
  completed: boolean;
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

const MAILBOX_RECEIVER_OPTION_KEYS = new Set([
  'runtime',
  'registration',
  'resolveSourceRegistration',
  'deliver',
  'maxConnections',
  'recentRequestIdLimit',
]);

function assertKnownReceiverOptionKeys(options: Record<string, unknown>): void {
  for (const key of Object.keys(options)) {
    if (!MAILBOX_RECEIVER_OPTION_KEYS.has(key)) {
      throw new MailboxReceiverError(
        'invalid_options',
        `Mailbox receiver options contain an unsupported field: ${key}`
      );
    }
  }
}

/** Normalize receiver options before any socket or filesystem allocation. */
export function normalizeMailboxReceiverOptions(
  options: MailboxReceiverOptions
): NormalizedMailboxReceiverOptions {
  if (!isRecord(options)) {
    throw new MailboxReceiverError('invalid_options', 'Mailbox receiver options must be an object');
  }
  assertKnownReceiverOptionKeys(options);
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
      `Mailbox receiver registration is invalid: ${sanitizeErrorMessage(
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
    options.maxConnections === undefined ? DEFAULT_MAX_CONNECTIONS : options.maxConnections,
    'maxConnections',
    MAX_RECEIVER_CONNECTIONS
  );
  const recentRequestIdLimit = validateIntegerOption(
    options.recentRequestIdLimit === undefined
      ? DEFAULT_RECENT_REQUEST_ID_LIMIT
      : options.recentRequestIdLimit,
    'recentRequestIdLimit',
    MAX_RECENT_REQUEST_ID_LIMIT
  );
  if (recentRequestIdLimit < maxConnections) {
    throw new MailboxReceiverError(
      'invalid_options',
      'recentRequestIdLimit must be at least maxConnections so in-flight requests remain deduplicated'
    );
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

async function validateMailboxReceiverStartup(
  options: NormalizedMailboxReceiverOptions
): Promise<void> {
  const { runtime, registration } = options;
  await runtime.validateSocketPath(registration.socketPath, {
    allowMissing: true,
    requireSocket: true,
  });
  try {
    await fs.lstat(registration.socketPath);
    throw new MailboxReceiverError(
      'socket_in_use',
      `Mailbox socket path already exists: ${registration.socketPath}`
    );
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
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
  private readonly activeConnections = new Set<net.Socket>();
  private readonly pending: MailboxPendingMessage[] = [];
  /** Messages removed by a manager drain but not yet acknowledged or requeued. */
  private readonly pendingDeliveryReservations = new Set<MailboxPendingMessage>();
  private readonly recentRequests = new Map<string, RecentRequest>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private server: net.Server | undefined;
  private listening = false;
  private socketOwned = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(options: NormalizedMailboxReceiverOptions) {
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
    const normalizedOptions = normalizeMailboxReceiverOptions(options);
    return MailboxReceiver.createNormalized(normalizedOptions);
  }

  public static async createNormalized(
    options: NormalizedMailboxReceiverOptions
  ): Promise<MailboxReceiver> {
    await validateMailboxReceiverStartup(options);
    const receiver = new MailboxReceiver(options);
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

  /**
   * Remove one FIFO batch for provider delivery while reserving its capacity.
   * New mailbox sends cannot consume these reserved slots until the batch is
   * acknowledged or requeued.
   */
  public takePendingForDelivery(limit?: number): MailboxPendingMessage[] {
    const messages = this.drainPending(limit);
    for (const message of messages) {
      this.pendingDeliveryReservations.add(message);
    }
    return messages;
  }

  /** Release the capacity for a batch that the provider accepted. */
  public acknowledgePending(messages: readonly MailboxPendingMessage[]): void {
    const uniqueMessages = new Set(messages);
    if (
      uniqueMessages.size !== messages.length ||
      messages.some((message) => !this.pendingDeliveryReservations.has(message))
    ) {
      throw new MailboxReceiverError(
        'receiver_not_ready',
        'Mailbox pending delivery reservation is not active'
      );
    }
    for (const message of messages) {
      this.pendingDeliveryReservations.delete(message);
    }
  }

  /** Put a drained batch back at the front when the provider is unavailable. */
  public requeuePending(messages: readonly MailboxPendingMessage[]): void {
    if (messages.length === 0) {
      return;
    }
    if (this.closed) {
      return;
    }

    // Ignore a repeated requeue of a batch that is already back in the FIFO.
    // This keeps retry cleanup idempotent without duplicating messages.
    const seen = new Set<MailboxPendingMessage>();
    const toRequeue = messages.filter((message) => {
      if (seen.has(message) || this.pending.includes(message)) {
        return false;
      }
      seen.add(message);
      return true;
    });
    const reservationsToRelease = toRequeue.filter((message) =>
      this.pendingDeliveryReservations.has(message)
    ).length;
    if (
      this.pending.length +
        toRequeue.length +
        this.pendingDeliveryReservations.size -
        reservationsToRelease >
      MAX_PENDING_MESSAGES_PER_RECIPIENT
    ) {
      throw new MailboxReceiverError(
        'receiver_not_ready',
        'Mailbox pending queue cannot accept the requeued messages'
      );
    }
    for (const message of toRequeue) {
      this.pendingDeliveryReservations.delete(message);
    }
    // splice restores the batch at the front of the FIFO in its original order.
    this.pending.splice(0, 0, ...toRequeue);
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
    if (this.closed || this.activeConnections.size >= this.maxConnections) {
      socket.end();
      return;
    }

    this.connections.add(socket);
    this.activeConnections.add(socket);
    const connection = new MailboxConnection(socket, {
      onRequest: (request, isPeerEnded): Promise<MailboxAcknowledgement | undefined> =>
        this.acceptRequest(request, isPeerEnded),
      onInactive: (): void => {
        this.activeConnections.delete(socket);
      },
      onClosed: (): void => {
        this.connections.delete(socket);
        this.activeConnections.delete(socket);
      },
    });
    connection.start();
  }

  private async acceptRequest(
    request: MailboxMessageRequest,
    isPeerEnded: () => boolean
  ): Promise<MailboxAcknowledgement | undefined> {
    if (isPeerEnded()) {
      return undefined;
    }
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
      const acknowledgement = await existing.completion;
      if (acknowledgement !== undefined) {
        return acknowledgement;
      }
      // The original completed with no acknowledgement because the peer ended
      // before delivery began (the immediate-FIN rule). That entry did not
      // invoke the callback, so it is safe to remove and allow a fresh attempt.
      if (this.recentRequests.get(request.requestId) === existing) {
        this.recentRequests.delete(request.requestId);
      }
      if (isPeerEnded()) {
        return undefined;
      }
      return this.acceptRequest(request, isPeerEnded);
    }

    const completion = this.enqueueDelivery(request, isPeerEnded).catch((error: unknown) =>
      buildMailboxFailureAcknowledgement(
        request.requestId,
        'connection_failed',
        `Mailbox delivery failed: ${sanitizeErrorMessage(error, 'delivery callback failed')}`
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
    if (acknowledgement === undefined) {
      if (this.recentRequests.get(request.requestId) === recentRequest) {
        this.recentRequests.delete(request.requestId);
      }
      return undefined;
    }
    recentRequest.completed = true;
    this.trimRecentRequests();
    return acknowledgement;
  }

  /** Serialize delivery callbacks so one recipient observes one FIFO order. */
  private enqueueDelivery(
    request: MailboxMessageRequest,
    isPeerEnded: () => boolean
  ): Promise<MailboxAcknowledgement | undefined> {
    const completion = this.deliveryTail.then(() => this.deliverRequest(request, isPeerEnded));
    this.deliveryTail = completion.then(
      (): void => undefined,
      (): void => undefined
    );
    return completion;
  }

  /**
   * Validate and deliver one request. Once the delivery callback is invoked,
   * this method always returns a concrete acknowledgement so the dedup history
   * retains a stable result — even if the original client aborts mid-delivery.
   * The only path that returns `undefined` is the immediate-FIN rule: the peer
   * ended before source validation and delivery began, so no callback ran and
   * the request ID is not permanently reserved.
   */
  private async deliverRequest(
    request: MailboxMessageRequest,
    isPeerEnded: () => boolean
  ): Promise<MailboxAcknowledgement | undefined> {
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
    if (this.closed) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'runtime_closed',
        'Mailbox receiver is closed'
      );
    }
    if (sourceRegistration === undefined) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'unknown_source',
        'Mailbox source is not an active registered identity'
      );
    }
    if (isPeerEnded()) {
      return undefined;
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
    if (this.closed) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'runtime_closed',
        'Mailbox receiver is closed'
      );
    }
    if (isPeerEnded()) {
      return undefined;
    }

    // Past this point, the delivery callback will be invoked. Any peer abort
    // after this must still produce a concrete acknowledgement so the dedup
    // history retains a stable result and never invokes the callback again.
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
        `Mailbox delivery failed: ${sanitizeErrorMessage(error, 'delivery callback failed')}`
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
    if (
      this.pending.length + this.pendingDeliveryReservations.size >=
      MAX_PENDING_MESSAGES_PER_RECIPIENT
    ) {
      return buildMailboxFailureAcknowledgement(
        request.requestId,
        'queue_full',
        `Mailbox pending queue is full at ${MAX_PENDING_MESSAGES_PER_RECIPIENT} messages`
      );
    }

    const trustedSourceRegistration = Object.freeze({ ...sourceRegistration });
    this.pending.push(
      Object.freeze({
        request: trustedRequest,
        sourceRegistration: trustedSourceRegistration,
      })
    );
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

  private async closeInternal(): Promise<void> {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.activeConnections.clear();
    this.pending.length = 0;
    this.pendingDeliveryReservations.clear();
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
