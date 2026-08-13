import { Buffer } from 'node:buffer';
import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as z from 'zod/v4';

import { CleanupRegistry } from '../../common/cleanup_registry.js';
import {
  AGENT_TYPES,
  MAX_AGENT_NAME_LENGTH,
  agentAddressSchema,
  agentExecutorSchema,
  agentIdSchema,
  agentNameSchema,
  agentTypeSchema,
  nonterminalAgentLifecycleStateSchema,
  ORCHESTRATOR_AGENT_NAME,
} from './contracts.js';
import { MAILBOX_PROTOCOL_VERSION, MAX_MAILBOX_AGENT_ID_LENGTH } from './mailbox_protocol.js';

/** A short prefix keeps Unix socket paths usable on macOS and Linux. */
export const AGENT_MESSAGING_RUNTIME_PREFIX = 'tm-';

/**
 * Conservative maximum path length for Unix-domain sockets.
 *
 * macOS supports a shorter `sockaddr_un.sun_path` than Linux. A path of 103
 * bytes plus the terminating NUL fits the commonly supported macOS limit.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103;

/** Registration records are bounded independently from the JSONL frame bound. */
export const MAX_REGISTRATION_SOCKET_PATH_BYTES = 4096;
export const MAX_REGISTRATION_FILE_BYTES = 16 * 1024;
export const REGISTRATION_FILE_MODE = 0o600;
export const RUNTIME_DIRECTORY_MODE = 0o700;

const REGISTRATION_FILE_SUFFIX = '.json';
const TEMP_FILE_MARKER = '.tmp.';
export const MAX_REGISTRATION_TEMP_FILE_ATTEMPTS = 100;

const boundedAgentIdSchema = agentIdSchema
  .max(MAX_MAILBOX_AGENT_ID_LENGTH)
  .refine((value: string): boolean => !containsControlCharacters(value));

const registrationSocketPathSchema = z
  .string()
  .min(1)
  .max(MAX_REGISTRATION_SOCKET_PATH_BYTES)
  .refine((value: string): boolean => !containsControlCharacters(value));

const registrationCommonSchema = {
  protocolVersion: z.literal(MAILBOX_PROTOCOL_VERSION),
  id: boundedAgentIdSchema,
  executor: agentExecutorSchema,
  state: nonterminalAgentLifecycleStateSchema,
  socketPath: registrationSocketPathSchema,
};

/** The strict discovery record for the reserved orchestrator identity. */
export const orchestratorRegistrationSchema = z
  .object({
    ...registrationCommonSchema,
    name: z.literal(ORCHESTRATOR_AGENT_NAME),
    role: z.literal('orchestrator'),
  })
  .strict();

/** The strict discovery record for an ordinary subagent identity. */
export const subagentRegistrationSchema = z
  .object({
    ...registrationCommonSchema,
    name: agentNameSchema,
    role: z.literal('subagent'),
    type: agentTypeSchema,
  })
  .strict();

/** A published registration record. It is discovery metadata, not lifecycle authority. */
export const agentRegistrationSchema = z.discriminatedUnion('role', [
  orchestratorRegistrationSchema,
  subagentRegistrationSchema,
]);
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

export const orchestratorRegistrationDraftSchema = orchestratorRegistrationSchema.omit({
  protocolVersion: true,
  socketPath: true,
});
export const subagentRegistrationDraftSchema = subagentRegistrationSchema.omit({
  protocolVersion: true,
  socketPath: true,
});
export const agentRegistrationDraftSchema = z.discriminatedUnion('role', [
  orchestratorRegistrationDraftSchema,
  subagentRegistrationDraftSchema,
]);

export type OrchestratorRegistrationDraft = z.infer<typeof orchestratorRegistrationDraftSchema>;
export type SubagentRegistrationDraft = z.infer<typeof subagentRegistrationDraftSchema>;

export type AgentRegistrationDraft = OrchestratorRegistrationDraft | SubagentRegistrationDraft;

