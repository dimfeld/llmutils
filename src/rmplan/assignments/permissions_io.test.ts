import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import {
  PermissionsFileParseError,
  PermissionsVersionConflictError,
  getPermissionsFilePath,
  readSharedPermissions,
  writeSharedPermissions,
  addSharedPermission,
} from './permissions_io.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('permissions_io', () => {
  let tempDir: string;
  let fakeConfigDir: string;
  const originalEnv: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'permissions-io-test-'));
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

  test('readSharedPermissions returns default structure when file is missing', async () => {
    const repositoryId = 'test-repo';
    const result = await readSharedPermissions({ repositoryId });

    expect(result).toEqual({
      repositoryId,
      version: 0,
      permissions: {
        allow: [],
        deny: [],
      },
    });
  });

  test('writeSharedPermissions persists data with optimistic version check', async () => {
    const repositoryId = 'test-repo';
    const initial = await readSharedPermissions({ repositoryId });

    const updated = {
      ...initial,
      version: initial.version + 1,
      permissions: {
        allow: ['Edit', 'Write', 'Bash(jj commit:*)'],
        deny: [],
      },
      updatedAt: new Date().toISOString(),
    };

    await writeSharedPermissions(updated);

    const filePath = getPermissionsFilePath(repositoryId);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(JSON.parse(fileContent)).toEqual(updated);

    const reread = await readSharedPermissions({ repositoryId });
    expect(reread).toEqual(updated);

    const files = await fs.readdir(path.dirname(filePath));
    expect(files.sort()).toEqual(['permissions.json']);
  });

  test('writeSharedPermissions detects version conflicts from stale data', async () => {
    const repositoryId = 'test-repo';
    const base = await readSharedPermissions({ repositoryId });
    const firstWrite = {
      ...base,
      version: base.version + 1,
      permissions: {
        allow: ['Edit'],
        deny: [],
      },
    };

    await writeSharedPermissions(firstWrite);

    const stale = {
      ...firstWrite,
      version: 1,
    };

    await expect(writeSharedPermissions(stale)).rejects.toBeInstanceOf(
      PermissionsVersionConflictError
    );
  });

  test('readSharedPermissions throws when file contains invalid JSON', async () => {
    const repositoryId = 'test-repo';
    const filePath = getPermissionsFilePath(repositoryId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, '{invalid json', 'utf-8');

    await expect(readSharedPermissions({ repositoryId })).rejects.toBeInstanceOf(
      PermissionsFileParseError
    );
  });

  test('readSharedPermissions rejects repositoryId mismatches', async () => {
    const expectedRepositoryId = 'expected-id';
    const filePath = getPermissionsFilePath(expectedRepositoryId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const persisted = {
      repositoryId: 'different-id',
      version: 2,
      permissions: { allow: [], deny: [] },
    };
    await fs.writeFile(filePath, JSON.stringify(persisted), 'utf-8');

    await expect(
      readSharedPermissions({ repositoryId: expectedRepositoryId })
    ).rejects.toBeInstanceOf(PermissionsFileParseError);
  });

  describe('addSharedPermission', () => {
    test('adds new allow permission to empty file', async () => {
      const repositoryId = 'add-test-1';
      await addSharedPermission({
        repositoryId,
        permission: 'Edit',
        type: 'allow',
      });

      const result = await readSharedPermissions({ repositoryId });
      expect(result.permissions.allow).toEqual(['Edit']);
      expect(result.permissions.deny).toEqual([]);
      expect(result.version).toBe(1);
    });

    test('adds new deny permission', async () => {
      const repositoryId = 'add-test-2';
      await addSharedPermission({
        repositoryId,
        permission: 'Bash(rm:*)',
        type: 'deny',
      });

      const result = await readSharedPermissions({ repositoryId });
      expect(result.permissions.allow).toEqual([]);
      expect(result.permissions.deny).toEqual(['Bash(rm:*)']);
      expect(result.version).toBe(1);
    });

    test('appends to existing permissions', async () => {
      const repositoryId = 'add-test-3';

      // Add first permission
      await addSharedPermission({
        repositoryId,
        permission: 'Edit',
        type: 'allow',
      });

      // Add second permission
      await addSharedPermission({
        repositoryId,
        permission: 'Write',
        type: 'allow',
      });

      // Add Bash prefix
      await addSharedPermission({
        repositoryId,
        permission: 'Bash(jj commit:*)',
        type: 'allow',
      });

      const result = await readSharedPermissions({ repositoryId });
      expect(result.permissions.allow).toEqual(['Edit', 'Write', 'Bash(jj commit:*)']);
      expect(result.version).toBe(3);
    });

    test('does not duplicate existing permissions', async () => {
      const repositoryId = 'add-test-dup';

      await addSharedPermission({
        repositoryId,
        permission: 'Edit',
        type: 'allow',
      });

      // Try to add the same permission again
      await addSharedPermission({
        repositoryId,
        permission: 'Edit',
        type: 'allow',
      });

      const result = await readSharedPermissions({ repositoryId });
      expect(result.permissions.allow).toEqual(['Edit']);
      // Version should still be 1 since no change was made
      expect(result.version).toBe(1);
    });

    test('concurrent adds get sequential non-overlapping additions', async () => {
      const repositoryId = 'add-test-concurrent';

      // Fire off multiple concurrent additions
      await Promise.all([
        addSharedPermission({ repositoryId, permission: 'Edit', type: 'allow' }),
        addSharedPermission({ repositoryId, permission: 'Write', type: 'allow' }),
        addSharedPermission({ repositoryId, permission: 'Bash(npm test:*)', type: 'allow' }),
      ]);

      const result = await readSharedPermissions({ repositoryId });
      // All permissions should be present (order may vary due to concurrency)
      expect(result.permissions.allow).toContain('Edit');
      expect(result.permissions.allow).toContain('Write');
      expect(result.permissions.allow).toContain('Bash(npm test:*)');
      expect(result.permissions.allow.length).toBe(3);
    });

    test('sets updatedAt timestamp', async () => {
      const repositoryId = 'add-test-timestamp';
      const before = new Date().toISOString();

      await addSharedPermission({
        repositoryId,
        permission: 'Edit',
        type: 'allow',
      });

      const after = new Date().toISOString();
      const result = await readSharedPermissions({ repositoryId });

      expect(result.updatedAt).toBeDefined();
      expect(result.updatedAt! >= before).toBe(true);
      expect(result.updatedAt! <= after).toBe(true);
    });
  });
});
