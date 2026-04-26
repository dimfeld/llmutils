import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '$tim/db/plan.js';
import { listReviewIssuesForPlan } from '$tim/db/plan_review_issue.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { getReviewIssues, createReview, insertReviewIssues } from '$tim/db/review.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import type { PlanSchema } from '$tim/planSchema.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import {
  addReviewIssueToPlanTask,
  clearReviewIssues,
  deleteReviewIssue,
  convertReviewIssueToTask,
  removeReviewIssue,
} from './review_issue_actions.remote.js';

describe('review issue remote actions', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-issue-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-review-issue-actions').id;
    ensurePlanCompatibilityColumns();
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('removeReviewIssue removes the targeted issue and keeps the rest', async () => {
    seedPlan({
      uuid: 'plan-remove',
      planId: 254,
      reviewIssues: [makeIssue('major', 'bug', 'First'), makeIssue('minor', 'style', 'Second')],
    });

    await invokeCommand(removeReviewIssue, { planUuid: 'plan-remove', issueIndex: 0 });

    const mirroredIssues = listReviewIssuesForPlan(currentDb, 'plan-remove');

    expect(mirroredIssues.map((issue) => issue.content)).toEqual(['Second']);
    expect(
      currentDb
        .prepare('SELECT count(*) AS count FROM plan_review_issue WHERE plan_uuid = ?')
        .get('plan-remove')
    ).toEqual({ count: 2 });
  });

  test('removeReviewIssue rejects out-of-range indexes', async () => {
    seedPlan({
      uuid: 'plan-remove-range',
      planId: 255,
      reviewIssues: [makeIssue('major', 'bug', 'Only issue')],
    });

    await expect(
      invokeCommand(removeReviewIssue, { planUuid: 'plan-remove-range', issueIndex: 2 })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Issue index out of range' },
    });
  });

  test('removeReviewIssue rejects missing plans', async () => {
    await expect(
      invokeCommand(removeReviewIssue, { planUuid: 'missing-plan', issueIndex: 0 })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('convertReviewIssueToTask appends a task, removes the issue, and marks the plan in_progress', async () => {
    const issue = makeIssue(
      'critical',
      'testing',
      'Missing regression coverage',
      'src/example.ts',
      42,
      'Add a focused integration test'
    );
    seedPlan({
      uuid: 'plan-convert',
      planId: 256,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
      reviewIssues: [issue, makeIssue('minor', 'style', 'Leftover issue')],
    });

    await invokeCommand(convertReviewIssueToTask, { planUuid: 'plan-convert', issueIndex: 0 });

    const plan = getPlanByUuid(currentDb, 'plan-convert');
    const tasks = getPlanTasksByUuid(currentDb, 'plan-convert');
    const createdTask = createTaskFromIssue(issue);

    expect(plan?.status).toBe('in_progress');
    expect(listReviewIssuesForPlan(currentDb, 'plan-convert').map((row) => row.content)).toEqual([
      'Leftover issue',
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatchObject({
      task_index: 1,
      title: createdTask.title,
      description: createdTask.description ?? '',
      done: 0,
    });
  });

  test('convertReviewIssueToTask rejects plans without review issues', async () => {
    seedPlan({
      uuid: 'plan-no-issues',
      planId: 257,
      reviewIssues: [],
    });

    await expect(
      invokeCommand(convertReviewIssueToTask, { planUuid: 'plan-no-issues', issueIndex: 0 })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Issue index out of range' },
    });
  });

  test('clearReviewIssues clears the saved review issue list', async () => {
    seedPlan({
      uuid: 'plan-clear',
      planId: 258,
      reviewIssues: [makeIssue('major', 'bug', 'First'), makeIssue('minor', 'style', 'Second')],
    });

    await invokeCommand(clearReviewIssues, { planUuid: 'plan-clear' });

    expect(listReviewIssuesForPlan(currentDb, 'plan-clear')).toEqual([]);
  });

  test('clearReviewIssues rejects missing plans', async () => {
    await expect(
      invokeCommand(clearReviewIssues, { planUuid: 'missing-plan' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('deleteReviewIssue removes the targeted review issue', async () => {
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/401',
      branch: 'feature/review-issue-delete',
    });
    const issue = seedReviewIssue(review.id, makeIssue('major', 'bug', 'Delete me'));
    seedReviewIssue(review.id, makeIssue('minor', 'style', 'Keep me'));

    await invokeCommand(deleteReviewIssue, { reviewId: review.id, issueId: issue.id });

    expect(getReviewIssues(currentDb, review.id)).toHaveLength(1);
    expect(getReviewIssues(currentDb, review.id)[0]?.content).toBe('Keep me');
  });

  test('addReviewIssueToPlanTask appends a task for the single linked plan', async () => {
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/402',
      branch: 'feature/review-issue-task',
    });
    const issue = seedReviewIssue(
      review.id,
      makeIssue(
        'critical',
        'testing',
        'Missing regression coverage',
        'src/example.ts',
        42,
        'Add coverage'
      )
    );
    seedPlan({
      uuid: 'plan-task',
      planId: 259,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
    });
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: review.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 4021,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, 'plan-task', prStatus.status.id);

    await invokeCommand(addReviewIssueToPlanTask, {
      reviewId: review.id,
      issueId: issue.id,
      planUuid: 'plan-task',
    });

    const plan = getPlanByUuid(currentDb, 'plan-task');
    const tasks = getPlanTasksByUuid(currentDb, 'plan-task');
    const createdTask = createTaskFromIssue({
      severity: issue.severity,
      category: issue.category,
      content: issue.content,
      file: issue.file ?? undefined,
      line: issue.line ?? undefined,
      suggestion: issue.suggestion ?? undefined,
    });

    expect(plan?.status).toBe('in_progress');
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatchObject({
      task_index: 1,
      title: createdTask.title,
      description: `${createdTask.description ?? ''}\n\n[source:review-issue:${issue.id}]`,
      done: 0,
    });
  });

  test('addReviewIssueToPlanTask rejects PRs linked to multiple plans', async () => {
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/403',
      branch: 'feature/review-issue-task-multi',
    });
    const issue = seedReviewIssue(review.id, makeIssue('major', 'bug', 'Shared issue'));
    seedPlan({ uuid: 'plan-task-a', planId: 260 });
    seedPlan({ uuid: 'plan-task-b', planId: 261 });
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: review.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 4031,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, 'plan-task-a', prStatus.status.id);
    linkPlanToPr(currentDb, 'plan-task-b', prStatus.status.id);

    await expect(
      invokeCommand(addReviewIssueToPlanTask, {
        reviewId: review.id,
        issueId: issue.id,
        planUuid: 'plan-task-a',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'PR is not linked to this plan' },
    });
  });

  function seedPlan({
    uuid,
    planId,
    status = 'pending',
    tasks = [],
    reviewIssues = null,
  }: {
    uuid: string;
    planId: number;
    status?: PlanSchema['status'];
    tasks?: Array<{ title: string; description: string; done?: boolean }>;
    reviewIssues?: NonNullable<PlanSchema['reviewIssues']> | null;
  }) {
    upsertPlan(currentDb, projectId, {
      uuid,
      planId,
      title: `Plan ${planId}`,
      goal: 'Exercise review issue remote commands',
      details: 'Test fixture',
      status,
      tasks,
      reviewIssues,
    });
  }

  function makeIssue(
    severity: 'critical' | 'major' | 'minor' | 'info',
    category: string,
    content: string,
    file?: string,
    line?: number,
    suggestion?: string
  ): NonNullable<PlanSchema['reviewIssues']>[number] {
    return {
      severity,
      category,
      content,
      ...(file ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(suggestion ? { suggestion } : {}),
    };
  }

  function seedReview({
    prUrl,
    branch,
    baseBranch = 'main',
  }: {
    prUrl: string;
    branch: string;
    baseBranch?: string;
  }) {
    return createReview(currentDb, {
      projectId,
      prUrl,
      branch,
      baseBranch,
      status: 'complete',
    });
  }

  function seedReviewIssue(
    reviewId: number,
    issue: NonNullable<PlanSchema['reviewIssues']>[number]
  ) {
    insertReviewIssues(currentDb, {
      reviewId,
      issues: [
        {
          severity: issue.severity,
          category: issue.category,
          content: issue.content,
          file: issue.file ?? null,
          line: issue.line ? String(issue.line) : null,
          suggestion: issue.suggestion ?? null,
        },
      ],
    });

    return getReviewIssues(currentDb, reviewId).at(-1)!;
  }

  function ensurePlanCompatibilityColumns() {
    const columns = new Set(
      currentDb
        .prepare('PRAGMA table_info(plan)')
        .all()
        .map((row) => (row as { name: string }).name)
    );

    if (!columns.has('base_commit')) {
      currentDb.prepare('ALTER TABLE plan ADD COLUMN base_commit TEXT').run();
    }

    if (!columns.has('base_change_id')) {
      currentDb.prepare('ALTER TABLE plan ADD COLUMN base_change_id TEXT').run();
    }
  }
});