export type RuntimeDirectoryErrorCode =
  | 'unsupported_platform'
  | 'runtime_closed'
  | 'invalid_agent_id'
  | 'invalid_registration'
  | 'path_outside_runtime'
  | 'path_not_descendant'
  | 'symlink_path'
  | 'unexpected_path_entry'
  | 'socket_path_too_long'
  | 'registration_not_found'
  | 'invalid_registration_path'
  | 'temporary_file_exhausted'
  | 'filesystem_error';

/** An error raised at a filesystem or registration boundary. */
export class AgentMessagingRuntimeDirectoryError extends Error {
  public readonly code: RuntimeDirectoryErrorCode;

  public constructor(code: RuntimeDirectoryErrorCode, message: string) {
    super(message);
    this.name = 'AgentMessagingRuntimeDirectoryError';
    this.code = code;
  }
}

export interface ListRegistrationsOptions {
  /** Throw on a malformed final record instead of safely skipping it. */
  skipMalformed?: boolean;
}

export interface ValidateSocketPathOptions {
  /** Permit a missing socket leaf. Parent components are still checked. */
  allowMissing?: boolean;
  /** Require an existing leaf to be a Unix socket. */
  requireSocket?: boolean;
}

export interface WriteRegistrationOptions {
  /** Require the derived socket entry to already exist as a Unix socket. */
  requireSocket?: boolean;
}

const listRegistrationsOptionsSchema = z
  .object({
    skipMalformed: z.boolean().optional(),
  })
  .strict();

const validateSocketPathOptionsSchema = z
  .object({
    allowMissing: z.boolean().optional(),
    requireSocket: z.boolean().optional(),
  })
  .strict();

const writeRegistrationOptionsSchema = z
  .object({
    requireSocket: z.boolean().optional(),
  })
  .strict();

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function validationMessage(result: { error: { issues: Array<{ message: string }> } }): string {
  return result.error.issues[0]?.message ?? 'Agent registration failed validation';
}

function parseRuntimeDirectoryOptions<T>(value: unknown, schema: z.ZodType<T>, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_registration',
      `${label} are invalid: ${validationMessage(result)}`
    );
  }
  return result.data;
}

function parseAgentId(value: unknown): string {
  const result = boundedAgentIdSchema.safeParse(value);
  if (!result.success) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_agent_id',
      `Agent ID is invalid: ${validationMessage(result)}`
    );
  }

  const id = result.data;
  if (
    id === '.' ||
    id === '..' ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('\0') ||
    path.basename(id) !== id
  ) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_agent_id',
      'Agent ID must be one safe filename component without path separators'
    );
  }

  return id;
}

function parseRegistration(value: unknown): AgentRegistration {
  const result = agentRegistrationSchema.safeParse(value);
  if (!result.success) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_registration',
      `Agent registration is invalid: ${validationMessage(result)}`
    );
  }

  const registration = result.data;
  parseAgentId(registration.id);
  if (!path.isAbsolute(registration.socketPath)) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_registration',
      'Agent registration socketPath must be absolute'
    );
  }
  if (Buffer.byteLength(registration.socketPath, 'utf8') > MAX_REGISTRATION_SOCKET_PATH_BYTES) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_registration',
      `Agent registration socketPath must be at most ${MAX_REGISTRATION_SOCKET_PATH_BYTES} bytes`
    );
  }

  return registration;
}

/** Parse and strictly validate a registration without trusting its paths. */
export function parseAgentRegistration(value: unknown): AgentRegistration {
  return parseRegistration(value);
}

/** Compare all published registration fields that identify one generation. */
export function sameAgentRegistration(left: AgentRegistration, right: AgentRegistration): boolean {
  if (
    left.protocolVersion !== right.protocolVersion ||
    left.id !== right.id ||
    left.name !== right.name ||
    left.role !== right.role ||
    left.executor !== right.executor ||
    left.state !== right.state ||
    left.socketPath !== right.socketPath
  ) {
    return false;
  }
  return left.role === 'subagent' && right.role === 'subagent' ? left.type === right.type : true;
}

