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
  removeAssignment,
  reserveNextPlanId,
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

  test('removeAssignment deletes entries and bumps version', async () => {
    const repositoryId = 'test-repo';
    const base = await readAssignments({ repositoryId });
    const uuid = '123e4567-e89b-12d3-a456-426614174abc';
    const assignedAt = new Date().toISOString();

    const withAssignment = {
      ...base,
      version: base.version + 1,
      assignments: {
        [uuid]: {
          planId: 77,
          workspacePaths: ['/tmp/workspace-1'],
          users: ['carol'],
          status: 'in_progress' as const,
          assignedAt,
          updatedAt: assignedAt,
        },
      },
    };

    await writeAssignments(withAssignment);

    const removed = await removeAssignment({ repositoryId, uuid, repositoryRemoteUrl: null });
    expect(removed).toBe(true);

    const persisted = await readAssignments({ repositoryId });
    expect(persisted.assignments[uuid]).toBeUndefined();
    expect(persisted.version).toBe(withAssignment.version + 1);
  });

  test('removeAssignment returns false when entry missing', async () => {
    const repositoryId = 'missing-test';
    const existing = await readAssignments({ repositoryId });
    expect(existing.assignments).toEqual({});

    const removed = await removeAssignment({
      repositoryId,
      uuid: 'abcd',
      repositoryRemoteUrl: null,
    });
    expect(removed).toBe(false);

    const after = await readAssignments({ repositoryId });
    expect(after).toEqual(existing);
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

  describe('reserveNextPlanId', () => {
    test('returns localMaxId + 1 when no shared state exists', async () => {
      const repositoryId = 'reserve-test-1';
      const result = await reserveNextPlanId({
        repositoryId,
        localMaxId: 5,
      });

      expect(result).toEqual({ startId: 6, endId: 6 });

      // Verify the highestPlanId was persisted
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(6);
    });

    test('returns max(localMaxId, sharedMaxId) + 1 when shared state has higher ID', async () => {
      const repositoryId = 'reserve-test-2';

      // Set up initial shared state with higher ID
      await writeAssignments({
        repositoryId,
        repositoryRemoteUrl: null,
        version: 1,
        assignments: {},
        highestPlanId: 10,
      });

      const result = await reserveNextPlanId({
        repositoryId,
        localMaxId: 5,
      });

      expect(result).toEqual({ startId: 11, endId: 11 });

      // Verify the highestPlanId was updated
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(11);
    });

    test('uses localMaxId when it is higher than shared state', async () => {
      const repositoryId = 'reserve-test-3';

      // Set up initial shared state with lower ID
      await writeAssignments({
        repositoryId,
        repositoryRemoteUrl: null,
        version: 1,
        assignments: {},
        highestPlanId: 3,
      });

      const result = await reserveNextPlanId({
        repositoryId,
        localMaxId: 10,
      });

      expect(result).toEqual({ startId: 11, endId: 11 });

      // Verify the highestPlanId was updated
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(11);
    });

    test('reserves multiple IDs with count > 1', async () => {
      const repositoryId = 'reserve-test-batch';
      const result = await reserveNextPlanId({
        repositoryId,
        localMaxId: 5,
        count: 3,
      });

      expect(result).toEqual({ startId: 6, endId: 8 });

      // Verify the highestPlanId was set to the end of the range
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(8);
    });

    test('batch reservation with existing shared state', async () => {
      const repositoryId = 'reserve-test-batch-existing';

      // Set up initial shared state
      await writeAssignments({
        repositoryId,
        repositoryRemoteUrl: null,
        version: 1,
        assignments: {},
        highestPlanId: 10,
      });

      const result = await reserveNextPlanId({
        repositoryId,
        localMaxId: 5,
        count: 5,
      });

      expect(result).toEqual({ startId: 11, endId: 15 });

      // Verify the highestPlanId was updated
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(15);
    });

    test('preserves existing assignments when reserving IDs', async () => {
      const repositoryId = 'reserve-test-preserve';
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      const assignedAt = new Date().toISOString();

      // Set up initial state with an assignment
      await writeAssignments({
        repositoryId,
        repositoryRemoteUrl: 'https://example.com/repo.git',
        version: 1,
        assignments: {
          [uuid]: {
            planId: 42,
            workspacePaths: ['/tmp/workspace'],
            users: ['alice'],
            status: 'in_progress',
            assignedAt,
            updatedAt: assignedAt,
          },
        },
        highestPlanId: 50,
      });

      await reserveNextPlanId({
        repositoryId,
        localMaxId: 10,
      });

      // Verify assignments were preserved
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.assignments[uuid]).toBeDefined();
      expect(assignments.assignments[uuid].planId).toBe(42);
      expect(assignments.repositoryRemoteUrl).toBe('https://example.com/repo.git');
    });

    test('throws error when count is less than 1', async () => {
      const repositoryId = 'reserve-test-invalid-count';

      await expect(
        reserveNextPlanId({
          repositoryId,
          localMaxId: 5,
          count: 0,
        })
      ).rejects.toThrow('count must be at least 1');
    });

    test('concurrent reservations get sequential non-overlapping IDs', async () => {
      const repositoryId = 'reserve-test-concurrent';

      // Fire off multiple concurrent reservations
      const [result1, result2, result3] = await Promise.all([
        reserveNextPlanId({ repositoryId, localMaxId: 0, count: 2 }),
        reserveNextPlanId({ repositoryId, localMaxId: 0, count: 3 }),
        reserveNextPlanId({ repositoryId, localMaxId: 0, count: 1 }),
      ]);

      // Collect all reserved IDs
      const allIds: number[] = [];
      for (let id = result1.startId; id <= result1.endId; id++) allIds.push(id);
      for (let id = result2.startId; id <= result2.endId; id++) allIds.push(id);
      for (let id = result3.startId; id <= result3.endId; id++) allIds.push(id);

      // Verify no overlaps - all IDs should be unique
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);

      // Verify all IDs are in expected range
      const minId = Math.min(...allIds);
      const maxId = Math.max(...allIds);
      expect(minId).toBe(1);
      expect(maxId).toBe(6); // 2 + 3 + 1 = 6 total IDs

      // Verify final state has correct highestPlanId
      const assignments = await readAssignments({ repositoryId });
      expect(assignments.highestPlanId).toBe(6);
    });
  });
});
