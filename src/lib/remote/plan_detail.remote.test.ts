import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPlan } from '$tim/db/plan.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$lib/server/plans_browser.js', () => ({
  loadFinishConfigForProject: vi.fn(async () => ({
    updateDocsMode: 'after-completion',
    applyLessons: true,
  })),
}));

describe('plan_detail remote function', () => {
  let tempDir: string;
  let planUuid: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-detail-remote-test-'));
  });

  beforeEach(() => {
    planUuid = crypto.randomUUID();
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const project = getOrCreateProject(currentDb, 'repo-plan-detail-remote');

    upsertPlan(currentDb, project.id, {
      uuid: planUuid,
      planId: 1,
      title: 'Plan needing finish config',
      filename: '1.plan.md',
      status: 'needs_review',
      docsUpdatedAt: null,
      lessonsAppliedAt: null,
    });
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('loads per-project finish config before returning plan detail', async () => {
    const { getPlanDetail } = await import('./plan_detail.remote.js');

    await expect(invokeQuery(getPlanDetail, { planUuid })).resolves.toMatchObject({
      plan: {
        uuid: planUuid,
        canUpdateDocs: true,
      },
      openInEditorEnabled: expect.any(Boolean),
    });
  });
});
