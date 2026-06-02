import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { createReview, insertReviewIssues } from '$tim/db/review.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import { load } from './+page.server.js';

describe('projects/[projectId]/plans/[planId]/reviews/[reviewId]/+page.server', () => {
  let tempDir: string;
  let projectId: number;
  const planUuid = 'plan-review-viewer-uuid';

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-review-viewer-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-plan-review-viewer', {
      remoteUrl: 'https://example.com/repo-plan-review-viewer.git',
      lastGitRoot: '/tmp/repo-plan-review-viewer',
    }).id;
    upsertPlan(currentDb, projectId, {
      uuid: planUuid,
      planId: 7001,
      title: 'Plan 7001',
      status: 'pending',
      priority: 'medium',
      epic: false,
      filename: '7001.plan.md',
    });
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function invokeLoad(params: { projectId: string; planId: string; reviewId: string }) {
    return load({ params } as never);
  }

  test('returns review and plan when ids match', async () => {
    const review = createReview(currentDb, {
      projectId,
      planUuid,
      status: 'complete',
      reviewGuide: '# Guide\nbody',
    });
    const [issue] = insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'minor',
          category: 'style',
          file: 'src/foo.ts',
          line: 12,
          content: 'nit',
        },
      ],
    });

    const result = await invokeLoad({
      projectId: String(projectId),
      planId: planUuid,
      reviewId: String(review.id),
    });

    expect(result.review.id).toBe(review.id);
    expect(result.plan.uuid).toBe(planUuid);
    expect(result.plan.planId).toBe(7001);
    expect(result.projectId).toBe(String(projectId));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].id).toBe(issue.id);
    expect(result.submissions).toEqual([]);
    expect(result.currentBranch).toBeNull();
    expect(result.currentHeadSha).toBeNull();
    expect(result.submitAsCommentOnly).toBe(false);
  });

  test('includes PR submission context when a plan review is linked to a PR', async () => {
    const prUrl = 'https://github.com/example/repo/pull/7210';
    upsertPrStatus(currentDb, {
      prUrl,
      owner: 'example',
      repo: 'repo',
      prNumber: 7210,
      author: 'configured-reviewer',
      title: 'Plan-linked PR',
      state: 'open',
      draft: false,
      headSha: 'current-head-sha',
      baseBranch: 'main',
      headBranch: 'feature/plan-linked-pr',
      lastFetchedAt: '2026-05-15T00:00:00.000Z',
    });
    const review = createReview(currentDb, {
      projectId,
      planUuid,
      prUrl,
      branch: 'feature/plan-linked-pr',
      baseBranch: 'main',
      reviewedSha: 'reviewed-sha',
      status: 'complete',
      reviewGuide: '# Guide',
    });

    const result = await invokeLoad({
      projectId: String(projectId),
      planId: planUuid,
      reviewId: String(review.id),
    });

    expect(result.review.id).toBe(review.id);
    expect(result.currentBranch).toBe('feature/plan-linked-pr');
    expect(result.currentHeadSha).toBe('current-head-sha');
    expect(result.linkedPlanUuid).toBe(planUuid);
    expect(result.submitAsCommentOnly).toBe(false);
  });

  test('infers PR submission context for a plan-only review with one linked PR', async () => {
    const prUrl = 'https://github.com/example/repo/pull/7211';
    const prStatus = upsertPrStatus(currentDb, {
      prUrl,
      owner: 'example',
      repo: 'repo',
      prNumber: 7211,
      author: 'configured-reviewer',
      title: 'Plan-only linked PR',
      state: 'open',
      draft: false,
      headSha: 'linked-head-sha',
      baseBranch: 'main',
      headBranch: 'feature/plan-only-linked-pr',
      lastFetchedAt: '2026-05-15T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, planUuid, prStatus.status.id);
    const review = createReview(currentDb, {
      projectId,
      planUuid,
      branch: 'feature/plan-only-linked-pr',
      baseBranch: 'main',
      reviewedSha: 'reviewed-sha',
      status: 'complete',
      reviewGuide: '# Guide',
    });

    const result = await invokeLoad({
      projectId: String(projectId),
      planId: planUuid,
      reviewId: String(review.id),
    });

    expect(result.review.pr_url).toBeNull();
    expect(result.submissionPrUrl).toBe(prUrl);
    expect(result.currentBranch).toBe('feature/plan-only-linked-pr');
    expect(result.currentHeadSha).toBe('linked-head-sha');
    expect(result.linkedPlanUuid).toBe(planUuid);
  });

  test('returns 404 when plan does not exist', async () => {
    const review = createReview(currentDb, {
      projectId,
      planUuid,
      status: 'complete',
    });
    await expect(
      invokeLoad({
        projectId: String(projectId),
        planId: 'missing-plan-uuid',
        reviewId: String(review.id),
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 404 when review id is not finite', async () => {
    await expect(
      invokeLoad({
        projectId: String(projectId),
        planId: planUuid,
        reviewId: 'not-a-number',
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 404 when review does not exist', async () => {
    await expect(
      invokeLoad({
        projectId: String(projectId),
        planId: planUuid,
        reviewId: '99999',
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 404 when review belongs to a different plan', async () => {
    upsertPlan(currentDb, projectId, {
      uuid: 'other-plan-uuid',
      planId: 7002,
      title: 'Other Plan',
      status: 'pending',
      priority: 'medium',
      epic: false,
      filename: '7002.plan.md',
    });
    const otherReview = createReview(currentDb, {
      projectId,
      planUuid: 'other-plan-uuid',
      status: 'complete',
    });

    await expect(
      invokeLoad({
        projectId: String(projectId),
        planId: planUuid,
        reviewId: String(otherReview.id),
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 404 when plan belongs to a different project', async () => {
    const otherProjectId = getOrCreateProject(currentDb, 'other-project', {
      remoteUrl: 'https://example.com/other-project.git',
      lastGitRoot: '/tmp/other-project',
    }).id;
    const review = createReview(currentDb, {
      projectId,
      planUuid,
      status: 'complete',
    });

    await expect(
      invokeLoad({
        projectId: String(otherProjectId),
        planId: planUuid,
        reviewId: String(review.id),
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
