import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import {
  getPrReviewSubmissionsForReview,
  getReviewIssues,
  insertReviewIssues,
  updateReview,
  type InsertReviewIssueInput,
} from '../db/review.js';

const mocks = vi.hoisted(() => ({
  compareCommits: vi.fn(),
  createReview: vi.fn(),
  getOctokit: vi.fn(),
  workflowIssues: [] as unknown[],
  workflowOptions: [] as unknown[],
}));

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../common/github/octokit.js', () => ({
  getOctokit: mocks.getOctokit,
}));

vi.mock('../review_runner.js', () => ({
  resolveReviewExecutorSelection: vi.fn(() => 'both'),
}));

// The workflow runs LLM executors. Replace it with a stand-in that stores the issues an
// executor would have produced, so the rest of the flow runs against a real database.
vi.mock('./review_workflow.js', () => ({
  runReviewGuideWorkflow: vi.fn(
    async (options: { db: Database; review: { id: number }; reviewedSha: string }) => {
      mocks.workflowOptions.push(options);
      insertReviewIssues(options.db, {
        reviewId: options.review.id,
        issues: mocks.workflowIssues as InsertReviewIssueInput[],
      });
      updateReview(options.db, options.review.id, {
        status: 'complete',
        reviewGuide: null,
        reviewedSha: options.reviewedSha,
      });
    }
  ),
}));

import { AUTO_REVIEW_MARKER, runAutomaticPrReview } from './review_guide_auto_review.js';

const PR_URL = 'https://github.com/acme/repo/pull/42';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
  ' const c = 3;',
  '',
].join('\n');

function issue(overrides: Partial<InsertReviewIssueInput>): InsertReviewIssueInput {
  return {
    severity: 'major',
    category: 'bug',
    content: 'Issue content',
    file: 'src/a.ts',
    line: '2',
    startLine: null,
    suggestion: null,
    source: 'claude-code',
    resolved: false,
    ...overrides,
  };
}

describe('runAutomaticPrReview', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'github.com__acme__repo').id;
    mocks.workflowIssues = [];
    mocks.workflowOptions = [];
    mocks.compareCommits.mockReset().mockResolvedValue({ data: DIFF });
    mocks.createReview.mockReset().mockResolvedValue({
      data: {
        id: 777,
        html_url: `${PR_URL}#pullrequestreview-777`,
        user: { login: 'tim-bot[bot]' },
      },
    });
    mocks.getOctokit.mockReset().mockReturnValue({
      rest: {
        repos: { compareCommitsWithBasehead: mocks.compareCommits },
        pulls: { createReview: mocks.createReview },
      },
    });
  });

  afterEach(() => {
    db.close(false);
  });

  function run(dryRun?: boolean) {
    return runAutomaticPrReview({
      db,
      config: {} as never,
      baseDir: '/tmp/unused',
      projectId,
      metadata: {
        kind: 'pr',
        prUrl: PR_URL,
        prNumber: 42,
        title: 'PR title',
        author: 'alice',
        baseBranch: 'main',
        baseSha: 'base-sha',
        headBranch: 'feature',
        owner: 'acme',
        repo: 'repo',
      },
      baseSha: 'base-sha',
      reviewedSha: 'head-sha',
      authToken: 'app-token',
      dryRun,
    });
  }

  test('runs issues-only generation and posts inline and body issues as the App', async () => {
    mocks.workflowIssues = [
      issue({ content: 'Inline problem', suggestion: 'Fix it' }),
      issue({ content: 'Outside the diff', line: '40', severity: 'minor' }),
      issue({ content: 'General problem', file: null, line: null, severity: 'minor' }),
      issue({ content: 'Just a note', severity: 'note' }),
    ];

    const result = await run();

    expect(mocks.workflowOptions[0]).toEqual(
      expect.objectContaining({ issuesOnly: true, diffCatalog: null })
    );
    expect(mocks.getOctokit).toHaveBeenCalledWith('app-token');
    expect(mocks.getOctokit).not.toHaveBeenCalledWith(undefined);
    expect(mocks.compareCommits).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'repo', basehead: 'main...head-sha' })
    );

    const request = mocks.createReview.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      owner: 'acme',
      repo: 'repo',
      pull_number: 42,
      commit_id: 'head-sha',
      event: 'COMMENT',
      comments: [
        { path: 'src/a.ts', line: 2, side: 'RIGHT', body: 'Inline problem\n\nSuggestion: Fix it' },
      ],
    });
    expect(request.body).toContain(AUTO_REVIEW_MARKER);
    expect(request.body).toContain('Found 3 issues (1 major, 2 minor).');
    expect(request.body).toContain('### src/a.ts:40\n\nOutside the diff');
    expect(request.body).toContain('### General\n\nGeneral problem');
    expect(request.body).not.toContain('Just a note');

    expect(result).toEqual(
      expect.objectContaining({ issueCount: 3, inlineCount: 1, appendedCount: 2 })
    );

    const [submission] = getPrReviewSubmissionsForReview(db, result.reviewId);
    expect(submission).toEqual(
      expect.objectContaining({
        githubReviewId: 777,
        event: 'COMMENT',
        commitSha: 'head-sha',
        submittedBy: 'tim-bot[bot]',
        errorMessage: null,
      })
    );
    const stored = getReviewIssues(db, result.reviewId);
    expect(
      stored.filter((row) => row.severity !== 'note').every((row) => row.submittedInPrReviewId)
    ).toBe(true);
    expect(stored.find((row) => row.severity === 'note')?.submittedInPrReviewId).toBeNull();
  });

  test('posts a review that says no issues were found', async () => {
    const result = await run();

    expect(mocks.compareCommits).not.toHaveBeenCalled();
    const request = mocks.createReview.mock.calls[0]?.[0];
    expect(request).toMatchObject({ event: 'COMMENT', comments: [], commit_id: 'head-sha' });
    expect(request.body).toBe(`${AUTO_REVIEW_MARKER}\n## Automated review\n\nNo issues found.`);
    expect(result.issueCount).toBe(0);
    expect(getPrReviewSubmissionsForReview(db, result.reviewId)).toHaveLength(1);
  });

  test('dry run generates issues but does not post', async () => {
    mocks.workflowIssues = [issue({})];

    const result = await run(true);

    expect(mocks.createReview).not.toHaveBeenCalled();
    expect(mocks.compareCommits).not.toHaveBeenCalled();
    expect(result.issueCount).toBe(1);
    expect(getPrReviewSubmissionsForReview(db, result.reviewId)).toHaveLength(0);
  });

  test('records a failed submission and rethrows', async () => {
    mocks.workflowIssues = [issue({})];
    mocks.createReview.mockRejectedValue(new Error('GitHub said no'));

    await expect(run()).rejects.toThrow('GitHub said no');

    const reviewId = (mocks.workflowOptions[0] as { review: { id: number } }).review.id;
    const [submission] = getPrReviewSubmissionsForReview(db, reviewId);
    expect(submission).toEqual(
      expect.objectContaining({ githubReviewId: null, errorMessage: 'GitHub said no' })
    );
    expect(getReviewIssues(db, reviewId)[0]?.submittedInPrReviewId).toBeNull();
  });
});
