import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  createPrReviewSubmission,
  createReview,
  getLatestReviewByPlanUuid,
  getLatestReviewByPrUrl,
  getLatestReviewGuideByPlanUuid,
  getPrReviewSubmissionsForReview,
  getReviewById,
  getReviewIssues,
  getReviewsByPlanUuid,
  getReviewsByPrUrl,
  getReviewsForProject,
  listLatestReviewGuideSummaries,
  insertReviewIssues,
  markIssuesSubmitted,
  updateReview,
  updateReviewIssue,
} from './review.js';
import { getOrCreateProject } from './project.js';
import { nonSyncedUpsertPlan } from './plan.js';
import { runMigrations } from './migrations.js';

const PR_URL_1 = 'https://github.com/example/repo/pull/1';
const PR_URL_2 = 'https://github.com/example/repo/pull/2';
const PLAN_UUID_1 = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID_2 = '22222222-2222-4222-8222-222222222222';

describe('tim db/review', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'repo-review-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-review-2').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function createPlan(uuid: string, planId: number): void {
    nonSyncedUpsertPlan(db, projectId, {
      uuid,
      planId,
      title: `Plan ${planId}`,
      goal: `Goal ${planId}`,
    });
  }

  describe('createReview', () => {
    test('creates a review with minimal fields', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      expect(review.id).toBeTypeOf('number');
      expect(review.project_id).toBe(projectId);
      expect(review.pr_url).toBe(PR_URL_1);
      expect(review.branch).toBe('feature/my-branch');
      expect(review.status).toBe('pending');
      expect(review.pr_status_id).toBeNull();
      expect(review.plan_uuid).toBeNull();
      expect(review.base_branch).toBeNull();
      expect(review.reviewed_sha).toBeNull();
      expect(review.review_guide).toBeNull();
      expect(review.error_message).toBeNull();
      expect(review.created_at).toBeTruthy();
      expect(review.updated_at).toBeTruthy();
    });

    test('creates a review with all optional fields', () => {
      const review = createReview(db, {
        projectId,
        prStatusId: null,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        baseBranch: 'main',
        reviewedSha: 'abc123',
        reviewGuide: '# Review Guide\n\nSome content here.',
        status: 'complete',
        errorMessage: null,
      });

      expect(review.base_branch).toBe('main');
      expect(review.reviewed_sha).toBe('abc123');
      expect(review.review_guide).toBe('# Review Guide\n\nSome content here.');
      expect(review.status).toBe('complete');
      expect(review.error_message).toBeNull();
    });

    test('creates review with error status and message', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        status: 'error',
        errorMessage: 'Executor failed to complete',
      });

      expect(review.status).toBe('error');
      expect(review.error_message).toBe('Executor failed to complete');
    });

    test('multiple reviews per PR are supported (history)', () => {
      const review1 = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'sha-v1',
        status: 'complete',
      });

      const review2 = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'sha-v2',
        status: 'complete',
      });

      expect(review1.id).not.toBe(review2.id);
      expect(review1.reviewed_sha).toBe('sha-v1');
      expect(review2.reviewed_sha).toBe('sha-v2');
    });

    test('creates a plan-only review with nullable PR fields', () => {
      createPlan(PLAN_UUID_1, 101);

      const review = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        baseBranch: 'main',
        status: 'in_progress',
      });

      expect(review.project_id).toBe(projectId);
      expect(review.pr_url).toBeNull();
      expect(review.branch).toBeNull();
      expect(review.plan_uuid).toBe(PLAN_UUID_1);
      expect(review.base_branch).toBe('main');
      expect(review.status).toBe('in_progress');
    });

    test('CHECK constraint rejects insert with both pr_url and plan_uuid NULL', () => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO review (project_id, status, created_at, updated_at)
             VALUES (?, 'pending', datetime('now'), datetime('now'))`
          )
          .run(projectId)
      ).toThrow();
    });
  });

  describe('updateReview', () => {
    test('updates status field', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const updated = updateReview(db, review.id, { status: 'in_progress' });
      expect(updated?.status).toBe('in_progress');
      expect(updated?.pr_url).toBe(PR_URL_1);
    });

    test('updates reviewed_sha field', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const updated = updateReview(db, review.id, { reviewedSha: 'newsha123' });
      expect(updated?.reviewed_sha).toBe('newsha123');
    });

    test('updates review_guide field', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const guide = '# Review Guide\n\nThis is the guide text.';
      const updated = updateReview(db, review.id, { reviewGuide: guide });
      expect(updated?.review_guide).toBe(guide);
    });

    test('updates error_message field', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const updated = updateReview(db, review.id, {
        status: 'error',
        errorMessage: 'Something went wrong',
      });
      expect(updated?.status).toBe('error');
      expect(updated?.error_message).toBe('Something went wrong');
    });

    test('updates multiple fields at once', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const updated = updateReview(db, review.id, {
        status: 'complete',
        reviewedSha: 'final-sha',
        reviewGuide: '# Guide',
      });

      expect(updated?.status).toBe('complete');
      expect(updated?.reviewed_sha).toBe('final-sha');
      expect(updated?.review_guide).toBe('# Guide');
    });

    test('does not modify fields when null is passed (COALESCE behavior)', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'original-sha',
        status: 'in_progress',
      });

      // Pass undefined for fields that should not change
      const updated = updateReview(db, review.id, { status: 'complete' });

      // reviewed_sha should remain unchanged
      expect(updated?.reviewed_sha).toBe('original-sha');
      expect(updated?.status).toBe('complete');
    });

    test('clears reviewedSha when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'original-sha',
        status: 'complete',
      });
      expect(review.reviewed_sha).toBe('original-sha');

      const updated = updateReview(db, review.id, { reviewedSha: null });
      expect(updated?.reviewed_sha).toBeNull();
      // Other fields unchanged
      expect(updated?.status).toBe('complete');
    });

    test('clears reviewGuide when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewGuide: '# Some guide content',
        status: 'complete',
      });
      expect(review.review_guide).toBe('# Some guide content');

      const updated = updateReview(db, review.id, { reviewGuide: null });
      expect(updated?.review_guide).toBeNull();
    });

    test('clears errorMessage when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        status: 'error',
        errorMessage: 'Executor failed',
      });
      expect(review.error_message).toBe('Executor failed');

      const updated = updateReview(db, review.id, { status: 'complete', errorMessage: null });
      expect(updated?.error_message).toBeNull();
      expect(updated?.status).toBe('complete');
    });

    test('empty update object preserves all existing fields', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'sha-123',
        reviewGuide: '# Guide',
        status: 'complete',
        errorMessage: 'some error',
      });

      const updated = updateReview(db, review.id, {});
      expect(updated?.reviewed_sha).toBe('sha-123');
      expect(updated?.review_guide).toBe('# Guide');
      expect(updated?.status).toBe('complete');
      expect(updated?.error_message).toBe('some error');
    });

    test('returns null for non-existent review id', () => {
      const result = updateReview(db, 99999, { status: 'complete' });
      expect(result).toBeNull();
    });
  });

  describe('getLatestReviewByPrUrl', () => {
    test('returns null when no review exists', () => {
      const result = getLatestReviewByPrUrl(db, PR_URL_1);
      expect(result).toBeNull();
    });

    test('returns the single review for a PR', () => {
      const created = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const result = getLatestReviewByPrUrl(db, PR_URL_1);
      expect(result?.id).toBe(created.id);
    });

    test('returns the latest review when multiple reviews exist for a PR', () => {
      const first = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'sha-v1',
        status: 'complete',
      });

      const second = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewedSha: 'sha-v2',
        status: 'complete',
      });

      // Second review has higher id, so it should be returned
      const result = getLatestReviewByPrUrl(db, PR_URL_1);
      expect(result?.id).toBe(second.id);
      expect(result?.reviewed_sha).toBe('sha-v2');
      expect(first.id).not.toBe(second.id);
    });

    test('filters by projectId when provided', () => {
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      createReview(db, {
        projectId: otherProjectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        status: 'complete',
      });

      const resultForProject = getLatestReviewByPrUrl(db, PR_URL_1, { projectId });
      expect(resultForProject?.project_id).toBe(projectId);

      const resultForOtherProject = getLatestReviewByPrUrl(db, PR_URL_1, {
        projectId: otherProjectId,
      });
      expect(resultForOtherProject?.project_id).toBe(otherProjectId);
    });

    test('returns null when filtering by projectId with no matching review', () => {
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const result = getLatestReviewByPrUrl(db, PR_URL_1, { projectId: otherProjectId });
      expect(result).toBeNull();
    });
  });

  describe('plan-keyed review queries', () => {
    beforeEach(() => {
      createPlan(PLAN_UUID_1, 101);
      createPlan(PLAN_UUID_2, 102);
    });

    test('getLatestReviewByPlanUuid returns null when no review exists', () => {
      const result = getLatestReviewByPlanUuid(db, PLAN_UUID_1);
      expect(result).toBeNull();
    });

    test('getLatestReviewByPlanUuid returns the latest review for the plan including mixed PR rows', () => {
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'plan-sha-1',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'plan-sha-2',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/pr-only',
        reviewedSha: 'pr-sha',
        status: 'complete',
      });
      const mixed = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/mixed',
        planUuid: PLAN_UUID_1,
        reviewedSha: 'mixed-sha',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_2,
        reviewedSha: 'other-plan-sha',
        status: 'complete',
      });

      const result = getLatestReviewByPlanUuid(db, PLAN_UUID_1);
      expect(result?.id).toBe(mixed.id);
      expect(result?.reviewed_sha).toBe('mixed-sha');
    });

    test('getLatestReviewByPlanUuid filters by projectId and status', () => {
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        status: 'pending',
      });
      const complete = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        status: 'complete',
      });

      const result = getLatestReviewByPlanUuid(db, PLAN_UUID_1, {
        projectId,
        status: 'complete',
      });
      expect(result?.id).toBe(complete.id);

      const missing = getLatestReviewByPlanUuid(db, PLAN_UUID_1, {
        projectId: otherProjectId,
      });
      expect(missing).toBeNull();
    });

    test('getLatestReviewGuideByPlanUuid returns latest non-empty guide including mixed PR rows', () => {
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewGuide: '   ',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewGuide: '# Plan Guide',
        status: 'complete',
      });
      const mixed = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/mixed',
        planUuid: PLAN_UUID_1,
        reviewGuide: '# Mixed Guide',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewGuide: null,
        status: 'complete',
      });

      const result = getLatestReviewGuideByPlanUuid(db, PLAN_UUID_1);
      expect(result?.id).toBe(mixed.id);
      expect(result?.review_guide).toBe('# Mixed Guide');
    });

    test('getReviewsByPlanUuid returns history ordered by created_at DESC including mixed PR rows', () => {
      const first = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'sha-1',
      });
      const second = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'sha-2',
      });
      const mixed = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/mixed',
        planUuid: PLAN_UUID_1,
        reviewedSha: 'mixed-plan-pr',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_2,
        reviewedSha: 'other-plan',
      });

      const reviews = getReviewsByPlanUuid(db, PLAN_UUID_1);
      expect(reviews).toHaveLength(3);
      expect(reviews[0].id).toBe(mixed.id);
      expect(reviews[1].id).toBe(second.id);
      expect(reviews[2].id).toBe(first.id);
      expect(reviews[0].issue_count).toBe(0);
      expect(reviews[0].unresolved_count).toBe(0);
    });

    test('listLatestReviewGuideSummaries returns latest generated guide per plan or PR with issue counts', () => {
      createPlan(PLAN_UUID_1, 101);
      createPlan(PLAN_UUID_2, 102);

      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewGuide: '# Older plan guide',
        status: 'complete',
      });
      const latestPlan = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewGuide: '# Latest plan guide',
        status: 'complete',
      });
      const prGuide = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/review-summary',
        reviewGuide: '# PR guide',
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_2,
        reviewGuide: '   ',
        status: 'complete',
      });
      const otherProjectGuide = createReview(db, {
        projectId: otherProjectId,
        prUrl: PR_URL_2,
        branch: 'feature/other-project',
        reviewGuide: '# Other project guide',
        status: 'complete',
      });
      const staleGuide = createReview(db, {
        projectId,
        prUrl: 'https://github.com/example/repo/pull/99',
        branch: 'feature/stale-guide',
        reviewGuide: '# Stale guide',
        status: 'complete',
      });
      db.prepare('UPDATE review SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        staleGuide.id
      );

      insertReviewIssues(db, {
        reviewId: latestPlan.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Fix this',
            resolved: false,
          },
          {
            severity: 'minor',
            category: 'style',
            content: 'Already fixed',
            resolved: true,
          },
          {
            severity: 'note',
            category: 'other',
            content: 'Context note',
            resolved: false,
          },
        ],
      });

      const projectSummaries = listLatestReviewGuideSummaries(db, { projectId });
      expect(projectSummaries.map((summary) => summary.id)).toEqual([prGuide.id, latestPlan.id]);
      expect(projectSummaries.some((summary) => summary.id === staleGuide.id)).toBe(false);
      expect(projectSummaries[1].plan_id).toBe(101);
      expect(projectSummaries[1].plan_title).toBe('Plan 101');
      expect(projectSummaries[1].issue_count).toBe(2);
      expect(projectSummaries[1].unresolved_count).toBe(1);

      const allSummaries = listLatestReviewGuideSummaries(db, { projectId: 'all' });
      expect(allSummaries.map((summary) => summary.id)).toEqual([
        otherProjectGuide.id,
        prGuide.id,
        latestPlan.id,
      ]);
    });

    test('getReviewsByPlanUuid includes PR-only reviews for linked PR URLs', () => {
      const planOnly = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'plan-only',
      });
      const prOnly = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/pr-only',
        reviewedSha: 'pr-only',
      });
      createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/other-pr',
        reviewedSha: 'other-pr',
      });

      const reviews = getReviewsByPlanUuid(db, PLAN_UUID_1, { linkedPrUrls: [PR_URL_1] });

      expect(reviews.map((review) => review.id)).toEqual([prOnly.id, planOnly.id]);
    });

    test('getReviewsByPrUrl includes plan-only reviews for linked plan UUIDs', () => {
      const prOnly = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/pr-only',
        reviewedSha: 'pr-only',
      });
      const planOnly = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'plan-only',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_2,
        reviewedSha: 'other-plan',
      });

      const reviews = getReviewsByPrUrl(db, PR_URL_1, { linkedPlanUuids: [PLAN_UUID_1] });

      expect(reviews.map((review) => review.id)).toEqual([planOnly.id, prOnly.id]);
    });

    test('getReviewsByPlanUuid includes issue counts', () => {
      const review = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
      });
      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          { severity: 'major', category: 'bug', content: 'Unresolved' },
          { severity: 'minor', category: 'style', content: 'Resolved', resolved: true },
        ],
      });

      const reviews = getReviewsByPlanUuid(db, PLAN_UUID_1);
      expect(reviews[0].issue_count).toBe(2);
      expect(reviews[0].unresolved_count).toBe(1);
    });

    test('getReviewsByPlanUuid excludes note-only reviews from issue counts', () => {
      const review = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
      });
      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'note', category: 'other', content: 'Context note' }],
      });

      const reviews = getReviewsByPlanUuid(db, PLAN_UUID_1);
      expect(reviews[0].issue_count).toBe(0);
      expect(reviews[0].unresolved_count).toBe(0);
    });

    test('getReviewsByPlanUuid excludes notes from mixed review issue counts', () => {
      const review = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
      });
      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          { severity: 'major', category: 'bug', content: 'Actionable finding' },
          { severity: 'note', category: 'other', content: 'Context note' },
        ],
      });

      const reviews = getReviewsByPlanUuid(db, PLAN_UUID_1);
      expect(reviews[0].issue_count).toBe(1);
      expect(reviews[0].unresolved_count).toBe(1);
    });

    test('getReviewsByPrUrl excludes notes from issue counts', () => {
      const noteOnlyReview = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/note-only',
      });
      insertReviewIssues(db, {
        reviewId: noteOnlyReview.id,
        issues: [{ severity: 'note', category: 'other', content: 'Context note' }],
      });

      const mixedReview = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/mixed',
      });
      insertReviewIssues(db, {
        reviewId: mixedReview.id,
        issues: [
          { severity: 'major', category: 'bug', content: 'Actionable finding' },
          { severity: 'note', category: 'other', content: 'Context note' },
        ],
      });

      const noteOnlyReviews = getReviewsByPrUrl(db, PR_URL_1);
      expect(noteOnlyReviews[0].issue_count).toBe(0);
      expect(noteOnlyReviews[0].unresolved_count).toBe(0);

      const mixedReviews = getReviewsByPrUrl(db, PR_URL_2);
      expect(mixedReviews[0].issue_count).toBe(1);
      expect(mixedReviews[0].unresolved_count).toBe(1);
    });
  });

  describe('getReviewById', () => {
    test('returns the review for a valid id', () => {
      const created = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const result = getReviewById(db, created.id);
      expect(result?.id).toBe(created.id);
      expect(result?.pr_url).toBe(PR_URL_1);
    });

    test('returns null for non-existent id', () => {
      const result = getReviewById(db, 99999);
      expect(result).toBeNull();
    });
  });

  describe('insertReviewIssues and getReviewIssues', () => {
    test('inserts and retrieves review issues', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'critical',
            category: 'security',
            content: 'SQL injection vulnerability detected',
            file: 'src/db/query.ts',
            line: '42',
            startLine: '40',
            suggestion: 'Use parameterized queries',
            source: 'claude-code',
          },
          {
            severity: 'minor',
            category: 'style',
            content: 'Missing semicolon',
            file: 'src/utils.ts',
            line: '10',
            source: 'codex-cli',
          },
        ],
      });

      const issues = getReviewIssues(db, review.id);
      expect(issues).toHaveLength(2);

      const [first, second] = issues;
      expect(first.severity).toBe('critical');
      expect(first.category).toBe('security');
      expect(first.content).toBe('SQL injection vulnerability detected');
      expect(first.file).toBe('src/db/query.ts');
      expect(first.line).toBe('42');
      expect(first.start_line).toBe('40');
      expect(first.suggestion).toBe('Use parameterized queries');
      expect(first.source).toBe('claude-code');
      expect(first.resolved).toBe(0);

      expect(second.severity).toBe('minor');
      expect(second.category).toBe('style');
      expect(second.source).toBe('codex-cli');
      expect(second.start_line).toBeNull();
      expect(second.suggestion).toBeNull();
    });

    test('inserts issue with minimal required fields', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'info',
            category: 'other',
            content: 'General observation',
          },
        ],
      });

      const issues = getReviewIssues(db, review.id);
      expect(issues).toHaveLength(1);
      expect(issues[0].file).toBeNull();
      expect(issues[0].line).toBeNull();
      expect(issues[0].start_line).toBeNull();
      expect(issues[0].suggestion).toBeNull();
      expect(issues[0].source).toBeNull();
      expect(issues[0].side).toBeNull();
      expect(issues[0].submittedInPrReviewId).toBeNull();
    });

    test('preserves NULL side from the database', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      db.prepare(
        `
          INSERT INTO review_issue (
            review_id,
            severity,
            category,
            content,
            side,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
        `
      ).run(review.id, 'minor', 'other', 'Issue with null side');

      const [issue] = getReviewIssues(db, review.id);
      expect(issue.side).toBeNull();
    });

    test('round-trips a note issue with NULL side', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'note',
            category: 'other',
            content: 'Context-only note',
            file: 'src/example.ts',
            line: '5,11',
            side: null,
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(issue).toMatchObject({
        severity: 'note',
        content: 'Context-only note',
        file: 'src/example.ts',
        line: '5,11',
        side: null,
      });
    });

    test('throws when persisted side contains an unexpected value', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      db.prepare(
        `
          INSERT INTO review_issue (
            review_id,
            severity,
            category,
            content,
            side,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        `
      ).run(review.id, 'minor', 'other', 'Issue with bad side', 'UP');

      expect(() => getReviewIssues(db, review.id)).toThrow(
        'Unexpected review_issue.side value: UP'
      );
    });

    test('inserts issue with explicit side and submission id', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const submission = createPrReviewSubmission(db, {
        reviewId: review.id,
        event: 'COMMENT',
        body: 'Submitted review body',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Anchored issue',
            side: 'LEFT',
            submittedInPrReviewId: submission.id,
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(issue.side).toBe('LEFT');
      expect(issue.submittedInPrReviewId).toBe(submission.id);
    });

    test('throws when insertReviewIssues receives an invalid side', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      expect(() =>
        insertReviewIssues(db, {
          reviewId: review.id,
          issues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'Invalid side',
              side: 'UP' as 'LEFT',
            },
          ],
        })
      ).toThrow('Invalid review_issue.side value in insertReviewIssues: UP');
    });

    test('throws when insertReviewIssues uses submission from a different review', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/one',
      });
      const otherReview = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/two',
      });
      const submission = createPrReviewSubmission(db, {
        reviewId: otherReview.id,
        event: 'COMMENT',
      });

      expect(() =>
        insertReviewIssues(db, {
          reviewId: review.id,
          issues: [
            {
              severity: 'minor',
              category: 'other',
              content: 'Cross-review submission',
              submittedInPrReviewId: submission.id,
            },
          ],
        })
      ).toThrow(
        `Issue for review ${review.id} cannot reference submission ${submission.id} from review ${otherReview.id}`
      );
    });

    test('inserts issue with resolved=true', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Already fixed bug',
            resolved: true,
          },
        ],
      });

      const issues = getReviewIssues(db, review.id);
      expect(issues[0].resolved).toBe(1);
    });

    test('handles empty issues array without error', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      expect(() => insertReviewIssues(db, { reviewId: review.id, issues: [] })).not.toThrow();

      const issues = getReviewIssues(db, review.id);
      expect(issues).toHaveLength(0);
    });

    test('inserts issues for a combined source', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'performance',
            content: 'N+1 query issue',
            source: 'combined',
          },
        ],
      });

      const issues = getReviewIssues(db, review.id);
      expect(issues[0].source).toBe('combined');
    });

    test('returns empty array when no issues exist', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const issues = getReviewIssues(db, review.id);
      expect(issues).toHaveLength(0);
    });
  });

  describe('updateReviewIssue', () => {
    test('marks an issue as resolved', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Some bug',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(issue.resolved).toBe(0);

      const updated = updateReviewIssue(db, issue.id, { resolved: true });
      expect(updated?.resolved).toBe(1);
      expect(updated?.side).toBeNull();
      expect(updated?.submittedInPrReviewId).toBeNull();
    });

    test('marks a resolved issue as unresolved', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Some bug',
            resolved: true,
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, { resolved: false });
      expect(updated?.resolved).toBe(0);
    });

    test('updates severity and category', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'info',
            category: 'style',
            content: 'Nit',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, {
        severity: 'critical',
        category: 'security',
      });

      expect(updated?.severity).toBe('critical');
      expect(updated?.category).toBe('security');
      expect(updated?.content).toBe('Nit'); // content unchanged
    });

    test('preserves existing fields when only updating one field', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Original content',
            file: 'src/file.ts',
            line: '5',
            suggestion: 'Fix it',
            source: 'claude-code',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, { resolved: true });

      expect(updated?.severity).toBe('major');
      expect(updated?.category).toBe('bug');
      expect(updated?.content).toBe('Original content');
      expect(updated?.file).toBe('src/file.ts');
      expect(updated?.line).toBe('5');
      expect(updated?.suggestion).toBe('Fix it');
      expect(updated?.source).toBe('claude-code');
    });

    test('clears file field when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Some bug',
            file: 'src/file.ts',
            line: '10',
            startLine: '8',
            suggestion: 'Fix it',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(issue.file).toBe('src/file.ts');

      const updated = updateReviewIssue(db, issue.id, { file: null });
      expect(updated?.file).toBeNull();
      // Other optional fields unchanged
      expect(updated?.line).toBe('10');
      expect(updated?.start_line).toBe('8');
      expect(updated?.suggestion).toBe('Fix it');
    });

    test('clears line and startLine when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Nit',
            line: '5',
            startLine: '3',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, { line: null, startLine: null });
      expect(updated?.line).toBeNull();
      expect(updated?.start_line).toBeNull();
    });

    test('clears suggestion when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'info',
            category: 'other',
            content: 'Some comment',
            suggestion: 'Consider refactoring',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, { suggestion: null });
      expect(updated?.suggestion).toBeNull();
    });

    test('clears source when explicitly set to null', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'major',
            category: 'performance',
            content: 'N+1 query',
            source: 'claude-code',
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(issue.source).toBe('claude-code');

      const updated = updateReviewIssue(db, issue.id, { source: null });
      expect(updated?.source).toBeNull();
      // Content unchanged
      expect(updated?.content).toBe('N+1 query');
    });

    test('empty update object preserves all existing issue fields', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          {
            severity: 'critical',
            category: 'security',
            content: 'XSS vulnerability',
            file: 'src/render.ts',
            line: '42',
            startLine: '40',
            suggestion: 'Sanitize inputs',
            source: 'combined',
            resolved: false,
          },
        ],
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, {});
      expect(updated?.severity).toBe('critical');
      expect(updated?.category).toBe('security');
      expect(updated?.content).toBe('XSS vulnerability');
      expect(updated?.file).toBe('src/render.ts');
      expect(updated?.line).toBe('42');
      expect(updated?.start_line).toBe('40');
      expect(updated?.suggestion).toBe('Sanitize inputs');
      expect(updated?.source).toBe('combined');
      expect(updated?.resolved).toBe(0);
    });

    test('returns null for non-existent issue id', () => {
      const result = updateReviewIssue(db, 99999, { resolved: true });
      expect(result).toBeNull();
    });

    test('updates side and submitted review id fields', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'major', category: 'bug', content: 'Issue' }],
      });

      const submission = createPrReviewSubmission(db, {
        reviewId: review.id,
        event: 'REQUEST_CHANGES',
      });

      const [issue] = getReviewIssues(db, review.id);
      const updated = updateReviewIssue(db, issue.id, {
        side: 'LEFT',
        submittedInPrReviewId: submission.id,
      });

      expect(updated?.side).toBe('LEFT');
      expect(updated?.submittedInPrReviewId).toBe(submission.id);
    });

    test('throws when updateReviewIssue receives an invalid side', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'major', category: 'bug', content: 'Issue' }],
      });

      const [issue] = getReviewIssues(db, review.id);

      expect(() =>
        updateReviewIssue(db, issue.id, {
          side: 'UP' as 'LEFT',
        })
      ).toThrow('Invalid review_issue.side value in updateReviewIssue: UP');
    });

    test('throws when updateReviewIssue sets submission from another review', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });
      const otherReview = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/other-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'major', category: 'bug', content: 'Issue' }],
      });
      const submission = createPrReviewSubmission(db, {
        reviewId: otherReview.id,
        event: 'REQUEST_CHANGES',
      });

      const [issue] = getReviewIssues(db, review.id);
      expect(() =>
        updateReviewIssue(db, issue.id, {
          submittedInPrReviewId: submission.id,
        })
      ).toThrow(`Issue ${issue.id} does not belong to review of submission ${submission.id}`);
    });
  });

  describe('pr_review_submission helpers', () => {
    test('markIssuesSubmitted with empty array is a no-op', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'minor', category: 'other', content: 'Issue' }],
      });

      const submission = createPrReviewSubmission(db, { reviewId: review.id, event: 'COMMENT' });

      // Empty array should not throw and should not mark any issue
      expect(() => markIssuesSubmitted(db, [], submission.id)).not.toThrow();

      const issues = getReviewIssues(db, review.id);
      expect(issues[0].submittedInPrReviewId).toBeNull();
    });

    test('creates and reads back submission rows ordered newest first', async () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      const first = createPrReviewSubmission(db, {
        reviewId: review.id,
        githubReviewId: 1001,
        githubReviewUrl: 'https://github.com/example/repo/pull/1#pullrequestreview-1001',
        event: 'COMMENT',
        body: 'First body',
        commitSha: 'sha-1',
        submittedBy: 'alice',
      });
      const second = createPrReviewSubmission(db, {
        reviewId: review.id,
        githubReviewId: 1002,
        githubReviewUrl: 'https://github.com/example/repo/pull/1#pullrequestreview-1002',
        event: 'APPROVE',
        body: 'Second body',
        commitSha: 'sha-2',
        submittedBy: 'bob',
        errorMessage: null,
      });

      const rows = getPrReviewSubmissionsForReview(db, review.id);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(second.id);
      expect(rows[1].id).toBe(first.id);
      expect(rows[0]).toMatchObject({
        reviewId: review.id,
        githubReviewId: 1002,
        githubReviewUrl: 'https://github.com/example/repo/pull/1#pullrequestreview-1002',
        event: 'APPROVE',
        body: 'Second body',
        commitSha: 'sha-2',
        submittedBy: 'bob',
        errorMessage: null,
      });
      expect(rows[0].submittedAt).toBeTruthy();
    });

    test('markIssuesSubmitted updates only the selected issues', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          { severity: 'minor', category: 'other', content: 'Issue 1' },
          { severity: 'minor', category: 'other', content: 'Issue 2' },
          { severity: 'minor', category: 'other', content: 'Issue 3' },
        ],
      });
      const submission = createPrReviewSubmission(db, {
        reviewId: review.id,
        event: 'COMMENT',
      });
      const issues = getReviewIssues(db, review.id);

      markIssuesSubmitted(db, [issues[0].id, issues[2].id], submission.id);

      const updated = getReviewIssues(db, review.id);
      expect(updated[0].submittedInPrReviewId).toBe(submission.id);
      expect(updated[1].submittedInPrReviewId).toBeNull();
      expect(updated[2].submittedInPrReviewId).toBe(submission.id);
    });

    test('markIssuesSubmitted throws when an issue belongs to a different review', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/main',
      });
      const otherReview = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/other',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'minor', category: 'other', content: 'Issue in review 1' }],
      });
      insertReviewIssues(db, {
        reviewId: otherReview.id,
        issues: [{ severity: 'minor', category: 'other', content: 'Issue in review 2' }],
      });

      const submission = createPrReviewSubmission(db, {
        reviewId: review.id,
        event: 'COMMENT',
      });
      const [otherIssue] = getReviewIssues(db, otherReview.id);

      expect(() => markIssuesSubmitted(db, [otherIssue.id], submission.id)).toThrow(
        `Issue ${otherIssue.id} does not belong to review of submission ${submission.id}`
      );
    });

    test('rejects invalid submission event values', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      expect(() =>
        db
          .prepare(
            `
              INSERT INTO pr_review_submission (review_id, event, submitted_at)
              VALUES (?, ?, datetime('now'))
            `
          )
          .run(review.id, 'INVALID')
      ).toThrow();
    });
  });

  describe('cascade delete', () => {
    test('deleting a review cascades to review_issue rows', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [
          { severity: 'minor', category: 'style', content: 'Issue 1' },
          { severity: 'info', category: 'other', content: 'Issue 2' },
        ],
      });

      expect(getReviewIssues(db, review.id)).toHaveLength(2);

      db.prepare('DELETE FROM review WHERE id = ?').run(review.id);

      expect(getReviewIssues(db, review.id)).toHaveLength(0);
      expect(getReviewById(db, review.id)).toBeNull();
    });

    test('deleting a project cascades to review rows', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      db.prepare('DELETE FROM project WHERE id = ?').run(projectId);

      expect(getReviewById(db, review.id)).toBeNull();
    });

    test('deleting a plan removes plan-only reviews and preserves PR-linked reviews', () => {
      createPlan(PLAN_UUID_1, 101);
      const planOnlyReview = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        status: 'complete',
      });
      const prLinkedReview = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        planUuid: PLAN_UUID_1,
        status: 'complete',
      });

      db.prepare('DELETE FROM plan WHERE uuid = ?').run(PLAN_UUID_1);

      expect(getReviewById(db, planOnlyReview.id)).toBeNull();
      const remaining = getReviewById(db, prLinkedReview.id);
      expect(remaining).not.toBeNull();
      expect(remaining?.pr_url).toBe(PR_URL_1);
      expect(remaining?.plan_uuid).toBeNull();
    });

    test('deleting a review cascades to pr_review_submission rows', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });

      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'minor', category: 'other', content: 'Issue 1' }],
      });
      const submission = createPrReviewSubmission(db, { reviewId: review.id, event: 'COMMENT' });
      const [issue] = getReviewIssues(db, review.id);
      updateReviewIssue(db, issue.id, { submittedInPrReviewId: submission.id });

      expect(getPrReviewSubmissionsForReview(db, review.id)).toHaveLength(1);

      db.prepare('DELETE FROM review WHERE id = ?').run(review.id);

      expect(getPrReviewSubmissionsForReview(db, review.id)).toHaveLength(0);
      expect(getReviewIssues(db, review.id)).toHaveLength(0);
    });

    test('deleting a submission clears issue submitted_in_pr_review_id', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
      });
      insertReviewIssues(db, {
        reviewId: review.id,
        issues: [{ severity: 'minor', category: 'other', content: 'Issue 1' }],
      });
      const submission = createPrReviewSubmission(db, { reviewId: review.id, event: 'COMMENT' });
      const [issue] = getReviewIssues(db, review.id);

      markIssuesSubmitted(db, [issue.id], submission.id);
      expect(getReviewIssues(db, review.id)[0]?.submittedInPrReviewId).toBe(submission.id);

      db.prepare('DELETE FROM pr_review_submission WHERE id = ?').run(submission.id);

      expect(getReviewIssues(db, review.id)[0]?.submittedInPrReviewId).toBeNull();
    });
  });

  describe('store and retrieve review guide text', () => {
    test('stores and retrieves large review guide text', () => {
      const guideText = `# Review Guide

## Section 1: Authentication

This section covers changes to the authentication module.

### Diff

\`\`\`diff
- const token = req.cookies.session;
+ const token = req.headers.authorization?.replace('Bearer ', '');
\`\`\`

This change improves security by using headers instead of cookies.

## Section 2: Database Layer

Changes to query handling to prevent SQL injection.

### Diff

\`\`\`diff
- db.query(\`SELECT * FROM users WHERE id = \${userId}\`);
+ db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
\`\`\`
`;

      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        reviewGuide: guideText,
        status: 'complete',
      });

      const retrieved = getReviewById(db, review.id);
      expect(retrieved?.review_guide).toBe(guideText);
    });

    test('updates review guide after initial creation', () => {
      const review = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/my-branch',
        status: 'in_progress',
      });

      expect(review.review_guide).toBeNull();

      const guide = '# Updated Review Guide\n\nGenerated after review completed.';
      const updated = updateReview(db, review.id, {
        status: 'complete',
        reviewGuide: guide,
        reviewedSha: 'final-sha',
      });

      expect(updated?.review_guide).toBe(guide);
      expect(updated?.status).toBe('complete');
      expect(updated?.reviewed_sha).toBe('final-sha');
    });
  });

  describe('getReviewsForProject', () => {
    test('returns empty array when no reviews exist', () => {
      const reviews = getReviewsForProject(db, projectId);
      expect(reviews).toHaveLength(0);
    });

    test('returns all reviews for a project', () => {
      createPlan(PLAN_UUID_1, 101);
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch-1',
      });
      createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/branch-2',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
      });

      const reviews = getReviewsForProject(db, projectId);
      expect(reviews).toHaveLength(3);
      expect(reviews.some((review) => review.plan_uuid === PLAN_UUID_1)).toBe(true);
    });

    test('does not return reviews from other projects', () => {
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch-1',
      });
      createReview(db, {
        projectId: otherProjectId,
        prUrl: PR_URL_2,
        branch: 'feature/branch-2',
      });

      const reviews = getReviewsForProject(db, projectId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].pr_url).toBe(PR_URL_1);
    });

    test('returns reviews ordered by created_at DESC (newest first)', () => {
      const first = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch',
        reviewedSha: 'sha-1',
      });
      const second = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch',
        reviewedSha: 'sha-2',
      });

      const reviews = getReviewsForProject(db, projectId);
      expect(reviews).toHaveLength(2);
      // Newer (higher id) should be first
      expect(reviews[0].id).toBe(second.id);
      expect(reviews[1].id).toBe(first.id);
    });

    test('with latestPerPr option returns only latest review per PR URL', () => {
      createPlan(PLAN_UUID_1, 101);
      // Two reviews for PR_URL_1
      createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch',
        reviewedSha: 'sha-v1',
        status: 'complete',
      });
      const latestForPr1 = createReview(db, {
        projectId,
        prUrl: PR_URL_1,
        branch: 'feature/branch',
        reviewedSha: 'sha-v2',
        status: 'complete',
      });

      // One review for PR_URL_2
      const forPr2 = createReview(db, {
        projectId,
        prUrl: PR_URL_2,
        branch: 'feature/branch-2',
        status: 'in_progress',
      });
      const planOnly = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        status: 'complete',
      });
      createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'older-plan-sha',
        status: 'complete',
      });
      const latestPlanOnly = createReview(db, {
        projectId,
        planUuid: PLAN_UUID_1,
        reviewedSha: 'latest-plan-sha',
        status: 'complete',
      });

      const latest = getReviewsForProject(db, projectId, { latestPerPr: true });
      expect(latest).toHaveLength(3);

      const pr1Review = latest.find((r) => r.pr_url === PR_URL_1);
      const pr2Review = latest.find((r) => r.pr_url === PR_URL_2);
      const planReview = latest.find((r) => r.plan_uuid === PLAN_UUID_1);

      expect(pr1Review?.id).toBe(latestForPr1.id);
      expect(pr2Review?.id).toBe(forPr2.id);
      expect(planReview?.id).toBe(latestPlanOnly.id);
      expect(latest.some((review) => review.id === planOnly.id)).toBe(false);
    });

    test('without latestPerPr option returns all reviews including history', () => {
      // Three reviews for the same PR
      createReview(db, { projectId, prUrl: PR_URL_1, branch: 'feature/branch' });
      createReview(db, { projectId, prUrl: PR_URL_1, branch: 'feature/branch' });
      createReview(db, { projectId, prUrl: PR_URL_1, branch: 'feature/branch' });

      const all = getReviewsForProject(db, projectId);
      expect(all).toHaveLength(3);

      const latest = getReviewsForProject(db, projectId, { latestPerPr: true });
      expect(latest).toHaveLength(1);
    });
  });

  describe('migration 25 schema structure', () => {
    test('review_issue has side and submitted_in_pr_review_id columns after migration', () => {
      // openDatabase() already ran all migrations; verify the new columns exist
      const columns = db.prepare("PRAGMA table_info('review_issue')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('side');
      expect(columnNames).toContain('submitted_in_pr_review_id');
    });

    test('pr_review_submission table exists with expected columns', () => {
      const columns = db.prepare("PRAGMA table_info('pr_review_submission')").all() as Array<{
        name: string;
      }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('review_id');
      expect(columnNames).toContain('github_review_id');
      expect(columnNames).toContain('github_review_url');
      expect(columnNames).toContain('event');
      expect(columnNames).toContain('body');
      expect(columnNames).toContain('commit_sha');
      expect(columnNames).toContain('submitted_by');
      expect(columnNames).toContain('submitted_at');
      expect(columnNames).toContain('error_message');
    });

    test('submitted_in_pr_review_id foreign key uses ON DELETE SET NULL', () => {
      const foreignKeys = db.prepare("PRAGMA foreign_key_list('review_issue')").all() as Array<{
        from: string;
        table: string;
        on_delete: string;
      }>;

      const submittedFk = foreignKeys.find(
        (fk) => fk.from === 'submitted_in_pr_review_id' && fk.table === 'pr_review_submission'
      );
      expect(submittedFk).toBeDefined();
      expect(submittedFk?.on_delete).toBe('SET NULL');
    });
  });

  describe('migration 37 review plan linkage', () => {
    test('review table has nullable PR columns, plan_uuid index, and plan-delete trigger', () => {
      const columns = db.prepare("PRAGMA table_info('review')").all() as Array<{
        name: string;
        notnull: number;
      }>;
      const columnByName = new Map(columns.map((column) => [column.name, column]));

      expect(columnByName.get('pr_url')?.notnull).toBe(0);
      expect(columnByName.get('branch')?.notnull).toBe(0);
      expect(columnByName.has('plan_uuid')).toBe(true);

      const indexes = db.prepare("PRAGMA index_list('review')").all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain('idx_review_plan_uuid');

      const trigger = db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'review_delete_plan_only_before_plan_delete'"
        )
        .get() as { sql: string } | null;
      expect(trigger?.sql).toContain(
        'DELETE FROM review WHERE plan_uuid = OLD.uuid AND pr_url IS NULL'
      );
    });

    test('migration preserves existing review rows when upgrading from schema version 36', async () => {
      const legacyPath = path.join(tempDir, 'legacy-review.db');
      const legacyDb = new Database(legacyPath);
      try {
        legacyDb.run('PRAGMA foreign_keys = ON');
        legacyDb.run(`
          CREATE TABLE schema_version (
            version INTEGER NOT NULL DEFAULT 0,
            import_completed INTEGER NOT NULL DEFAULT 1,
            bootstrap_completed INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO schema_version (version, import_completed, bootstrap_completed)
            VALUES (36, 1, 1);

          CREATE TABLE project (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id TEXT NOT NULL UNIQUE
          );
          CREATE TABLE plan (
            uuid TEXT NOT NULL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            plan_id INTEGER NOT NULL
          );
          CREATE TABLE pr_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT
          );
          CREATE TABLE review (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            pr_status_id INTEGER REFERENCES pr_status(id) ON DELETE SET NULL,
            pr_url TEXT NOT NULL,
            branch TEXT NOT NULL,
            base_branch TEXT,
            reviewed_sha TEXT,
            review_guide TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'in_progress', 'complete', 'error')),
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
          );
          CREATE INDEX idx_review_project_id ON review(project_id);
          CREATE INDEX idx_review_pr_url ON review(pr_url);

          INSERT INTO project (id, repository_id) VALUES (1, 'legacy-repo');
          INSERT INTO review (
            id,
            project_id,
            pr_url,
            branch,
            base_branch,
            reviewed_sha,
            review_guide,
            status,
            created_at,
            updated_at
          ) VALUES (
            7,
            1,
            'https://github.com/example/repo/pull/7',
            'feature/legacy',
            'main',
            'abc123',
            '# Legacy Guide',
            'complete',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          ), (
            8,
            1,
            'https://github.com/example/repo/pull/8',
            'feature/no-guide',
            'main',
            'def456',
            NULL,
            'in_progress',
            '2026-01-02T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z'
          ), (
            9,
            1,
            'https://github.com/example/repo/pull/9',
            'feature/no-reviewed-sha',
            'develop',
            NULL,
            '# Guide Without SHA',
            'complete',
            '2026-01-03T00:00:00.000Z',
            '2026-01-03T00:00:00.000Z'
          );
        `);

        runMigrations(legacyDb);

        const migrated = legacyDb.prepare('SELECT * FROM review ORDER BY id').all() as Array<{
          id: number;
          pr_url: string | null;
          branch: string | null;
          base_branch: string | null;
          reviewed_sha: string | null;
          plan_uuid: string | null;
          review_guide: string | null;
          status: string;
        }>;
        expect(migrated).toEqual([
          expect.objectContaining({
            id: 7,
            pr_url: 'https://github.com/example/repo/pull/7',
            branch: 'feature/legacy',
            base_branch: 'main',
            reviewed_sha: 'abc123',
            plan_uuid: null,
            review_guide: '# Legacy Guide',
            status: 'complete',
          }),
          expect.objectContaining({
            id: 8,
            pr_url: 'https://github.com/example/repo/pull/8',
            branch: 'feature/no-guide',
            base_branch: 'main',
            reviewed_sha: 'def456',
            plan_uuid: null,
            review_guide: null,
            status: 'in_progress',
          }),
          expect.objectContaining({
            id: 9,
            pr_url: 'https://github.com/example/repo/pull/9',
            branch: 'feature/no-reviewed-sha',
            base_branch: 'develop',
            reviewed_sha: null,
            plan_uuid: null,
            review_guide: '# Guide Without SHA',
            status: 'complete',
          }),
        ]);
      } finally {
        legacyDb.close(false);
        await fs.rm(legacyPath, { force: true });
      }
    });
  });

  describe('migration 38 review issue note severity', () => {
    test('preserves review_issue rows and widens severity check when upgrading from schema version 37', async () => {
      const legacyPath = path.join(tempDir, 'legacy-review-issue-note.db');
      const legacyDb = new Database(legacyPath);
      try {
        legacyDb.run('PRAGMA foreign_keys = ON');
        legacyDb.run(`
          CREATE TABLE schema_version (
            version INTEGER NOT NULL DEFAULT 0,
            import_completed INTEGER NOT NULL DEFAULT 1,
            bootstrap_completed INTEGER NOT NULL DEFAULT 1
          );
          INSERT INTO schema_version (version, import_completed, bootstrap_completed)
            VALUES (37, 1, 1);

          CREATE TABLE project (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repository_id TEXT NOT NULL UNIQUE
          );
          CREATE TABLE plan (
            uuid TEXT NOT NULL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            plan_id INTEGER NOT NULL
          );
          CREATE TABLE pr_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT
          );
          CREATE TABLE review (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            pr_status_id INTEGER REFERENCES pr_status(id) ON DELETE SET NULL,
            pr_url TEXT,
            branch TEXT,
            base_branch TEXT,
            reviewed_sha TEXT,
            review_guide TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'in_progress', 'complete', 'error')),
            error_message TEXT,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            plan_uuid TEXT REFERENCES plan(uuid) ON DELETE SET NULL,
            CHECK (pr_url IS NOT NULL OR plan_uuid IS NOT NULL)
          );
          CREATE INDEX idx_review_project_id ON review(project_id);
          CREATE INDEX idx_review_pr_url ON review(pr_url);
          CREATE INDEX idx_review_plan_uuid ON review(plan_uuid);

          CREATE TABLE pr_review_submission (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
            github_review_id INTEGER,
            github_review_url TEXT,
            event TEXT NOT NULL CHECK (event IN ('APPROVE', 'COMMENT', 'REQUEST_CHANGES')),
            body TEXT,
            commit_sha TEXT,
            submitted_by TEXT,
            submitted_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            error_message TEXT
          );
          CREATE INDEX idx_pr_review_submission_review_id ON pr_review_submission(review_id);

          CREATE TABLE review_issue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            review_id INTEGER NOT NULL REFERENCES review(id) ON DELETE CASCADE,
            severity TEXT NOT NULL
              CHECK(severity IN ('critical', 'major', 'minor', 'info')),
            category TEXT NOT NULL
              CHECK(category IN ('security', 'performance', 'bug', 'style', 'compliance', 'testing', 'other')),
            content TEXT NOT NULL,
            file TEXT,
            line TEXT,
            start_line TEXT,
            suggestion TEXT,
            source TEXT
              CHECK(source IN ('claude-code', 'codex-cli', 'combined')),
            resolved INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
            side TEXT,
            submitted_in_pr_review_id INTEGER REFERENCES pr_review_submission(id) ON DELETE SET NULL
          );
          CREATE INDEX idx_review_issue_review_id ON review_issue(review_id);

          INSERT INTO project (id, repository_id) VALUES (1, 'legacy-repo');
          INSERT INTO review (
            id,
            project_id,
            pr_url,
            branch,
            status,
            created_at,
            updated_at
          ) VALUES (
            3,
            1,
            'https://github.com/example/repo/pull/3',
            'feature/notes',
            'complete',
            '2026-01-02T00:00:00.000Z',
            '2026-01-02T00:00:00.000Z'
          );
          INSERT INTO pr_review_submission (
            id,
            review_id,
            github_review_id,
            github_review_url,
            event,
            body,
            commit_sha,
            submitted_by,
            submitted_at
          ) VALUES (
            4,
            3,
            999,
            'https://github.com/example/repo/pull/3#pullrequestreview-999',
            'COMMENT',
            'Submitted body',
            'abc123',
            'tester',
            '2026-01-03T00:00:00.000Z'
          );
          INSERT INTO review_issue (
            id,
            review_id,
            severity,
            category,
            content,
            file,
            line,
            start_line,
            suggestion,
            source,
            side,
            resolved,
            submitted_in_pr_review_id,
            created_at,
            updated_at
          ) VALUES
            (
              11,
              3,
              'critical',
              'security',
              'Critical content',
              'src/a.ts',
              '10',
              NULL,
              'Fix critical',
              'claude-code',
              'RIGHT',
              0,
              4,
              '2026-01-04T00:00:00.000Z',
              '2026-01-05T00:00:00.000Z'
            ),
            (
              12,
              3,
              'major',
              'bug',
              'Major content',
              'src/b.ts',
              '20-22',
              '20',
              NULL,
              'codex-cli',
              'LEFT',
              1,
              NULL,
              '2026-01-06T00:00:00.000Z',
              '2026-01-07T00:00:00.000Z'
            ),
            (
              13,
              3,
              'info',
              'other',
              'Info content',
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              NULL,
              0,
              NULL,
              '2026-01-08T00:00:00.000Z',
              '2026-01-09T00:00:00.000Z'
            );
        `);

        runMigrations(legacyDb);

        const migrated = legacyDb
          .prepare(
            `
            SELECT
              id,
              review_id,
              severity,
              category,
              content,
              file,
              line,
              start_line,
              suggestion,
              source,
              side,
              resolved,
              submitted_in_pr_review_id,
              created_at,
              updated_at
            FROM review_issue
            ORDER BY id
          `
          )
          .all();
        expect(migrated).toEqual([
          {
            id: 11,
            review_id: 3,
            severity: 'critical',
            category: 'security',
            content: 'Critical content',
            file: 'src/a.ts',
            line: '10',
            start_line: null,
            suggestion: 'Fix critical',
            source: 'claude-code',
            side: 'RIGHT',
            resolved: 0,
            submitted_in_pr_review_id: 4,
            created_at: '2026-01-04T00:00:00.000Z',
            updated_at: '2026-01-05T00:00:00.000Z',
          },
          {
            id: 12,
            review_id: 3,
            severity: 'major',
            category: 'bug',
            content: 'Major content',
            file: 'src/b.ts',
            line: '20-22',
            start_line: '20',
            suggestion: null,
            source: 'codex-cli',
            side: 'LEFT',
            resolved: 1,
            submitted_in_pr_review_id: null,
            created_at: '2026-01-06T00:00:00.000Z',
            updated_at: '2026-01-07T00:00:00.000Z',
          },
          {
            id: 13,
            review_id: 3,
            severity: 'info',
            category: 'other',
            content: 'Info content',
            file: null,
            line: null,
            start_line: null,
            suggestion: null,
            source: null,
            side: null,
            resolved: 0,
            submitted_in_pr_review_id: null,
            created_at: '2026-01-08T00:00:00.000Z',
            updated_at: '2026-01-09T00:00:00.000Z',
          },
        ]);

        legacyDb
          .prepare(
            `
            INSERT INTO review_issue (
              review_id,
              severity,
              category,
              content,
              file,
              line
            ) VALUES (?, ?, ?, ?, ?, ?)
          `
          )
          .run(3, 'note', 'other', 'A descriptive annotation', 'src/note.ts', '44');

        const noteSeverity = legacyDb
          .prepare('SELECT severity FROM review_issue WHERE content = ?')
          .get('A descriptive annotation') as { severity: string } | null;
        expect(noteSeverity?.severity).toBe('note');

        expect(() =>
          legacyDb
            .prepare(
              `
              INSERT INTO review_issue (
                review_id,
                severity,
                category,
                content
              ) VALUES (?, ?, ?, ?)
            `
            )
            .run(3, 'bogus', 'other', 'Invalid severity')
        ).toThrow();

        const indexes = legacyDb.prepare("PRAGMA index_list('review_issue')").all() as Array<{
          name: string;
        }>;
        expect(indexes.map((index) => index.name)).toContain('idx_review_issue_review_id');

        const foreignKeys = legacyDb
          .prepare("PRAGMA foreign_key_list('review_issue')")
          .all() as Array<{
          from: string;
          table: string;
          on_delete: string;
        }>;
        expect(
          foreignKeys.find(
            (fk) => fk.from === 'submitted_in_pr_review_id' && fk.table === 'pr_review_submission'
          )?.on_delete
        ).toBe('SET NULL');
      } finally {
        legacyDb.close(false);
        await fs.rm(legacyPath, { force: true });
      }
    });
  });

  describe('PR URL canonicalization', () => {
    test('createReview validates empty PR URLs instead of coercing them to null', () => {
      expect(() =>
        createReview(db, {
          projectId,
          prUrl: '',
          branch: 'feature/my-branch',
        })
      ).toThrow('Invalid pull request identifier');
    });

    test('createReview canonicalizes /pulls/ variant to /pull/', () => {
      const pullsUrl = 'https://github.com/example/repo/pulls/1';
      const canonicalUrl = 'https://github.com/example/repo/pull/1';

      const review = createReview(db, {
        projectId,
        prUrl: pullsUrl,
        branch: 'feature/my-branch',
      });

      expect(review.pr_url).toBe(canonicalUrl);
    });

    test('createReview strips query parameters from URL', () => {
      const urlWithQuery = 'https://github.com/example/repo/pull/1?foo=bar&baz=qux';
      const canonicalUrl = 'https://github.com/example/repo/pull/1';

      const review = createReview(db, {
        projectId,
        prUrl: urlWithQuery,
        branch: 'feature/my-branch',
      });

      expect(review.pr_url).toBe(canonicalUrl);
    });

    test('createReview with /pulls/ and query params stores canonical form', () => {
      const messyUrl = 'https://github.com/example/repo/pulls/42?tab=files';
      const canonicalUrl = 'https://github.com/example/repo/pull/42';

      const review = createReview(db, {
        projectId,
        prUrl: messyUrl,
        branch: 'feature/my-branch',
      });

      expect(review.pr_url).toBe(canonicalUrl);
    });

    test('getLatestReviewByPrUrl finds review using /pulls/ variant', () => {
      const canonicalUrl = 'https://github.com/example/repo/pull/1';
      const pullsVariant = 'https://github.com/example/repo/pulls/1';

      createReview(db, {
        projectId,
        prUrl: canonicalUrl,
        branch: 'feature/my-branch',
        status: 'complete',
      });

      const result = getLatestReviewByPrUrl(db, pullsVariant);
      expect(result).not.toBeNull();
      expect(result?.pr_url).toBe(canonicalUrl);
    });

    test('getLatestReviewByPrUrl finds review using URL with query params', () => {
      const canonicalUrl = 'https://github.com/example/repo/pull/1';
      const urlWithQuery = 'https://github.com/example/repo/pull/1?foo=bar';

      createReview(db, {
        projectId,
        prUrl: canonicalUrl,
        branch: 'feature/my-branch',
        status: 'complete',
      });

      const result = getLatestReviewByPrUrl(db, urlWithQuery);
      expect(result).not.toBeNull();
      expect(result?.pr_url).toBe(canonicalUrl);
    });

    test('getLatestReviewByPrUrl finds review using /pulls/ variant with query params', () => {
      const canonicalUrl = 'https://github.com/example/repo/pull/1';
      const messyLookup = 'https://github.com/example/repo/pulls/1?foo=bar';

      createReview(db, {
        projectId,
        prUrl: canonicalUrl,
        branch: 'feature/my-branch',
        status: 'complete',
      });

      const result = getLatestReviewByPrUrl(db, messyLookup);
      expect(result).not.toBeNull();
      expect(result?.pr_url).toBe(canonicalUrl);
    });
  });
});
