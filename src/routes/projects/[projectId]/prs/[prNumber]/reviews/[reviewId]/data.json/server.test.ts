import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import type { TimConfig } from '$tim/configSchema.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPrStatus } from '$tim/db/pr_status.js';
import { createPrReviewSubmission, createReview, insertReviewIssues } from '$tim/db/review.js';

let currentDb: Database;
let currentConfig: TimConfig;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

import { GET } from './+server.js';

function makeRequest(projectId: number, prNumber: number, reviewId: number): Request {
  return new Request(
    `http://localhost/projects/${projectId}/prs/${prNumber}/reviews/${reviewId}/data.json`
  );
}

describe('/projects/[projectId]/prs/[prNumber]/reviews/[reviewId]/data.json GET', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-data-route-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = {};
    projectId = getOrCreateProject(currentDb, 'github.com__example__repo').id;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns review detail data as JSON', async () => {
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/2780',
      owner: 'example',
      repo: 'repo',
      prNumber: 2780,
      author: 'alice',
      title: 'Review data endpoint',
      state: 'open',
      draft: false,
      headSha: 'head-sha-current',
      baseBranch: 'main',
      headBranch: 'feature/data-json',
      lastFetchedAt: '2026-05-15T00:00:00.000Z',
    });
    const review = createReview(currentDb, {
      projectId,
      prStatusId: prStatus.status.id,
      prUrl: 'https://github.com/example/repo/pull/2780',
      branch: 'feature/data-json',
      baseBranch: 'main',
      reviewedSha: 'reviewed-sha',
      reviewGuide: '# Review Guide\n\nRaw markdown guide',
      status: 'complete',
    });
    insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'major',
          category: 'bug',
          content: 'Issue content',
          file: 'src/file.ts',
          line: '42',
          suggestion: 'Fix it',
          source: 'codex-cli',
        },
      ],
    });
    createPrReviewSubmission(currentDb, {
      reviewId: review.id,
      githubReviewId: 12345,
      githubReviewUrl: 'https://github.com/example/repo/pull/2780#pullrequestreview-12345',
      event: 'COMMENT',
      body: 'Submitted review body',
      commitSha: 'reviewed-sha',
      submittedBy: 'alice',
    });

    const response = await GET({
      params: {
        projectId: String(projectId),
        prNumber: '2780',
        reviewId: String(review.id),
      },
      request: makeRequest(projectId, 2780, review.id),
    } as never);
    const body = (await response.json()) as {
      review: { id: number; review_guide: string | null };
      issues: Array<{ content: string; file: string | null }>;
      submissions: Array<{ githubReviewId: number | null; body: string | null }>;
      currentBranch: string | null;
      currentHeadSha: string | null;
      linkedPlans: unknown[];
      linkedPlanUuid: string | null;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-cache');
    expect(body.review.id).toBe(review.id);
    expect(body.review.review_guide).toBe('# Review Guide\n\nRaw markdown guide');
    expect(body.issues).toMatchObject([{ content: 'Issue content', file: 'src/file.ts' }]);
    expect(body.submissions).toMatchObject([
      { githubReviewId: 12345, body: 'Submitted review body' },
    ]);
    expect(body.currentBranch).toBe('feature/data-json');
    expect(body.currentHeadSha).toBe('head-sha-current');
    expect(body.linkedPlans).toEqual([]);
    expect(body.linkedPlanUuid).toBeNull();
  });

  test('returns 404 when the route PR number does not match the review', async () => {
    const review = createReview(currentDb, {
      projectId,
      prUrl: 'https://github.com/example/repo/pull/2780',
      branch: 'feature/data-json',
      status: 'complete',
    });

    await expect(
      GET({
        params: {
          projectId: String(projectId),
          prNumber: '2781',
          reviewId: String(review.id),
        },
        request: makeRequest(projectId, 2781, review.id),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });

  test('returns 404 when the route project does not match the review', async () => {
    const otherProjectId = getOrCreateProject(currentDb, 'github.com__example__other').id;
    const review = createReview(currentDb, {
      projectId,
      prUrl: 'https://github.com/example/repo/pull/2780',
      branch: 'feature/data-json',
      status: 'complete',
    });

    await expect(
      GET({
        params: {
          projectId: String(otherProjectId),
          prNumber: '2780',
          reviewId: String(review.id),
        },
        request: makeRequest(otherProjectId, 2780, review.id),
      } as never)
    ).rejects.toMatchObject({ status: 404 });
  });
});
