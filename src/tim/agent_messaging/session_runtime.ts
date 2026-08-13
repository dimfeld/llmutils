import { promises as fs } from 'node:fs';

import {
  MailboxClient,
  normalizeMailboxClientTiming,
  type MailboxClientTiming,
  type MailboxClientTimingOptions,
  type MailboxTargetReference,
} from './mailbox_client.js';
import {
  fileIdentity,
  isNotFoundError,
  isRecord,
  sameFileIdentity,
  sanitizeErrorMessage,
  type FileIdentity,
} from './mailbox_helpers.js';
import {
  MailboxReceiver,
  normalizeMailboxReceiverOptions,
  type MailboxDeliveryCallback,
  type NormalizedMailboxReceiverOptions,
} from './mailbox_server.js';
import {
  AgentMessagingRuntimeDirectory,
  AgentMessagingRuntimeDirectoryError,
  sameAgentRegistration,
  type AgentRegistration,
  type AgentRegistrationDraft,
} from './runtime_dir.js';
import {
  MailboxProtocolError,
  type MailboxAcknowledgement,
  type MailboxIdentity,
  type MailboxSendMessageInput,
} from './mailbox_protocol.js';

export interface AgentMessagingSessionRuntimeOptions extends MailboxClientTimingOptions {}

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

/**
 * A registration record reference is generation-bound: an AgentRegistration
 * object must be the exact object returned by its SessionRegistrationHandle.
 * Use a handle or name when the reference was not obtained from registration.
 */
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

type RegistrationSlotState =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'starting'; readonly receiver: MailboxReceiver }
  | { readonly kind: 'published'; readonly receiver: MailboxReceiver }
  | { readonly kind: 'closing'; readonly receiver?: MailboxReceiver }
  | { readonly kind: 'closed' };

class RegistrationSlot {
  public readonly registration: AgentRegistration;

  private state: RegistrationSlotState = { kind: 'reserved' };
  private startupPromise: Promise<SessionRegistrationHandle> | undefined;
  private cleanupPromise: Promise<void> | undefined;

  public constructor(registration: AgentRegistration) {
    this.registration = registration;
  }

  public get receiver(): MailboxReceiver | undefined {
    return 'receiver' in this.state ? this.state.receiver : undefined;
  }

  public get isPublished(): boolean {
    return this.state.kind === 'published';
  }

  public get isCancelled(): boolean {
    return this.state.kind === 'closing' || this.state.kind === 'closed';
  }

  public get startup(): Promise<SessionRegistrationHandle> | undefined {
    return this.startupPromise;
  }

  public get cleanup(): Promise<void> | undefined {
    return this.cleanupPromise;
  }

  public setStartup(promise: Promise<SessionRegistrationHandle>): void {
    this.startupPromise = promise;
  }

  public setReceiver(receiver: MailboxReceiver): void {
    if (this.state.kind === 'reserved' || this.state.kind === 'starting') {
      this.state = { kind: 'starting', receiver };
      return;
    }
    if (this.state.kind === 'closing') {
      this.state = { kind: 'closing', receiver };
    }
  }

  public markPublished(receiver: MailboxReceiver): void {
    if (this.state.kind !== 'starting') {
      throw new AgentMessagingSessionRuntimeError(
        'registration_failed',
        'Mailbox registration was cancelled before publication'
      );
    }
    this.state = { kind: 'published', receiver };
  }

  public cancel(): void {
    if (this.state.kind === 'closed' || this.state.kind === 'closing') {
      return;
    }
    this.state = { kind: 'closing', receiver: this.receiver };
  }

  public setCleanup(promise: Promise<void>): void {
    this.cleanupPromise = promise;
  }

  public markClosed(): void {
    this.state = { kind: 'closed' };
  }
}

/** Owns active registrations, receiver publication, and the session root. */
export class AgentMessagingSessionRuntime {
  public readonly runtime: AgentMessagingRuntimeDirectory;
  public readonly client: MailboxClient;

