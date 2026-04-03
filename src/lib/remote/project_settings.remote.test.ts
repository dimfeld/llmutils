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

import { updateProjectSetting } from './project_settings.remote.js';

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
      invokeCommand(updateProjectSetting, { projectId, setting: 'featured', value: true })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(true);
  });

  test('successfully updates an existing project setting', async () => {
    await invokeCommand(updateProjectSetting, { projectId, setting: 'featured', value: true });

    await expect(
      invokeCommand(updateProjectSetting, { projectId, setting: 'featured', value: false })
    ).resolves.toBeUndefined();

    expect(getProjectSetting(currentDb, projectId, 'featured')).toBe(false);
  });

  test('returns a 404 when the project does not exist', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId: projectId + 999,
        setting: 'featured',
        value: true,
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

  test('rejects non-boolean values for the featured setting', async () => {
    await expect(
      invokeCommand(updateProjectSetting, {
        projectId,
        setting: 'featured',
        value: 'yes',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        message: expect.stringContaining('Invalid value for setting "featured"'),
      },
    });
  });
});
