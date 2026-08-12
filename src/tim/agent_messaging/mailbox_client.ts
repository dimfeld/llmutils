import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';

import { MailboxConnectionFramePolicy, MailboxJsonlDecoder } from './mailbox_framing.js';
import {
  MailboxProtocolError,
  buildMailboxMessageRequest,
  encodeMailboxFrame,
  mailboxIdentitySchema,
  parseMailboxAcknowledgement,
  parseMailboxFrame,
  type MailboxAcknowledgement,
  type MailboxIdentity,
} from './mailbox_protocol.js';
import {
  AgentMessagingRuntimeDirectory,
  AgentMessagingRuntimeDirectoryError,
  parseAgentRegistration,
  type AgentRegistration,
} from './runtime_dir.js';
import { agentAddressSchema, agentIdSchema } from './contracts.js';
import type { MailboxSourceRegistrationResolver } from './mailbox_server.js';

export const DEFAULT_MAILBOX_CONNECTION_TIMEOUT_MS = 5_000;
export const DEFAULT_MAILBOX_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
const MAX_MAILBOX_TIMEOUT_MS = 120_000;

export interface MailboxTargetReference {
  readonly name: string;
  readonly id?: string;
}

export interface MailboxSendMessageInput {
  readonly content: string;
  readonly requestId?: string;
  readonly timestamp?: string;
}

export type MailboxTargetRegistrationResolver = (
  target: MailboxTargetReference
) => AgentRegistration | undefined | Promise<AgentRegistration | undefined>;

export interface MailboxClientOptions {
  readonly runtime: AgentMessagingRuntimeDirectory;
  readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  readonly resolveTargetRegistration: MailboxTargetRegistrationResolver;
  readonly connectionTimeoutMs?: number;
  readonly acknowledgementTimeoutMs?: number;
}

interface NodeSocketError extends Error {
  readonly code?: string;
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

const MAILBOX_CLIENT_OPTION_KEYS = new Set([
  'runtime',
  'resolveSourceRegistration',
  'resolveTargetRegistration',
  'connectionTimeoutMs',
  'acknowledgementTimeoutMs',
]);
const MAILBOX_SEND_INPUT_KEYS = new Set(['content', 'requestId', 'timestamp']);
const MAILBOX_TARGET_KEYS = new Set(['name', 'id']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string,
  errorCode: MailboxProtocolError['code']
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new MailboxProtocolError(errorCode, `${label} contains an unsupported field: ${key}`);
    }
  }
}

function safeErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  let safe = '';
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
  }
  return safe.slice(0, 512) || fallback;
}

function validateTimeout(value: unknown, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > MAX_MAILBOX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `${label} must be a safe integer from 1 through ${MAX_MAILBOX_TIMEOUT_MS}`
    );
  }
  return value as number;
}

function mapRuntimeError(error: unknown, context: string): MailboxProtocolError {
  if (error instanceof MailboxProtocolError) {
    return error;
  }
  if (error instanceof AgentMessagingRuntimeDirectoryError && error.code === 'runtime_closed') {
    return new MailboxProtocolError('runtime_closed', 'The agent messaging runtime is closed');
  }
  return new MailboxProtocolError(
    'target_stale',
    `${context}: ${safeErrorMessage(error, context)}`
  );
}

function mapSocketError(error: unknown, connected: boolean): MailboxProtocolError {
  const socketError = isRecord(error) ? (error as unknown as NodeSocketError) : undefined;
  const code = socketError?.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') {
    return new MailboxProtocolError(
      'target_stale',
      'The target mailbox socket is missing or no longer accepting connections'
    );
  }
  if (code === 'ETIMEDOUT') {
    return new MailboxProtocolError(
      'connection_failed',
      'The target mailbox connection timed out before acknowledgement'
    );
  }
  return new MailboxProtocolError(
    'connection_failed',
    connected
      ? 'The target mailbox connection closed before acknowledgement'
      : `The target mailbox connection failed: ${safeErrorMessage(error, 'connection failed')}`
  );
}

