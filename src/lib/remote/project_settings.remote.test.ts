import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { getProjectSetting } from '$tim/db/project_settings.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import { updateProjectSetting, updateProjectSettings } from './project_settings.remote.js';

describe('project settings remote actions', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-settings-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-project-settings-remote', {
      remoteUrl: 'https://example.com/repo-project-settings-remote.git',
      lastGitRoot: '/tmp/repo-project-settings-remote',
    }).id;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('successfully sets a project setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: true,
        baseRevision: 0,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(true);
  });

  test('successfully updates an existing project setting', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'featured',
      value: true,
      baseRevision: 0,
    });

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: false,
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(false);
  });

  test('stale baseRevision conflicts instead of overwriting latest project setting', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'featured',
      value: true,
      baseRevision: 0,
    });

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: false,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      name: 'SyncWriteConflictError',
    });

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(true);
  });

  test('returns a 404 when the project does not exist', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId: projectId + 999,
        setting: 'featured',
        value: true,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Project not found' },
    });
  });

  test('rejects undefined values during input validation', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: undefined,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: [
        expect.objectContaining({
          message: 'Value must not be undefined',
          path: ['value'],
        }),
      ],
    });
  });

  test('rejects unknown setting names', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'nonexistent',
        value: true,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: 'Unknown setting: "nonexistent"',
      },
    });
  });

  test('rejects non-boolean values for the featured setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: 'yes',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "featured"'),
      },
    });
  });

  test('successfully sets an abbreviation setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: 'AB',
        baseRevision: 0,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBe('AB');
  });

  test('rejects abbreviation longer than 4 characters', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: 'ABCDE',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "abbreviation"'),
      },
    });
  });

  test('rejects non-string abbreviation', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: 123,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "abbreviation"'),
      },
    });
  });

  test('successfully sets a color setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'color',
        value: '#e74c3c',
        baseRevision: 0,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'color')).toBe('#e74c3c');
  });

  test('rejects invalid color values', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'color',
        value: '#ffffff',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "color"'),
      },
    });
  });

  test('rejects non-string color values', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'color',
        value: true,
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "color"'),
      },
    });
  });

  test('empty string clears a setting back to default', async () => {
    // Set a color first
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'color',
      value: '#e74c3c',
      baseRevision: 0,
    });
    expect(getProjectSetting(currentDb, projectId, 'color')).toBe('#e74c3c');

    // Clear it with empty string
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'color',
        value: '',
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'color')).toBeNull();
  });

  test('whitespace-only abbreviation clears to default', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'abbreviation',
      value: 'AB',
      baseRevision: 0,
    });
    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBe('AB');

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: '   ',
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBeNull();
  });

  test('trims whitespace from abbreviation before saving', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: ' AB ',
        baseRevision: 0,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBe('AB');
  });

  test('successfully sets a branchPrefix setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'di/',
        baseRevision: 0,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'branchPrefix')).toBe('di/');
  });

  test('successfully updates an existing branchPrefix', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'branchPrefix',
      value: 'di/',
      baseRevision: 0,
    });

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'feature-',
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'branchPrefix')).toBe('feature-');
  });

  test('rejects branchPrefix longer than 20 characters', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'a-very-long-prefix-that-exceeds',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "branchPrefix"'),
      },
    });
  });

  test('rejects invalid branchPrefix characters', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'foo:bar',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "branchPrefix"'),
      },
    });
  });

  test('rejects branchPrefix with SOH control character (\\x01)', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'foo\x01bar',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "branchPrefix"'),
      },
    });
  });

  test('rejects branchPrefix with DEL character (\\x7f)', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: 'foo\x7fbar',
        baseRevision: 0,
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "branchPrefix"'),
      },
    });
  });

  test('empty string clears branchPrefix to null', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'branchPrefix',
      value: 'di/',
      baseRevision: 0,
    });
    expect(getProjectSetting(currentDb, projectId, 'branchPrefix')).toBe('di/');

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'branchPrefix',
        value: '',
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'branchPrefix')).toBeNull();
  });

  test('empty string clears abbreviation setting', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'abbreviation',
      value: 'AB',
      baseRevision: 0,
    });
    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBe('AB');

    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'abbreviation',
        value: '',
        baseRevision: 1,
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBeNull();
  });

  test('successfully applies multiple settings in one batch', async () => {
    await expect(
      invokeCommand(updateProjectSettings, {
        projectId,
        settings: [
          { setting: 'featured', value: false, baseRevision: 0 },
          { setting: 'abbreviation', value: ' AB ', baseRevision: 0 },
          { setting: 'color', value: '#e74c3c', baseRevision: 0 },
          { setting: 'branchPrefix', value: 'di/', baseRevision: 0 },
        ],
      })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(false);
    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBe('AB');
    expect(getProjectSetting(currentDb, projectId, 'color')).toBe('#e74c3c');
    expect(getProjectSetting(currentDb, projectId, 'branchPrefix')).toBe('di/');
  });

  test('stale baseRevision in a batch rolls back other setting changes', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'featured',
      value: true,
      baseRevision: 0,
    });
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'color',
      value: '#e74c3c',
      baseRevision: 0,
    });

    await expect(
      invokeCommand(updateProjectSettings, {
        projectId,
        settings: [
          { setting: 'abbreviation', value: 'AB', baseRevision: 0 },
          { setting: 'featured', value: false, baseRevision: 0 },
          { setting: 'color', value: '', baseRevision: 1 },
        ],
      })
    ).rejects.toMatchObject({
      name: 'SyncWriteConflictError',
    });

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(true);
    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBeNull();
    expect(getProjectSetting(currentDb, projectId, 'color')).toBe('#e74c3c');
  });

  test('rejects a batch before writing any settings when one value is invalid', async () => {
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'featured',
      value: true,
      baseRevision: 0,
    });
    await invokeCommand(updateProjectSetting, {
      projectId,
      setting: 'color',
      value: '#e74c3c',
      baseRevision: 0,
    });

    await expect(
      invokeCommand(updateProjectSettings, {
        projectId,
        settings: [
          { setting: 'featured', value: false, baseRevision: 1 },
          { setting: 'abbreviation', value: 'ABCDE', baseRevision: 0 },
          { setting: 'color', value: '', baseRevision: 1 },
        ],
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "abbreviation"'),
      },
    });

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(true);
    expect(getProjectSetting(currentDb, projectId, 'abbreviation')).toBeNull();
    expect(getProjectSetting(currentDb, projectId, 'color')).toBe('#e74c3c');
  });
});
