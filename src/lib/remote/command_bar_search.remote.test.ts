import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

describe('command_bar_search remote function', () => {
  let tempDir: string;
  let projectId: number;
  let otherProjectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-command-bar-search-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'github.com__example__repo').id;
    otherProjectId = getOrCreateProject(currentDb, 'github.com__other__repo').id;

    upsertPlan(currentDb, projectId, {
      uuid: 'plan-command-bar',
      planId: 42,
      title: 'Command palette keyboard shortcut',
      status: 'in_progress',
    });
    upsertPlan(currentDb, otherProjectId, {
      uuid: 'plan-other-project',
      planId: 43,
      title: 'Other project command palette',
      status: 'pending',
    });

    const linkedOnlyPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/no-project/misc/pull/102',
      owner: 'no-project',
      repo: 'misc',
      prNumber: 102,
      title: 'Command palette linked through plan',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/other/repo/pull/103',
      owner: 'other',
      repo: 'repo',
      prNumber: 103,
      title: 'Other project command palette PR',
      state: 'open',
      draft: false,
      author: 'dimfeld',
      lastFetchedAt: '2026-04-01T00:00:00.000Z',
    });

    linkPlanToPr(currentDb, 'plan-command-bar', linkedOnlyPr.status.id);
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns plans and PRs for a scoped project search', async () => {
    const { searchCommandBar } = await import('./command_bar_search.remote.js');

    await expect(invokeQuery(searchCommandBar, { query: 'Command palette', projectId })).resolves
      .toEqual({
        plans: [
          expect.objectContaining({
            uuid: 'plan-command-bar',
            planId: 42,
            projectId,
          }),
        ],
        prs: [
          expect.objectContaining({
            pr_url: 'https://github.com/no-project/misc/pull/102',
            pr_number: 102,
            projectId,
          }),
        ],
      });
  });

  test('searches across all projects when projectId is omitted', async () => {
    const { searchCommandBar } = await import('./command_bar_search.remote.js');

    const result = await invokeQuery(searchCommandBar, { query: 'Other project' });

    expect(result.plans).toEqual([
      expect.objectContaining({
        uuid: 'plan-other-project',
        projectId: otherProjectId,
      }),
    ]);
    expect(result.prs).toEqual([
      expect.objectContaining({
        pr_url: 'https://github.com/other/repo/pull/103',
        projectId: otherProjectId,
      }),
    ]);
  });
});
