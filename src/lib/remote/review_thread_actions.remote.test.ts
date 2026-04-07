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
    pullRequest?: string[];
    createPlanPrLink?: boolean;
  }) {
    const prUrl = options.pullRequest?.[0] ?? 'https://github.com/owner/repo/pull/42';

    upsertPlan(currentDb, projectId, {
      uuid: options.planUuid,
      planId: options.planId,
      title: `Plan ${options.planId}`,
      goal: 'Test plan',
      details: 'Test fixture',
      status: options.status ?? 'pending',
      tasks: options.tasks ?? [],
      pullRequest: options.pullRequest,
    });

    const prStatus = upsertPrStatus(currentDb, {
      prUrl,
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      state: 'OPEN',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      reviewThreads: [options.thread],
    });

    // Link PR to plan
    if (options.createPlanPrLink !== false) {
      currentDb
        .prepare(`INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')`)
        .run(options.planUuid, prStatus.status.id);
    }

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
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_thread1]');
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
    expect(tasks[2].description).toContain('[source:review-thread:PRRT_thread2]');
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
    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-no-thread',
      planId: 302,
      thread: {
        threadId: 'PRRT_present',
        path: 'src/existing.ts',
        line: 1,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    currentDb.prepare(`DELETE FROM pr_review_thread WHERE pr_status_id = ?`).run(prStatusId);

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-no-thread',
        prStatusId,
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
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_thread4]');
  });

  test('allows conversion via plan pull_request fallback without a plan_pr row', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/142';
    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-pull-request-fallback',
      planId: 306,
      pullRequest: [prUrl],
      createPlanPrLink: false,
      thread: {
        threadId: 'PRRT_fallback',
        path: 'src/fallback.ts',
        line: 22,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            commentId: 'IC_fallback',
            databaseId: 98765,
            body: 'Fallback linkage should still work.',
            state: 'SUBMITTED',
          },
        ],
      },
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-pull-request-fallback',
      prStatusId,
      threadId: 'PRRT_fallback',
    });

    const tasks = getPlanTasksByUuid(currentDb, 'plan-pull-request-fallback');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Address review: src/fallback.ts:22');
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_fallback]');
  });

  test('rejects resolved thread conversion', async () => {
    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-resolved-thread',
      planId: 307,
      thread: {
        threadId: 'PRRT_resolved',
        path: 'src/resolved.ts',
        line: 7,
        isResolved: true,
        isOutdated: false,
        comments: [
          {
            commentId: 'IC_resolved',
            body: 'This is already resolved.',
            state: 'SUBMITTED',
          },
        ],
      },
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-resolved-thread',
        prStatusId,
        threadId: 'PRRT_resolved',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'Cannot convert a resolved thread to a task' },
    });
  });

  test('detects duplicates by source marker and allows different threads at the same file and line', async () => {
    const firstThread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_same_line_1',
      path: 'src/shared.ts',
      line: 33,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_same_line_1',
          databaseId: 30001,
          body: 'First comment at this line.',
          state: 'SUBMITTED',
        },
      ],
    };
    const secondThread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_same_line_2',
      path: 'src/shared.ts',
      line: 33,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_same_line_2',
          databaseId: 30002,
          body: 'Second comment at the same line.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      planUuid: 'plan-source-marker-duplicate',
      planId: 308,
      thread: firstThread,
    });
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/owner/repo/pull/42',
      owner: 'owner',
      repo: 'repo',
      prNumber: 42,
      state: 'OPEN',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      reviewThreads: [firstThread, secondThread],
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-source-marker-duplicate',
      prStatusId,
      threadId: 'PRRT_same_line_1',
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: 'plan-source-marker-duplicate',
        prStatusId,
        threadId: 'PRRT_same_line_1',
      })
    ).rejects.toMatchObject({
      status: 409,
      body: { message: 'This thread has already been converted to a task' },
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: 'plan-source-marker-duplicate',
      prStatusId,
      threadId: 'PRRT_same_line_2',
    });

    const tasks = getPlanTasksByUuid(currentDb, 'plan-source-marker-duplicate');
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe('Address review: src/shared.ts:33');
    expect(tasks[1].title).toBe('Address review: src/shared.ts:33');
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_same_line_1]');
    expect(tasks[1].description).toContain('[source:review-thread:PRRT_same_line_2]');
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
