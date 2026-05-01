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
} from './plan.js';
import { clearPlanSyncContext, removePlanFromDb, syncPlanToDb } from './plan_sync.js';
import { getProject } from './project.js';
import { recordWorkspace } from './workspace.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

function buildTestConfig(tasksDir: string): TimConfig {
  const config = getDefaultConfig();
  return {
    ...config,
    paths: {
      ...(config.paths ?? {}),
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
    const count = db.prepare('SELECT COUNT(*) as count FROM plan').get() as { count: number };
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

    clearPlanBaseTracking(getDatabase(), planUuid);

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
        tasks: [{ title: 'new task', description: 'new task description', done: false }],
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

    await removePlanFromDb(planUuid, { config, cwdForIdentity: repoDir, throwOnError: true });

    expect(getPlanByUuid(getDatabase(), planUuid)).toBeNull();
    expect(getAssignment(getDatabase(), project!.id, planUuid)).toBeNull();
  });
});
