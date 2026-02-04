import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { sharedPermissionsFileSchema, type SharedPermissionsFile } from './permissions_schema.js';

const TEMP_FILE_SUFFIX = `.tmp-${process.pid}-${Date.now()}`;
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;
const LOCK_STALE_THRESHOLD_MS = 5 * 60_000;

export interface ReadSharedPermissionsOptions {
  repositoryId: string;
}

export interface WriteSharedPermissionsOptions {
  /**
   * The version the caller believes is currently persisted. Defaults to
   * `permissions.version - 1` to support optimistic locking.
   */
  expectedVersion?: number;
}

export interface AddSharedPermissionOptions {
  repositoryId: string;
  permission: string;
  type: 'allow' | 'deny';
}

export class PermissionsFileParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PermissionsFileParseError';
  }
}

export class PermissionsVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionsVersionConflictError';
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function getConfigRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'tim');
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'tim');
  }

  return path.join(os.homedir(), '.config', 'tim');
}

export function getPermissionsFilePath(repositoryId: string): string {
  const baseDir = getConfigRoot();
  return path.join(baseDir, 'shared', repositoryId, 'permissions.json');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireFileLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  // Spin until we can create the lock file or we exceed the deadline.
  while (true) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })
        );
      } finally {
        await handle.close();
      }

      return async () => {
        await fs.rm(lockPath, { force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new PermissionsVersionConflictError(
          `Timed out acquiring permissions lock at ${lockPath}`
        );
      }

      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > LOCK_STALE_THRESHOLD_MS) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        const statCode = (statError as NodeJS.ErrnoException).code;
        if (statCode !== 'ENOENT') {
          await sleep(LOCK_RETRY_DELAY_MS);
          continue;
        }
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function readExistingPermissions(filePath: string): Promise<SharedPermissionsFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return sharedPermissionsFileSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    if (error instanceof SyntaxError || (error as { name?: string }).name === 'ZodError') {
      throw new PermissionsFileParseError(
        `Failed to parse permissions file at ${filePath}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    throw error;
  }
}

export async function readSharedPermissions(
  options: ReadSharedPermissionsOptions
): Promise<SharedPermissionsFile> {
  const filePath = getPermissionsFilePath(options.repositoryId);
  const existing = await readExistingPermissions(filePath);

  if (!existing) {
    return {
      repositoryId: options.repositoryId,
      version: 0,
      permissions: {
        allow: [],
        deny: [],
      },
    };
  }

  if (existing.repositoryId !== options.repositoryId) {
    throw new PermissionsFileParseError(
      `Permissions file repositoryId mismatch: expected ${options.repositoryId}, found ${existing.repositoryId}`
    );
  }

  return existing;
}

export async function writeSharedPermissions(
  permissions: SharedPermissionsFile,
  options: WriteSharedPermissionsOptions = {}
): Promise<void> {
  const validated = sharedPermissionsFileSchema.parse(permissions);
  const filePath = getPermissionsFilePath(validated.repositoryId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const expectedVersion = options.expectedVersion ?? Math.max(0, validated.version - 1);

  const lockPath = `${filePath}.lock`;
  const releaseLock = await acquireFileLock(lockPath);
  const tempPath = `${filePath}.${TEMP_FILE_SUFFIX}.${Math.random().toString(36).slice(2)}`;
  const serialized = ensureTrailingNewline(JSON.stringify(validated, null, 2));

  try {
    const current = await readExistingPermissions(filePath);
    const currentVersion = current?.version ?? 0;

    if (expectedVersion !== currentVersion) {
      throw new PermissionsVersionConflictError(
        `Permissions version conflict for ${validated.repositoryId}: expected ${expectedVersion}, found ${currentVersion}`
      );
    }

    if (validated.version < currentVersion) {
      throw new PermissionsVersionConflictError(
        `Permissions version ${validated.version} is older than persisted version ${currentVersion} for ${validated.repositoryId}`
      );
    }

    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

/**
 * Atomically adds a permission to the shared permissions file.
 * Handles file locking and version conflicts automatically.
 */
export async function addSharedPermission(options: AddSharedPermissionOptions): Promise<void> {
  const filePath = getPermissionsFilePath(options.repositoryId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const lockPath = `${filePath}.lock`;
  const releaseLock = await acquireFileLock(lockPath);
  const tempPath = `${filePath}.${TEMP_FILE_SUFFIX}.${Math.random().toString(36).slice(2)}`;

  try {
    const current = await readExistingPermissions(filePath);
    const currentPermissions = current?.permissions ?? { allow: [], deny: [] };

    // Check if permission already exists in the target list
    const targetList =
      options.type === 'allow' ? currentPermissions.allow : currentPermissions.deny;
    if (targetList.includes(options.permission)) {
      // Permission already exists, nothing to do
      return;
    }

    // Add the permission to the appropriate list
    const updatedPermissions = {
      allow: [...currentPermissions.allow],
      deny: [...currentPermissions.deny],
    };

    if (options.type === 'allow') {
      updatedPermissions.allow.push(options.permission);
    } else {
      updatedPermissions.deny.push(options.permission);
    }

    const updated: SharedPermissionsFile = {
      repositoryId: options.repositoryId,
      version: (current?.version ?? 0) + 1,
      permissions: updatedPermissions,
      updatedAt: new Date().toISOString(),
    };

    const serialized = ensureTrailingNewline(JSON.stringify(updated, null, 2));
    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  } finally {
    await releaseLock();
  }
}