  private readonly byId = new Map<string, RegistrationSlot>();
  private readonly byName = new Map<string, RegistrationSlot>();
  private readonly entries = new Set<RegistrationSlot>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(runtime: AgentMessagingRuntimeDirectory, clientTiming: MailboxClientTiming) {
    this.runtime = runtime;
    this.client = new MailboxClient({
      ...clientTiming,
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
    let clientTiming: MailboxClientTiming;
    try {
      clientTiming = normalizeMailboxClientTiming(options);
    } catch (error) {
      throw new AgentMessagingSessionRuntimeError(
        'invalid_options',
        `Session runtime options are invalid: ${sanitizeErrorMessage(error, 'invalid options')}`
      );
    }
    const runtime = await AgentMessagingRuntimeDirectory.create();
    try {
      return new AgentMessagingSessionRuntime(runtime, clientTiming);
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
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
    let receiverOptions: NormalizedMailboxReceiverOptions;
    try {
      receiverOptions = normalizeMailboxReceiverOptions({
        ...options,
        runtime: this.runtime,
        registration,
        resolveSourceRegistration: (sourceId, sourceName) =>
          this.resolveSourceRegistration(sourceId, sourceName),
      });
    } catch (error) {
      throw new AgentMessagingSessionRuntimeError(
        'invalid_options',
        `Mailbox registration options are invalid: ${sanitizeErrorMessage(error, 'invalid options')}`
      );
    }

    const entry = this.reserve(registration);
    try {
      await this.assertNoExistingRegistrationOnDisk(registration);
      this.ensureOpen();
    } catch (error) {
      this.releaseReservation(entry);
      throw error;
    }
    const startupPromise = this.startRegistration(entry, receiverOptions);
    entry.setStartup(startupPromise);
    return startupPromise;
  }

  private async startRegistration(
    entry: RegistrationSlot,
    receiverOptions: NormalizedMailboxReceiverOptions
  ): Promise<SessionRegistrationHandle> {
    const registration = entry.registration;
    let receiver: MailboxReceiver | undefined;
    let publishedFile: FileIdentity | undefined;
    try {
      receiver = await MailboxReceiver.createNormalized(receiverOptions);
      entry.setReceiver(receiver);
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
      if (!sameAgentRegistration(published, registration)) {
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
      entry.markPublished(receiver);
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
        `Mailbox registration failed: ${sanitizeErrorMessage(error, 'registration failed')}`
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

  /**
   * Deregister one active generation. An AgentRegistration reference is an
   * exact-object handle, not a structural lookup, so a reread or listed copy
   * is intentionally treated as already gone to protect replacement entries.
   */
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
        `Agent registration path cannot be reused: ${sanitizeErrorMessage(error, 'registration conflict')}`
      );
    }
  }

  private reserve(registration: AgentRegistration): RegistrationSlot {
    if (this.byId.has(registration.id) || this.byName.has(registration.name)) {
      throw new AgentMessagingSessionRuntimeError(
        'identity_reserved',
        `Agent identity is already reserved: ${registration.name}`
      );
    }
    const placeholder = new RegistrationSlot(registration);
    this.byId.set(registration.id, placeholder);
    this.byName.set(registration.name, placeholder);
    this.entries.add(placeholder);
    return placeholder;
  }

  private releaseReservation(entry: RegistrationSlot): void {
    if (this.byId.get(entry.registration.id) === entry) {
      this.byId.delete(entry.registration.id);
    }
    if (this.byName.get(entry.registration.name) === entry) {
      this.byName.delete(entry.registration.name);
    }
    this.entries.delete(entry);
    entry.markClosed();
  }

  private assertEntryActive(entry: RegistrationSlot): void {
    if (this.closed) {
      throw new AgentMessagingSessionRuntimeError(
        'runtime_closed',
        'The agent messaging session runtime was closed during registration'
      );
    }
    if (
      entry.isCancelled ||
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
    if (entry === undefined || !entry.isPublished || entry.registration.name !== sourceName) {
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
      !entry.isPublished ||
      (target.id !== undefined && entry.registration.id !== target.id)
    ) {
      return undefined;
    }
    return entry.registration;
  }

  private findEntry(reference: SessionRegistrationReference): RegistrationSlot | undefined {
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

  private unpublish(entry: RegistrationSlot): void {
    entry.cancel();
    if (this.byId.get(entry.registration.id) === entry) {
      this.byId.delete(entry.registration.id);
    }
    if (this.byName.get(entry.registration.name) === entry) {
      this.byName.delete(entry.registration.name);
    }
  }

  private deregisterEntry(entry: RegistrationSlot): Promise<void> {
    if (entry.cleanup !== undefined) {
      return entry.cleanup;
    }
    this.unpublish(entry);
    return this.cleanupEntryOnce(entry);
  }

  private cleanupEntryOnce(entry: RegistrationSlot): Promise<void> {
    if (entry.cleanup === undefined) {
      entry.setCleanup(this.cleanupEntry(entry));
    }
    return entry.cleanup as Promise<void>;
  }

  private async cleanupEntry(entry: RegistrationSlot): Promise<void> {
    try {
      if (entry.receiver === undefined && entry.startup !== undefined) {
        await entry.startup.catch(() => undefined);
      }
      // The receiver owns the socket. It must stop accepting messages before
      // discovery metadata is removed.
      if (entry.receiver !== undefined) {
        await entry.receiver.close();
      }
      await this.removeRegistrationIfOwned(entry.registration);
    } finally {
      this.entries.delete(entry);
      entry.markClosed();
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
    if (sameAgentRegistration(published, registration)) {
      await this.runtime.removeRegistration(registration.id);
    }
  }

  private async closeInternal(entries: RegistrationSlot[]): Promise<void> {
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
