import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getPlanByUuid, getPlanTasksByUuid, upsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPrStatus, type StoredPrReviewThreadInput } from '$tim/db/pr_status.js';
import { recordWorkspace } from '$tim/db/workspace.js';
import type { TimConfig } from '$tim/configSchema.js';
import type { PlanSchema } from '$tim/planSchema.js';
import { setApplyBatchOperationHookForTesting } from '$tim/sync/apply.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentManager: SessionManager;
let currentConfig: TimConfig;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: currentConfig,
    db: currentDb,
  }),
}));

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => currentManager,
}));

const { addReplyToReviewThreadMock, resolveReviewThreadMock } = vi.hoisted(() => ({
  addReplyToReviewThreadMock: vi.fn<(threadId: string, body: string) => Promise<boolean>>(),
  resolveReviewThreadMock: vi.fn<(threadId: string) => Promise<boolean>>(),
}));

const { spawnPrFixProcessMock } = vi.hoisted(() => ({
  spawnPrFixProcessMock: vi.fn<
    (
      planId: number,
      cwd: string
    ) => Promise<{
      success: boolean;
      planId?: number;
      error?: string;
      earlyExit?: boolean;
    }>
  >(),
}));

vi.mock('$common/github/pull_requests.js', () => ({
  addReplyToReviewThread: addReplyToReviewThreadMock,
  resolveReviewThread: resolveReviewThreadMock,
}));

vi.mock('$lib/server/plan_actions.js', () => ({
  spawnPrFixProcess: (...args: Parameters<typeof spawnPrFixProcessMock>) =>
    spawnPrFixProcessMock(...args),
}));

import {
  convertThreadToTask,
  replyToThread,
  resolveThread,
  startFixThreads,
} from './review_thread_actions.remote.js';
import { isPlanLaunching, resetLaunchLockState, setLaunchLock } from '$lib/server/launch_lock.js';

