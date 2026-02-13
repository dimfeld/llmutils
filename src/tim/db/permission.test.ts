import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase } from './database.js';
import { getPermissions, addPermission, removePermission, setPermissions } from './permission.js';
import { getOrCreateProject } from './project.js';

describe('tim db/permission', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-permission-db-test-'));
    db = openDatabase(path.join(tempDir, 'tim.db'));
    projectId = getOrCreateProject(db, 'repo-1').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getPermissions returns empty lists for project with no permissions', () => {
    expect(getPermissions(db, projectId)).toEqual({ allow: [], deny: [] });
  });

  test('addPermission inserts new permission and blocks duplicates', () => {
    expect(addPermission(db, projectId, 'allow', 'Edit')).toBe(true);
    expect(addPermission(db, projectId, 'allow', 'Edit')).toBe(false);
    expect(addPermission(db, projectId, 'deny', 'Bash(rm:*)')).toBe(true);

    expect(getPermissions(db, projectId)).toEqual({
      allow: ['Edit'],
      deny: ['Bash(rm:*)'],
    });
  });

  test('removePermission deletes a matching permission', () => {
    addPermission(db, projectId, 'allow', 'Edit');

    expect(removePermission(db, projectId, 'allow', 'Edit')).toBe(true);
    expect(removePermission(db, projectId, 'allow', 'Edit')).toBe(false);
    expect(getPermissions(db, projectId)).toEqual({ allow: [], deny: [] });
  });

  test('removePermission returns false when permission does not exist', () => {
    expect(removePermission(db, projectId, 'deny', 'Bash(rm:*)')).toBe(false);
  });

  test('setPermissions replaces all existing permissions', () => {
    addPermission(db, projectId, 'allow', 'Edit');
    addPermission(db, projectId, 'deny', 'Bash(rm:*)');

    setPermissions(db, projectId, {
      allow: ['Read', 'Write'],
      deny: ['Bash(git push:*)'],
    });

    expect(getPermissions(db, projectId)).toEqual({
      allow: ['Read', 'Write'],
      deny: ['Bash(git push:*)'],
    });
  });

  test('setPermissions with empty arrays clears existing permissions', () => {
    addPermission(db, projectId, 'allow', 'Read');
    addPermission(db, projectId, 'deny', 'Bash(rm:*)');

    setPermissions(db, projectId, { allow: [], deny: [] });

    expect(getPermissions(db, projectId)).toEqual({ allow: [], deny: [] });
  });
});
