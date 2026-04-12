import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  createReview,
  getLatestReviewByPrUrl,
  getReviewById,
  getReviewIssues,
  getReviewsForProject,
  insertReviewIssues,
  updateReview,
  updateReviewIssue,
} from './review.js';
import { getOrCreateProject } from './project.js';

const PR_URL_1 = 'https://github.com/example/repo/pull/1';
const PR_URL_2 = 'https://github.com/example/repo/pull/2';

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

      const reviews = getReviewsForProject(db, projectId);
      expect(reviews).toHaveLength(2);
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

      const latest = getReviewsForProject(db, projectId, { latestPerPr: true });
      expect(latest).toHaveLength(2);

      const pr1Review = latest.find((r) => r.pr_url === PR_URL_1);
      const pr2Review = latest.find((r) => r.pr_url === PR_URL_2);

      expect(pr1Review?.id).toBe(latestForPr1.id);
      expect(pr2Review?.id).toBe(forPr2.id);
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

  describe('PR URL canonicalization', () => {
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
