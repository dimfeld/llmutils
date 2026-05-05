import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { getReviewIssues, createReview, insertReviewIssues } from '$tim/db/review.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { createTaskFromIssue } from '$tim/commands/review.js';
import type { TimConfig } from '$tim/configSchema.js';
import type { PlanSchema } from '$tim/planSchema.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { setApplyBatchOperationHookForTesting } from '$tim/sync/apply.js';

let currentDb: Database;
let currentConfig: TimConfig;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
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
    currentConfig = { sync: { nodeId: '00000000-0000-4000-8000-000000000001' } };
    projectId = getOrCreateProject(currentDb, 'repo-review-issue-actions').id;
    ensurePlanCompatibilityColumns();
  });

  afterEach(() => {
    setApplyBatchOperationHookForTesting(null);
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('removeReviewIssue removes the targeted issue and keeps the rest', async () => {
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000156',
      planId: 254,
      reviewIssues: [makeIssue('major', 'bug', 'First'), makeIssue('minor', 'style', 'Second')],
    });

    await invokeCommand(removeReviewIssue, {
      planUuid: '00000000-0000-4000-8000-000000000156',
      issueIndex: 0,
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000156');

    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([
      makeIssue('minor', 'style', 'Second'),
    ]);
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
      uuid: '00000000-0000-4000-8000-000000000256',
      planId: 256,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
      reviewIssues: [issue, makeIssue('minor', 'style', 'Leftover issue')],
    });

    await invokeCommand(convertReviewIssueToTask, {
      planUuid: '00000000-0000-4000-8000-000000000256',
      issueIndex: 0,
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000256');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000256');
    const createdTask = createTaskFromIssue(issue);

    expect(plan?.status).toBe('in_progress');
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([
      makeIssue('minor', 'style', 'Leftover issue'),
    ]);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]).toMatchObject({
      task_index: 1,
      title: createdTask.title,
      description: createdTask.description ?? '',
      done: 0,
    });
    expect(tasks[1]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(tasks[1]?.revision).toBe(1);
  });

  test('convertReviewIssueToTask removes only one duplicate review issue', async () => {
    const issue = makeIssue('major', 'bug', 'Duplicated issue', 'src/duplicate.ts', 7);
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000151',
      planId: 265,
      status: 'needs_review',
      reviewIssues: [issue, issue],
    });

    await invokeCommand(convertReviewIssueToTask, {
      planUuid: '00000000-0000-4000-8000-000000000151',
      issueIndex: 1,
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000151');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000151');

    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([issue]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe(createTaskFromIssue(issue).title);
  });

  test('convertReviewIssueToTask allows only one concurrent conversion for the same issue', async () => {
    const issue = makeIssue('major', 'bug', 'Concurrent duplicated issue', 'src/race.ts', 11);
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000154',
      planId: 268,
      status: 'needs_review',
      reviewIssues: [issue, issue],
    });

    const results = await Promise.allSettled([
      invokeCommand(convertReviewIssueToTask, {
        planUuid: '00000000-0000-4000-8000-000000000154',
        issueIndex: 0,
      }),
      invokeCommand(convertReviewIssueToTask, {
        planUuid: '00000000-0000-4000-8000-000000000154',
        issueIndex: 0,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      body: { message: 'Review issues changed; refresh and try again' },
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000154');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000154');
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([issue]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe(createTaskFromIssue(issue).title);
  });

  test('convertReviewIssueToTask queues one persistent batch with removal, status, and task operations', async () => {
    currentConfig = persistentConfig();
    const issue = makeIssue('major', 'bug', 'Queue this issue', 'src/queued.ts', 15);
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000152',
      planId: 266,
      status: 'needs_review',
      reviewIssues: [issue],
    });

    await invokeCommand(convertReviewIssueToTask, {
      planUuid: '00000000-0000-4000-8000-000000000152',
      issueIndex: 0,
    });

    expect(queuedOperationRows()).toEqual([
      {
        operation_type: 'plan.set_scalar',
        status: 'queued',
        batch_id: expect.any(String),
      },
      {
        operation_type: 'plan.add_task',
        status: 'queued',
        batch_id: expect.any(String),
      },
      {
        operation_type: 'plan.remove_list_item',
        status: 'queued',
        batch_id: expect.any(String),
      },
    ]);
    const batchIds = new Set(queuedOperationRows().map((row) => row.batch_id));
    expect(batchIds.size).toBe(1);
    expect(batchIds.has(null)).toBe(false);
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

  test('convertReviewIssueToTask rolls back all plan changes when the batch fails', async () => {
    const issue = makeIssue('major', 'bug', 'Rollback issue');
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000101',
      planId: 262,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
      reviewIssues: [issue],
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw new Error('injected review issue batch failure');
      }
    });

    await expect(
      invokeCommand(convertReviewIssueToTask, {
        planUuid: '00000000-0000-4000-8000-000000000101',
        issueIndex: 0,
      })
    ).rejects.toThrow('injected review issue batch failure');

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000101');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000101');

    expect(plan?.status).toBe('needs_review');
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual([issue]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Existing task');
  });

  test('clearReviewIssues clears the saved review issue list', async () => {
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000258',
      planId: 258,
      reviewIssues: [makeIssue('major', 'bug', 'First'), makeIssue('minor', 'style', 'Second')],
    });

    await invokeCommand(clearReviewIssues, { planUuid: '00000000-0000-4000-8000-000000000258' });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000258');

    expect(plan?.review_issues).toBeNull();
  });

  test('clearReviewIssues clears duplicate identical review issues through routed operations', async () => {
    const issue = makeIssue('major', 'bug', 'Duplicated clear issue', 'src/clear.ts', 9);
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000155',
      planId: 269,
      reviewIssues: [issue, issue],
    });

    await invokeCommand(clearReviewIssues, {
      planUuid: '00000000-0000-4000-8000-000000000155',
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000155');
    expect(plan?.review_issues).toBeNull();
    expect(queuedOperationRows()).toEqual([
      {
        operation_type: 'plan.remove_list_item',
        status: 'applied',
        batch_id: expect.any(String),
      },
      {
        operation_type: 'plan.remove_list_item',
        status: 'applied',
        batch_id: expect.any(String),
      },
    ]);
  });

  test('clearReviewIssues rolls back all removals when the batch fails', async () => {
    const issues = [makeIssue('major', 'bug', 'First'), makeIssue('minor', 'style', 'Second')];
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000102',
      planId: 263,
      reviewIssues: issues,
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw new Error('injected clear issues batch failure');
      }
    });

    await expect(
      invokeCommand(clearReviewIssues, { planUuid: '00000000-0000-4000-8000-000000000102' })
    ).rejects.toThrow('injected clear issues batch failure');

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000102');
    expect(JSON.parse(plan?.review_issues ?? '[]')).toEqual(issues);
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
      uuid: '00000000-0000-4000-8000-000000000259',
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
    linkPlanToPr(currentDb, '00000000-0000-4000-8000-000000000259', prStatus.status.id);

    await invokeCommand(addReviewIssueToPlanTask, {
      reviewId: review.id,
      issueId: issue.id,
      planUuid: '00000000-0000-4000-8000-000000000259',
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000259');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000259');
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
    expect(tasks[1]?.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(tasks[1]?.revision).toBe(1);
  });

  test('addReviewIssueToPlanTask allows only one concurrent conversion for the same issue', async () => {
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/406',
      branch: 'feature/review-issue-task-race',
    });
    const issue = seedReviewIssue(review.id, makeIssue('major', 'bug', 'Race issue task'));
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000155',
      planId: 269,
      status: 'needs_review',
    });
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: review.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 4061,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, '00000000-0000-4000-8000-000000000155', prStatus.status.id);

    const args = {
      reviewId: review.id,
      issueId: issue.id,
      planUuid: '00000000-0000-4000-8000-000000000155',
    };
    const results = await Promise.allSettled([
      invokeCommand(addReviewIssueToPlanTask, args),
      invokeCommand(addReviewIssueToPlanTask, args),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      body: { message: 'This review issue has already been converted to a task' },
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000155');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.description).toContain(`[source:review-issue:${issue.id}]`);
  });

  test('addReviewIssueToPlanTask rolls back task and status changes when the batch fails', async () => {
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/404',
      branch: 'feature/review-issue-task-rollback',
    });
    const issue = seedReviewIssue(review.id, makeIssue('major', 'bug', 'Rollback task'));
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000103',
      planId: 264,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
    });
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: review.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 4041,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, '00000000-0000-4000-8000-000000000103', prStatus.status.id);

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw new Error('injected review issue task batch failure');
      }
    });

    await expect(
      invokeCommand(addReviewIssueToPlanTask, {
        reviewId: review.id,
        issueId: issue.id,
        planUuid: '00000000-0000-4000-8000-000000000103',
      })
    ).rejects.toThrow('injected review issue task batch failure');

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000103');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000103');

    expect(plan?.status).toBe('needs_review');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Existing task');
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

  test('addReviewIssueToPlanTask queues one persistent batch for status and task operations', async () => {
    currentConfig = persistentConfig();
    const review = seedReview({
      prUrl: 'https://github.com/example/repo/pull/405',
      branch: 'feature/review-issue-persistent',
    });
    const issue = seedReviewIssue(review.id, makeIssue('major', 'bug', 'Persistent issue task'));
    seedPlan({
      uuid: '00000000-0000-4000-8000-000000000153',
      planId: 267,
      status: 'needs_review',
    });
    const prStatus = upsertPrStatus(currentDb, {
      prUrl: review.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 4051,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    linkPlanToPr(currentDb, '00000000-0000-4000-8000-000000000153', prStatus.status.id);

    await invokeCommand(addReviewIssueToPlanTask, {
      reviewId: review.id,
      issueId: issue.id,
      planUuid: '00000000-0000-4000-8000-000000000153',
    });

    expect(queuedOperationRows()).toEqual([
      {
        operation_type: 'plan.set_scalar',
        status: 'queued',
        batch_id: expect.any(String),
      },
      {
        operation_type: 'plan.add_task',
        status: 'queued',
        batch_id: expect.any(String),
      },
    ]);
    expect(new Set(queuedOperationRows().map((row) => row.batch_id)).size).toBe(1);
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

  function persistentConfig(): TimConfig {
    return {
      sync: {
        role: 'persistent',
        nodeId: '00000000-0000-4000-8000-000000000001',
        mainUrl: 'http://127.0.0.1:8124',
        nodeToken: 'test-token',
      },
    };
  }

  function queuedOperationRows() {
    return currentDb
      .prepare(
        `
          SELECT operation_type, status, batch_id
          FROM sync_operation
          ORDER BY local_sequence
        `
      )
      .all() as Array<{
      operation_type: string;
      status: string;
      batch_id: string | null;
    }>;
  }
});
