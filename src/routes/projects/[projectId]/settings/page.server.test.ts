import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import { load } from './+page.server.js';

describe('projects/[projectId]/settings/+page.server', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-settings-page-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-project-settings-page', {
      remoteUrl: 'https://example.com/repo-project-settings-page.git',
      lastGitRoot: '/tmp/repo-project-settings-page',
    }).id;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('redirects to the all-project sessions page when projectId is all', async () => {
    await expect(load({ params: { projectId: 'all' } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/projects/all/sessions',
    });
  });

  test('loads project settings for a numeric project id', async () => {
    setProjectSetting(currentDb, projectId, 'featured', false);

    await expect(
      load({
        params: { projectId: String(projectId) },
      } as never)
    ).resolves.toEqual({
      settings: {
        featured: false,
      },
      settingMetadata: {
        featured: {
          revision: 1,
          updatedAt: expect.any(String),
          updatedByNode: null,
        },
      },
    });
  });
});