/**
 * Return true only for a strict descendant. In particular, `..foo` is a valid
 * child name while `..` and `../outside` are not.
 */
export function isStrictPathDescendant(rootPath: string, candidatePath: string): boolean {
  if (path.isAbsolute(rootPath) === false || path.isAbsolute(candidatePath) === false) {
    return false;
  }

  const relative = path.relative(rootPath, candidatePath);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertStrictPathDescendant(rootPath: string, candidatePath: string): void {
  if (!path.isAbsolute(candidatePath)) {
    throw new AgentMessagingRuntimeDirectoryError(
      'path_outside_runtime',
      'Filesystem paths must be absolute'
    );
  }
  if (!isStrictPathDescendant(rootPath, candidatePath)) {
    throw new AgentMessagingRuntimeDirectoryError(
      'path_not_descendant',
      'Filesystem path must be a strict descendant of the agent messaging runtime'
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function wrapFilesystemError(error: unknown, context: string): AgentMessagingRuntimeDirectoryError {
  if (error instanceof AgentMessagingRuntimeDirectoryError) {
    return error;
  }
  const message = error instanceof Error ? error.message : 'unexpected filesystem failure';
  return new AgentMessagingRuntimeDirectoryError('filesystem_error', `${context}: ${message}`);
}

async function removeExactRoot(rootPath: string): Promise<void> {
  try {
    const stats = await fs.lstat(rootPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return;
    }
    await fs.rm(rootPath, { recursive: true, force: true });
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }
}

function removeExactRootSync(rootPath: string): void {
  try {
    const stats = fsSync.lstatSync(rootPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return;
    }
    fsSync.rmSync(rootPath, { recursive: true, force: true });
  } catch {
    // Emergency cleanup is best effort. Normal close() reports failures.
  }
}

let temporaryFileCounter = 0;

/**
 * Owns one private session runtime directory and its registration namespace.
 * This class does not create receivers or decide lifecycle state transitions.
 */
export class AgentMessagingRuntimeDirectory {
  public readonly rootPath: string;
  public readonly agentsDirectory: string;
  public readonly socketsDirectory: string;

  private readonly unregisterEmergencyCleanup: () => void;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  private constructor(rootPath: string, unregisterEmergencyCleanup: () => void) {
    this.rootPath = rootPath;
    this.agentsDirectory = path.join(rootPath, 'agents');
    this.socketsDirectory = path.join(rootPath, 'sockets');
    this.unregisterEmergencyCleanup = unregisterEmergencyCleanup;
  }

  /** Create a new private runtime under the platform temporary directory. */
  public static async create(): Promise<AgentMessagingRuntimeDirectory> {
    if (process.platform === 'win32') {
      throw new AgentMessagingRuntimeDirectoryError(
        'unsupported_platform',
        'Agent messaging requires Unix-domain socket support and is not available on Windows'
      );
    }

    let rootPath: string | undefined;
    try {
      rootPath = await fs.mkdtemp(path.join(os.tmpdir(), AGENT_MESSAGING_RUNTIME_PREFIX));
      await fs.chmod(rootPath, RUNTIME_DIRECTORY_MODE);
      await verifyDirectory(rootPath, 'runtime root');

      const agentsDirectory = path.join(rootPath, 'agents');
      const socketsDirectory = path.join(rootPath, 'sockets');
      await fs.mkdir(agentsDirectory, { mode: RUNTIME_DIRECTORY_MODE });
      await fs.mkdir(socketsDirectory, { mode: RUNTIME_DIRECTORY_MODE });
      await fs.chmod(agentsDirectory, RUNTIME_DIRECTORY_MODE);
      await fs.chmod(socketsDirectory, RUNTIME_DIRECTORY_MODE);
      await verifyDirectory(agentsDirectory, 'agents directory');
      await verifyDirectory(socketsDirectory, 'sockets directory');

      const unregisterEmergencyCleanup = CleanupRegistry.getInstance().register(() => {
        removeExactRootSync(rootPath as string);
      });

      return new AgentMessagingRuntimeDirectory(rootPath, unregisterEmergencyCleanup);
    } catch (error) {
      if (rootPath !== undefined) {
        await removeExactRoot(rootPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new AgentMessagingRuntimeDirectoryError(
        'runtime_closed',
        'The agent messaging runtime has been closed'
      );
    }
  }

  private getContainedRegistrationPath(agentId: string): string {
    const id = parseAgentId(agentId);
    const registrationPath = path.join(this.agentsDirectory, `${id}${REGISTRATION_FILE_SUFFIX}`);
    assertStrictPathDescendant(this.rootPath, registrationPath);
    return registrationPath;
  }

  private getContainedSocketPath(agentId: string): string {
    const id = parseAgentId(agentId);
    const socketPath = path.join(this.socketsDirectory, `${id}.sock`);
    assertStrictPathDescendant(this.rootPath, socketPath);
    const byteLength = Buffer.byteLength(socketPath, 'utf8');
    if (byteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new AgentMessagingRuntimeDirectoryError(
        'socket_path_too_long',
        `Unix socket path must be at most ${MAX_UNIX_SOCKET_PATH_BYTES} bytes; got ${byteLength}`
      );
    }
    return socketPath;
  }

  /** Derive the only valid registration filename for an opaque agent ID. */
  public registrationPath(agentId: string): string {
    this.ensureOpen();
    return this.getContainedRegistrationPath(agentId);
  }

  /** Derive the only valid Unix socket filename for an opaque agent ID. */
  public socketPath(agentId: string): string {
    this.ensureOpen();
    return this.getContainedSocketPath(agentId);
  }

  /** Build a validated record using this runtime's derived socket path. */
  public createRegistration(draft: AgentRegistrationDraft): AgentRegistration {
    this.ensureOpen();
    const parsedDraft = parseRegistrationDraft(draft);
    return parseRegistration({
      protocolVersion: MAILBOX_PROTOCOL_VERSION,
      ...parsedDraft,
      socketPath: this.getContainedSocketPath(parsedDraft.id),
    });
  }

  private async validatePathComponents(
    candidatePath: string,
    allowMissingLeaf: boolean
  ): Promise<void> {
    assertStrictPathDescendant(this.rootPath, candidatePath);

    const relative = path.relative(this.rootPath, candidatePath);
    const components = relative.split(path.sep);
    let currentPath = this.rootPath;

    const rootStats = await fs.lstat(currentPath);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'symlink_path',
        'The trusted agent messaging runtime root is not a directory'
      );
    }

    for (const [index, component] of components.entries()) {
      currentPath = path.join(currentPath, component);
      try {
        const stats = await fs.lstat(currentPath);
        if (stats.isSymbolicLink()) {
          throw new AgentMessagingRuntimeDirectoryError(
            'symlink_path',
            `Symlinked path component is not allowed: ${currentPath}`
          );
        }
        if (index < components.length - 1 && !stats.isDirectory()) {
          throw new AgentMessagingRuntimeDirectoryError(
            'unexpected_path_entry',
            `Path component is not a directory: ${currentPath}`
          );
        }
      } catch (error) {
        if (isNotFoundError(error) && allowMissingLeaf && index === components.length - 1) {
          return;
        }
        throw error;
      }
    }
  }

  /** Validate a contained socket path without following symlinks. */
  public async validateSocketPath(
    socketPath: string,
    options: ValidateSocketPathOptions = {}
  ): Promise<void> {
    this.ensureOpen();
    const parsedOptions = parseRuntimeDirectoryOptions(
      options,
      validateSocketPathOptionsSchema,
      'Socket path options'
    );
    if (!path.isAbsolute(socketPath)) {
      throw new AgentMessagingRuntimeDirectoryError(
        'path_outside_runtime',
        'Socket path must be absolute'
      );
    }
    const byteLength = Buffer.byteLength(socketPath, 'utf8');
    if (byteLength > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new AgentMessagingRuntimeDirectoryError(
        'socket_path_too_long',
        `Unix socket path must be at most ${MAX_UNIX_SOCKET_PATH_BYTES} bytes; got ${byteLength}`
      );
    }

    await this.validatePathComponents(socketPath, parsedOptions.allowMissing ?? false);

    let stats: fsSync.Stats;
    try {
      stats = await fs.lstat(socketPath);
    } catch (error) {
      if (isNotFoundError(error) && parsedOptions.allowMissing) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'symlink_path',
        `Symlinked socket entry is not allowed: ${socketPath}`
      );
    }
    if (parsedOptions.requireSocket && !stats.isSocket()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'unexpected_path_entry',
        `Expected a Unix socket at ${socketPath}`
      );
    }
  }

  private validateRegistrationForRuntime(value: unknown): AgentRegistration {
    const parsed = parseRegistration(value);
    const expectedSocketPath = this.getContainedSocketPath(parsed.id);
    if (parsed.socketPath !== expectedSocketPath) {
      throw new AgentMessagingRuntimeDirectoryError(
        'path_outside_runtime',
        'Registration socketPath does not match the derived opaque-ID socket path'
      );
    }
    return parsed;
  }

  private async validateRegistrationTarget(
    registration: AgentRegistration,
    registrationPath: string,
    allowMissingRegistration: boolean,
    requireSocket: boolean
  ): Promise<void> {
    await this.validatePathComponents(registrationPath, allowMissingRegistration);
    await this.validateSocketPath(registration.socketPath, {
      allowMissing: !requireSocket,
      requireSocket,
    });
  }

  /** Atomically publish a complete owner-only registration record. */
  public async writeRegistration(
    registration: AgentRegistration,
    options: WriteRegistrationOptions = {}
  ): Promise<string> {
    this.ensureOpen();
    const parsedOptions = parseRuntimeDirectoryOptions(
      options,
      writeRegistrationOptionsSchema,
      'Registration write options'
    );
    const parsed = this.validateRegistrationForRuntime(registration);
    const registrationPath = this.getContainedRegistrationPath(parsed.id);
    try {
      await this.validateRegistrationTarget(
        parsed,
        registrationPath,
        true,
        parsedOptions.requireSocket ?? false
      );
    } catch (error) {
      throw wrapFilesystemError(error, 'Could not validate the registration target');
    }

    let existingStats: fsSync.Stats | undefined;
    try {
      existingStats = await fs.lstat(registrationPath);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw wrapFilesystemError(error, 'Could not inspect the registration path');
      }
    }
    if (existingStats?.isSymbolicLink()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'symlink_path',
        `Symlinked registration entry is not allowed: ${registrationPath}`
      );
    }
    if (existingStats !== undefined && !existingStats.isFile()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'unexpected_path_entry',
        `Registration path is not a regular file: ${registrationPath}`
      );
    }

    const payload = `${JSON.stringify(parsed)}\n`;
    if (Buffer.byteLength(payload, 'utf8') > MAX_REGISTRATION_FILE_BYTES) {
      throw new AgentMessagingRuntimeDirectoryError(
        'invalid_registration',
        `Agent registration must be at most ${MAX_REGISTRATION_FILE_BYTES} bytes`
      );
    }
    let temporaryPath: string | undefined;
    let fileHandle: fsSync.promises.FileHandle | undefined;

    try {
      for (let attempt = 0; attempt < MAX_REGISTRATION_TEMP_FILE_ATTEMPTS; attempt += 1) {
        const counter = temporaryFileCounter++;
        const candidate = `${registrationPath}${TEMP_FILE_MARKER}${process.pid}.${Date.now()}.${counter}`;
        try {
          fileHandle = await fs.open(candidate, 'wx', REGISTRATION_FILE_MODE);
          temporaryPath = candidate;
          break;
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error;
          }
        }
      }

      if (fileHandle === undefined || temporaryPath === undefined) {
        throw new AgentMessagingRuntimeDirectoryError(
          'temporary_file_exhausted',
          `Could not allocate a unique temporary registration file after ${MAX_REGISTRATION_TEMP_FILE_ATTEMPTS} attempts`
        );
      }

      await fileHandle.writeFile(payload, { encoding: 'utf8' });
      await fileHandle.chmod(REGISTRATION_FILE_MODE);
      await fileHandle.close();
      fileHandle = undefined;

      await fs.rename(temporaryPath, registrationPath);
      temporaryPath = undefined;
      return registrationPath;
    } catch (error) {
      if (fileHandle !== undefined) {
        await fileHandle.close().catch(() => undefined);
      }
      if (temporaryPath !== undefined) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      throw wrapFilesystemError(error, 'Could not publish the agent registration');
    }
  }

  private resolveRegistrationPath(idOrPath: string): string {
    if (path.isAbsolute(idOrPath)) {
      assertStrictPathDescendant(this.rootPath, idOrPath);
      const basename = path.basename(idOrPath);
      if (!basename.endsWith(REGISTRATION_FILE_SUFFIX)) {
        throw new AgentMessagingRuntimeDirectoryError(
          'invalid_registration_path',
          'Registration path must end in .json'
        );
      }
      const id = basename.slice(0, -REGISTRATION_FILE_SUFFIX.length);
      const expectedPath = this.getContainedRegistrationPath(id);
      if (idOrPath !== expectedPath) {
        throw new AgentMessagingRuntimeDirectoryError(
          'invalid_registration_path',
          'Registration path must be the derived opaque-ID path'
        );
      }
      return expectedPath;
    }
    return this.getContainedRegistrationPath(idOrPath);
  }

  /** Read and strictly validate one registration by ID or exact path. */
  public async readRegistration(idOrPath: string): Promise<AgentRegistration> {
    this.ensureOpen();
    const registrationPath = this.resolveRegistrationPath(idOrPath);
    await this.validatePathComponents(registrationPath, true);

    let stats: fsSync.Stats;
    try {
      stats = await fs.lstat(registrationPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new AgentMessagingRuntimeDirectoryError(
          'registration_not_found',
          `Agent registration does not exist: ${registrationPath}`
        );
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'symlink_path',
        `Symlinked registration entry is not allowed: ${registrationPath}`
      );
    }
    if (!stats.isFile()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'unexpected_path_entry',
        `Registration path is not a regular file: ${registrationPath}`
      );
    }
    if (stats.size > MAX_REGISTRATION_FILE_BYTES) {
      throw new AgentMessagingRuntimeDirectoryError(
        'invalid_registration',
        `Agent registration must be at most ${MAX_REGISTRATION_FILE_BYTES} bytes`
      );
    }
    if (process.platform !== 'win32' && (stats.mode & 0o777) !== REGISTRATION_FILE_MODE) {
      throw new AgentMessagingRuntimeDirectoryError(
        'unexpected_path_entry',
        `Registration file does not have mode ${REGISTRATION_FILE_MODE.toString(8)}`
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(await fs.readFile(registrationPath, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new AgentMessagingRuntimeDirectoryError(
          'invalid_registration',
          `Registration file contains invalid JSON: ${registrationPath}`
        );
      }
      throw error;
    }

    const registration = this.validateRegistrationForRuntime(value);
    await this.validateRegistrationTarget(registration, registrationPath, false, false);
    return registration;
  }

  /** List final registration files in deterministic filename order. */
  public async listRegistrations(
    options: ListRegistrationsOptions = {}
  ): Promise<AgentRegistration[]> {
    this.ensureOpen();
    const parsedOptions = parseRuntimeDirectoryOptions(
      options,
      listRegistrationsOptionsSchema,
      'Registration listing options'
    );
    await this.validatePathComponents(this.agentsDirectory, false);
    const skipMalformed = parsedOptions.skipMalformed ?? true;
    const entries = await fs.readdir(this.agentsDirectory, { withFileTypes: true });
    const names = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(REGISTRATION_FILE_SUFFIX) &&
          !entry.name.includes(TEMP_FILE_MARKER)
      )
      .map((entry) => entry.name)
      .toSorted();

    const registrations: AgentRegistration[] = [];
    for (const name of names) {
      try {
        registrations.push(await this.readRegistration(path.join(this.agentsDirectory, name)));
      } catch (error) {
        if (!skipMalformed) {
          throw error;
        }
      }
    }
    return registrations;
  }

  private async removeOwnedEntry(
    entryPath: string,
    expectedKind: 'registration' | 'socket'
  ): Promise<void> {
    await this.validatePathComponents(entryPath, false).catch((error: unknown) => {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    });

    let stats: fsSync.Stats;
    try {
      stats = await fs.lstat(entryPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new AgentMessagingRuntimeDirectoryError(
        'symlink_path',
        `Symlinked ${expectedKind} entry is not removed: ${entryPath}`
      );
    }
    const validKind = expectedKind === 'registration' ? stats.isFile() : stats.isSocket();
    if (!validKind) {
      throw new AgentMessagingRuntimeDirectoryError(
        'unexpected_path_entry',
        `Refusing to remove unexpected ${expectedKind} entry: ${entryPath}`
      );
    }
    await fs.unlink(entryPath);
  }

  /** Remove one exact registration file. Missing files are already removed. */
  public async removeRegistration(idOrRegistration: string | AgentRegistration): Promise<void> {
    this.ensureOpen();
    const idOrPath = typeof idOrRegistration === 'string' ? idOrRegistration : idOrRegistration.id;
    await this.removeOwnedEntry(this.resolveRegistrationPath(idOrPath), 'registration');
  }

  /** Remove one exact socket entry. Missing sockets are already removed. */
  public async removeSocket(agentId: string): Promise<void> {
    this.ensureOpen();
    await this.removeOwnedEntry(this.getContainedSocketPath(agentId), 'socket');
  }

  /** Close the exact created root. Repeated and concurrent closes share one promise. */
  public close(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    this.closed = true;
    this.closePromise = (async (): Promise<void> => {
      await removeExactRoot(this.rootPath);
      this.unregisterEmergencyCleanup();
    })();
    return this.closePromise;
  }
}

