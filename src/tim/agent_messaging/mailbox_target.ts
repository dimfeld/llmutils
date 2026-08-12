import { promises as fs } from 'node:fs';

import {
  fileIdentity,
  sameFileIdentity,
  sanitizeErrorMessage,
  type FileIdentity,
} from './mailbox_helpers.js';
import { MailboxProtocolError } from './mailbox_protocol.js';
import {
  AgentMessagingRuntimeDirectory,
  AgentMessagingRuntimeDirectoryError,
  sameAgentRegistration,
  type AgentRegistration,
} from './runtime_dir.js';

export type { FileIdentity } from './mailbox_helpers.js';

export interface SocketIdentity extends FileIdentity {}

/** Immutable registration and socket identities bound to one send attempt. */
export interface MailboxTargetSnapshot {
  readonly registration: AgentRegistration;
  readonly registrationFileIdentity: FileIdentity;
  readonly socketPath: string;
  readonly socketIdentity: SocketIdentity;
}

function staleTarget(message: string): MailboxProtocolError {
  return new MailboxProtocolError('target_stale', message);
}

async function readRegistrationFileIdentity(
  runtime: AgentMessagingRuntimeDirectory,
  agentId: string
): Promise<FileIdentity> {
  const registrationPath = runtime.registrationPath(agentId);
  const stats = await fs.lstat(registrationPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw staleTarget('Mailbox target registration is not a regular file');
  }
  return fileIdentity(stats);
}

export async function readMailboxRegistrationSnapshot(
  runtime: AgentMessagingRuntimeDirectory,
  agentId: string
): Promise<{ readonly registration: AgentRegistration; readonly fileIdentity: FileIdentity }> {
  const registration = await runtime.readRegistration(agentId);
  const fileIdentity = await readRegistrationFileIdentity(runtime, agentId);
  return { registration, fileIdentity };
}

/** Read and validate one contained Unix socket, optionally against an inode snapshot. */
export async function validateMailboxSocketIdentity(
  runtime: AgentMessagingRuntimeDirectory,
  socketPath: string,
  expectedIdentity?: SocketIdentity
): Promise<SocketIdentity> {
  await runtime.validateSocketPath(socketPath, { allowMissing: false, requireSocket: true });
  const stats = await fs.lstat(socketPath);
  if (stats.isSymbolicLink() || !stats.isSocket()) {
    throw staleTarget('Mailbox target socket is missing or is not a Unix socket');
  }
  const identity = fileIdentity(stats);
  if (expectedIdentity !== undefined && !sameFileIdentity(identity, expectedIdentity)) {
    throw staleTarget('Mailbox target socket was replaced before delivery');
  }
  return identity;
}

/**
 * Capture an immutable target generation. The returned registration is copied
 * and frozen so later resolver mutations cannot change the request target.
 */
export async function createMailboxTargetSnapshot(
  runtime: AgentMessagingRuntimeDirectory,
  registration: AgentRegistration
): Promise<MailboxTargetSnapshot> {
  const expectedSocketPath = runtime.socketPath(registration.id);
  if (registration.socketPath !== expectedSocketPath) {
    throw staleTarget('Mailbox target socket path does not match its opaque ID');
  }

  const published = await readMailboxRegistrationSnapshot(runtime, registration.id);
  if (!sameAgentRegistration(published.registration, registration)) {
    throw staleTarget('Mailbox target registration changed before delivery');
  }
  const socketIdentity = await validateMailboxSocketIdentity(runtime, expectedSocketPath);
  const frozenRegistration = Object.freeze({ ...registration });
  return Object.freeze({
    registration: frozenRegistration,
    registrationFileIdentity: published.fileIdentity,
    socketPath: expectedSocketPath,
    socketIdentity,
  });
}

/**
 * Preserve the socket-registration-socket race check immediately before the
 * request is written to the connected socket.
 */
export async function validateMailboxTargetSnapshot(
  runtime: AgentMessagingRuntimeDirectory,
  snapshot: MailboxTargetSnapshot
): Promise<void> {
  await validateMailboxSocketIdentity(runtime, snapshot.socketPath, snapshot.socketIdentity);

  const published = await readMailboxRegistrationSnapshot(runtime, snapshot.registration.id);
  if (
    !sameFileIdentity(published.fileIdentity, snapshot.registrationFileIdentity) ||
    !sameAgentRegistration(published.registration, snapshot.registration)
  ) {
    throw staleTarget('Mailbox target registration changed before delivery');
  }

  await validateMailboxSocketIdentity(runtime, snapshot.socketPath, snapshot.socketIdentity);
}

export function mapTargetSnapshotError(error: unknown, fallback: string): MailboxProtocolError {
  if (error instanceof MailboxProtocolError) {
    return error;
  }
  if (error instanceof AgentMessagingRuntimeDirectoryError && error.code === 'runtime_closed') {
    return new MailboxProtocolError('runtime_closed', 'The agent messaging runtime is closed');
  }
  return new MailboxProtocolError(
    'target_stale',
    `${fallback}: ${sanitizeErrorMessage(error, fallback)}`
  );
}
