import { promises as fs } from 'node:fs';

import {
  MailboxClient,
  type MailboxClientOptions,
  type MailboxSendMessageInput,
  type MailboxTargetReference,
} from './mailbox_client.js';
import {
  createMailboxReceiver,
  type MailboxDeliveryCallback,
  type MailboxReceiver,
} from './mailbox_server.js';
import {
  AgentMessagingRuntimeDirectory,
  AgentMessagingRuntimeDirectoryError,
  type AgentRegistration,
  type AgentRegistrationDraft,
} from './runtime_dir.js';
import {
  MailboxProtocolError,
  type MailboxAcknowledgement,
  type MailboxIdentity,
} from './mailbox_protocol.js';

export interface AgentMessagingSessionRuntimeOptions extends Omit<
  MailboxClientOptions,
  'runtime' | 'resolveSourceRegistration' | 'resolveTargetRegistration'
> {}

export interface RegisterMailboxOptions {
  readonly registration: AgentRegistrationDraft;
  readonly deliver: MailboxDeliveryCallback;
  readonly maxConnections?: number;
  readonly recentRequestIdLimit?: number;
}

export interface SessionRegistrationHandle {
  readonly registration: AgentRegistration;
  readonly receiver: MailboxReceiver;
  readonly ready: Promise<void>;
  deregister(): Promise<void>;
}

export type SessionRegistrationReference = string | SessionRegistrationHandle | AgentRegistration;

export type SessionRuntimeErrorCode =
  | 'runtime_closed'
  | 'identity_reserved'
  | 'registration_conflict'
  | 'registration_failed'
  | 'invalid_options';

export class AgentMessagingSessionRuntimeError extends Error {
  public readonly code: SessionRuntimeErrorCode;

  public constructor(code: SessionRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'AgentMessagingSessionRuntimeError';
    this.code = code;
  }
}

interface RegistrationEntry {
  readonly registration: AgentRegistration;
  receiver: MailboxReceiver | undefined;
  published: boolean;
  cancelled: boolean;
  cleanupPromise: Promise<void> | undefined;
  startupPromise: Promise<SessionRegistrationHandle> | undefined;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

const SESSION_RUNTIME_OPTION_KEYS = new Set(['connectionTimeoutMs', 'acknowledgementTimeoutMs']);
const REGISTER_MAILBOX_OPTION_KEYS = new Set([
  'registration',
  'deliver',
  'maxConnections',
  'recentRequestIdLimit',
]);
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_RECENT_REQUEST_ID_LIMIT = 256;
const MAX_RECEIVER_CONNECTIONS = 1024;
const MAX_RECENT_REQUEST_ID_LIMIT = 4096;
const MAX_MAILBOX_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>,
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new AgentMessagingSessionRuntimeError(
        'invalid_options',
        `${label} contains an unsupported field: ${key}`
      );
    }
  }
}

function validateBoundedInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new AgentMessagingSessionRuntimeError(
      'invalid_options',
      `${label} must be a safe integer from 1 through ${maximum}`
    );
  }
  return value as number;
}

function validateSessionOptions(options: Record<string, unknown>): void {
  assertKnownKeys(options, SESSION_RUNTIME_OPTION_KEYS, 'Session runtime options');
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      validateBoundedInteger(value, key, MAX_MAILBOX_TIMEOUT_MS);
    }
  }
}