async function verifyDirectory(directoryPath: string, label: string): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AgentMessagingRuntimeDirectoryError(
      'unexpected_path_entry',
      `${label} is not an owner-private directory`
    );
  }
  if (process.platform !== 'win32' && (stats.mode & 0o777) !== RUNTIME_DIRECTORY_MODE) {
    throw new AgentMessagingRuntimeDirectoryError(
      'unexpected_path_entry',
      `${label} does not have mode ${RUNTIME_DIRECTORY_MODE.toString(8)}`
    );
  }
}

function parseRegistrationDraft(value: unknown): AgentRegistrationDraft {
  const result = agentRegistrationDraftSchema.safeParse(value);
  if (!result.success) {
    throw new AgentMessagingRuntimeDirectoryError(
      'invalid_registration',
      `Agent registration draft is invalid: ${validationMessage(result)}`
    );
  }
  return result.data;
}

/** Create a private agent-messaging runtime directory. */
export async function createAgentMessagingRuntimeDirectory(): Promise<AgentMessagingRuntimeDirectory> {
  return AgentMessagingRuntimeDirectory.create();
}

/** Export the canonical name grammar for consumers that validate before allocation. */
export { AGENT_TYPES, MAX_AGENT_NAME_LENGTH, agentAddressSchema, agentNameSchema };
