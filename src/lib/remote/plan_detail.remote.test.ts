import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { createReview } from '$tim/db/review.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$lib/server/plans_browser.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/plans_browser.js')>()),
  loadFinishConfigForProject: vi.fn(async () => ({
    updateDocsMode: 'after-completion',
    applyLessons: true,
  })),
}));

describe('plan_detail remote function', () => {
  let tempDir: string;
  let planUuid: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-detail-remote-test-'));
  });

  beforeEach(() => {
    planUuid = crypto.randomUUID();
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const project = getOrCreateProject(currentDb, 'repo-plan-detail-remote');
    projectId = project.id;

    nonSyncedUpsertPlan(currentDb, project.id, {
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

  test('returns PR-linked review guides for active plan details', async () => {
    const { getPlanDetail } = await import('./plan_detail.remote.js');
    const pr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/311',
      owner: 'example',
      repo: 'repo',
      prNumber: 311,
      author: 'alice',
      title: 'Linked review guide',
      state: 'open',
      draft: false,
      headSha: 'head-sha',
      baseBranch: 'main',
      headBranch: 'feature/review-guide',
      lastFetchedAt: '2026-05-15T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, planUuid, pr.status.id, 'auto');
    const review = createReview(currentDb, {
      projectId,
      prUrl: pr.status.pr_url,
      branch: 'feature/review-guide',
      baseBranch: 'main',
      reviewedSha: 'head-sha',
      status: 'complete',
      reviewGuide: '# Guide',
    });

    const result = await invokeQuery(getPlanDetail, { planUuid });

    expect(result?.reviews).toEqual([
      expect.objectContaining({
        id: review.id,
        pr_url: pr.status.pr_url,
      }),
    ]);
    expect(result?.reviews[0]).not.toHaveProperty('review_guide');
    expect(result?.plan.prStatuses).toEqual([
      {
        status: {
          pr_url: pr.status.pr_url,
          state: 'open',
          merged_at: null,
        },
      },
    ]);
  });
});
