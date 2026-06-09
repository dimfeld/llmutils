import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { clearConfigCache } from '$tim/configLoader.js';
import { importAssignment } from '$tim/db/assignment.js';
import { openDatabase } from '$tim/db/database.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  upsertPlanDependencies,
  nonSyncedUpsertPlan,
} from '$tim/db/plan.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

describe('plan metadata remote commands', () => {
  let tempDir: string;
  let projectRoot: string;
  let projectId: number;
  const parentUuid = '11111111-1111-4111-8111-111111111111';
  const basePlanUuid = '22222222-2222-4222-8222-222222222222';
  const dependencyUuid = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    clearConfigCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-metadata-remote-test-'));
    projectRoot = path.join(tempDir, 'repo');
    await fs.mkdir(path.join(projectRoot, '.tim', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(projectRoot, '.tim', 'config', 'tim.yml'),
      ['tags:', '  allowed:', '    - backend', '    - remote', '    - web', ''].join('\n')
    );

    currentDb = openDatabase(':memory:');
    projectId = getOrCreateProject(currentDb, 'repo-plan-metadata-remote', {
      lastGitRoot: projectRoot,
    }).id;
    seedPlan(parentUuid, 10, 'Parent plan');
    seedPlan(basePlanUuid, 11, 'Base plan');
    seedPlan(dependencyUuid, 12, 'Dependency plan');
  });

  afterEach(async () => {
    clearConfigCache();
    currentDb.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates a plan through the remote command', async () => {
    const { createPlan } = await import('./plan_metadata.remote.js');

    const result = await invokeCommand(createPlan, {
      projectId,
      title: 'Remote-created plan',
      priority: 'urgent',
      status: 'needs_review',
      simple: true,
    });

    expect(result).toMatchObject({ projectId, planId: 13 });
    expect(getPlanByUuid(currentDb, result.planUuid)).toMatchObject({
      title: 'Remote-created plan',
      priority: 'urgent',
      status: 'needs_review',
      simple: 1,
    });
    expect(syncOperationRows()).toEqual([{ operation_type: 'plan.create', status: 'applied' }]);
  });

  test('creates relationship metadata through the remote command', async () => {
    const { createPlan } = await import('./plan_metadata.remote.js');

    const result = await invokeCommand(createPlan, {
      projectId,
      title: 'Remote child plan',
      tags: [' Web ', 'backend', 'web'],
      parentUuid,
      basePlanUuid,
      dependencyUuids: [dependencyUuid, dependencyUuid],
    });

    expect(getPlanByUuid(currentDb, result.planUuid)).toMatchObject({
      title: 'Remote child plan',
      parent_uuid: parentUuid,
      base_plan_uuid: basePlanUuid,
    });
    expect(getPlanTagsByUuid(currentDb, result.planUuid).map((tag) => tag.tag)).toEqual([
      'backend',
      'web',
    ]);
    expect(
      getPlanDependenciesByUuid(currentDb, result.planUuid).map(
        (dependency) => dependency.depends_on_uuid
      )
    ).toEqual([dependencyUuid]);
    expect(
      getPlanDependenciesByUuid(currentDb, parentUuid).map(
        (dependency) => dependency.depends_on_uuid
      )
    ).toContain(result.planUuid);
  });

  test('surfaces validation failures from the service', async () => {
    const { createPlan } = await import('./plan_metadata.remote.js');

    await expect(
      invokeCommand(createPlan, {
        projectId,
        title: 'Remote invalid status',
        status: 'blocked',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'validation_failed',
        field: 'status',
      },
    });
  });

  test('returns structured validation errors for invalid tags', async () => {
    const { createPlan } = await import('./plan_metadata.remote.js');

    await expect(
      invokeCommand(createPlan, {
        projectId,
        title: 'Remote invalid tag',
        tags: ['blocked'],
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'validation_failed',
        field: 'tags',
        message: expect.stringContaining('Invalid tag: blocked'),
      },
    });
  });

  test('updates metadata through the remote command', async () => {
    const { updatePlanMetadata } = await import('./plan_metadata.remote.js');

    const targetUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    seedPlan(targetUuid, 13, 'Remote target');
    upsertPlanDependencies(currentDb, targetUuid, [dependencyUuid]);

    const result = await invokeCommand(updatePlanMetadata, {
      projectId: 'all',
      planUuid: targetUuid,
      title: 'Remote updated target',
      status: 'in_progress',
      tags: [' Remote ', 'backend', 'remote'],
      parentUuid,
      basePlanUuid,
      dependencyUuids: [],
    });

    expect(result).toEqual({ planUuid: targetUuid });
    expect(getPlanByUuid(currentDb, targetUuid)).toMatchObject({
      title: 'Remote updated target',
      status: 'in_progress',
      parent_uuid: parentUuid,
      base_plan_uuid: basePlanUuid,
    });
    expect(getPlanTagsByUuid(currentDb, targetUuid).map((tag) => tag.tag)).toEqual([
      'backend',
      'remote',
    ]);
    expect(getPlanDependenciesByUuid(currentDb, targetUuid)).toEqual([]);
  });

  test('surfaces update validation failures from the service', async () => {
    const { updatePlanMetadata } = await import('./plan_metadata.remote.js');

    await expect(
      invokeCommand(updatePlanMetadata, {
        projectId,
        planUuid: parentUuid,
        status: 'recently_done',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'validation_failed',
        field: 'status',
      },
    });
  });

  test('returns structured invalid reference errors from update', async () => {
    const { updatePlanMetadata } = await import('./plan_metadata.remote.js');

    await expect(
      invokeCommand(updatePlanMetadata, {
        projectId,
        planUuid: parentUuid,
        basePlanUuid: '99999999-9999-4999-8999-999999999999',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'invalid_reference',
        field: 'basePlanUuid',
      },
    });
  });

  test('returns structured cycle errors from rejected sync writes', async () => {
    const { updatePlanMetadata } = await import('./plan_metadata.remote.js');

    const targetUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const cycleDependencyUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    seedPlan(targetUuid, 13, 'Remote cycle target');
    seedPlan(cycleDependencyUuid, 14, 'Remote cycle dependency');
    upsertPlanDependencies(currentDb, cycleDependencyUuid, [targetUuid]);

    await expect(
      invokeCommand(updatePlanMetadata, {
        projectId,
        planUuid: targetUuid,
        dependencyUuids: [cycleDependencyUuid],
      })
    ).rejects.toMatchObject({
      status: 409,
      body: {
        kind: 'cycle_detected',
        message: expect.stringMatching(/cycle/i),
      },
    });
  });

  test('runs status side effects through the remote update command', async () => {
    const { updatePlanMetadata } = await import('./plan_metadata.remote.js');

    const cascadeParentUuid = '44444444-4444-4444-8444-444444444444';
    const cascadeChildUuid = '55555555-5555-4555-8555-555555555555';
    nonSyncedUpsertPlan(currentDb, projectId, {
      uuid: cascadeParentUuid,
      planId: 13,
      title: 'Remote cascade parent',
      status: 'pending',
      priority: 'medium',
      epic: true,
    });
    nonSyncedUpsertPlan(currentDb, projectId, {
      uuid: cascadeChildUuid,
      planId: 14,
      title: 'Remote cascade child',
      status: 'pending',
      priority: 'medium',
      parentUuid: cascadeParentUuid,
    });
    upsertPlanDependencies(currentDb, cascadeParentUuid, [cascadeChildUuid]);
    importAssignment(
      currentDb,
      projectId,
      cascadeChildUuid,
      14,
      null,
      'dimfeld',
      'in_progress',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    await invokeCommand(updatePlanMetadata, {
      projectId,
      planUuid: cascadeChildUuid,
      status: 'done',
    });

    expect(getPlanByUuid(currentDb, cascadeChildUuid)?.status).toBe('done');
    expect(getPlanByUuid(currentDb, cascadeParentUuid)?.status).toBe('needs_review');
    expect(assignmentCount(cascadeChildUuid)).toBe(0);
    expect(syncOperationRows().map((row) => row.operation_type)).toEqual([
      'plan.set_scalar',
      'plan.set_scalar',
    ]);
  });

  test('rejects all-project creation through the remote command', async () => {
    const { createPlan } = await import('./plan_metadata.remote.js');

    await expect(
      invokeCommand(createPlan, {
        projectId: 'all',
        title: 'Remote all-project plan',
      })
    ).rejects.toMatchObject({
      status: 400,
      body: {
        kind: 'validation_failed',
        field: 'projectId',
      },
    });
    expect(syncOperationRows()).toEqual([]);
  });

  test('returns structured persistence errors from rejected writes', async () => {
    vi.resetModules();
    vi.doMock('$lib/server/plan_metadata.js', async () => {
      const { SyncWriteRejectedError } = await import('$tim/sync/errors.js');
      return {
        createPlanFromWeb: async () => {
          throw new SyncWriteRejectedError('Could not persist plan metadata', {
            operationUuid: 'operation-persistence-failure',
            targetKey: 'plan:plan-persistence-failure',
            reason: 'disk write failed',
          });
        },
        updatePlanMetadataFromWeb: async () => {
          throw new Error('unexpected update call');
        },
      };
    });

    try {
      const { createPlan } = await import('./plan_metadata.remote.js');

      await expect(
        invokeCommand(createPlan, {
          projectId,
          title: 'Remote persistence failure',
        })
      ).rejects.toMatchObject({
        status: 500,
        body: {
          kind: 'persistence_failed',
          message: 'disk write failed',
        },
      });
    } finally {
      vi.doUnmock('$lib/server/plan_metadata.js');
      vi.resetModules();
    }
  });

  test('returns structured sync conflict errors from remote commands', async () => {
    vi.resetModules();
    vi.doMock('$lib/server/plan_metadata.js', async () => {
      const { SyncWriteConflictError } = await import('$tim/sync/errors.js');
      return {
        createPlanFromWeb: async () => {
          throw new SyncWriteConflictError('Plan metadata conflict', {
            operationUuid: 'operation-sync-conflict',
            targetKey: 'plan:plan-sync-conflict',
            fieldPath: 'title',
          });
        },
        updatePlanMetadataFromWeb: async () => {
          throw new Error('unexpected update call');
        },
      };
    });

    try {
      const { createPlan } = await import('./plan_metadata.remote.js');

      await expect(
        invokeCommand(createPlan, {
          projectId,
          title: 'Remote conflict failure',
        })
      ).rejects.toMatchObject({
        status: 409,
        body: {
          kind: 'sync_conflict',
          message: 'Plan metadata conflict',
          field: 'title',
        },
      });
    } finally {
      vi.doUnmock('$lib/server/plan_metadata.js');
      vi.resetModules();
    }
  });

  function seedPlan(uuid: string, planId: number, title: string): void {
    nonSyncedUpsertPlan(currentDb, projectId, {
      uuid,
      planId,
      title,
      status: 'pending',
      priority: 'medium',
    });
  }

  function syncOperationRows(): Array<{ operation_type: string; status: string }> {
    return currentDb
      .query<{ operation_type: string; status: string }, []>(
        'SELECT operation_type, status FROM sync_operation ORDER BY local_sequence'
      )
      .all();
  }

  function assignmentCount(uuid: string): number {
    const row = currentDb
      .query<{ count: number }, [string]>(
        'SELECT COUNT(*) AS count FROM assignment WHERE plan_uuid = ?'
      )
      .get(uuid);
    return row?.count ?? 0;
  }
});
