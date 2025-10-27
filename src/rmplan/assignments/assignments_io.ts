import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { assignmentsFileSchema, type AssignmentsFile } from './assignments_schema.js';

const TEMP_FILE_SUFFIX = `.tmp-${process.pid}-${Date.now()}`;

export interface ReadAssignmentsOptions {
  repositoryId: string;
  repositoryRemoteUrl?: string | null;
}

export interface WriteAssignmentsOptions {
  /**
   * The version the caller believes is currently persisted. Defaults to
   * `assignments.version - 1` to support optimistic locking.
   */
  expectedVersion?: number;
}

export class AssignmentsFileParseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssignmentsFileParseError';
  }
}

export class AssignmentsVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentsVersionConflictError';
  }
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith('\n') ? content : `${content}\n`;
}

function getConfigRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'rmplan');
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, 'rmplan');
  }

  return path.join(os.homedir(), '.config', 'rmplan');
}

export function getAssignmentsFilePath(repositoryId: string): string {
  const baseDir = getConfigRoot();
  return path.join(baseDir, 'shared', repositoryId, 'assignments.json');
}

async function readExistingAssignments(filePath: string): Promise<AssignmentsFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return assignmentsFileSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    if (error instanceof SyntaxError || (error as { name?: string }).name === 'ZodError') {
      throw new AssignmentsFileParseError(
        `Failed to parse assignments file at ${filePath}`,
        error instanceof Error ? { cause: error } : undefined
      );
    }

    throw error;
  }
}

export async function readAssignments(options: ReadAssignmentsOptions): Promise<AssignmentsFile> {
  const filePath = getAssignmentsFilePath(options.repositoryId);
  const existing = await readExistingAssignments(filePath);

  if (!existing) {
    return {
      repositoryId: options.repositoryId,
      repositoryRemoteUrl: options.repositoryRemoteUrl ?? null,
      version: 0,
      assignments: {},
    };
  }

  if (existing.repositoryId !== options.repositoryId) {
    throw new AssignmentsFileParseError(
      `Assignments file repositoryId mismatch: expected ${options.repositoryId}, found ${existing.repositoryId}`
    );
  }

  return existing;
}

export async function writeAssignments(
  assignments: AssignmentsFile,
  options: WriteAssignmentsOptions = {}
): Promise<void> {
  const validated = assignmentsFileSchema.parse(assignments);
  const filePath = getAssignmentsFilePath(validated.repositoryId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  const expectedVersion = options.expectedVersion ?? Math.max(0, validated.version - 1);

  const current = await readExistingAssignments(filePath);
  const currentVersion = current?.version ?? 0;

  if (expectedVersion !== currentVersion) {
    throw new AssignmentsVersionConflictError(
      `Assignments version conflict for ${validated.repositoryId}: expected ${expectedVersion}, found ${currentVersion}`
    );
  }

  if (validated.version < currentVersion) {
    throw new AssignmentsVersionConflictError(
      `Assignments version ${validated.version} is older than persisted version ${currentVersion} for ${validated.repositoryId}`
    );
  }

  const tempPath = `${filePath}.${TEMP_FILE_SUFFIX}.${Math.random().toString(36).slice(2)}`;

  const serialized = ensureTrailingNewline(JSON.stringify(validated, null, 2));

  try {
    await fs.writeFile(tempPath, serialized, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}
