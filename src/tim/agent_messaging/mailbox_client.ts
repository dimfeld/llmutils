import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { MailboxJsonlDecoder } from './mailbox_framing.js';
import { isRecord, sanitizeErrorMessage } from './mailbox_helpers.js';
import {
  MailboxProtocolError,
  buildMailboxMessageRequest,
  encodeMailboxFrame,
  mailboxIdentitySchema,
  parseMailboxSendMessageInput,
  parseMailboxAcknowledgement,
  parseMailboxFrame,
  type MailboxSendMessageInput,
  type MailboxAcknowledgement,
  type MailboxIdentity,
} from './mailbox_protocol.js';
import {
  createMailboxTargetSnapshot,
  mapTargetSnapshotError,
  validateMailboxSocketIdentity,
  validateMailboxTargetSnapshot,
  type MailboxTargetSnapshot,
} from './mailbox_target.js';
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

export interface MailboxClientTiming {
  readonly connectionTimeoutMs: number;
  readonly acknowledgementTimeoutMs: number;
}

export type MailboxClientTimingOptions = Partial<MailboxClientTiming>;

export interface MailboxTargetReference {
  readonly name: string;
  readonly id?: string;
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

const MAILBOX_CLIENT_OPTION_KEYS = new Set([
  'runtime',
  'resolveSourceRegistration',
  'resolveTargetRegistration',
  'connectionTimeoutMs',
  'acknowledgementTimeoutMs',
]);
const MAILBOX_TARGET_KEYS = new Set(['name', 'id']);

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

/** Parse the canonical client timing options once at the client boundary. */
export function normalizeMailboxClientTiming(value: unknown): MailboxClientTiming {
  if (!isRecord(value)) {
    throw new TypeError('Mailbox client timing options must be an object');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'connectionTimeoutMs' && key !== 'acknowledgementTimeoutMs') {
      throw new TypeError(`Mailbox client timing options contain an unsupported field: ${key}`);
    }
  }
  return {
    connectionTimeoutMs: validateTimeout(
      value.connectionTimeoutMs === undefined
        ? DEFAULT_MAILBOX_CONNECTION_TIMEOUT_MS
        : value.connectionTimeoutMs,
      'connectionTimeoutMs'
    ),
    acknowledgementTimeoutMs: validateTimeout(
      value.acknowledgementTimeoutMs === undefined
        ? DEFAULT_MAILBOX_ACKNOWLEDGEMENT_TIMEOUT_MS
        : value.acknowledgementTimeoutMs,
      'acknowledgementTimeoutMs'
    ),
  };
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
    `${context}: ${sanitizeErrorMessage(error, context)}`
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
      : `The target mailbox connection failed: ${sanitizeErrorMessage(error, 'connection failed')}`
  );
}

function mapAcknowledgementError(error: unknown): MailboxProtocolError {
  if (error instanceof MailboxProtocolError && error.code === 'runtime_closed') {
    return error;
  }
  return new MailboxProtocolError(
    'invalid_ack',
    `The target returned an invalid mailbox acknowledgement: ${sanitizeErrorMessage(
      error,
      'invalid acknowledgement'
    )}`
  );
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
    const timing = normalizeMailboxClientTiming({
      connectionTimeoutMs: options.connectionTimeoutMs,
      acknowledgementTimeoutMs: options.acknowledgementTimeoutMs,
    });
    this.connectionTimeoutMs = timing.connectionTimeoutMs;
    this.acknowledgementTimeoutMs = timing.acknowledgementTimeoutMs;
  }

  public async sendMessage(
    trustedSource: MailboxIdentity,
    target: MailboxTargetReference,
    input: MailboxSendMessageInput
  ): Promise<MailboxAcknowledgement> {
    const validatedInput = parseMailboxSendMessageInput(input);
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
        `Mailbox source registration is invalid: ${sanitizeErrorMessage(error, 'invalid source')}`
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
        `Mailbox source registration is invalid: ${sanitizeErrorMessage(error, 'invalid source')}`
      );
    }
    if (sourceRegistration.socketPath !== expectedSourceSocketPath) {
      throw new MailboxProtocolError(
        'unknown_source',
        'Mailbox source registration socket path is invalid'
      );
    }
    try {
      await validateMailboxSocketIdentity(this.runtime, expectedSourceSocketPath);
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
        `Mailbox target registration is invalid: ${sanitizeErrorMessage(error, 'invalid target')}`
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

    let targetSnapshot: MailboxTargetSnapshot;
    try {
      targetSnapshot = await createMailboxTargetSnapshot(this.runtime, targetRegistration);
    } catch (error) {
      throw mapTargetSnapshotError(error, 'Mailbox target is stale');
    }
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
    return this.exchange(targetSnapshot, encoded, request.requestId);
  }

  private exchange(
    target: MailboxTargetSnapshot,
    encodedRequest: string,
    requestId: string
  ): Promise<MailboxAcknowledgement> {
    return new Promise<MailboxAcknowledgement>((resolve, reject) => {
      let socket: net.Socket;
      try {
        socket = net.createConnection(target.socketPath);
      } catch (error) {
        reject(mapSocketError(error, false));
        return;
      }

      const decoder = new MailboxJsonlDecoder({ maxFrames: 1 });
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
            await validateMailboxTargetSnapshot(this.runtime, target);
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
            // Keep the request connection open until the receiver sends its
            // acknowledgement. Bun does not reliably support peer FIN before
            // the response on an accepted Unix socket.
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
    `Mailbox source could not be resolved: ${sanitizeErrorMessage(error, 'unknown source')}`
  );
}

function mapTargetResolutionError(error: unknown): MailboxProtocolError {
  if (error instanceof MailboxProtocolError && error.code === 'runtime_closed') {
    return error;
  }
  return new MailboxProtocolError(
    'unknown_target',
    `Mailbox target could not be resolved: ${sanitizeErrorMessage(error, 'unknown target')}`
  );
}
