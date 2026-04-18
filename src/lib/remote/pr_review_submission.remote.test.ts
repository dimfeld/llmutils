import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeCommand, invokeQuery } from '$lib/test-utils/invoke_command.js';
import { openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import * as reviewDbModule from '$tim/db/review.js';
import {
  createPrReviewSubmission,
  createReview,
  getPrReviewSubmissionsForReview,
  getReviewIssues,
  insertReviewIssues,
} from '$tim/db/review.js';

let currentDb: Database;
let currentConfig: { githubUsername?: string | null };

const { compareCommitsMock, submitPrReviewMock } = vi.hoisted(() => ({
  compareCommitsMock: vi.fn(),
  submitPrReviewMock: vi.fn(),
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig as never,
    db: currentDb,
  }),
}));

vi.mock('$common/github/octokit.js', () => ({
  getOctokit: () => ({
    rest: {
      repos: {
        compareCommitsWithBasehead: compareCommitsMock,
      },
    },
  }),
}));

vi.mock('$common/github/pr_reviews.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$common/github/pr_reviews.js')>();
  return {
    ...actual,
    submitPrReview: submitPrReviewMock,
  };
});

import {
  createReviewIssue,
  getReviewSubmissions,
  getSubmissionPartition,
  submitReviewToGitHub,
  updateReviewIssueFields,
} from './pr_review_submission.remote.js';

