import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import {
  deleteProjectSetting,
  getProjectSetting,
  getProjectSettings,
  setProjectSetting,
} from './project_settings.js';

describe('tim db/project_settings', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-settings-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('setProjectSetting stores and getProjectSetting returns parsed JSON value', () => {
    const project = getOrCreateProject(db, 'repo-1');

    setProjectSetting(db, project.id, 'featured', true);

    expect(getProjectSetting(db, project.id, 'featured')).toBe(true);
  });

  test('getProjectSettings returns all settings for a project', () => {
    const project = getOrCreateProject(db, 'repo-1');

    setProjectSetting(db, project.id, 'featured', false);
    setProjectSetting(db, project.id, 'displayName', 'Main Project');

    expect(getProjectSettings(db, project.id)).toEqual({
      displayName: 'Main Project',
      featured: false,
    });
  });

  test('setProjectSetting overwrites an existing setting', () => {
    const project = getOrCreateProject(db, 'repo-1');

    setProjectSetting(db, project.id, 'featured', true);
    setProjectSetting(db, project.id, 'featured', false);

    expect(getProjectSetting(db, project.id, 'featured')).toBe(false);
  });

  test('deleteProjectSetting removes an existing setting and returns true', () => {
    const project = getOrCreateProject(db, 'repo-1');
    setProjectSetting(db, project.id, 'featured', true);

    expect(deleteProjectSetting(db, project.id, 'featured')).toBe(true);
    expect(getProjectSetting(db, project.id, 'featured')).toBeNull();
  });

  test('deleteProjectSetting returns false when the setting does not exist', () => {
    const project = getOrCreateProject(db, 'repo-1');

    expect(deleteProjectSetting(db, project.id, 'missing')).toBe(false);
  });

  test('getProjectSetting returns null for a nonexistent setting', () => {
    const project = getOrCreateProject(db, 'repo-1');

    expect(getProjectSetting(db, project.id, 'featured')).toBeNull();
  });

  test('settings are isolated between projects', () => {
    const firstProject = getOrCreateProject(db, 'repo-1');
    const secondProject = getOrCreateProject(db, 'repo-2');

    setProjectSetting(db, firstProject.id, 'featured', false);
    setProjectSetting(db, secondProject.id, 'featured', true);

    expect(getProjectSettings(db, firstProject.id)).toEqual({ featured: false });
    expect(getProjectSettings(db, secondProject.id)).toEqual({ featured: true });
  });

  test('setProjectSetting throws on undefined value', () => {
    const project = getOrCreateProject(db, 'repo-1');
    expect(() => setProjectSetting(db, project.id, 'featured', undefined)).toThrow();
  });

  test('project setting rows are deleted when the parent project is deleted', () => {
    const project = getOrCreateProject(db, 'repo-1');
    setProjectSetting(db, project.id, 'featured', false);

    db.prepare('DELETE FROM project WHERE id = ?').run(project.id);

    expect(getProjectSetting(db, project.id, 'featured')).toBeNull();
    expect(getProjectSettings(db, project.id)).toEqual({});
  });
});