function validateRegisterOptions(options: Record<string, unknown>): void {
  assertKnownKeys(options, REGISTER_MAILBOX_OPTION_KEYS, 'Mailbox registration options');
  const maxConnections = validateBoundedInteger(
    options.maxConnections === undefined ? DEFAULT_MAX_CONNECTIONS : options.maxConnections,
    'maxConnections',
    MAX_RECEIVER_CONNECTIONS
  );
  const recentRequestIdLimit = validateBoundedInteger(
    options.recentRequestIdLimit === undefined
      ? DEFAULT_RECENT_REQUEST_ID_LIMIT
      : options.recentRequestIdLimit,
    'recentRequestIdLimit',
    MAX_RECENT_REQUEST_ID_LIMIT
  );
  if (recentRequestIdLimit < maxConnections) {
    throw new AgentMessagingSessionRuntimeError(
      'invalid_options',
      'recentRequestIdLimit must be at least maxConnections so in-flight requests remain deduplicated'
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function fileIdentity(stats: { dev: number; ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
  return left.role === 'subagent' && right.role === 'subagent'
    ? left.type === right.type
    : left.role === right.role;
}

function describeError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  let safe = '';
  for (const character of raw) {
    const codePoint = character.codePointAt(0);
    safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? ' ' : character;
  }
  return safe.slice(0, 512) || fallback;
}

/** Owns active registrations, receiver publication, and the session root. */
export class AgentMessagingSessionRuntime {
  public readonly runtime: AgentMessagingRuntimeDirectory;
  public readonly client: MailboxClient;

  private readonly byId = new Map<string, RegistrationEntry>();
  private readonly byName = new Map<string, RegistrationEntry>();
  private readonly entries = new Set<RegistrationEntry>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(
    runtime: AgentMessagingRuntimeDirectory,
    clientOptions: AgentMessagingSessionRuntimeOptions
  ) {
    this.runtime = runtime;
    this.client = new MailboxClient({
      ...clientOptions,
      runtime,
      resolveSourceRegistration: (sourceId, sourceName) =>
        this.resolveSourceRegistration(sourceId, sourceName),
      resolveTargetRegistration: (target) => this.resolveTargetRegistration(target),
    });
  }

  public static async create(
    options: AgentMessagingSessionRuntimeOptions = {}
  ): Promise<AgentMessagingSessionRuntime> {
    if (!isRecord(options)) {
      throw new AgentMessagingSessionRuntimeError(
        'invalid_options',
        'Agent messaging session runtime options must be an object'
      );
    }
    validateSessionOptions(options);
    const runtime = await AgentMessagingRuntimeDirectory.create();
    try {
      return new AgentMessagingSessionRuntime(runtime, options);
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  public static createRuntime(
    options: AgentMessagingSessionRuntimeOptions = {}
  ): Promise<AgentMessagingSessionRuntime> {
    return AgentMessagingSessionRuntime.create(options);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public async register(options: RegisterMailboxOptions): Promise<SessionRegistrationHandle> {
    this.ensureOpen();
    if (!isRecord(options) || typeof options.deliver !== 'function') {
      throw new AgentMessagingSessionRuntimeError(
        'invalid_options',
        'Mailbox registration options must include a delivery callback'
      );
    }
    validateRegisterOptions(options);

    // This validates all identity and derived-path fields before the local
    // reservation or receiver allocates a socket.
    const registration = this.runtime.createRegistration(options.registration);
    const entry = this.reserve(registration);
    try {
      await this.assertNoExistingRegistrationOnDisk(registration);
      this.ensureOpen();
    } catch (error) {
      this.releaseReservation(entry);
      throw error;
    }
    const startupPromise = this.startRegistration(entry, options);
    entry.startupPromise = startupPromise;
    return startupPromise;
  }

  private async startRegistration(
    entry: RegistrationEntry,
    options: RegisterMailboxOptions
  ): Promise<SessionRegistrationHandle> {
    const registration = entry.registration;
    let receiver: MailboxReceiver | undefined;
    let publishedFile: FileIdentity | undefined;
    try {
      receiver = await createMailboxReceiver({
        runtime: this.runtime,
        registration,
        resolveSourceRegistration: (sourceId, sourceName) =>
          this.resolveSourceRegistration(sourceId, sourceName),
        deliver: options.deliver,
        maxConnections: options.maxConnections,
        recentRequestIdLimit: options.recentRequestIdLimit,
      });
      entry.receiver = receiver;
      this.assertEntryActive(entry);
      await this.runtime.validateSocketPath(registration.socketPath, {
        allowMissing: false,
        requireSocket: true,
      });
      this.assertEntryActive(entry);
      await this.runtime.writeRegistration(registration, { requireSocket: true });
      publishedFile = await this.readRegistrationFileIdentity(registration.id);
      this.assertEntryActive(entry);
      const published = await this.runtime.readRegistration(registration.id);
      if (!registrationMatches(published, registration)) {
        throw new AgentMessagingSessionRuntimeError(
          'registration_failed',
          'Published mailbox registration did not match the requested identity'
        );
      }

      if (this.byId.get(registration.id) !== entry || entry.receiver !== receiver) {
        throw new AgentMessagingSessionRuntimeError(
          'registration_failed',
          'Mailbox registration reservation was lost before publication'
        );
      }
      this.assertEntryActive(entry);
      entry.published = true;
      const handle: SessionRegistrationHandle = {
        registration,
        receiver,
        ready: receiver.ready,
        deregister: (): Promise<void> => this.deregisterEntry(entry),
      };
      return handle;
    } catch (error) {
      if (receiver !== undefined) {
        await receiver.close().catch(() => undefined);
      }
      await this.removeRegistrationIfOwned(registration, publishedFile).catch(() => undefined);
      this.releaseReservation(entry);
      if (error instanceof AgentMessagingSessionRuntimeError) {
        throw error;
      }
      throw new AgentMessagingSessionRuntimeError(
        'registration_failed',
        `Mailbox registration failed: ${describeError(error, 'registration failed')}`
      );
    }
  }

  public async sendMessage(
    trustedSource: MailboxIdentity,
    target: MailboxTargetReference,
    input: MailboxSendMessageInput
  ): Promise<MailboxAcknowledgement> {
    this.ensureOpen();
    return this.client.sendMessage(trustedSource, target, input);
  }

  public send(
    trustedSource: MailboxIdentity,
    target: MailboxTargetReference,
    input: MailboxSendMessageInput
  ): Promise<MailboxAcknowledgement> {
    return this.sendMessage(trustedSource, target, input);
  }

  public deregister(reference: SessionRegistrationReference): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    const entry = this.findEntry(reference);
    if (entry === undefined) {
      return Promise.resolve();
    }
    return this.deregisterEntry(entry);
  }

  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.closed = true;
    const entries = [...this.entries];
    for (const entry of entries) {
      this.unpublish(entry);
    }
    this.closePromise = this.closeInternal(entries);
    return this.closePromise;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new AgentMessagingSessionRuntimeError(
        'runtime_closed',
        'The agent messaging session runtime has been closed'
      );
    }
  }

  private async assertNoExistingRegistrationOnDisk(registration: AgentRegistration): Promise<void> {
    try {
      await this.runtime.readRegistration(registration.id);
      throw new AgentMessagingSessionRuntimeError(
        'registration_conflict',
        `Agent registration already exists: ${registration.name}`
      );
    } catch (error) {
      if (error instanceof AgentMessagingSessionRuntimeError) {
        throw error;
      }
      if (
        error instanceof AgentMessagingRuntimeDirectoryError &&
        error.code === 'registration_not_found'
      ) {
        return;
      }
      throw new AgentMessagingSessionRuntimeError(
        'registration_conflict',
        `Agent registration path cannot be reused: ${describeError(error, 'registration conflict')}`
      );
    }
  }

  private reserve(registration: AgentRegistration): RegistrationEntry {
    if (this.byId.has(registration.id) || this.byName.has(registration.name)) {
      throw new AgentMessagingSessionRuntimeError(
        'identity_reserved',
        `Agent identity is already reserved: ${registration.name}`
      );
    }
    const placeholder = {
      registration,
      receiver: undefined,
      published: false,
      cancelled: false,
      cleanupPromise: undefined,
      startupPromise: undefined,
    };
    this.byId.set(registration.id, placeholder);
    this.byName.set(registration.name, placeholder);
    this.entries.add(placeholder);
    return placeholder;
  }

  private releaseReservation(entry: RegistrationEntry): void {
    if (this.byId.get(entry.registration.id) === entry) {
      this.byId.delete(entry.registration.id);
    }
    if (this.byName.get(entry.registration.name) === entry) {
      this.byName.delete(entry.registration.name);
    }
    this.entries.delete(entry);
  }

  private assertEntryActive(entry: RegistrationEntry): void {
    if (this.closed) {
      throw new AgentMessagingSessionRuntimeError(
        'runtime_closed',
        'The agent messaging session runtime was closed during registration'
      );
    }
    if (
      entry.cancelled ||
      this.byId.get(entry.registration.id) !== entry ||
      this.byName.get(entry.registration.name) !== entry
    ) {
      throw new AgentMessagingSessionRuntimeError(
        'registration_failed',
        'Mailbox registration was cancelled before publication'
      );
    }
  }

  private resolveSourceRegistration(
    sourceId: string,
    sourceName: string
  ): AgentRegistration | undefined {
    if (this.closed) {
      throw new MailboxProtocolError(
        'runtime_closed',
        'The agent messaging session runtime is closed'
      );
    }
    const entry = this.byId.get(sourceId);
    if (entry === undefined || !entry.published || entry.registration.name !== sourceName) {
      return undefined;
    }
    return entry.registration;
  }

  private resolveTargetRegistration(target: MailboxTargetReference): AgentRegistration | undefined {
    if (this.closed) {
      throw new MailboxProtocolError(
        'runtime_closed',
        'The agent messaging session runtime is closed'
      );
    }
    const entry = this.byName.get(target.name);
    if (
      entry === undefined ||
      !entry.published ||
      (target.id !== undefined && entry.registration.id !== target.id)
    ) {
      return undefined;
    }
    return entry.registration;
  }

  private findEntry(reference: SessionRegistrationReference): RegistrationEntry | undefined {
    if (typeof reference === 'string') {
      return this.byName.get(reference) ?? this.byId.get(reference);
    }
    const registration = 'registration' in reference ? reference.registration : reference;
    const entry = this.byId.get(registration.id);
    // Object references are handles to one registration generation. Matching
    // only the ID would let a stale handle deregister a replacement that
    // reused that ID.
    return entry?.registration === registration ? entry : undefined;
  }

  private unpublish(entry: RegistrationEntry): void {
    entry.cancelled = true;
    entry.published = false;
    if (this.byId.get(entry.registration.id) === entry) {
      this.byId.delete(entry.registration.id);
    }
    if (this.byName.get(entry.registration.name) === entry) {
      this.byName.delete(entry.registration.name);
    }
  }

  private deregisterEntry(entry: RegistrationEntry): Promise<void> {
    if (entry.cleanupPromise !== undefined) {
      return entry.cleanupPromise;
    }
    this.unpublish(entry);
    return this.cleanupEntryOnce(entry);
  }

  private cleanupEntryOnce(entry: RegistrationEntry): Promise<void> {
    if (entry.cleanupPromise === undefined) {
      entry.cleanupPromise = this.cleanupEntry(entry);
    }
    return entry.cleanupPromise;
  }

  private async cleanupEntry(entry: RegistrationEntry): Promise<void> {
    try {
      if (entry.receiver === undefined && entry.startupPromise !== undefined) {
        await entry.startupPromise.catch(() => undefined);
      }
      // The receiver owns the socket. It must stop accepting messages before
      // discovery metadata is removed.
      if (entry.receiver !== undefined) {
        await entry.receiver.close();
      }
      await this.removeRegistrationIfOwned(entry.registration);
    } finally {
      this.entries.delete(entry);
    }
  }

  private async readRegistrationFileIdentity(id: string): Promise<FileIdentity | undefined> {
    let stats;
    try {
      stats = await fs.lstat(this.runtime.registrationPath(id));
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
    return fileIdentity(stats);
  }

  private async removeRegistrationIfOwned(
    registration: AgentRegistration,
    expectedFile?: FileIdentity
  ): Promise<void> {
    const initialFile = await this.readRegistrationFileIdentity(registration.id);
    if (
      initialFile === undefined ||
      (expectedFile !== undefined && !sameFileIdentity(initialFile, expectedFile))
    ) {
      return;
    }
    let published: AgentRegistration;
    try {
      published = await this.runtime.readRegistration(registration.id);
    } catch (error) {
      if (
        error instanceof AgentMessagingRuntimeDirectoryError &&
        error.code === 'registration_not_found'
      ) {
        return;
      }
      if (error instanceof AgentMessagingRuntimeDirectoryError && error.code === 'runtime_closed') {
        return;
      }
      return;
    }
    const finalFile = await this.readRegistrationFileIdentity(registration.id);
    if (
      finalFile === undefined ||
      !sameFileIdentity(initialFile, finalFile) ||
      (expectedFile !== undefined && !sameFileIdentity(finalFile, expectedFile))
    ) {
      return;
    }
    if (registrationMatches(published, registration)) {
      await this.runtime.removeRegistration(registration.id);
    }
  }

  private async closeInternal(entries: RegistrationEntry[]): Promise<void> {
    const results = await Promise.allSettled(entries.map((entry) => this.cleanupEntryOnce(entry)));
    let firstError: unknown;
    for (const result of results) {
      if (result.status === 'rejected' && firstError === undefined) {
        firstError = result.reason;
      }
    }

    try {
      await this.runtime.close();
    } catch (error) {
      firstError ??= error;
    }
    this.byId.clear();
    this.byName.clear();
    this.entries.clear();
    if (firstError !== undefined) {
      throw firstError;
    }
  }
}

export async function createAgentMessagingSessionRuntime(
  options: AgentMessagingSessionRuntimeOptions = {}
): Promise<AgentMessagingSessionRuntime> {
  return AgentMessagingSessionRuntime.create(options);
}

export const createSessionRuntime = createAgentMessagingSessionRuntime;