function mapAcknowledgementError(error: unknown): MailboxProtocolError {
  if (error instanceof MailboxProtocolError && error.code === 'runtime_closed') {
    return error;
  }
  return new MailboxProtocolError(
    'invalid_ack',
    `The target returned an invalid mailbox acknowledgement: ${safeErrorMessage(
      error,
      'invalid acknowledgement'
    )}`
  );
}

function registrationMatches(left: AgentRegistration, right: AgentRegistration): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.role !== right.role ||
    left.executor !== right.executor ||
    left.state !== right.state ||
    left.socketPath !== right.socketPath
  ) {
    return false;
  }
  if (left.role === 'subagent' && right.role === 'subagent') {
    return left.type === right.type;
  }
  return left.role === right.role;
}

function validateTargetReference(target: MailboxTargetReference): MailboxTargetReference {
  if (!isRecord(target)) {
    throw new MailboxProtocolError('unknown_target', 'Mailbox target must be an object');
  }
  assertKnownKeys(target, MAILBOX_TARGET_KEYS, 'Mailbox target', 'unknown_target');
  const nameResult = agentAddressSchema.safeParse(target.name);
  if (!nameResult.success) {
    throw new MailboxProtocolError('unknown_target', 'Mailbox target name is invalid');
  }
  if (target.id !== undefined && !agentIdSchema.safeParse(target.id).success) {
    throw new MailboxProtocolError('unknown_target', 'Mailbox target ID is invalid');
  }
  return {
    name: nameResult.data,
    ...(target.id === undefined ? {} : { id: target.id }),
  };
}

function validateSendInput(input: MailboxSendMessageInput): MailboxSendMessageInput {
  if (!isRecord(input)) {
    throw new MailboxProtocolError('invalid_message', 'Mailbox send input must be an object');
  }
  assertKnownKeys(input, MAILBOX_SEND_INPUT_KEYS, 'Mailbox send input', 'invalid_message');

  try {
    // Use the canonical request builder to validate all public input fields
    // before resolving identities or inspecting a target socket.
    buildMailboxMessageRequest(
      { id: 'input-validation', name: 'input-validation' },
      {
        requestId: input.requestId === undefined ? 'input-validation-request' : input.requestId,
        targetId: 'input-validation-target',
        targetName: 'input-validation-target',
        content: input.content,
        timestamp: input.timestamp === undefined ? undefined : input.timestamp,
      }
    );
  } catch (error) {
    if (error instanceof MailboxProtocolError) {
      throw error;
    }
    throw new MailboxProtocolError(
      'invalid_message',
      `Mailbox send input is invalid: ${safeErrorMessage(error, 'invalid message')}`
    );
  }

  return {
    content: input.content,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
  };
}

