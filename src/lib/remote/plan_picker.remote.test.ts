import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeQuery } from '$lib/test-utils/invoke_command.js';
import { openDatabase } from '$tim/db/database.js';
import { nonSyncedUpsertPlan } from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

describe('plan picker remote query', () => {
  let projectId: number;
  let otherProjectId: number;

  beforeEach(() => {
    currentDb = openDatabase(':memory:');
    projectId = getOrCreateProject(currentDb, 'repo-plan-picker-remote').id;
    otherProjectId = getOrCreateProject(currentDb, 'repo-plan-picker-remote-other').id;
    nonSyncedUpsertPlan(currentDb, projectId, {
      uuid: 'plan-picker-remote',
      planId: 42,
      title: 'Remote picker metadata search',
      status: 'pending',
      priority: 'medium',
    });
    nonSyncedUpsertPlan(currentDb, otherProjectId, {
      uuid: 'plan-picker-remote-other-project',
      planId: 42,
      title: 'Remote picker other project',
      status: 'pending',
      priority: 'medium',
    });
  });

  afterEach(() => {
    currentDb.close(false);
  });

  test('returns narrow picker options through the remote query', async () => {
    const { searchPlanPicker } = await import('./plan_picker.remote.js');

    const result = await invokeQuery(searchPlanPicker, {
      projectId,
      query: 'Remote picker',
      relation: 'basePlan',
    });

    expect(result).toEqual([
      {
        uuid: 'plan-picker-remote',
        projectId,
        planId: 42,
        title: 'Remote picker metadata search',
        status: 'pending',
        priority: 'medium',
        parentUuid: null,
        basePlanUuid: null,
      },
    ]);
  });

  test('validates relation values at the remote boundary', async () => {
    const { searchPlanPicker } = await import('./plan_picker.remote.js');

    await expect(
      invokeQuery(searchPlanPicker, {
        projectId,
        query: 'Remote picker',
        relation: 'child',
      } as never)
    ).rejects.toBeDefined();
  });

  test('validates limit bounds at the remote boundary', async () => {
    const { searchPlanPicker } = await import('./plan_picker.remote.js');

    await expect(
      invokeQuery(searchPlanPicker, {
        projectId,
        query: 'Remote picker',
        relation: 'basePlan',
        limit: 51,
      })
    ).rejects.toBeDefined();
  });

  test('returns structured errors for unknown projects', async () => {
    const { searchPlanPicker } = await import('./plan_picker.remote.js');

    await expect(
      invokeQuery(searchPlanPicker, {
        projectId: 999_999,
        query: 'Remote picker',
        relation: 'basePlan',
      })
    ).rejects.toMatchObject({
      status: 404,
      body: {
        kind: 'not_found',
        field: 'projectId',
      },
    });
  });

  test('returns structured errors for current-plan project mismatches', async () => {
    const { searchPlanPicker } = await import('./plan_picker.remote.js');

    await expect(
      invokeQuery(searchPlanPicker, {
        projectId,
        query: 'Remote picker',
        relation: 'dependency',
        currentPlanUuid: 'plan-picker-remote-other-project',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'project_mismatch',
        field: 'currentPlanUuid',
      },
    });
  });
});
