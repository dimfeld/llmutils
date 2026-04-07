import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPrStatus, type StoredPrReviewThreadInput } from '$tim/db/pr_status.js';
import type { PlanSchema } from '$tim/planSchema.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

import { convertThreadToTask } from './review_thread_actions.remote.js';

describe('convertThreadToTask', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-thread-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'repo-review-thread-actions').id;
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function seedPlanWithThread(options: {
    planUuid: string;
    planId: number;
    status?: PlanSchema['status'];
    tasks?: Array<{ title: string; description: string; done?: boolean }>;
    thread: StoredPrReviewThreadInput;
  }) {
    upsertPlan(currentDb, projectId, {
      uuid: options.planUuid,
      planId: options.planId,
      title: `Plan ${options.planId}`,
      goal: 'Test plan',
      details: 'Test fixture',
      status: options.status ?? 'pending',
      tasks: options.tasks ?? [],
    });

    const prStatus = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/owner/repo/pull/42',
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      state: 'OPEN',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      reviewThreads: [options.thread],
    });

    // Link PR to plan
    currentDb
      .prepare(
        `INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')`
      )
      .run(options.planUuid, prStatus.status.id);

    return { prStatusId: prStatus.status.id };
  }

  test('converts a review thread to a task and marks plan in_progress', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread1',
      path: 'src/auth.ts',
      line: 42,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_comment1',
          databaseId: 12345,
          author: 'reviewer',
          body: 'This needs a null check.',
          diffHunk: '@@ -10,5 +10,5 @@\n context\n-old\n+new',
          state: 'SUBMITTED',
          createdAt: '2025-01-15T10:00:00Z',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-thread-convert',
      planId: 300,
      status: 'needs_review',
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-thread-convert',
      prStatusId,
      threadId: 'PRRT_thread1',
    });

    const plan = getPlanByUuid(currentDb, 'plan-thread-convert');
    const tasks = getPlanTasksByUuid(currentDb, 'plan-thread-convert');

    expect(plan?.status).toBe('in_progress');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_index).toBe(0);
    expect(tasks[0].title).toBe('Address review: src/auth.ts:42');
    expect(tasks[0].description).toContain('This needs a null check.');
    expect(tasks[0].description).toContain('#discussion_r12345');
    expect(tasks[0].done).toBe(0);
  });

  test('appends task after existing tasks', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread2',
      path: 'src/utils.ts',
      line: 10,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_comment2',
          body: 'Consider refactoring.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-thread-append',
      planId: 301,
      tasks: [
        { title: 'Existing task 1', description: 'Already here', done: false },
        { title: 'Existing task 2', description: 'Also here', done: true },
      ],
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-thread-append',
      prStatusId,
      threadId: 'PRRT_thread2',
    });

    const tasks = getPlanTasksByUuid(currentDb, 'plan-thread-append');
    expect(tasks).toHaveLength(3);
    expect(tasks[2].task_index).toBe(2);
    expect(tasks[2].title).toBe('Address review: src/utils.ts:10');
  });

  test('rejects missing plan', async () => {
    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'nonexistent-plan',
        prStatusId: 999,
        threadId: 'PRRT_x',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('rejects missing thread', async () => {
    upsertPlan(currentDb, projectId, {
      uuid: 'plan-no-thread',
      planId: 302,
      title: 'Plan 302',
      goal: 'Test',
      details: 'Test',
      status: 'pending',
      tasks: [],
    });

    const prStatus = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/owner/repo/pull/99',
      owner: 'owner',
      repo: 'repo',
      prNumber: 99,
      state: 'OPEN',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      reviewThreads: [],
    });

    currentDb
      .prepare(
        `INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')`
      )
      .run('plan-no-thread', prStatus.status.id);

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-no-thread',
        prStatusId: prStatus.status.id,
        threadId: 'PRRT_nonexistent',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Review thread not found' },
    });
  });

  test('rejects conversion when the PR is not linked to the plan', async () => {
    upsertPlan(currentDb, projectId, {
      uuid: 'plan-unlinked-pr',
      planId: 304,
      title: 'Plan 304',
      goal: 'Test',
      details: 'Test',
      status: 'pending',
      tasks: [],
    });

    const prStatus = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/owner/repo/pull/100',
      owner: 'owner',
      repo: 'repo',
      prNumber: 100,
      state: 'OPEN',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      reviewThreads: [
        {
          threadId: 'PRRT_unlinked',
          path: 'src/unlinked.ts',
          line: 12,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              commentId: 'IC_unlinked',
              body: 'Please fix this before merge.',
              state: 'SUBMITTED',
            },
          ],
        },
      ],
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-unlinked-pr',
        prStatusId: prStatus.status.id,
        threadId: 'PRRT_unlinked',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'PR is not linked to this plan' },
    });
  });

  test('rejects duplicate conversion of the same thread', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread4',
      path: 'src/dupe.ts',
      line: 18,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_comment4',
          databaseId: 45678,
          body: 'Handle this branch explicitly.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-duplicate-thread',
      planId: 305,
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-duplicate-thread',
      prStatusId,
      threadId: 'PRRT_thread4',
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-duplicate-thread',
        prStatusId,
        threadId: 'PRRT_thread4',
      })
    ).rejects.toMatchObject({
      status: 409,
      body: { message: 'This thread has already been converted to a task' },
    });

    const tasks = getPlanTasksByUuid(currentDb, 'plan-duplicate-thread');
    expect(tasks).toHaveLength(1);
  });

  test('does not change status if plan is already in_progress', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread3',
      path: 'src/main.ts',
      line: 5,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_comment3',
          body: 'Fix this.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-already-progress',
      planId: 303,
      status: 'in_progress',
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-already-progress',
      prStatusId,
      threadId: 'PRRT_thread3',
    });

    const plan = getPlanByUuid(currentDb, 'plan-already-progress');
    expect(plan?.status).toBe('in_progress');
  });
});
