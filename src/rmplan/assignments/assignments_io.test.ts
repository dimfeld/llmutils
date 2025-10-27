import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import {
  AssignmentsFileParseError,
  AssignmentsVersionConflictError,
  getAssignmentsFilePath,
  readAssignments,
  writeAssignments,
} from './assignments_io.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('assignments_io', () => {
  let tempDir: string;
  let fakeConfigDir: string;
  const originalEnv: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assignments-io-test-'));
    fakeConfigDir = path.join(tempDir, 'config');
    await fs.mkdir(fakeConfigDir, { recursive: true });

    originalEnv.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
    originalEnv.APPDATA = process.env.APPDATA;

    process.env.XDG_CONFIG_HOME = fakeConfigDir;
    delete process.env.APPDATA;

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => path.join(tempDir, 'home'),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('readAssignments returns default structure when file is missing', async () => {
    const repositoryId = 'test-repo';
    const result = await readAssignments({
      repositoryId,
      repositoryRemoteUrl: 'https://example.com/repo.git',
    });

    expect(result).toEqual({
      repositoryId,
      repositoryRemoteUrl: 'https://example.com/repo.git',
      version: 0,
      assignments: {},
    });
  });

  test('writeAssignments persists data with optimistic version check', async () => {
    const repositoryId = 'test-repo';
    const initial = await readAssignments({
      repositoryId,
      repositoryRemoteUrl: 'https://example.com/repo.git',
    });

    const assignedAt = new Date().toISOString();
    const updated = {
      ...initial,
      version: initial.version + 1,
      assignments: {
        '123e4567-e89b-12d3-a456-426614174000': {
          planId: 42,
          workspacePaths: ['/tmp/workspace-a'],
          users: ['alice'],
          status: 'in_progress',
          assignedAt,
          updatedAt: assignedAt,
        },
      },
    };

    await writeAssignments(updated);

    const filePath = getAssignmentsFilePath(repositoryId);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(fileContent)).toEqual(updated);

    const reread = await readAssignments({ repositoryId });
    expect(reread).toEqual(updated);

    const files = await fs.readdir(path.dirname(filePath));
    expect(files.sort()).toEqual(['assignments.json']);
  });

  test('writeAssignments detects version conflicts from stale data', async () => {
    const repositoryId = 'test-repo';
    const base = await readAssignments({ repositoryId });
    const firstWrite = {
      ...base,
      repositoryRemoteUrl: 'https://example.com/upstream.git',
      version: base.version + 1,
    };

    await writeAssignments(firstWrite);

    const stale = {
      ...firstWrite,
      version: 1,
    };

    await expect(writeAssignments(stale)).rejects.toBeInstanceOf(AssignmentsVersionConflictError);
  });

  test('readAssignments throws when file contains invalid JSON', async () => {
    const repositoryId = 'test-repo';
    const filePath = getAssignmentsFilePath(repositoryId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{invalid json', 'utf-8');

    await expect(readAssignments({ repositoryId })).rejects.toBeInstanceOf(
      AssignmentsFileParseError
    );
  });

  test('writeAssignments fails when existing file is invalid', async () => {
    const repositoryId = 'test-repo';
    const filePath = getAssignmentsFilePath(repositoryId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{"repositoryId":"test-repo","version":"not-a-number"}', 'utf-8');

    const next = {
      repositoryId,
      repositoryRemoteUrl: null,
      version: 1,
      assignments: {},
    };

    await expect(writeAssignments(next)).rejects.toBeInstanceOf(AssignmentsFileParseError);
  });

  test('readAssignments rejects repositoryId mismatches', async () => {
    const expectedRepositoryId = 'expected-id';
    const filePath = getAssignmentsFilePath(expectedRepositoryId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const persisted = {
      repositoryId: 'different-id',
      repositoryRemoteUrl: null,
      version: 2,
      assignments: {},
    };
    await fs.writeFile(filePath, JSON.stringify(persisted), 'utf-8');

    await expect(readAssignments({ repositoryId: expectedRepositoryId })).rejects.toBeInstanceOf(
      AssignmentsFileParseError
    );
  });
});