function seedPlanWithThread(options: {
  projectId: number;
  planUuid: string;
  planId: number;
  status?: PlanSchema['status'];
  tasks?: Array<{ title: string; description: string; done?: boolean }>;
  thread: StoredPrReviewThreadInput;
  pullRequest?: string[];
  createPlanPrLink?: boolean;
}) {
  const prUrl = options.pullRequest?.[0] ?? 'https://github.com/owner/repo/pull/42';

  upsertPlan(currentDb, options.projectId, {
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

  if (options.createPlanPrLink !== false) {
    currentDb
      .prepare(`INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')`)
      .run(options.planUuid, prStatus.status.id);
  }

  return { prStatusId: prStatus.status.id };
}

describe('convertThreadToTask', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-thread-actions-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(currentDb);
    currentConfig = defaultConfig();
    projectId = getOrCreateProject(currentDb, 'repo-review-thread-actions').id;
    addReplyToReviewThreadMock.mockReset();
    resolveReviewThreadMock.mockReset();
    spawnPrFixProcessMock.mockReset();
  });

  afterEach(() => {
    setApplyBatchOperationHookForTesting(null);
    resetLaunchLockState();
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

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
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000301',
      planId: 300,
      status: 'needs_review',
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000301',
      prStatusId,
      threadId: 'PRRT_thread1',
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000301');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000301');

    expect(plan?.status).toBe('in_progress');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].task_index).toBe(0);
    expect(tasks[0].title).toBe('Address review: src/auth.ts:42');
    expect(tasks[0].description).toContain('This needs a null check.');
    expect(tasks[0].description).toContain('#discussion_r12345');
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_thread1]');
    expect(tasks[0].done).toBe(0);
    expect(tasks[0].uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(tasks[0].revision).toBe(1);
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
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000302',
      planId: 301,
      tasks: [
        { title: 'Existing task 1', description: 'Already here', done: false },
        { title: 'Existing task 2', description: 'Also here', done: true },
      ],
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000302',
      prStatusId,
      threadId: 'PRRT_thread2',
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000302');
    expect(tasks).toHaveLength(3);
    expect(tasks[2].task_index).toBe(2);
    expect(tasks[2].title).toBe('Address review: src/utils.ts:10');
    expect(tasks[2].description).toContain('[source:review-thread:PRRT_thread2]');
  });

  test('rolls back task and status changes when the batch fails', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread_rollback',
      path: 'src/rollback.ts',
      line: 24,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_rollback',
          body: 'Rollback this conversion.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000201',
      planId: 318,
      status: 'needs_review',
      tasks: [{ title: 'Existing task', description: 'Already there', done: false }],
      thread,
    });

    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw new Error('injected review thread batch failure');
      }
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: '00000000-0000-4000-8000-000000000201',
        prStatusId,
        threadId: 'PRRT_thread_rollback',
      })
    ).rejects.toThrow('injected review thread batch failure');

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000201');
    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000201');
    expect(plan?.status).toBe('needs_review');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe('Existing task');
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
      projectId,
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
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000303',
      planId: 305,
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000303',
      prStatusId,
      threadId: 'PRRT_thread4',
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: '00000000-0000-4000-8000-000000000303',
        prStatusId,
        threadId: 'PRRT_thread4',
      })
    ).rejects.toMatchObject({
      status: 409,
      body: { message: 'This thread has already been converted to a task' },
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000303');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_thread4]');
  });

  test('allows only one concurrent conversion for the same thread', async () => {
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread_race',
      path: 'src/race.ts',
      line: 31,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_thread_race',
          databaseId: 87654,
          body: 'Convert this once.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000252',
      planId: 320,
      thread,
    });

    const args = {
      planUuid: '00000000-0000-4000-8000-000000000252',
      prStatusId,
      threadId: 'PRRT_thread_race',
    };
    const results = await Promise.allSettled([
      invokeCommand(convertThreadToTask, args),
      invokeCommand(convertThreadToTask, args),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected?.reason).toMatchObject({
      status: 409,
      body: { message: 'This thread has already been converted to a task' },
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000252');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_thread_race]');
  });

  test('allows conversion via plan pull_request fallback without a plan_pr row', async () => {
    const prUrl = 'https://github.com/owner/repo/pull/142';
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000305',
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
      planUuid: '00000000-0000-4000-8000-000000000305',
      prStatusId,
      threadId: 'PRRT_fallback',
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000305');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Address review: src/fallback.ts:22');
    expect(tasks[0].description).toContain('[source:review-thread:PRRT_fallback]');
  });

  test('rejects resolved thread conversion', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
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
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000306',
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
      planUuid: '00000000-0000-4000-8000-000000000306',
      prStatusId,
      threadId: 'PRRT_same_line_1',
    });

    await expect(
      invokeCommand(convertThreadToTask, {
        planUuid: '00000000-0000-4000-8000-000000000306',
        prStatusId,
        threadId: 'PRRT_same_line_1',
      })
    ).rejects.toMatchObject({
      status: 409,
      body: { message: 'This thread has already been converted to a task' },
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000306',
      prStatusId,
      threadId: 'PRRT_same_line_2',
    });

    const tasks = getPlanTasksByUuid(currentDb, '00000000-0000-4000-8000-000000000306');
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
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000307',
      planId: 303,
      status: 'in_progress',
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000307',
      prStatusId,
      threadId: 'PRRT_thread3',
    });

    const plan = getPlanByUuid(currentDb, '00000000-0000-4000-8000-000000000307');
    expect(plan?.status).toBe('in_progress');
  });

  test('queues one persistent batch for status and task operations', async () => {
    currentConfig = persistentConfig();
    const thread: StoredPrReviewThreadInput = {
      threadId: 'PRRT_thread_persistent',
      path: 'src/persistent.ts',
      line: 19,
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          commentId: 'IC_persistent',
          databaseId: 65432,
          body: 'Queue this thread conversion.',
          state: 'SUBMITTED',
        },
      ],
    };

    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: '00000000-0000-4000-8000-000000000251',
      planId: 319,
      status: 'needs_review',
      thread,
    });

    await invokeCommand(convertThreadToTask, {
      planUuid: '00000000-0000-4000-8000-000000000251',
      prStatusId,
      threadId: 'PRRT_thread_persistent',
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
    const batchIds = new Set(queuedOperationRows().map((row) => row.batch_id));
    expect(batchIds.size).toBe(1);
    expect(batchIds.has(null)).toBe(false);
  });
});

