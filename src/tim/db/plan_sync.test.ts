import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { runWithLogger, type LoggerAdapter } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getDefaultConfig, type TimConfig } from '../configSchema.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import { claimAssignment, getAssignment } from './assignment.js';
import { closeDatabaseForTesting, getDatabase } from './database.js';
import { getPlanByUuid, getPlanTagsByUuid, getPlanTasksByUuid, upsertPlan } from './plan.js';
import {
  clearPlanSyncContext,
  removePlanFromDb,
  syncAllPlansToDb,
  syncPlanToDb,
} from './plan_sync.js';
import { getOrCreateProject, getProject } from './project.js';

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
  let tasksDir: string;
  let originalXdgConfigHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-sync-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tempDir;

    closeDatabaseForTesting();
    clearPlanSyncContext();
    clearPlanCache();
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
    clearPlanCache();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  class CaptureWarnAdapter implements LoggerAdapter {
    public readonly warns: string[] = [];
    log(): void {}
    error(): void {}
    warn(...args: any[]): void {
      this.warns.push(args.map((arg) => String(arg)).join(' '));
    }
    writeStdout(): void {}
    writeStderr(): void {}
    debugLog(): void {}
    sendStructured(): void {}
  }

  test('syncPlanToDb upserts plan metadata, tasks, and references', async () => {
    const config = buildTestConfig(tasksDir);
    const planFile = path.join(tasksDir, '10-sample.plan.md');
    const plan = {
      id: 10,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Sample plan',
      goal: 'Do the thing',
      details: 'Plan sync details',
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

    await syncPlanToDb(plan, planFile, { config });

    const repository = await getRepositoryIdentity();
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
    expect(savedPlan?.filename).toBe('10-sample.plan.md');
    const savedTags = getPlanTagsByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(savedTags.map((row) => row.tag)).toEqual(['db', 'sync']);

    const savedTasks = getPlanTasksByUuid(db, '11111111-1111-4111-8111-111111111111');
    expect(savedTasks).toHaveLength(1);
    expect(savedTasks[0]?.title).toBe('task one');
    expect(savedTasks[0]?.done).toBe(1);

    const deps = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all('11111111-1111-4111-8111-111111111111') as Array<{ depends_on_uuid: string }>;
    expect(deps.map((entry) => entry.depends_on_uuid)).toEqual([
      '77777777-7777-4777-8777-777777777777',
    ]);
  });

  test('syncPlanToDb ignores plans without UUID', async () => {
    const config = buildTestConfig(tasksDir);
    const planFile = path.join(tasksDir, 'no-uuid.plan.md');
    await syncPlanToDb(
      {
        id: 44,
        title: 'No uuid',
        goal: 'Skip this',
        tasks: [],
      },
      planFile,
      { config }
    );

    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) as count FROM plan').get() as { count: number };
    expect(count.count).toBe(0);
  });

  test('syncPlanToDb persists branch and clears it when branch is unset', async () => {
    const config = buildTestConfig(tasksDir);
    const planFile = path.join(tasksDir, '46-branch-sync.plan.md');
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
      planFile,
      { config }
    );

    const db = getDatabase();
    let savedPlan = getPlanByUuid(db, planUuid);
    expect(savedPlan).not.toBeNull();
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
      planFile,
      { config }
    );

    savedPlan = getPlanByUuid(db, planUuid);
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.branch).toBeNull();
  });

  test('syncPlanToDb gracefully handles unavailable database path', async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();

    const badConfigRoot = path.join(tempDir, 'xdg-config-file');
    await fs.writeFile(badConfigRoot, 'not a directory');

    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = badConfigRoot;

      await expect(
        syncPlanToDb(
          {
            id: 45,
            uuid: '45454545-4545-4454-8454-454545454545',
            title: 'DB unavailable',
            goal: 'Should not throw',
            tasks: [],
          },
          path.join(tasksDir, '45-db-unavailable.plan.md'),
          { config: buildTestConfig(tasksDir) }
        )
      ).resolves.toBeUndefined();

      process.env.XDG_CONFIG_HOME = tempDir;
      clearPlanSyncContext();
      closeDatabaseForTesting();

      const repository = await getRepositoryIdentity();
      const db = getDatabase();
      const project = getProject(db, repository.repositoryId);
      if (project) {
        expect(getPlanByUuid(db, '45454545-4545-4454-8454-454545454545')).toBeNull();
      }
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
    }
  });

  test('syncAllPlansToDb syncs disk plans and prunes stale DB rows with assignments', async () => {
    const config = buildTestConfig(tasksDir);

    await writePlanFile(path.join(tasksDir, '1-parent.plan.md'), {
      id: 1,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Parent',
      goal: 'Parent goal',
      tasks: [{ title: 'parent task', description: 'parent task', done: false }],
    });

    await writePlanFile(path.join(tasksDir, '2-child.plan.md'), {
      id: 2,
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Child',
      goal: 'Child goal',
      parent: 1,
      references: {
        '1': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      dependencies: [1],
      tasks: [{ title: 'child task', description: 'child task', done: false }],
    });

    await syncPlanToDb(
      {
        id: 1,
        uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        title: 'Parent',
        goal: 'Parent goal',
        tasks: [],
      },
      path.join(tasksDir, '1-parent.plan.md'),
      { config }
    );

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const projectId = project!.id;

    upsertPlan(db, projectId, {
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      planId: 999,
      title: 'Stale plan',
      goal: 'Should be pruned',
      filename: '999-stale.plan.md',
    });
    claimAssignment(db, projectId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 999, null, 'test-user');

    const result = await syncAllPlansToDb(projectId, tasksDir, { prune: true });
    expect(result.synced).toBe(2);
    expect(result.pruned).toBe(1);
    expect(result.errors).toBe(0);

    expect(getPlanByUuid(db, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).not.toBeNull();
    expect(getPlanByUuid(db, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).not.toBeNull();
    expect(getPlanByUuid(db, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBeNull();
    expect(getAssignment(db, projectId, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toBeNull();
  });

  test('removePlanFromDb deletes plan row and assignment row', async () => {
    const config = buildTestConfig(tasksDir);
    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    upsertPlan(db, projectId, {
      uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      planId: 4,
      title: 'To remove',
      filename: '4-remove.plan.md',
    });
    claimAssignment(db, projectId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 4, null, 'test-user');

    await removePlanFromDb('dddddddd-dddd-4ddd-8ddd-dddddddddddd', { config });

    expect(getPlanByUuid(db, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBeNull();
    expect(getAssignment(db, projectId, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBeNull();
  });

  test('removePlanFromDb returns early for undefined planUuid', async () => {
    await expect(removePlanFromDb(undefined)).resolves.toBeUndefined();
  });

  test('removePlanFromDb catches errors and warns instead of throwing', async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();

    const badConfigRoot = path.join(tempDir, 'xdg-config-file');
    await fs.writeFile(badConfigRoot, 'not a directory');

    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = badConfigRoot;
      const adapter = new CaptureWarnAdapter();

      await runWithLogger(adapter, async () => {
        await expect(
          removePlanFromDb('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', {
            config: buildTestConfig(tasksDir),
          })
        ).resolves.toBeUndefined();
      });

      expect(
        adapter.warns.some((line) =>
          line.includes('Failed to remove plan eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee from SQLite')
        )
      ).toBe(true);
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
    }
  });

  test('syncAllPlansToDb syncs duplicate numeric IDs with different UUIDs', async () => {
    const planAPath = path.join(tasksDir, '5-dup-a.plan.md');
    const planBPath = path.join(tasksDir, '5-dup-b.plan.md');

    await writePlanFile(planAPath, {
      id: 5,
      uuid: 'f1111111-1111-4111-8111-111111111111',
      title: 'Duplicate ID A',
      goal: 'First duplicate',
      tasks: [],
    });
    await writePlanFile(planBPath, {
      id: 5,
      uuid: 'f2222222-2222-4222-8222-222222222222',
      title: 'Duplicate ID B',
      goal: 'Second duplicate',
      tasks: [],
    });

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    const result = await syncAllPlansToDb(projectId, tasksDir, { prune: false });
    expect(result.synced).toBe(2);
    expect(result.errors).toBe(0);

    expect(getPlanByUuid(db, 'f1111111-1111-4111-8111-111111111111')).not.toBeNull();
    expect(getPlanByUuid(db, 'f2222222-2222-4222-8222-222222222222')).not.toBeNull();
  });

  test('syncAllPlansToDb prune does not falsely remove plans with duplicate numeric IDs', async () => {
    const planAPath = path.join(tasksDir, '6-dup-a.plan.md');
    const planBPath = path.join(tasksDir, '6-dup-b.plan.md');

    await writePlanFile(planAPath, {
      id: 6,
      uuid: 'f3333333-3333-4333-8333-333333333333',
      title: 'Duplicate prune A',
      goal: 'First duplicate',
      tasks: [],
    });
    await writePlanFile(planBPath, {
      id: 6,
      uuid: 'f4444444-4444-4444-8444-444444444444',
      title: 'Duplicate prune B',
      goal: 'Second duplicate',
      tasks: [],
    });

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    const firstSync = await syncAllPlansToDb(projectId, tasksDir, { prune: true });
    expect(firstSync.synced).toBe(2);
    expect(firstSync.pruned).toBe(0);
    expect(firstSync.errors).toBe(0);

    const secondSync = await syncAllPlansToDb(projectId, tasksDir, { prune: true });
    expect(secondSync.synced).toBe(2);
    expect(secondSync.pruned).toBe(0);
    expect(secondSync.errors).toBe(0);

    expect(getPlanByUuid(db, 'f3333333-3333-4333-8333-333333333333')).not.toBeNull();
    expect(getPlanByUuid(db, 'f4444444-4444-4444-8444-444444444444')).not.toBeNull();
  });

  test('syncPlanToDb deduplicates dependency UUIDs resolved from references', async () => {
    const config = buildTestConfig(tasksDir);
    const planFile = path.join(tasksDir, '7-duplicate-deps.plan.md');
    const planUuid = 'f5555555-5555-4555-8555-555555555555';
    const dependencyUuid = 'f6666666-6666-4666-8666-666666666666';

    await syncPlanToDb(
      {
        id: 7,
        uuid: planUuid,
        title: 'Duplicate dependency refs',
        goal: 'No duplicate dependency rows',
        references: {
          '11': dependencyUuid,
          '12': dependencyUuid,
        },
        dependencies: [11, 12],
        tasks: [],
      },
      planFile,
      { config }
    );

    const db = getDatabase();
    const deps = db
      .prepare(
        'SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ? ORDER BY depends_on_uuid'
      )
      .all(planUuid) as Array<{ depends_on_uuid: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_uuid).toBe(dependencyUuid);
  });

  test('syncPlanToDb resolves parent and dependencies from on-disk plans when references are missing', async () => {
    const config = buildTestConfig(tasksDir);
    const parentUuid = 'f7777777-7777-4777-8777-777777777777';
    const childUuid = 'f8888888-8888-4888-8888-888888888888';

    await writePlanFile(path.join(tasksDir, '9-parent.plan.md'), {
      id: 9,
      uuid: parentUuid,
      title: 'Fallback parent',
      goal: 'Provide UUID lookup for child',
      tasks: [],
    });
    clearPlanSyncContext();

    await syncPlanToDb(
      {
        id: 10,
        uuid: childUuid,
        title: 'Fallback child',
        goal: 'Resolve parent/dependency from disk map',
        parent: 9,
        dependencies: [9],
        tasks: [],
      },
      path.join(tasksDir, '10-child.plan.md'),
      { config }
    );

    const db = getDatabase();
    const savedPlan = getPlanByUuid(db, childUuid);
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.parent_uuid).toBe(parentUuid);

    const deps = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all(childUuid) as Array<{ depends_on_uuid: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_uuid).toBe(parentUuid);
  });

  test('syncPlanToDb keeps repository identity from git cwd when plan paths are outside repo', async () => {
    const externalTasksDir = path.join(tempDir, 'external-tasks');
    await fs.mkdir(externalTasksDir, { recursive: true });

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const expectedProject = getOrCreateProject(db, repository.repositoryId);

    await syncPlanToDb(
      {
        id: 11,
        uuid: 'f9999999-9999-4999-8999-999999999999',
        title: 'External tasks plan',
        goal: 'Ensure project mapping uses git cwd',
        tasks: [],
      },
      path.join(externalTasksDir, '11-external.plan.md'),
      {
        config: buildTestConfig(externalTasksDir),
        baseDir: externalTasksDir,
      }
    );

    const savedPlan = getPlanByUuid(db, 'f9999999-9999-4999-8999-999999999999');
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.project_id).toBe(expectedProject.id);
  });

  test('syncPlanToDb resolves missing references from explicit tasksDir override', async () => {
    const fallbackTasksDir = path.join(tempDir, 'fallback-tasks');
    const configTasksDir = path.join(tempDir, 'config-tasks');
    await fs.mkdir(fallbackTasksDir, { recursive: true });
    await fs.mkdir(configTasksDir, { recursive: true });

    const parentUuid = 'fa111111-1111-4111-8111-111111111111';
    const childUuid = 'fa222222-2222-4222-8222-222222222222';

    await writePlanFile(path.join(fallbackTasksDir, '21-parent.plan.md'), {
      id: 21,
      uuid: parentUuid,
      title: 'Parent in fallback dir',
      goal: 'Used for fallback lookup',
      tasks: [],
    });

    await syncPlanToDb(
      {
        id: 22,
        uuid: childUuid,
        title: 'Child in fallback dir',
        goal: 'Should resolve parent from fallback dir',
        parent: 21,
        dependencies: [21],
        tasks: [],
      },
      path.join(fallbackTasksDir, '22-child.plan.md'),
      {
        config: buildTestConfig(configTasksDir),
        tasksDir: fallbackTasksDir,
      }
    );

    const db = getDatabase();
    const savedPlan = getPlanByUuid(db, childUuid);
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.parent_uuid).toBe(parentUuid);

    const deps = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all(childUuid) as Array<{ depends_on_uuid: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_uuid).toBe(parentUuid);
  });

  test('syncPlanToDb resolves missing references across sibling subdirectories using tasks root fallback', async () => {
    const config = buildTestConfig(tasksDir);
    const childDir = path.join(tasksDir, 'a');
    const parentDir = path.join(tasksDir, 'b');
    await fs.mkdir(childDir, { recursive: true });
    await fs.mkdir(parentDir, { recursive: true });

    const parentUuid = 'fc111111-1111-4111-8111-111111111111';
    const childUuid = 'fc222222-2222-4222-8222-222222222222';

    await writePlanFile(path.join(parentDir, '41-parent.plan.md'), {
      id: 41,
      uuid: parentUuid,
      title: 'Parent in sibling folder',
      goal: 'Used to resolve fallback references',
      tasks: [],
    });
    clearPlanSyncContext();

    await syncPlanToDb(
      {
        id: 42,
        uuid: childUuid,
        title: 'Child in sibling folder',
        goal: 'Must resolve via tasks root, not local folder',
        parent: 41,
        dependencies: [41],
        tasks: [],
      },
      path.join(childDir, '42-child.plan.md'),
      {
        config,
        baseDir: childDir,
      }
    );

    const db = getDatabase();
    const savedPlan = getPlanByUuid(db, childUuid);
    expect(savedPlan).not.toBeNull();
    expect(savedPlan?.parent_uuid).toBe(parentUuid);

    const deps = db
      .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
      .all(childUuid) as Array<{ depends_on_uuid: string }>;
    expect(deps).toHaveLength(1);
    expect(deps[0]?.depends_on_uuid).toBe(parentUuid);
  });

  test('syncAllPlansToDb reports parse errors when prune is disabled without warning by default', async () => {
    const validPlanUuid = 'fc333333-3333-4333-8333-333333333333';
    const brokenPlanPath = path.join(tasksDir, 'broken-no-prune.plan.md');

    await writePlanFile(path.join(tasksDir, '43-valid.plan.md'), {
      id: 43,
      uuid: validPlanUuid,
      title: 'Valid no-prune plan',
      goal: 'Still syncs with parse failures present',
      tasks: [],
    });
    await fs.writeFile(
      brokenPlanPath,
      ['---', 'id: 44', 'uuid: not-a-uuid', 'title: Broken', 'goal: Broken goal', '---', ''].join(
        '\n'
      )
    );

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    const adapter = new CaptureWarnAdapter();
    const result = await runWithLogger(adapter, async () => {
      return syncAllPlansToDb(projectId, tasksDir, { prune: false });
    });

    expect(result.synced).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.errors).toBe(1);
    expect(
      adapter.warns.some((line) =>
        line.includes(`Failed to parse plan file during sync: ${brokenPlanPath}`)
      )
    ).toBe(false);

    expect(getPlanByUuid(db, validPlanUuid)).not.toBeNull();
  });

  test('syncAllPlansToDb warns on parse errors when verbose is enabled', async () => {
    const validPlanUuid = 'fc444444-4444-4444-8444-444444444444';
    const brokenPlanPath = path.join(tasksDir, 'broken-verbose.plan.md');

    await writePlanFile(path.join(tasksDir, '44-valid.plan.md'), {
      id: 44,
      uuid: validPlanUuid,
      title: 'Valid verbose plan',
      goal: 'Still syncs with parse failures present',
      tasks: [],
    });
    await fs.writeFile(
      brokenPlanPath,
      ['---', 'id: 45', 'uuid: not-a-uuid', 'title: Broken', 'goal: Broken goal', '---', ''].join(
        '\n'
      )
    );

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    const adapter = new CaptureWarnAdapter();
    const result = await runWithLogger(adapter, async () => {
      return syncAllPlansToDb(projectId, tasksDir, { prune: false, verbose: true });
    });

    expect(result.synced).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.errors).toBe(1);
    expect(
      adapter.warns.some((line) =>
        line.includes(`Failed to parse plan file during sync: ${brokenPlanPath}`)
      )
    ).toBe(true);

    expect(getPlanByUuid(db, validPlanUuid)).not.toBeNull();
  });

  test('syncAllPlansToDb does not prune when plan files fail to parse', async () => {
    const validPlanUuid = 'fb111111-1111-4111-8111-111111111111';
    const stalePlanUuid = 'fb222222-2222-4222-8222-222222222222';
    const brokenPlanPath = path.join(tasksDir, 'broken.plan.md');

    await writePlanFile(path.join(tasksDir, '31-valid.plan.md'), {
      id: 31,
      uuid: validPlanUuid,
      title: 'Valid plan',
      goal: 'Should still sync',
      tasks: [],
    });

    await fs.writeFile(
      brokenPlanPath,
      [
        '---',
        'id: 32',
        'uuid: not-a-uuid',
        'title: Broken',
        'goal: Broken goal',
        'tasks: []',
        '---',
        '',
      ].join('\n')
    );

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const projectId = getOrCreateProject(db, repository.repositoryId).id;

    upsertPlan(db, projectId, {
      uuid: stalePlanUuid,
      planId: 9999,
      title: 'Existing stale row',
      goal: 'Must not be pruned while parsing fails',
      filename: '9999-stale.plan.md',
    });

    const result = await syncAllPlansToDb(projectId, tasksDir, { prune: true });
    expect(result.synced).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.errors).toBe(1);

    expect(getPlanByUuid(db, validPlanUuid)).not.toBeNull();
    expect(getPlanByUuid(db, stalePlanUuid)).not.toBeNull();
  });
});
