import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { nonSyncedUpsertPlan } from '../db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '../db/pr_status.js';
import { createReview, getReviewIssues, insertReviewIssues } from '../db/review.js';
import { listReviewGuideIssuesForTarget, resolveReviewGuideTarget } from './review_guide_manage.js';

const PLAN_UUID = '11111111-1111-4111-8111-111111111111';
const PR_URL = 'https://github.com/example/repo/pull/5';

describe('review guide issue management', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-guide-manage-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, constructGitHubRepositoryId('example', 'repo')).id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function seedLinkedPlanAndPr(): { prStatusId: number } {
    nonSyncedUpsertPlan(db, projectId, {
      uuid: PLAN_UUID,
      planId: 123,
      title: 'Review guide management',
      branch: 'feature/review-guide-management',
      pullRequest: [PR_URL],
    });

    const pr = upsertPrStatus(db, {
      prUrl: PR_URL,
      owner: 'example',
      repo: 'repo',
      prNumber: 5,
      author: 'octocat',
      title: 'Review guide PR',
      state: 'open',
      draft: false,
      headBranch: 'feature/review-guide-management',
      baseBranch: 'main',
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(db, PLAN_UUID, pr.status.id);

    return { prStatusId: pr.status.id };
  }

  test('lists issues from the latest linked PR review when resolving by plan ID', async () => {
    const { prStatusId } = seedLinkedPlanAndPr();
    const planReview = createReview(db, {
      projectId,
      planUuid: PLAN_UUID,
      reviewGuide: '# Older plan guide',
      status: 'complete',
    });
    insertReviewIssues(db, {
      reviewId: planReview.id,
      issues: [
        {
          severity: 'major',
          category: 'bug',
          content: 'Older plan issue',
        },
      ],
    });

    const prReview = createReview(db, {
      projectId,
      prStatusId,
      prUrl: PR_URL,
      branch: 'feature/review-guide-management',
      reviewGuide: '# Newer PR guide',
      status: 'complete',
    });
    const [prIssue] = insertReviewIssues(db, {
      reviewId: prReview.id,
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Fix the token leak.',
          file: 'src/auth.ts',
          line: '42',
          suggestion: 'Read the token from scoped credentials instead.',
          source: 'codex-cli',
        },
      ],
    });

    const target = await resolveReviewGuideTarget(db, projectId, '123', tempDir);
    const output = listReviewGuideIssuesForTarget(db, target, {});

    expect(output).toContain('plan 123: Review guide management');
    expect(output).toContain(`Review #${prReview.id}: 1 unresolved / 1 total issue(s)`);
    expect(output).toContain(`#${prIssue.id} [open] critical/security src/auth.ts:42`);
    expect(output).toContain('Fix the token leak.');
    expect(output).toContain('Suggestion: Read the token from scoped credentials instead.');
    expect(output).not.toContain('Older plan issue');
  });

  test('resolves a branch to its linked plan and PR review history', async () => {
    const { prStatusId } = seedLinkedPlanAndPr();
    const review = createReview(db, {
      projectId,
      prStatusId,
      prUrl: PR_URL,
      branch: 'feature/review-guide-management',
      reviewGuide: '# Branch guide',
      status: 'complete',
    });
    insertReviewIssues(db, {
      reviewId: review.id,
      issues: [
        {
          severity: 'minor',
          category: 'testing',
          content: 'Add a regression test.',
          file: 'src/review.ts',
        },
      ],
    });

    const target = await resolveReviewGuideTarget(
      db,
      projectId,
      'feature/review-guide-management',
      tempDir
    );
    const output = listReviewGuideIssuesForTarget(db, target, {});

    expect(output).toContain('plan 123: Review guide management');
    expect(output).toContain(`Review #${review.id}`);
    expect(output).toContain('Add a regression test.');
  });

  test('omits resolved issues by default and includes them with all option', async () => {
    seedLinkedPlanAndPr();
    const review = createReview(db, {
      projectId,
      planUuid: PLAN_UUID,
      reviewGuide: '# Plan guide',
      status: 'complete',
    });
    const [issue] = insertReviewIssues(db, {
      reviewId: review.id,
      issues: [
        {
          severity: 'major',
          category: 'bug',
          content: 'Already handled.',
          resolved: true,
        },
      ],
    });

    const target = await resolveReviewGuideTarget(db, projectId, '123', tempDir);
    expect(listReviewGuideIssuesForTarget(db, target, {})).not.toContain('Already handled.');

    const allOutput = listReviewGuideIssuesForTarget(db, target, { all: true });
    expect(allOutput).toContain(`#${issue.id} [resolved] major/bug`);
    expect(getReviewIssues(db, review.id)[0].resolved).toBe(1);
  });
});
