import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getDefaultConfig, type TimConfig } from '../configSchema.js';
import { claimAssignment, getAssignment } from './assignment.js';
import { closeDatabaseForTesting, getDatabase } from './database.js';
import {
  clearPlanBaseTracking,
  getPlanByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  setPlanBasePlan,
} from './plan.js';
import { clearPlanSyncContext, removePlanFromDb, syncPlanToDb } from './plan_sync.js';
import { getProject } from './project.js';
import { recordWorkspace } from './workspace.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadPlansFromDb } from '../plans_db.js';
import { materializePlan, syncMaterializedPlan } from '../plan_materialize.js';
import { readPlanFile, writePlanFile } from '../plans.js';

function buildTestConfig(tasksDir: string): TimConfig {
  const config = getDefaultConfig();
  return {
    ...config,
    paths: {
      ...config.paths,
      tasks: tasksDir,
    },
  };
}

describe('tim db/plan_sync', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;
  let originalCwd: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-sync-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(repoDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/sync-tests.git`.cwd(repoDir).quiet();

    originalCwd = process.cwd();
    process.chdir(repoDir);
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    closeDatabaseForTesting();
    clearPlanSyncContext();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    closeDatabaseForTesting();
    clearPlanSyncContext();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('syncPlanToDb upserts plan metadata, tasks, and references', async () => {
    const config = buildTestConfig(tasksDir);
    const plan = {
      id: 10,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Sample plan',
      goal: 'Do the thing',
      details: 'Plan sync details',
      createdAt: '2026-02-09T08:00:00.000Z',
      updatedAt: '2026-02-10T12:34:56.000Z',
      docsUpdatedAt: '2026-02-11T00:00:00.000Z',
      lessonsAppliedAt: '2026-02-12T00:00:00.000Z',
      status: 'in_progress' as const,
      priority: 'high' as const,
      simple: true,
      tdd: false,
      discoveredFrom: 5,
      issue: ['https://github.com/example/repo/issues/10'],
      pullRequest: ['https://github.com/example/repo/pull/11'],
      assignedTo: 'dimfeld',
      baseBranch: 'main',
      parent: 9,
      references: {
        '9': '99999999-9999-4999-8999-999999999999',
        '7': '77777777-7777-4777-8777-777777777777',
      },
      dependencies: [7],
      tags: ['sync', 'db'],
      tasks: [{ title: 'task one', description: 'do task one', done: true }],
    };

    await syncPlanToDb(plan, { config });

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();

    const savedPlan = getPlanByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.project_id).toBe(project?.id);
    expect(savedPlan?.plan_id).toBe(10);
    expect(savedPlan?.details).toBe('Plan sync details');
    expect(savedPlan?.simple).toBe(1);
    expect(savedPlan?.tdd).toBe(0);
    expect(savedPlan?.discovered_from).toBe(5);
    expect(savedPlan?.issue).toBe('["https://github.com/example/repo/issues/10"]');
    expect(savedPlan?.pull_request).toBe('["https://github.com/example/repo/pull/11"]');
    expect(savedPlan?.assigned_to).toBe('dimfeld');
    expect(savedPlan?.base_branch).toBe('main');
    expect(savedPlan?.parent_uuid).toBe('99999999-9999-4999-8999-999999999999');
    expect(savedPlan?.created_at).toBe('2026-02-09T08:00:00.000Z');
    expect(savedPlan?.updated_at).toBe('2026-02-10T12:34:56.000Z');
    expect(savedPlan?.docs_updated_at).toBe('2026-02-11T00:00:00.000Z');
    expect(savedPlan?.lessons_applied_at).toBe('2026-02-12T00:00:00.000Z');
    expect(getPlanTagsByUuid(db, savedPlan!.uuid).map((row) => row.tag)).toEqual(['db', 'sync']);
    expect(getPlanTasksByUuid(db, savedPlan!.uuid)).toHaveLength(1);
  });

  test('syncPlanToDb and loadPlansFromDb round-trip basePlan through UUID mapping', async () => {
    const config = buildTestConfig(tasksDir);
    const basePlanUuid = '22222222-2222-4222-8222-222222222222';
    const childPlanUuid = '33333333-3333-4333-8333-333333333333';

    await syncPlanToDb(
      {
        id: 22,
        uuid: basePlanUuid,
        title: 'Base plan',
        goal: 'Provide a predecessor branch',
        branch: 'feature/base-plan',
        tasks: [],
      },
      { config }
    );
    await syncPlanToDb(
      {
        id: 33,
        uuid: childPlanUuid,
        title: 'Child stacked plan',
        goal: 'Resolve basePlan back to numeric ID',
        basePlan: 22,
        tasks: [],
      },
      { config, idToUuid: new Map([[22, basePlanUuid]]) }
    );

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();

    const savedPlan = getPlanByUuid(db, childPlanUuid);
    expect(savedPlan?.base_plan_uuid).toBe(basePlanUuid);

    const { plans } = loadPlansFromDb(tasksDir, repository.repositoryId);
    expect(plans.get(33)?.basePlan).toBe(22);
  });

  test('setPlanBasePlan persists base_plan_uuid and clears it through the sync router', async () => {
    const config = buildTestConfig(tasksDir);
    const basePlanUuid = '44444444-4444-4444-8444-444444444444';
    const childPlanUuid = '55555555-5555-4555-8555-555555555555';

    await syncPlanToDb(
      {
        id: 44,
        uuid: basePlanUuid,
        title: 'Scalar base plan',
        goal: 'Target for setPlanBasePlan',
        tasks: [],
      },
      { config }
    );
    await syncPlanToDb(
      {
        id: 55,
        uuid: childPlanUuid,
        title: 'Scalar child plan',
        goal: 'Update basePlan through sync router',
        tasks: [],
      },
      { config }
    );

    const db = getDatabase();
    await setPlanBasePlan(db, config, childPlanUuid, basePlanUuid);
    expect(getPlanByUuid(db, childPlanUuid)?.base_plan_uuid).toBe(basePlanUuid);

    await setPlanBasePlan(db, config, childPlanUuid, null);
    expect(getPlanByUuid(db, childPlanUuid)?.base_plan_uuid).toBeNull();

    const operations = db
      .prepare('SELECT operation_type, status, payload FROM sync_operation ORDER BY local_sequence')
      .all() as Array<{
      operation_type: string;
      status: string;
      payload: string;
    }>;
    const basePlanOps = operations.filter((row) => {
      const payload = JSON.parse(row.payload) as { field?: string };
      return row.operation_type === 'plan.set_scalar' && payload.field === 'base_plan_uuid';
    });
    expect(basePlanOps.map((row) => row.status)).toEqual(['applied', 'applied']);
  });

  test('materializePlan writes basePlan to YAML frontmatter', async () => {
    const config = buildTestConfig(tasksDir);
    const basePlanUuid = '66666666-6666-4666-8666-666666666666';
    const childPlanUuid = '77777777-7777-4777-8777-777777777777';

    await syncPlanToDb(
      {
        id: 66,
        uuid: basePlanUuid,
        title: 'Materialized base plan',
        goal: 'Predecessor plan',
        tasks: [],
      },
      { config }
    );
    await syncPlanToDb(
      {
        id: 77,
        uuid: childPlanUuid,
        title: 'Materialized child plan',
        goal: 'Emit basePlan in frontmatter',
        basePlan: 66,
        tasks: [],
      },
      { config, idToUuid: new Map([[66, basePlanUuid]]) }
    );

    const planPath = await materializePlan(77, repoDir);
    const content = await fs.readFile(planPath, 'utf8');
    expect(content).toContain('basePlan: 66');

    const parsed = await readPlanFile(planPath);
    expect(parsed.basePlan).toBe(66);
  });

  test('syncMaterializedPlan applies edited basePlan from YAML back to DB', async () => {
    const config = buildTestConfig(tasksDir);
    const originalBaseUuid = '88888888-8888-4888-8888-888888888888';
    const nextBaseUuid = '99999999-9999-4999-8999-999999999999';
    const childPlanUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await syncPlanToDb(
      {
        id: 88,
        uuid: originalBaseUuid,
        title: 'Original base plan',
        goal: 'Original predecessor',
        tasks: [],
      },
      { config }
    );
    await syncPlanToDb(
      {
        id: 99,
        uuid: nextBaseUuid,
        title: 'Next base plan',
        goal: 'New predecessor',
        tasks: [],
      },
      { config }
    );
    await syncPlanToDb(
      {
        id: 100,
        uuid: childPlanUuid,
        title: 'Editable basePlan child',
        goal: 'Sync edited basePlan from materialized YAML',
        basePlan: 88,
        tasks: [],
      },
      {
        config,
        idToUuid: new Map([
          [88, originalBaseUuid],
          [99, nextBaseUuid],
        ]),
      }
    );

    const planPath = await materializePlan(100, repoDir);
    const editedPlan = await readPlanFile(planPath);
    editedPlan.basePlan = 99;
    await writePlanFile(planPath, editedPlan, { skipDb: true });

    await syncMaterializedPlan(100, repoDir, { config });

    expect(getPlanByUuid(getDatabase(), childPlanUuid)?.base_plan_uuid).toBe(nextBaseUuid);
    const reloaded = loadPlansFromDb(
      tasksDir,
      (await getRepositoryIdentity({ cwd: repoDir })).repositoryId
    );
    expect(reloaded.plans.get(100)?.basePlan).toBe(99);
  });

  test('syncPlanToDb rejects plans missing UUID identity', async () => {
    await expect(
      syncPlanToDb(
        {
          id: 44,
          title: 'No uuid',
          goal: 'Skip this',
          tasks: [],
        },
        { config: buildTestConfig(tasksDir) }
      )
    ).rejects.toThrow('Plan must have a UUID before syncing to DB');

    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) as count FROM plan').get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  test('syncPlanToDb clears branch when branch is unset', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '46464646-4646-4464-8464-464646464646';

    await syncPlanToDb(
      {
        id: 46,
        uuid: planUuid,
        title: 'Branch sync plan',
        goal: 'Verify branch sync behavior',
        branch: 'feature/branch-sync',
        tasks: [],
      },
      { config }
    );

    let savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.branch).toBe('feature/branch-sync');

    await syncPlanToDb(
      {
        id: 46,
        uuid: planUuid,
        title: 'Branch sync plan',
        goal: 'Verify branch sync behavior',
        branch: undefined,
        tasks: [],
      },
      { config }
    );

    savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.branch).toBeNull();
  });

  test('syncPlanToDb with preserveBaseTracking preserves cleared DB base fields for existing plans', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '57575757-5757-4575-8575-575757575757';

    await syncPlanToDb(
      {
        id: 57,
        uuid: planUuid,
        title: 'Base tracking sync plan',
        goal: 'Protect DB-managed base fields',
        baseBranch: 'feature/base',
        baseCommit: 'abcdef1234567890',
        baseChangeId: 'zzzzzzzzzzzz',
        tasks: [],
      },
      { config }
    );

    await clearPlanBaseTracking(getDatabase(), config, planUuid);

    // Simulate stale plan file values — all three should be preserved as null from DB.
    await syncPlanToDb(
      {
        id: 57,
        uuid: planUuid,
        title: 'Base tracking sync plan',
        goal: 'Protect DB-managed base fields',
        baseBranch: 'feature/base',
        baseCommit: 'abcdef1234567890',
        baseChangeId: 'zzzzzzzzzzzz',
        tasks: [],
      },
      { config, preserveBaseTracking: true }
    );

    const savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.base_branch).toBeNull();
    expect(savedPlan?.base_commit).toBeNull();
    expect(savedPlan?.base_change_id).toBeNull();
  });

  test('syncPlanToDb with preserveBaseTracking strips baseCommit/baseChangeId on first import', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '63636363-6363-4636-8636-636363636363';

    await syncPlanToDb(
      {
        id: 63,
        uuid: planUuid,
        title: 'New plan with base tracking',
        goal: 'Initial import from file',
        baseBranch: 'feature/parent-branch',
        baseCommit: 'deadbeef12345678',
        baseChangeId: 'initialchangeid',
        tasks: [],
      },
      { config, preserveBaseTracking: true }
    );

    const savedPlan = getPlanByUuid(getDatabase(), planUuid);
    // baseBranch is imported from file for new plans (user-settable).
    expect(savedPlan?.base_branch).toBe('feature/parent-branch');
    // baseCommit and baseChangeId are machine-managed — never imported from file.
    expect(savedPlan?.base_commit).toBeNull();
    expect(savedPlan?.base_change_id).toBeNull();
  });

  test('syncPlanToDb with preserveBaseTracking preserves non-null DB base fields over stale file values', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '74747474-7474-4747-8747-474747474747';

    await syncPlanToDb(
      {
        id: 74,
        uuid: planUuid,
        title: 'Stale file base tracking plan',
        goal: 'DB base values should win over stale file',
        baseBranch: 'feature/db-branch',
        baseCommit: 'db-commit-hash',
        baseChangeId: 'db-change-id',
        tasks: [],
      },
      { config }
    );

    // Simulate the DB being updated via setPlanBaseTracking with different values.
    const db = getDatabase();
    db.prepare('UPDATE plan SET base_branch=?, base_commit=?, base_change_id=? WHERE uuid=?').run(
      'feature/newer-branch',
      'newer-commit-hash',
      'newer-change-id',
      planUuid
    );

    // Sync with stale file values — all base fields from DB should be preserved.
    await syncPlanToDb(
      {
        id: 74,
        uuid: planUuid,
        title: 'Stale file base tracking plan',
        goal: 'DB base values should win over stale file',
        baseBranch: 'feature/db-branch',
        baseCommit: 'db-commit-hash',
        baseChangeId: 'db-change-id',
        tasks: [],
      },
      { config, preserveBaseTracking: true }
    );

    const savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.base_branch).toBe('feature/newer-branch');
    expect(savedPlan?.base_commit).toBe('newer-commit-hash');
    expect(savedPlan?.base_change_id).toBe('newer-change-id');
  });

  test('syncPlanToDb without preserveBaseTracking syncs baseBranch from file but protects baseCommit/baseChangeId', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '68686868-6868-4686-8686-686868686868';

    await syncPlanToDb(
      {
        id: 68,
        uuid: planUuid,
        title: 'Materialized plan sync',
        goal: 'baseBranch syncs from file, machine-managed fields preserved',
        baseBranch: 'feature/old-base',
        tasks: [],
      },
      { config }
    );

    // Simulate DB being updated by workspace setup with tracking data.
    const db = getDatabase();
    db.prepare('UPDATE plan SET base_commit=?, base_change_id=? WHERE uuid=?').run(
      'db-commit',
      'db-change-id',
      planUuid
    );

    // Without preserveBaseTracking, baseBranch syncs from file normally,
    // but baseCommit/baseChangeId are always DB-managed and preserved.
    await syncPlanToDb(
      {
        id: 68,
        uuid: planUuid,
        title: 'Materialized plan sync',
        goal: 'baseBranch syncs from file, machine-managed fields preserved',
        baseBranch: 'feature/new-base',
        baseCommit: 'stale-file-commit',
        baseChangeId: 'stale-file-change-id',
        tasks: [],
      },
      { config }
    );

    const savedPlan = getPlanByUuid(getDatabase(), planUuid);
    // baseBranch syncs from file (user-editable, no preserveBaseTracking flag).
    expect(savedPlan?.base_branch).toBe('feature/new-base');
    // baseCommit/baseChangeId are always DB-managed — DB values preserved.
    expect(savedPlan?.base_commit).toBe('db-commit');
    expect(savedPlan?.base_change_id).toBe('db-change-id');
  });

  test('syncPlanToDb still syncs non-base-tracking fields normally with preserveBaseTracking', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '85858585-8585-4858-8858-858585858585';

    await syncPlanToDb(
      {
        id: 85,
        uuid: planUuid,
        title: 'Original title',
        goal: 'Original goal',
        status: 'in_progress' as const,
        branch: 'feature/original-branch',
        tasks: [],
      },
      { config }
    );

    let savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.title).toBe('Original title');
    expect(savedPlan?.status).toBe('in_progress');
    expect(savedPlan?.branch).toBe('feature/original-branch');

    // Sync with updated non-base-tracking fields (with preserveBaseTracking enabled).
    await syncPlanToDb(
      {
        id: 85,
        uuid: planUuid,
        title: 'Updated title',
        goal: 'Updated goal',
        status: 'needs_review' as const,
        branch: 'feature/updated-branch',
        tasks: [
          {
            title: 'new task',
            description: 'new task description',
            done: false,
          },
        ],
      },
      { config, preserveBaseTracking: true }
    );

    savedPlan = getPlanByUuid(getDatabase(), planUuid);
    expect(savedPlan?.title).toBe('Updated title');
    expect(savedPlan?.goal).toBe('Updated goal');
    expect(savedPlan?.status).toBe('needs_review');
    expect(savedPlan?.branch).toBe('feature/updated-branch');
  });

  test('syncPlanToDb preserves explicit new task UUIDs inserted at existing indexes', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = '96969696-9696-4696-8696-969696969696';
    const originalTaskUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const insertedTaskUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    await syncPlanToDb(
      {
        id: 96,
        uuid: planUuid,
        title: 'Task identity plan',
        goal: 'Preserve inserted task identity',
        tasks: [
          {
            uuid: originalTaskUuid,
            title: 'old task',
            description: 'old description',
            done: false,
          },
        ],
      },
      { config }
    );

    await syncPlanToDb(
      {
        id: 96,
        uuid: planUuid,
        title: 'Task identity plan',
        goal: 'Preserve inserted task identity',
        tasks: [
          {
            uuid: insertedTaskUuid,
            title: 'new task',
            description: 'new description',
            done: false,
          },
          {
            uuid: originalTaskUuid,
            title: 'old task',
            description: 'old description',
            done: false,
          },
        ],
      },
      { config }
    );

    const tasks = getPlanTasksByUuid(getDatabase(), planUuid);
    expect(tasks.map((task) => ({ title: task.title, uuid: task.uuid }))).toEqual([
      { title: 'new task', uuid: insertedTaskUuid },
      { title: 'old task', uuid: originalTaskUuid },
    ]);
  });

  test('removePlanFromDb removes the plan and its assignment', async () => {
    const config = buildTestConfig(tasksDir);
    const planUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    await syncPlanToDb(
      {
        id: 12,
        uuid: planUuid,
        title: 'Assigned plan',
        goal: 'To be deleted',
        tasks: [],
      },
      { config }
    );

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const project = getProject(getDatabase(), repository.repositoryId);
    expect(project).not.toBeNull();
    const workspace = recordWorkspace(getDatabase(), {
      projectId: project!.id,
      taskId: 'assigned-plan',
      workspacePath: repoDir,
    });
    claimAssignment(getDatabase(), project!.id, planUuid, 12, workspace.id, 'dimfeld');
    expect(getAssignment(getDatabase(), project!.id, planUuid)).not.toBeNull();

    await removePlanFromDb(planUuid, {
      config,
      cwdForIdentity: repoDir,
      throwOnError: true,
    });

    expect(getPlanByUuid(getDatabase(), planUuid)).toBeNull();
    expect(getAssignment(getDatabase(), project!.id, planUuid)).toBeNull();
  });

  test('legacy direct helpers reject synced write modes', async () => {
    const config = {
      ...buildTestConfig(tasksDir),
      sync: { role: 'persistent', nodeId: 'persistent-node' },
    } as TimConfig;

    await expect(
      syncPlanToDb(
        {
          id: 13,
          uuid: '13131313-1313-4313-8313-131313131313',
          title: 'Must be routed',
          goal: 'Do not bypass the queue',
          tasks: [],
        },
        { config, cwdForIdentity: repoDir, throwOnError: true }
      )
    ).rejects.toThrow('Legacy direct plan DB helpers cannot write in sync-persistent mode');
  });
});