function persistentConfig(): TimConfig {
  return {
    githubUsername: 'configured-user',
    sync: {
      role: 'persistent',
      nodeId: '00000000-0000-4000-8000-000000000002',
      mainUrl: 'http://127.0.0.1:8124',
      nodeToken: 'test-token',
    },
  };
}

function defaultConfig(): TimConfig {
  return {
    githubUsername: 'configured-user',
    sync: { nodeId: '00000000-0000-4000-8000-000000000002' },
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

describe('resolveThread', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-thread-resolve-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = defaultConfig();
    projectId = getOrCreateProject(currentDb, 'repo-review-thread-resolve').id;
    addReplyToReviewThreadMock.mockReset();
    resolveReviewThreadMock.mockReset();
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('resolves a thread and updates the local cache row', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-resolve-thread',
      planId: 309,
      thread: {
        threadId: 'PRRT_resolve_me',
        path: 'src/resolve.ts',
        line: 11,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    resolveReviewThreadMock.mockResolvedValue(true);

    await expect(
      invokeCommand(resolveThread, {
        prStatusId,
        threadId: 'PRRT_resolve_me',
      })
    ).resolves.toEqual({ success: true });

    expect(resolveReviewThreadMock).toHaveBeenCalledWith('PRRT_resolve_me');
    expect(
      currentDb
        .prepare(
          `SELECT is_resolved FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`
        )
        .get(prStatusId, 'PRRT_resolve_me')
    ).toEqual({ is_resolved: 1 });
  });

  test('returns success false when GitHub resolve fails', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-resolve-thread-fail',
      planId: 310,
      thread: {
        threadId: 'PRRT_resolve_fail',
        path: 'src/resolve-fail.ts',
        line: 14,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    resolveReviewThreadMock.mockResolvedValue(false);

    await expect(
      invokeCommand(resolveThread, {
        prStatusId,
        threadId: 'PRRT_resolve_fail',
      })
    ).resolves.toEqual({ success: false });

    expect(
      currentDb
        .prepare(
          `SELECT is_resolved FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`
        )
        .get(prStatusId, 'PRRT_resolve_fail')
    ).toEqual({ is_resolved: 0 });
  });

  test('rejects missing local review thread before calling GitHub', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-resolve-thread-missing',
      planId: 311,
      thread: {
        threadId: 'PRRT_resolve_missing',
        path: 'src/missing.ts',
        line: 20,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    currentDb
      .prepare(`DELETE FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`)
      .run(prStatusId, 'PRRT_resolve_missing');
    resolveReviewThreadMock.mockResolvedValue(true);

    await expect(
      invokeCommand(resolveThread, {
        prStatusId,
        threadId: 'PRRT_resolve_missing',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Review thread not found' },
    });
    expect(resolveReviewThreadMock).not.toHaveBeenCalled();
  });

  test('propagates error when GitHub API throws', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-resolve-thread-throw',
      planId: 312,
      thread: {
        threadId: 'PRRT_resolve_throw',
        path: 'src/throw.ts',
        line: 5,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    resolveReviewThreadMock.mockRejectedValue(new Error('GitHub API rate limit exceeded'));

    await expect(
      invokeCommand(resolveThread, {
        prStatusId,
        threadId: 'PRRT_resolve_throw',
      })
    ).rejects.toThrow('GitHub API rate limit exceeded');

    // Local cache should remain unchanged
    expect(
      currentDb
        .prepare(
          `SELECT is_resolved FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`
        )
        .get(prStatusId, 'PRRT_resolve_throw')
    ).toEqual({ is_resolved: 0 });
  });

  test('resolves an already-resolved thread idempotently without calling GitHub', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-resolve-already-resolved',
      planId: 313,
      thread: {
        threadId: 'PRRT_already_resolved',
        path: 'src/already.ts',
        line: 3,
        isResolved: true,
        isOutdated: false,
        comments: [],
      },
    });
    resolveReviewThreadMock.mockResolvedValue(true);

    await expect(
      invokeCommand(resolveThread, {
        prStatusId,
        threadId: 'PRRT_already_resolved',
      })
    ).resolves.toEqual({ success: true });

    expect(resolveReviewThreadMock).not.toHaveBeenCalled();
    expect(
      currentDb
        .prepare(
          `SELECT is_resolved FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`
        )
        .get(prStatusId, 'PRRT_already_resolved')
    ).toEqual({ is_resolved: 1 });
  });
});