function socketIdentity(stats: { dev: number; ino: number }): SocketIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameSocketIdentity(left: SocketIdentity, right: SocketIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Sends one bounded mailbox request to one exact registration snapshot. */
export class MailboxClient {
  private readonly runtime: AgentMessagingRuntimeDirectory;
  private readonly resolveSourceRegistration: MailboxSourceRegistrationResolver;
  private readonly resolveTargetRegistration: MailboxTargetRegistrationResolver;
  private readonly connectionTimeoutMs: number;
  private readonly acknowledgementTimeoutMs: number;

  public constructor(options: MailboxClientOptions) {
    if (!isRecord(options)) {
      throw new TypeError('Mailbox client options must be an object');
    }
    assertKnownKeys(
      options,
      MAILBOX_CLIENT_OPTION_KEYS,
      'Mailbox client options',
      'invalid_message'
    );
    if (!(options.runtime instanceof AgentMessagingRuntimeDirectory)) {
      throw new TypeError('Mailbox client runtime must be an agent messaging runtime directory');
    }
    if (typeof options.resolveSourceRegistration !== 'function') {
      throw new TypeError('Mailbox client source resolver must be a function');
    }
    if (typeof options.resolveTargetRegistration !== 'function') {
      throw new TypeError('Mailbox client target resolver must be a function');
    }

    this.runtime = options.runtime;
    this.resolveSourceRegistration = options.resolveSourceRegistration;
    this.resolveTargetRegistration = options.resolveTargetRegistration;
    this.connectionTimeoutMs = validateTimeout(
      options.connectionTimeoutMs === undefined
        ? DEFAULT_MAILBOX_CONNECTION_TIMEOUT_MS
        : options.connectionTimeoutMs,
      'connectionTimeoutMs'
    );
    this.acknowledgementTimeoutMs = validateTimeout(
      options.acknowledgementTimeoutMs === undefined
        ? DEFAULT_MAILBOX_ACKNOWLEDGEMENT_TIMEOUT_MS
        : options.acknowledgementTimeoutMs,
      'acknowledgementTimeoutMs'
    );
  }

  public async sendMessage(
    trustedSource: MailboxIdentity,
    target: MailboxTargetReference,
    input: MailboxSendMessageInput
  ): Promise<MailboxAcknowledgement> {
    const validatedInput = validateSendInput(input);
    const sourceResult = mailboxIdentitySchema.safeParse(trustedSource);
    if (!sourceResult.success) {
      throw new MailboxProtocolError('unknown_source', 'Mailbox source identity is invalid');
    }
    const targetReference = validateTargetReference(target);

    let sourceRegistration: AgentRegistration | undefined;
    try {
      sourceRegistration = await this.resolveSourceRegistration(
        sourceResult.data.id,
        sourceResult.data.name
      );
    } catch (error) {
      throw mapSourceResolutionError(error);
    }
    if (sourceRegistration === undefined) {
      throw new MailboxProtocolError(
        'unknown_source',
        'Mailbox source is not an active registered identity'
      );
    }
    try {
      sourceRegistration = parseAgentRegistration(sourceRegistration);
    } catch (error) {
      throw new MailboxProtocolError(
        'unknown_source',
        `Mailbox source registration is invalid: ${safeErrorMessage(error, 'invalid source')}`
      );
    }
    if (
      sourceRegistration.id !== sourceResult.data.id ||
      sourceRegistration.name !== sourceResult.data.name
    ) {
      throw new MailboxProtocolError(
        'unknown_source',
        'Mailbox source identity does not match its active registration'
      );
    }
    let expectedSourceSocketPath: string;
    try {
      expectedSourceSocketPath = this.runtime.socketPath(sourceRegistration.id);
    } catch (error) {
      throw new MailboxProtocolError(
        'unknown_source',
        `Mailbox source registration is invalid: ${safeErrorMessage(error, 'invalid source')}`
      );
    }
    if (sourceRegistration.socketPath !== expectedSourceSocketPath) {
      throw new MailboxProtocolError(
        'unknown_source',
        'Mailbox source registration socket path is invalid'
      );
    }
    try {
      await this.runtime.validateSocketPath(expectedSourceSocketPath, {
        allowMissing: false,
        requireSocket: true,
      });
    } catch (error) {
      const mapped = mapRuntimeError(error, 'Mailbox source socket is stale');
      if (mapped.code === 'runtime_closed') {
        throw mapped;
      }
      throw new MailboxProtocolError('unknown_source', 'Mailbox source is not ready');
    }

    let targetRegistration: AgentRegistration | undefined;
    try {
      targetRegistration = await this.resolveTargetRegistration(targetReference);
    } catch (error) {
      throw mapTargetResolutionError(error);
    }
    if (targetRegistration === undefined) {
      throw new MailboxProtocolError(
        'unknown_target',
        'Mailbox target is not an active registered identity'
      );
    }
    try {
      targetRegistration = parseAgentRegistration(targetRegistration);
    } catch (error) {
      throw new MailboxProtocolError(
        'target_stale',
        `Mailbox target registration is invalid: ${safeErrorMessage(error, 'invalid target')}`
      );
    }
    if (
      targetRegistration.name !== targetReference.name ||
      (targetReference.id !== undefined && targetRegistration.id !== targetReference.id)
    ) {
      throw new MailboxProtocolError(
        'unknown_target',
        'Mailbox target does not match the requested active identity'
      );
    }

    const targetSnapshot = await this.validateTargetSnapshot(targetRegistration);
    const request = buildMailboxMessageRequest(
      { id: sourceRegistration.id, name: sourceRegistration.name },
      {
        requestId: validatedInput.requestId ?? randomUUID(),
        targetId: targetSnapshot.registration.id,
        targetName: targetSnapshot.registration.name,
        content: validatedInput.content,
        timestamp: validatedInput.timestamp,
      }
    );
    const encoded = encodeMailboxFrame(request);
    return this.exchange(
      targetSnapshot.registration,
      targetSnapshot.socketIdentity,
      targetSnapshot.registration.socketPath,
      encoded,
      request.requestId
    );
  }

  public send(
    trustedSource: MailboxIdentity,
    target: MailboxTargetReference,
    input: MailboxSendMessageInput
  ): Promise<MailboxAcknowledgement> {
    return this.sendMessage(trustedSource, target, input);
  }

  private async validateTargetSnapshot(
    target: AgentRegistration
  ): Promise<{ registration: AgentRegistration; socketIdentity: SocketIdentity }> {
    let expectedSocketPath: string;
    try {
      expectedSocketPath = this.runtime.socketPath(target.id);
    } catch (error) {
      throw mapRuntimeError(error, 'Mailbox target socket is stale');
    }
    if (target.socketPath !== expectedSocketPath) {
      throw new MailboxProtocolError(
        'target_stale',
        'Mailbox target socket path does not match its opaque ID'
      );
    }

    let published: AgentRegistration;
    try {
      published = await this.runtime.readRegistration(target.id);
    } catch (error) {
      throw mapRuntimeError(error, 'Mailbox target registration is stale');
    }
    if (!registrationMatches(published, target)) {
      throw new MailboxProtocolError(
        'target_stale',
        'Mailbox target registration changed before delivery'
      );
    }
    try {
      await this.runtime.validateSocketPath(expectedSocketPath, {
        allowMissing: false,
        requireSocket: true,
      });
    } catch (error) {
      throw mapRuntimeError(error, 'Mailbox target socket is stale');
    }
    let stats;
    try {
      stats = await fs.lstat(expectedSocketPath);
    } catch (error) {
      throw mapRuntimeError(error, 'Mailbox target socket is stale');
    }
    if (stats.isSymbolicLink() || !stats.isSocket()) {
      throw new MailboxProtocolError(
        'target_stale',
        'Mailbox target socket is missing or is not a Unix socket'
      );
    }
    return { registration: target, socketIdentity: socketIdentity(stats) };
  }

  private exchange(
    target: AgentRegistration,
    expectedSocketIdentity: SocketIdentity,
    socketPath: string,
    encodedRequest: string,
    requestId: string
  ): Promise<MailboxAcknowledgement> {
    return new Promise<MailboxAcknowledgement>((resolve, reject) => {
      let socket: net.Socket;
      try {
        socket = net.createConnection(socketPath);
      } catch (error) {
        reject(mapSocketError(error, false));
        return;
      }

      const decoder = new MailboxJsonlDecoder({ maxFrames: 1 });
      const framePolicy = new MailboxConnectionFramePolicy('ack');
      let connected = false;
      let receivedData = false;
      let settled = false;
      let connectionTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
        settleReject(
          new MailboxProtocolError(
            'connection_failed',
            'The target mailbox connection timed out before it was established'
          )
        );
      }, this.connectionTimeoutMs);
      let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;

      const clearTimers = (): void => {
        if (connectionTimer !== undefined) {
          clearTimeout(connectionTimer);
          connectionTimer = undefined;
        }
        if (acknowledgementTimer !== undefined) {
          clearTimeout(acknowledgementTimer);
          acknowledgementTimer = undefined;
        }
      };
      const settleResolve = (acknowledgement: MailboxAcknowledgement): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        resolve(acknowledgement);
        if (!socket.destroyed) {
          socket.end();
        }
      };
      const settleReject = (error: MailboxProtocolError): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimers();
        reject(error);
        socket.destroy();
      };

      socket.setNoDelay(true);
      socket.once('connect', () => {
        connected = true;
        if (connectionTimer !== undefined) {
          clearTimeout(connectionTimer);
          connectionTimer = undefined;
        }
        void (async (): Promise<void> => {
          try {
            await this.runtime.validateSocketPath(socketPath, {
              allowMissing: false,
              requireSocket: true,
            });
            const currentStats = await fs.lstat(socketPath);
            if (
              currentStats.isSymbolicLink() ||
              !currentStats.isSocket() ||
              !sameSocketIdentity(expectedSocketIdentity, socketIdentity(currentStats))
            ) {
              throw new MailboxProtocolError(
                'target_stale',
                'Mailbox target socket was replaced before delivery'
              );
            }
            const published = await this.runtime.readRegistration(target.id);
            if (!registrationMatches(published, target)) {
              throw new MailboxProtocolError(
                'target_stale',
                'Mailbox target registration changed before delivery'
              );
            }
            await this.runtime.validateSocketPath(socketPath, {
              allowMissing: false,
              requireSocket: true,
            });
            const finalStats = await fs.lstat(socketPath);
            if (
              finalStats.isSymbolicLink() ||
              !finalStats.isSocket() ||
              !sameSocketIdentity(expectedSocketIdentity, socketIdentity(finalStats))
            ) {
              throw new MailboxProtocolError(
                'target_stale',
                'Mailbox target socket was replaced before delivery'
              );
            }
            if (settled) {
              return;
            }
            acknowledgementTimer = setTimeout(() => {
              settleReject(
                new MailboxProtocolError(
                  'ack_timeout',
                  'The target mailbox did not acknowledge the request before the deadline'
                )
              );
            }, this.acknowledgementTimeoutMs);
            socket.write(encodedRequest);
          } catch (error) {
            if (settled) {
              return;
            }
            if (error instanceof MailboxProtocolError) {
              settleReject(error);
            } else {
              settleReject(mapRuntimeError(error, 'Mailbox target became stale'));
            }
          }
        })();
      });
      socket.on('data', (chunk: Buffer) => {
        if (settled) {
          return;
        }
        receivedData = true;
        let lines: string[];
        try {
          lines = decoder.push(chunk);
          for (const line of lines) {
            const frame = parseMailboxFrame(line);
            framePolicy.accept(frame);
            const acknowledgement = parseMailboxAcknowledgement(frame);
            if (acknowledgement.requestId !== requestId) {
              throw new MailboxProtocolError(
                'invalid_ack',
                'Mailbox acknowledgement requestId does not match the request'
              );
            }
            settleResolve(acknowledgement);
          }
        } catch (error) {
          settleReject(mapAcknowledgementError(error));
        }
      });
      socket.once('end', () => {
        if (settled) {
          return;
        }
        if (!receivedData) {
          settleReject(mapSocketError(undefined, connected));
          return;
        }
        try {
          decoder.finish();
          settleReject(
            new MailboxProtocolError(
              'invalid_ack',
              'The target mailbox closed without one complete acknowledgement'
            )
          );
        } catch (error) {
          settleReject(mapAcknowledgementError(error));
        }
      });
      socket.once('close', () => {
        if (!settled) {
          settleReject(mapSocketError(undefined, connected));
        }
      });
      socket.once('error', (error: NodeSocketError) => {
        if (!settled) {
          settleReject(mapSocketError(error, connected));
        }
      });
    });
  }
}

function mapSourceResolutionError(error: unknown): MailboxProtocolError {
  if (error instanceof MailboxProtocolError && error.code === 'runtime_closed') {
    return error;
  }
  return new MailboxProtocolError(
    'unknown_source',
    `Mailbox source could not be resolved: ${safeErrorMessage(error, 'unknown source')}`
  );
}

function mapTargetResolutionError(error: unknown): MailboxProtocolError {
  if (error instanceof MailboxProtocolError && error.code === 'runtime_closed') {
    return error;
  }
  return new MailboxProtocolError(
    'unknown_target',
    `Mailbox target could not be resolved: ${safeErrorMessage(error, 'unknown target')}`
  );
}

export function createMailboxClient(options: MailboxClientOptions): MailboxClient {
  return new MailboxClient(options);
}
