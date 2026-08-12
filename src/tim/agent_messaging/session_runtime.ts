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
  cleanupPromise: Promise<void> | undefined;
  startupPromise: Promise<SessionRegistrationHandle> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

    // This validates all identity and derived-path fields before the local
    // reservation or receiver allocates a socket.
    const registration = this.runtime.createRegistration(options.registration);
    await this.assertNoExistingRegistration(registration);
    this.ensureOpen();
    const entry = this.reserve(registration);
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
      if (this.closed) {
        throw new AgentMessagingSessionRuntimeError(
          'runtime_closed',
          'The agent messaging session runtime was closed during registration'
        );
      }
      await this.runtime.validateSocketPath(registration.socketPath, {
        allowMissing: false,
        requireSocket: true,
      });
      await this.runtime.writeRegistration(registration, { requireSocket: true });
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
      await this.removeRegistrationIfOwned(registration).catch(() => undefined);
      this.releaseReservation(registration, receiver);
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
    const entries = [...new Set(this.byId.values())];
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

  private async assertNoExistingRegistration(registration: AgentRegistration): Promise<void> {
    if (this.byId.has(registration.id) || this.byName.has(registration.name)) {
      throw new AgentMessagingSessionRuntimeError(
        'identity_reserved',
        `Agent identity is already reserved: ${registration.name}`
      );
    }
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
    const placeholder = {
      registration,
      receiver: undefined,
      published: false,
      cleanupPromise: undefined,
      startupPromise: undefined,
    };
    this.byId.set(registration.id, placeholder);
    this.byName.set(registration.name, placeholder);
    return placeholder;
  }

  private releaseReservation(
    registration: AgentRegistration,
    receiver: MailboxReceiver | undefined
  ): void {
    const entry = this.byId.get(registration.id);
    if (entry !== undefined && (receiver === undefined || entry.receiver === receiver)) {
      this.byId.delete(registration.id);
      if (this.byName.get(registration.name) === entry) {
        this.byName.delete(registration.name);
      }
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
    return entry?.registration.id === registration.id ? entry : undefined;
  }

  private unpublish(entry: RegistrationEntry): void {
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
    entry.cleanupPromise = this.cleanupEntry(entry);
    return entry.cleanupPromise;
  }

  private async cleanupEntry(entry: RegistrationEntry): Promise<void> {
    if (entry.receiver === undefined && entry.startupPromise !== undefined) {
      await entry.startupPromise.catch(() => undefined);
    }
    // The receiver owns the socket. It must stop accepting messages before
    // discovery metadata is removed.
    if (entry.receiver !== undefined) {
      await entry.receiver.close();
    }
    await this.removeRegistrationIfOwned(entry.registration);
  }

  private async removeRegistrationIfOwned(registration: AgentRegistration): Promise<void> {
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
    if (registrationMatches(published, registration)) {
      await this.runtime.removeRegistration(registration.id);
    }
  }

  private async closeInternal(entries: RegistrationEntry[]): Promise<void> {
    const results = await Promise.allSettled(entries.map((entry) => this.cleanupEntry(entry)));
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
