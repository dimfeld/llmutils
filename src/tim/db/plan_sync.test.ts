import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getDefaultConfig, type TimConfig } from '../configSchema.js';
import { claimAssignment, getAssignment } from './assignment.js';
import { closeDatabaseForTesting, getDatabase } from './database.js';
import { getPlanByUuid, getPlanTagsByUuid, getPlanTasksByUuid } from './plan.js';
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

  test('syncPlanToDb ignores plans without UUID', async () => {
    await syncPlanToDb(
      {
        id: 44,
        title: 'No uuid',
        goal: 'Skip this',
        tasks: [],
      },
      { config: buildTestConfig(tasksDir) }
    );

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