describe('replyToThread', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-thread-reply-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentConfig = defaultConfig();
    projectId = getOrCreateProject(currentDb, 'repo-review-thread-reply').id;
    addReplyToReviewThreadMock.mockReset();
    resolveReviewThreadMock.mockReset();
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('posts a reply to the GitHub review thread', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-reply-thread',
      planId: 314,
      thread: {
        threadId: 'PRRT_reply_me',
        path: 'src/reply.ts',
        line: 4,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    addReplyToReviewThreadMock.mockResolvedValue(true);

    await expect(
      invokeCommand(replyToThread, {
        prStatusId,
        threadId: 'PRRT_reply_me',
        body: 'Fixed in the latest commit.',
      })
    ).resolves.toEqual({ success: true });

    expect(addReplyToReviewThreadMock).toHaveBeenCalledWith(
      'PRRT_reply_me',
      'Fixed in the latest commit.'
    );
    expect(
      currentDb
        .prepare(
          `
            SELECT author, body, state, diff_hunk, database_id
            FROM pr_review_thread_comment
            WHERE review_thread_id = (
              SELECT id
              FROM pr_review_thread
              WHERE pr_status_id = ? AND thread_id = ?
            )
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get(prStatusId, 'PRRT_reply_me')
    ).toEqual({
      author: 'configured-user',
      body: 'Fixed in the latest commit.',
      state: 'SUBMITTED',
      diff_hunk: null,
      database_id: null,
    });
  });

  test('returns success false when GitHub reply fails', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-reply-thread-fail',
      planId: 315,
      thread: {
        threadId: 'PRRT_reply_fail',
        path: 'src/reply-fail.ts',
        line: 8,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    addReplyToReviewThreadMock.mockResolvedValue(false);

    await expect(
      invokeCommand(replyToThread, {
        prStatusId,
        threadId: 'PRRT_reply_fail',
        body: 'Attempted reply.',
      })
    ).resolves.toEqual({ success: false });
    expect(
      currentDb
        .prepare(
          `
            SELECT COUNT(*) as count
            FROM pr_review_thread_comment
            WHERE review_thread_id = (
              SELECT id
              FROM pr_review_thread
              WHERE pr_status_id = ? AND thread_id = ?
            )
          `
        )
        .get(prStatusId, 'PRRT_reply_fail')
    ).toEqual({ count: 0 });
  });

  test('propagates error when GitHub API throws', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-reply-thread-throw',
      planId: 316,
      thread: {
        threadId: 'PRRT_reply_throw',
        path: 'src/reply-throw.ts',
        line: 12,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    addReplyToReviewThreadMock.mockRejectedValue(new Error('Network error'));

    await expect(
      invokeCommand(replyToThread, {
        prStatusId,
        threadId: 'PRRT_reply_throw',
        body: 'Will not arrive.',
      })
    ).rejects.toThrow('Network error');
  });

  test('rejects reply when the local review thread is missing', async () => {
    const { prStatusId } = seedPlanWithThread({
      projectId,
      planUuid: 'plan-reply-thread-missing',
      planId: 317,
      thread: {
        threadId: 'PRRT_reply_missing',
        path: 'src/reply-missing.ts',
        line: 18,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    });
    currentDb
      .prepare(`DELETE FROM pr_review_thread WHERE pr_status_id = ? AND thread_id = ?`)
      .run(prStatusId, 'PRRT_reply_missing');

    await expect(
      invokeCommand(replyToThread, {
        prStatusId,
        threadId: 'PRRT_reply_missing',
        body: 'No matching local thread.',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Review thread not found' },
    });
    expect(addReplyToReviewThreadMock).not.toHaveBeenCalled();
  });
});

describe('startFixThreads', () => {
  let tempDir: string;
  let projectId: number;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-thread-start-fix-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    currentManager = new SessionManager(currentDb);
    currentConfig = defaultConfig();
    projectId = getOrCreateProject(currentDb, 'repo-review-thread-start-fix').id;
    addReplyToReviewThreadMock.mockReset();
    resolveReviewThreadMock.mockReset();
    spawnPrFixProcessMock.mockReset();
  });

  afterEach(() => {
    resetLaunchLockState();
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('rejects missing plans', async () => {
    await expect(
      invokeCommand(startFixThreads, { planUuid: 'missing-plan' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('rejects plans with no unresolved review threads', async () => {
    seedPlanWithThread({
      projectId,
      planUuid: 'plan-no-unresolved',
      planId: 400,
      thread: {
        threadId: 'PRRT_resolved_only',
        path: 'src/resolved.ts',
        line: 9,
        isResolved: true,
        isOutdated: false,
        comments: [{ commentId: 'IC_resolved_only', body: 'Already done.', state: 'SUBMITTED' }],
      },
    });

    await expect(
      invokeCommand(startFixThreads, { planUuid: 'plan-no-unresolved' })
    ).rejects.toMatchObject({
      status: 400,
      body: { message: 'No unresolved review threads to fix' },
    });
  });

  test('returns already_running when a session is active for the plan', async () => {
    seedPlanWithThread({
      projectId,
      planUuid: 'plan-active-session',
      planId: 401,
      thread: {
        threadId: 'PRRT_active',
        path: 'src/active.ts',
        line: 12,
        isResolved: false,
        isOutdated: false,
        comments: [{ commentId: 'IC_active', body: 'Needs a fix.', state: 'SUBMITTED' }],
      },
    });
    currentManager.handleWebSocketConnect('conn-fix', () => {});
    currentManager.handleWebSocketMessage('conn-fix', {
      type: 'session_info',
      command: 'agent',
      interactive: true,
      planId: 401,
      planUuid: 'plan-active-session',
      workspacePath: '/tmp/primary-workspace',
    });

    await expect(
      invokeCommand(startFixThreads, { planUuid: 'plan-active-session' })
    ).resolves.toEqual({
      status: 'already_running',
      connectionId: 'conn-fix',
    });
    expect(spawnPrFixProcessMock).not.toHaveBeenCalled();
  });

  test('returns already_running when a launch lock already exists', async () => {
    seedPlanWithThread({
      projectId,
      planUuid: 'plan-launch-locked',
      planId: 402,
      thread: {
        threadId: 'PRRT_locked',
        path: 'src/locked.ts',
        line: 6,
        isResolved: false,
        isOutdated: false,
        comments: [{ commentId: 'IC_locked', body: 'Fix me.', state: 'SUBMITTED' }],
      },
    });
    setLaunchLock('plan-launch-locked');

    await expect(
      invokeCommand(startFixThreads, { planUuid: 'plan-launch-locked' })
    ).resolves.toEqual({
      status: 'already_running',
    });
    expect(spawnPrFixProcessMock).not.toHaveBeenCalled();
  });

  test('spawns tim pr fix in the primary workspace when unresolved threads exist', async () => {
    seedPlanWithThread({
      projectId,
      planUuid: 'plan-start-fix',
      planId: 403,
      thread: {
        threadId: 'PRRT_fix_me',
        path: 'src/fix.ts',
        line: 19,
        isResolved: false,
        isOutdated: false,
        comments: [{ commentId: 'IC_fix_me', body: 'Needs fixing.', state: 'SUBMITTED' }],
      },
    });
    recordWorkspace(currentDb, {
      projectId,
      workspacePath: '/tmp/primary-workspace',
      workspaceType: 'primary',
    });
    spawnPrFixProcessMock.mockResolvedValue({ success: true, planId: 403 });

    await expect(invokeCommand(startFixThreads, { planUuid: 'plan-start-fix' })).resolves.toEqual({
      status: 'started',
      planId: 403,
    });

    expect(spawnPrFixProcessMock).toHaveBeenCalledWith(403, '/tmp/primary-workspace');
    expect(isPlanLaunching('plan-start-fix')).toBe(true);
  });
});
