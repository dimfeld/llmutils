import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { upsertPlan, upsertPlanTasks } from '$tim/db/plan.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

describe('plan_task_counts remote function', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-task-counts-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const project = getOrCreateProject(currentDb, 'repo-plan-task-counts-remote');

    upsertPlan(currentDb, project.id, {
      uuid: 'plan-with-tasks',
      planId: 1,
      title: 'Plan with tasks',
      filename: '1.plan.md',
    });
    upsertPlanTasks(currentDb, 'plan-with-tasks', [
      { title: 'done task', done: true, description: 'complete this' },
      { title: 'todo task', done: false, description: 'finish this' },
      { title: 'second done task', done: true, description: 'also complete this' },
    ]);

    upsertPlan(currentDb, project.id, {
      uuid: 'plan-without-tasks',
      planId: 2,
      title: 'Plan without tasks',
      filename: '2.plan.md',
    });
  });

  afterEach(() => {
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('returns completed and total counts for a plan', async () => {
    const { getPlanTaskCounts } = await import('./plan_task_counts.remote.js');

    await expect(invokeQuery(getPlanTaskCounts, { planUuid: 'plan-with-tasks' })).resolves.toEqual({
      done: 2,
      total: 3,
    });
  });

  test('returns zero counts for a plan without tasks', async () => {
    const { getPlanTaskCounts } = await import('./plan_task_counts.remote.js');

    await expect(
      invokeQuery(getPlanTaskCounts, { planUuid: 'plan-without-tasks' })
    ).resolves.toEqual({
      done: 0,
      total: 0,
    });
  });

  test('throws 404 for an unknown plan', async () => {
    const { getPlanTaskCounts } = await import('./plan_task_counts.remote.js');

    await expect(
      invokeQuery(getPlanTaskCounts, { planUuid: 'missing-plan' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });
});