describe('pr_review_submission remote functions', () => {
  beforeEach(() => {
    currentDb = openDatabase(':memory:');
    currentConfig = { githubUsername: 'configured-reviewer' };
    compareCommitsMock.mockReset();
    submitPrReviewMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    currentDb.close(false);
  });

  test('getReviewSubmissions returns submissions ordered by submitted_at desc', async () => {
    const review = seedReview('https://github.com/example/repo/pull/101');

    const first = createPrReviewSubmission(currentDb, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'First',
      commitSha: 'sha-1',
      githubReviewId: 11,
      githubReviewUrl: 'https://github.com/example/repo/pull/101#pullrequestreview-11',
    });
    const second = createPrReviewSubmission(currentDb, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'Second',
      commitSha: 'sha-2',
      githubReviewId: 12,
      githubReviewUrl: 'https://github.com/example/repo/pull/101#pullrequestreview-12',
    });

    const result = await invokeQuery(getReviewSubmissions, { reviewId: review.id });

    expect(result.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  test('updateReviewIssueFields updates and returns the issue row', async () => {
    const review = seedReview('https://github.com/example/repo/pull/102');
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Initial content',
      file: 'src/example.ts',
      line: '10',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    const updated = await invokeCommand(updateReviewIssueFields, {
      issueId: issue.id,
      patch: {
        severity: 'critical',
        side: 'LEFT',
        content: 'Updated content',
        suggestion: 'Use a guard clause',
      },
    });

    expect(updated.severity).toBe('critical');
    expect(updated.side).toBe('LEFT');
    expect(updated.content).toBe('Updated content');
    expect(updated.suggestion).toBe('Use a guard clause');
  });

  test('updateReviewIssueFields rejects invalid severity and side', async () => {
    const review = seedReview('https://github.com/example/repo/pull/103');
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs update',
      file: 'src/example.ts',
      line: '12',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          severity: 'severe',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      body: [
        expect.objectContaining({
          path: ['patch', 'severity'],
        }),
      ],
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          side: 'MIDDLE',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
      body: [
        expect.objectContaining({
          path: ['patch', 'side'],
        }),
      ],
    });
  });

  test('updateReviewIssueFields rejects non-numeric and invalid numeric line fields', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1031');
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs update',
      file: 'src/example.ts',
      line: '12',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          line: 'abc',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          line: '-5',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          line: '0',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: {
          startLine: '20',
          line: '10',
        },
      })
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  test('createReviewIssue creates a manual issue with source = null', async () => {
    const review = seedReview('https://github.com/example/repo/pull/104');

    const created = await invokeCommand(createReviewIssue, {
      reviewId: review.id,
      content: 'Manual finding',
      suggestion: 'Consider adding a null check',
      file: 'src/new-file.ts',
      startLine: '20',
      line: '21',
      side: 'RIGHT',
    });

    expect(created.review_id).toBe(review.id);
    expect(created.source).toBeNull();
    expect(created.severity).toBe('minor');
    expect(created.category).toBe('other');
    expect(created.side).toBe('RIGHT');
  });

  test('createReviewIssue rejects invalid anchor line strings and reversed ranges', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1041');

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'Invalid line',
        line: 'abc',
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'Negative line',
        line: '-5',
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'Zero line',
        line: '0',
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'Reversed range',
        startLine: '20',
        line: '10',
      })
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'startLine without line',
        startLine: '10',
      })
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  test('createReviewIssue rejects line anchor when file is missing', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1043');

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'Line without file',
        line: '10',
      })
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      invokeCommand(createReviewIssue, {
        reviewId: review.id,
        content: 'StartLine without file',
        startLine: '10',
        line: '12',
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('createReviewIssue accepts side without file or line', async () => {
    const review = seedReview('https://github.com/example/repo/pull/10431');

    const created = await invokeCommand(createReviewIssue, {
      reviewId: review.id,
      content: 'Side-only issue',
      side: 'RIGHT',
    });

    expect(created.file).toBeNull();
    expect(created.line).toBeNull();
    expect(created.side).toBe('RIGHT');
  });

  test('updateReviewIssueFields rejects clearing file while line is still set', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1044');
    const [issue] = insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'minor',
          category: 'other',
          content: 'Anchored issue',
          file: 'src/app.ts',
          startLine: null,
          line: '10',
          side: 'RIGHT',
          suggestion: null,
          source: null,
          resolved: false,
        },
      ],
    });

    // Clearing file while line is still set should fail.
    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: { file: null },
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('updateReviewIssueFields allows clearing file when line and startLine are also cleared', async () => {
    const review = seedReview('https://github.com/example/repo/pull/10441');
    const [issue] = insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'minor',
          category: 'other',
          content: 'Anchored issue',
          file: 'src/app.ts',
          startLine: null,
          line: '10',
          side: 'RIGHT',
          suggestion: null,
          source: null,
          resolved: false,
        },
      ],
    });

    const updated = await invokeCommand(updateReviewIssueFields, {
      issueId: issue.id,
      patch: { file: null, line: null, startLine: null },
    });

    expect(updated.file).toBeNull();
    expect(updated.line).toBeNull();
    expect(updated.start_line).toBeNull();
    // side is metadata and is allowed to persist on an unanchored issue
    expect(updated.side).toBe('RIGHT');
  });

  test('updateReviewIssueFields rejects partial update that would create an invalid merged range', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1042');
    const [issue] = insertReviewIssues(currentDb, {
      reviewId: review.id,
      issues: [
        {
          severity: 'minor',
          category: 'other',
          content: 'Pre-existing anchor',
          file: 'src/app.ts',
          startLine: '20',
          line: '30',
          side: 'RIGHT',
          suggestion: null,
          source: null,
          resolved: false,
        },
      ],
    });

    await expect(
      invokeCommand(updateReviewIssueFields, {
        issueId: issue.id,
        patch: { line: '10' },
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  test('submitReviewToGitHub persists success submission and stamps inline and appended issues', async () => {
    const review = seedReview('https://github.com/example/repo/pull/105');
    const inlineIssue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Inline issue',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    const appendedIssue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Appended issue',
      file: null,
      line: null,
      startLine: null,
      suggestion: 'Write a clearer explanation',
      side: 'RIGHT',
    });
    seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Resolved issue',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
      resolved: true,
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' context',
        '+new line',
      ].join('\n'),
    });
    submitPrReviewMock.mockResolvedValue({
      id: 5001,
      html_url: 'https://github.com/example/repo/pull/105#pullrequestreview-5001',
    });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'Review body',
      issueIds: [inlineIssue.id, appendedIssue.id],
      commitSha: 'commit-105',
    });

    expect(compareCommitsMock).toHaveBeenCalledTimes(1);
    expect(compareCommitsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'example',
        repo: 'repo',
        basehead: 'main...commit-105',
      })
    );
    expect(submitPrReviewMock).toHaveBeenCalledTimes(1);
    expect(submitPrReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prUrl: review.pr_url,
        commitSha: 'commit-105',
        event: 'COMMENT',
        comments: [
          expect.objectContaining({
            path: 'src/app.ts',
            line: 11,
            side: 'RIGHT',
          }),
        ],
        body: expect.stringContaining('## Additional notes'),
      })
    );

    expect(result).toMatchObject({
      githubReviewId: 5001,
      githubReviewUrl: 'https://github.com/example/repo/pull/105#pullrequestreview-5001',
      inlineCount: 1,
      appendedCount: 1,
    });

    const submissions = getPrReviewSubmissionsForReview(currentDb, review.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      githubReviewId: 5001,
      event: 'COMMENT',
      errorMessage: null,
      commitSha: 'commit-105',
    });

    const issues = getReviewIssues(currentDb, review.id);
    const inlineAfter = issues.find((issue) => issue.id === inlineIssue.id);
    const appendedAfter = issues.find((issue) => issue.id === appendedIssue.id);

    expect(inlineAfter?.submittedInPrReviewId).toBe(submissions[0].id);
    expect(appendedAfter?.submittedInPrReviewId).toBe(submissions[0].id);
  });

  test('submitReviewToGitHub persists error submission and does not stamp issues when GitHub fails', async () => {
    const review = seedReview('https://github.com/example/repo/pull/106');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Will fail to submit',
      file: 'src/failing.ts',
      line: '7',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/failing.ts b/src/failing.ts',
        '--- a/src/failing.ts',
        '+++ b/src/failing.ts',
        '@@ -7,0 +7,1 @@',
        '+new failing line',
      ].join('\n'),
    });
    submitPrReviewMock.mockRejectedValue(new Error('GitHub createReview failed'));

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'REQUEST_CHANGES',
        body: 'Please fix this',
        issueIds: [issue.id],
        commitSha: 'commit-106',
      })
    ).rejects.toThrow('GitHub createReview failed');

    const submissions = getPrReviewSubmissionsForReview(currentDb, review.id);
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      githubReviewId: null,
      githubReviewUrl: null,
      event: 'REQUEST_CHANGES',
      errorMessage: 'GitHub createReview failed',
      commitSha: 'commit-106',
    });

    const issues = getReviewIssues(currentDb, review.id);
    expect(issues.find((row) => row.id === issue.id)?.submittedInPrReviewId).toBeNull();
  });

  test('submitReviewToGitHub rejects duplicate issueIds', async () => {
    const review = seedReview('https://github.com/example/repo/pull/10610');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'dup',
      file: 'src/app.ts',
      line: '5',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'COMMENT',
        body: '',
        issueIds: [issue.id, issue.id],
        commitSha: 'commit-10610',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(submitPrReviewMock).not.toHaveBeenCalled();
  });

  test('getSubmissionPartition rejects duplicate issueIds', async () => {
    const review = seedReview('https://github.com/example/repo/pull/10611');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'dup',
      file: 'src/app.ts',
      line: '5',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeQuery(getSubmissionPartition, {
        reviewId: review.id,
        issueIds: [issue.id, issue.id],
        commitSha: 'commit-10611',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  test('submitReviewToGitHub rejects unknown issueIds', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1061');

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'COMMENT',
        body: '',
        issueIds: [9999],
        commitSha: 'commit-1061',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(submitPrReviewMock).not.toHaveBeenCalled();
  });

  test('submitReviewToGitHub rejects already-submitted issueIds', async () => {
    const review = seedReview('https://github.com/example/repo/pull/1062');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Already submitted',
      file: 'src/app.ts',
      line: '1',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    const prior = createPrReviewSubmission(currentDb, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'prior',
      commitSha: 'prior',
      githubReviewId: 1,
      githubReviewUrl: 'https://github.com/example/repo/pull/1062#pullrequestreview-1',
    });
    currentDb
      .prepare('UPDATE review_issue SET submitted_in_pr_review_id = ? WHERE id = ?')
      .run(prior.id, issue.id);

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'COMMENT',
        body: '',
        issueIds: [issue.id],
        commitSha: 'commit-1062',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(submitPrReviewMock).not.toHaveBeenCalled();
  });

  test('submitReviewToGitHub always fetches a fresh diff (no cross-request caching)', async () => {
    const reviewA1 = seedReview('https://github.com/example/repo/pull/107');
    const reviewA2 = seedReview('https://github.com/example/repo/pull/107');
    const reviewB = seedReview('https://github.com/example/repo/pull/108');

    const issueA1 = seedIssue(reviewA1.id, {
      severity: 'major',
      category: 'bug',
      content: 'Issue A1',
      file: 'src/shared.ts',
      line: '5',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    const issueA2 = seedIssue(reviewA2.id, {
      severity: 'major',
      category: 'bug',
      content: 'Issue A2',
      file: 'src/shared.ts',
      line: '5',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    const issueB = seedIssue(reviewB.id, {
      severity: 'major',
      category: 'bug',
      content: 'Issue B',
      file: 'src/shared.ts',
      line: '5',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/shared.ts b/src/shared.ts',
        '--- a/src/shared.ts',
        '+++ b/src/shared.ts',
        '@@ -5,0 +5,1 @@',
        '+shared',
      ].join('\n'),
    });
    submitPrReviewMock.mockResolvedValue({
      id: 6001,
      html_url: 'https://github.com/example/repo/pull/107#pullrequestreview-6001',
    });

    await invokeCommand(submitReviewToGitHub, {
      reviewId: reviewA1.id,
      event: 'COMMENT',
      body: 'A1',
      issueIds: [issueA1.id],
      commitSha: 'shared-commit-sha',
    });

    await invokeCommand(submitReviewToGitHub, {
      reviewId: reviewA2.id,
      event: 'COMMENT',
      body: 'A2',
      issueIds: [issueA2.id],
      commitSha: 'shared-commit-sha',
    });

    // Two submissions against the same PR+commit should each fetch the diff again — no cache.
    expect(compareCommitsMock).toHaveBeenCalledTimes(2);

    await invokeCommand(submitReviewToGitHub, {
      reviewId: reviewB.id,
      event: 'COMMENT',
      body: 'B',
      issueIds: [issueB.id],
      commitSha: 'shared-commit-sha',
    });

    expect(compareCommitsMock).toHaveBeenCalledTimes(3);
  });

  test('submitReviewToGitHub throws persistence error when DB write fails after GitHub success', async () => {
    const review = seedReview('https://github.com/example/repo/pull/111');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Persistence fails',
      file: 'src/persist.ts',
      line: '3',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/persist.ts b/src/persist.ts',
        '--- a/src/persist.ts',
        '+++ b/src/persist.ts',
        '@@ -3,0 +3,1 @@',
        '+persist line',
      ].join('\n'),
    });
    submitPrReviewMock.mockResolvedValue({
      id: 8001,
      html_url: 'https://github.com/example/repo/pull/111#pullrequestreview-8001',
    });
    vi.spyOn(reviewDbModule, 'createPrReviewSubmission').mockImplementationOnce(() => {
      throw new Error('DB down');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'COMMENT',
        body: 'body',
        issueIds: [issue.id],
        commitSha: 'commit-111',
      })
    ).rejects.toMatchObject({
      status: 500,
      body: expect.objectContaining({
        kind: 'persistence-failed',
        message: expect.stringContaining('GitHub review submitted successfully'),
        githubReviewId: 8001,
        githubReviewUrl: 'https://github.com/example/repo/pull/111#pullrequestreview-8001',
      }),
    });

    expect(warnSpy).toHaveBeenCalled();
    const submissions = getPrReviewSubmissionsForReview(currentDb, review.id);
    expect(submissions).toHaveLength(0);
    const issues = getReviewIssues(currentDb, review.id);
    expect(issues.find((row) => row.id === issue.id)?.submittedInPrReviewId).toBeNull();
  });

  test('submitReviewToGitHub rejects stamping issues already claimed by another submission', async () => {
    const review = seedReview('https://github.com/example/repo/pull/112');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Will be double-claimed',
      file: 'src/race.ts',
      line: '1',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    // Simulate a prior submission that already claimed the issue.
    const priorSubmission = createPrReviewSubmission(currentDb, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'prior',
      commitSha: 'prior',
      githubReviewId: 5555,
      githubReviewUrl: 'https://github.com/example/repo/pull/112#pullrequestreview-5555',
    });
    // Directly stamp the issue as already submitted, bypassing the submittable filter.
    currentDb
      .prepare('UPDATE review_issue SET submitted_in_pr_review_id = ? WHERE id = ?')
      .run(priorSubmission.id, issue.id);

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/race.ts b/src/race.ts',
        '--- a/src/race.ts',
        '+++ b/src/race.ts',
        '@@ -1,0 +1,1 @@',
        '+race',
      ].join('\n'),
    });
    // If the remote re-checks claim status inside the transaction, this won't be reached.
    submitPrReviewMock.mockResolvedValue({
      id: 9001,
      html_url: 'https://github.com/example/repo/pull/112#pullrequestreview-9001',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The remote filter drops the already-submitted issue, so the selected set is empty and
    // no stamping is attempted. But to exercise markIssuesSubmitted's new guard we call it
    // directly here.
    const { markIssuesSubmitted } = reviewDbModule;
    expect(() => markIssuesSubmitted(currentDb, [issue.id], priorSubmission.id)).toThrow(
      /already submitted/
    );
    warnSpy.mockRestore();
  });

  test('submitReviewToGitHub rethrows original GitHub error when failure record insert also fails', async () => {
    const review = seedReview('https://github.com/example/repo/pull/110');
    const issue = seedIssue(review.id, {
      severity: 'major',
      category: 'bug',
      content: 'Will fail twice',
      file: 'src/failing.ts',
      line: '7',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/failing.ts b/src/failing.ts',
        '--- a/src/failing.ts',
        '+++ b/src/failing.ts',
        '@@ -7,0 +7,1 @@',
        '+new failing line',
      ].join('\n'),
    });
    const submitError = new Error('GitHub createReview failed');
    submitPrReviewMock.mockRejectedValue(submitError);
    const createSubmissionSpy = vi
      .spyOn(reviewDbModule, 'createPrReviewSubmission')
      .mockImplementationOnce(() => {
        throw new Error('DB insert failed');
      });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      invokeCommand(submitReviewToGitHub, {
        reviewId: review.id,
        event: 'REQUEST_CHANGES',
        body: 'Please fix this',
        issueIds: [issue.id],
        commitSha: 'commit-110',
      })
    ).rejects.toThrow('GitHub createReview failed');

    expect(createSubmissionSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[pr_review_submission] Failed to record failed submission',
      expect.any(Error)
    );
  });

  test('getSubmissionPartition short-circuits when issueIds is empty (no diff fetch)', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2050');

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [],
      commitSha: 'commit-2050',
    });

    expect(result.inlineable).toEqual([]);
    expect(result.appendToBody).toEqual([]);
    expect(result.commitSha).toBe('commit-2050');
    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  test('getSubmissionPartition short-circuits even when base_branch is missing and issueIds is empty', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2051', {
      baseBranch: null,
    });

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [],
      commitSha: 'commit-2051',
    });

    expect(result.inlineable).toEqual([]);
    expect(result.appendToBody).toEqual([]);
    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  test('submitReviewToGitHub body-only APPROVE succeeds without fetching the diff', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2052');
    submitPrReviewMock.mockResolvedValue({
      id: 7777,
      html_url: 'https://github.com/example/repo/pull/2052#pullrequestreview-7777',
    });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'APPROVE',
      body: 'LGTM',
      issueIds: [],
      commitSha: 'commit-2052',
    });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(submitPrReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'APPROVE',
        commitSha: 'commit-2052',
        comments: [],
      })
    );
    expect(result).toMatchObject({
      githubReviewId: 7777,
      inlineCount: 0,
      appendedCount: 0,
    });
  });

  test('submitReviewToGitHub body-only succeeds even when base_branch is missing', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2053', {
      baseBranch: null,
    });
    submitPrReviewMock.mockResolvedValue({
      id: 7778,
      html_url: 'https://github.com/example/repo/pull/2053#pullrequestreview-7778',
    });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'body only',
      issueIds: [],
      commitSha: 'commit-2053',
    });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(result.githubReviewId).toBe(7778);
  });

  test('getSubmissionPartition body-only with fallback SHA short-circuits even when base_branch is null', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2054', {
      baseBranch: null,
    });

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'current-head-sha',
    });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      commitSha: 'stale-sha',
      usedCommitSha: 'current-head-sha',
      fellBackToHead: true,
      inlineable: [],
      appendToBody: [],
    });
  });

  test('submitReviewToGitHub body-only with fallback SHA uses the fallback without diff fetch (no base_branch)', async () => {
    const review = seedReview('https://github.com/example/repo/pull/2055', {
      baseBranch: null,
    });
    submitPrReviewMock.mockResolvedValue({
      id: 7779,
      html_url: 'https://github.com/example/repo/pull/2055#pullrequestreview-7779',
    });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'body only, stale sha',
      issueIds: [],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'current-head-sha',
    });

    expect(compareCommitsMock).not.toHaveBeenCalled();
    expect(submitPrReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: 'current-head-sha',
        comments: [],
      })
    );
    expect(result.githubReviewId).toBe(7779);
  });

  test('getSubmissionPartition partitions selected issues by diff endpoints', async () => {
    const review = seedReview('https://github.com/example/repo/pull/200');
    const inlineIssue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Inline candidate',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    const appendedIssue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'No anchor',
      file: null,
      line: null,
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });
    // Resolved issue should be filtered out before partitioning.
    seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Resolved',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
      resolved: true,
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' context',
        '+new line',
      ].join('\n'),
    });

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [inlineIssue.id, appendedIssue.id],
      commitSha: 'commit-200',
    });

    expect(result.commitSha).toBe('commit-200');
    expect(result.inlineable.map((i) => i.id)).toEqual([inlineIssue.id]);
    expect(result.appendToBody.map((i) => i.id)).toEqual([appendedIssue.id]);
    expect(result.inlineable[0]).toMatchObject({
      file: 'src/app.ts',
      line: '11',
      side: 'RIGHT',
    });
  });

  test('getSubmissionPartition rejects issue id from a different review', async () => {
    const reviewA = seedReview('https://github.com/example/repo/pull/201');
    const reviewB = seedReview('https://github.com/example/repo/pull/202');
    const otherIssue = seedIssue(reviewB.id, {
      severity: 'minor',
      category: 'style',
      content: 'Wrong review',
      file: null,
      line: null,
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeQuery(getSubmissionPartition, {
        reviewId: reviewA.id,
        issueIds: [otherIssue.id],
        commitSha: 'commit-201',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  test('getSubmissionPartition rejects reviews without base_branch', async () => {
    const review = seedReview('https://github.com/example/repo/pull/203', {
      baseBranch: null,
    });
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs anchor check',
      file: 'src/app.ts',
      line: '10',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    await expect(
      invokeQuery(getSubmissionPartition, {
        reviewId: review.id,
        issueIds: [issue.id],
        commitSha: 'commit-203',
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(compareCommitsMock).not.toHaveBeenCalled();
  });

  test('getSubmissionPartition calls compareCommitsWithBasehead with base...commitSha', async () => {
    const review = seedReview('https://github.com/example/repo/pull/204', {
      baseBranch: 'main',
    });
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs check',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    compareCommitsMock.mockResolvedValue({
      data: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' context',
        '+new line',
      ].join('\n'),
    });

    await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [issue.id],
      commitSha: 'supplied-sha',
    });

    expect(compareCommitsMock).toHaveBeenCalledTimes(1);
    expect(compareCommitsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'example',
        repo: 'repo',
        basehead: 'main...supplied-sha',
        mediaType: { format: 'diff' },
      })
    );
  });

  test('getSubmissionPartition falls back to fallbackCommitSha on 404', async () => {
    const review = seedReview('https://github.com/example/repo/pull/311', { baseBranch: 'main' });
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs check',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    compareCommitsMock.mockRejectedValueOnce(notFound).mockResolvedValueOnce({
      data: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' context',
        '+new line',
      ].join('\n'),
    });

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [issue.id],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'head-sha',
    });

    expect(result.usedCommitSha).toBe('head-sha');
    expect(result.fellBackToHead).toBe(true);
    expect(compareCommitsMock).toHaveBeenCalledTimes(2);
    expect(compareCommitsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ basehead: 'main...stale-sha' })
    );
    expect(compareCommitsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ basehead: 'main...head-sha' })
    );
  });

  test('getSubmissionPartition with empty issues still resolves fallback', async () => {
    const review = seedReview('https://github.com/example/repo/pull/312', { baseBranch: 'main' });
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    compareCommitsMock.mockRejectedValueOnce(notFound).mockResolvedValueOnce({ data: '' });

    const result = await invokeQuery(getSubmissionPartition, {
      reviewId: review.id,
      issueIds: [],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'head-sha',
    });

    expect(result.usedCommitSha).toBe('head-sha');
    expect(result.fellBackToHead).toBe(true);
    expect(result.inlineable).toEqual([]);
    expect(result.appendToBody).toEqual([]);
  });

  test('submitReviewToGitHub uses fallback SHA and persists it on success', async () => {
    const review = seedReview('https://github.com/example/repo/pull/313', { baseBranch: 'main' });
    const issue = seedIssue(review.id, {
      severity: 'minor',
      category: 'style',
      content: 'Needs check',
      file: 'src/app.ts',
      line: '11',
      startLine: null,
      suggestion: null,
      side: 'RIGHT',
    });

    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    compareCommitsMock.mockRejectedValueOnce(notFound).mockResolvedValueOnce({
      data: [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,2 +10,3 @@',
        ' context',
        '+new line',
      ].join('\n'),
    });
    submitPrReviewMock.mockResolvedValue({ id: 999, html_url: 'https://example/review/999' });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'COMMENT',
      body: 'Body',
      issueIds: [issue.id],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'head-sha',
    });

    expect(result.usedCommitSha).toBe('head-sha');
    expect(result.fellBackToHead).toBe(true);
    expect(submitPrReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'head-sha' })
    );
    const persisted = getPrReviewSubmissionsForReview(currentDb, review.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.commitSha).toBe('head-sha');
  });

  test('submitReviewToGitHub body-only submission also falls back', async () => {
    const review = seedReview('https://github.com/example/repo/pull/314', { baseBranch: 'main' });
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    compareCommitsMock.mockRejectedValueOnce(notFound).mockResolvedValueOnce({ data: '' });
    submitPrReviewMock.mockResolvedValue({ id: 1000, html_url: 'https://example/review/1000' });

    const result = await invokeCommand(submitReviewToGitHub, {
      reviewId: review.id,
      event: 'APPROVE',
      body: 'LGTM',
      issueIds: [],
      commitSha: 'stale-sha',
      fallbackCommitSha: 'head-sha',
    });

    expect(result.usedCommitSha).toBe('head-sha');
    expect(result.fellBackToHead).toBe(true);
    expect(submitPrReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ commitSha: 'head-sha', event: 'APPROVE' })
    );
    const persisted = getPrReviewSubmissionsForReview(currentDb, review.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.commitSha).toBe('head-sha');
  });

  function seedReview(
    prUrl: string,
    overrides: { reviewedSha?: string | null; baseBranch?: string | null } = {}
  ) {
    const projectId = getOrCreateProject(currentDb, `repo-${crypto.randomUUID()}`).id;
    const reviewedSha = 'reviewedSha' in overrides ? overrides.reviewedSha : 'seed-reviewed-sha';
    const baseBranch = 'baseBranch' in overrides ? overrides.baseBranch : 'main';
    return createReview(currentDb, {
      projectId,
      prUrl,
      branch: 'feature/review-submission',
      baseBranch,
      reviewedSha,
      status: 'complete',
    });
  }

  function seedIssue(
    reviewId: number,
    input: {
      severity: 'critical' | 'major' | 'minor' | 'info';
      category: 'security' | 'performance' | 'bug' | 'style' | 'compliance' | 'testing' | 'other';
      content: string;
      file: string | null;
      line: string | null;
      startLine: string | null;
      suggestion: string | null;
      side: 'LEFT' | 'RIGHT';
      resolved?: boolean;
    }
  ) {
    insertReviewIssues(currentDb, {
      reviewId,
      issues: [
        {
          severity: input.severity,
          category: input.category,
          content: input.content,
          file: input.file,
          line: input.line,
          startLine: input.startLine,
          suggestion: input.suggestion,
          source: null,
          side: input.side,
          resolved: input.resolved ?? false,
        },
      ],
    });

    const issues = getReviewIssues(currentDb, reviewId);
    const created = issues.at(-1);
    if (!created) {
      throw new Error('Failed to seed review issue');
    }

    return created;
  }
});
