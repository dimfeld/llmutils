import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { resolvePlanByNumericId, writePlanFile } from '../plans.js';
import { clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { getDefaultConfig } from '../configSchema.js';
import { handleAddCommand } from './add.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getPlanByPlanId } from '../db/plan.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { setApplyBatchOperationHookForTesting } from '../sync/apply.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../configLoader.js')>();
  return { ...actual, loadEffectiveConfig: vi.fn() };
});

vi.mock('node:os', async (importOriginal) => {
  const realOs = await importOriginal<typeof os>();
  return {
    ...realOs,
    homedir: vi.fn(() => realOs.homedir()),
  };
});

vi.mock('../../logging.js', () => ({
  debugLog: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('./materialized_edit.js', () => ({
  editMaterializedPlan: vi.fn(),
}));

describe('tim add command', () => {
  let tempDir: string;
  let tasksDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    setApplyBatchOperationHookForTesting(null);

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);

    const configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: tasksDir,
        },
      })
    );

    // Reset mocks to default state
    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockReset();

    const loggingModule = await import('../../logging.js');
    vi.mocked(loggingModule.log)
      .mockReset()
      .mockImplementation(() => {});
    vi.mocked(loggingModule.warn)
      .mockReset()
      .mockImplementation(() => {});
    vi.mocked(loggingModule.error)
      .mockReset()
      .mockImplementation(() => {});
    vi.mocked(loggingModule.debugLog)
      .mockReset()
      .mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    setApplyBatchOperationHookForTesting(null);
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    process.chdir(originalCwd);

    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (err) {
        console.error('Failed to clean up temp directory:', tempDir, err);
      }
    }
  });

  const createExistingPlan = async (
    id: number,
    overrides: Partial<any> = {},
    filename = `${id}.yml`
  ) => {
    const planPath = path.join(tasksDir, filename);
    await writePlanFile(
      planPath,
      {
        id,
        title: `Plan ${id}`,
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
        ...overrides,
      },
      { skipUpdatedAt: true, cwdForIdentity: tempDir }
    );
    return planPath;
  };

  const planExists = async (planPath: string) =>
    await fs
      .access(planPath)
      .then(() => true)
      .catch(() => false);

  test('creates plan with numeric ID when no plans exist', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Test', 'Title'], {}, command);

    const planPath = path.join(tasksDir, '1-test-title.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.id).toBe(1);
    expect(plan.uuid).toMatch(UUID_REGEX);
    expect(plan.title).toBe('Test Title');
    expect(plan.goal).toBe('');
    expect(plan.details).toBe('');
    expect(plan.status).toBe('pending');
    expect(plan.tasks).toEqual([]);
  });

  test('creates plan with next numeric ID when plans exist', async () => {
    await createExistingPlan(50, { title: 'Existing Plan 50' });
    await createExistingPlan(100, { title: 'Existing Plan 100' });

    // Run handler directly
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['New', 'Plan', 'Title'], {}, command);

    const planPath = path.join(tasksDir, '101-new-plan-title.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(101, tempDir);
    expect(plan.id).toBe(101);
    expect(plan.title).toBe('New Plan Title');
  });

  test('sync-enabled main node preserves previewed numeric ID without self-renumbering', async () => {
    await createExistingPlan(10, { title: 'Existing Plan 10' });

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      ...getDefaultConfig(),
      paths: { tasks: tasksDir },
      sync: {
        role: 'main',
        nodeId: 'main-add-test',
        allowedNodes: [],
      },
    } as never);

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Main', 'Sync', 'Plan'], {}, command);

    const { plan } = await resolvePlanByNumericId(11, tempDir);
    expect(plan.id).toBe(11);
    expect(plan.title).toBe('Main Sync Plan');
  });

  test('sync-enabled --edit can create an empty-title stub plan', async () => {
    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      ...getDefaultConfig(),
      paths: { tasks: tasksDir },
      sync: {
        role: 'main',
        nodeId: 'main-add-edit-test',
        allowedNodes: [],
      },
    } as never);
    const { editMaterializedPlan } = await import('./materialized_edit.js');
    vi.mocked(editMaterializedPlan).mockResolvedValue(undefined);

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleAddCommand([], { edit: true }, command);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.title).toBe('');
    expect(editMaterializedPlan).toHaveBeenCalledWith(1, tempDir, undefined);
    expect(
      (
        getDatabase().prepare('SELECT operation_type, status FROM sync_operation').all() as Array<{
          operation_type: string;
          status: string;
        }>
      )[0]
    ).toEqual({ operation_type: 'plan.create', status: 'applied' });
  });

  test('creates plan with numeric ID ignoring non-numeric plan files', async () => {
    await fs.writeFile(
      path.join(tasksDir, 'old-plan.yml'),
      stringifyPlanWithFrontmatter({
        id: 'abc123',
        title: 'Old Alphanumeric Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    await createExistingPlan(5, { title: 'Numeric Plan 5' });

    // Run handler directly
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Another', 'Plan'], {}, command);

    const planPath = path.join(tasksDir, '6-another-plan.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(6, tempDir);
    expect(plan.id).toBe(6);
    expect(plan.title).toBe('Another Plan');
  });

  test('creates plan within external storage when repository uses external config', async () => {
    const externalBase = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-external-'));
    const repositoryConfigDir = path.join(externalBase, 'repositories', 'example');
    const externalTasksDir = path.join(repositoryConfigDir, 'tasks');
    await fs.mkdir(externalTasksDir, { recursive: true });

    const config = {
      ...getDefaultConfig(),
      paths: undefined,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: repositoryConfigDir,
      resolvedConfigPath: path.join(repositoryConfigDir, '.rmfilter', 'config', 'tim.yml'),
      repositoryConfigName: 'example',
      repositoryRemoteUrl: null,
    };

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue(config as any);

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleAddCommand(['External', 'Plan'], {}, command);

    const createdPath = path.join(externalTasksDir, '1-external-plan.plan.md');
    expect(await planExists(createdPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.title).toBe('External Plan');

    await fs.rm(externalBase, { recursive: true, force: true });
  });

  test('handles multi-word titles correctly', async () => {
    // Run handler directly with multi-word title
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['This', 'is', 'a', 'Multi', 'Word', 'Title'], {}, command);

    const planPath = path.join(tasksDir, '1-this-is-a-multi-word-title.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('This is a Multi Word Title');
  });

  test('adds dependencies and priority correctly', async () => {
    await createExistingPlan(1, { title: 'Dependency 1' });
    await createExistingPlan(2, { title: 'Dependency 2' });

    // Run handler directly with dependencies and priority
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(
      ['Plan', 'with', 'Dependencies'],
      { dependsOn: [1, 2], priority: 'high' },
      command
    );

    const plan = (await resolvePlanByNumericId(3, tempDir)).plan;

    expect(plan.id).toBe(3);
    expect(plan.title).toBe('Plan with Dependencies');
    expect([...(plan.dependencies ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(plan.priority).toBe('high');

    const dep1 = (await resolvePlanByNumericId(1, tempDir)).plan;
    const dep2 = (await resolvePlanByNumericId(2, tempDir)).plan;
    expect(dep1.uuid).toMatch(UUID_REGEX);
    expect(dep2.uuid).toMatch(UUID_REGEX);
  });

  test('fails fast when dependsOn contains an unknown plan ID', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await expect(
      handleAddCommand(['Plan', 'with', 'Missing', 'Dependency'], { dependsOn: [999] }, command)
    ).rejects.toThrow('Dependency plan 999 not found');
  });

  test('creates plan with parent and updates parent dependencies', async () => {
    const parentCreatedAt = new Date().toISOString();
    await createExistingPlan(
      1,
      {
        title: 'Parent Plan',
        goal: 'Test parent goal',
        details: 'Test parent details',
        createdAt: parentCreatedAt,
        updatedAt: parentCreatedAt,
      },
      '1-parent-plan.yml'
    );

    // Add a small delay to ensure timestamps are different
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Run handler directly with parent option
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Child', 'Plan'], { parent: 1 }, command);

    const childPlan = (await resolvePlanByNumericId(2, tempDir)).plan;
    expect(childPlan.id).toBe(2);
    expect(childPlan.title).toBe('Child Plan');
    expect(childPlan.parent).toBe(1);

    const parentPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(parentPlan.dependencies).toEqual([2]);
    expect(new Date(parentPlan.updatedAt!).getTime()).toBeGreaterThan(
      new Date(parentCreatedAt).getTime()
    );
    expect(parentPlan.uuid).toMatch(UUID_REGEX);
  });

  test('rolls back child create and parent reconciliation when add --parent batch fails', async () => {
    await createExistingPlan(
      1,
      {
        title: 'Completed Parent',
        status: 'done',
        dependencies: [],
      },
      '1-completed-parent.yml'
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    setApplyBatchOperationHookForTesting((index) => {
      if (index === 0) {
        throw new Error('injected add parent batch failure');
      }
    });

    await expect(handleAddCommand(['Atomic', 'Child'], { parent: 1 }, command)).rejects.toThrow(
      'injected add parent batch failure'
    );

    setApplyBatchOperationHookForTesting(null);
    const parentPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(parentPlan.status).toBe('done');
    expect(parentPlan.dependencies ?? []).toEqual([]);
    const context = await (await import('../plan_materialize.js')).resolveProjectContext(tempDir);
    expect(getPlanByPlanId(getDatabase(), context.projectId, 2)).toBeNull();
  });

  test('sync-mode add --parent with legacy parent fails before creating child plan', async () => {
    await createExistingPlan(
      1,
      {
        title: 'Legacy Parent',
        status: 'done',
        dependencies: [],
        tasks: [{ title: 'Legacy task', description: '', done: false }],
      },
      '1-legacy-parent.yml'
    );

    const db = getDatabase();
    const context = await (await import('../plan_materialize.js')).resolveProjectContext(tempDir);
    const parentRow = getPlanByPlanId(db, context.projectId, 1);
    expect(parentRow).not.toBeNull();
    db.prepare('UPDATE plan_task SET uuid = NULL WHERE plan_uuid = ? AND task_index = 0').run(
      parentRow!.uuid
    );

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      ...getDefaultConfig(),
      paths: { tasks: tasksDir },
      sync: {
        role: 'main',
        nodeId: 'main-add-parent-legacy-test',
        allowedNodes: [],
      },
    } as never);

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await expect(handleAddCommand(['Sync', 'Child'], { parent: 1 }, command)).rejects.toThrow(
      'legacy task rows without UUIDs'
    );

    const parentPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(parentPlan.status).toBe('done');
    expect(parentPlan.dependencies ?? []).toEqual([]);
    expect(getPlanByPlanId(db, context.projectId, 2)).toBeNull();
  });

  test('local legacy add --parent rolls back child create when parent reconciliation fails', async () => {
    await createExistingPlan(
      1,
      {
        title: 'Legacy Parent',
        status: 'done',
        dependencies: [],
        tasks: [{ title: 'Legacy task', description: '', done: false }],
      },
      '1-legacy-parent.yml'
    );

    const db = getDatabase();
    const context = await (await import('../plan_materialize.js')).resolveProjectContext(tempDir);
    const parentRow = getPlanByPlanId(db, context.projectId, 1);
    expect(parentRow).not.toBeNull();
    db.prepare('UPDATE plan_task SET uuid = NULL WHERE plan_uuid = ? AND task_index = 0').run(
      parentRow!.uuid
    );
    db.prepare(
      `CREATE TRIGGER fail_legacy_add_parent_dependency
       BEFORE INSERT ON plan_dependency
       WHEN NEW.plan_uuid = '${parentRow!.uuid}'
       BEGIN
         SELECT RAISE(FAIL, 'injected legacy add parent failure');
       END`
    ).run();

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await expect(handleAddCommand(['Atomic', 'Child'], { parent: 1 }, command)).rejects.toThrow(
      'injected legacy add parent failure'
    );

    const parentPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(parentPlan.status).toBe('done');
    expect(parentPlan.dependencies ?? []).toEqual([]);
    expect(getPlanByPlanId(db, context.projectId, 2)).toBeNull();
  });

  test('errors when parent plan does not exist', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await expect(handleAddCommand(['Orphan', 'Plan'], { parent: 999 }, command)).rejects.toThrow(
      'No plan found in the database for identifier: 999'
    );
  });

  describe('--cleanup option', () => {
    test('creates cleanup plan with default title generation', async () => {
      await createExistingPlan(
        10,
        {
          title: 'Parent Plan',
          goal: 'Test parent goal',
          details: 'Test parent details',
        },
        '10-parent-plan.yml'
      );

      // Run handler directly with --cleanup option (no custom title)
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 10 }, command);

      const cleanupPlan = (await resolvePlanByNumericId(11, tempDir)).plan;
      expect(cleanupPlan.id).toBe(11);
      expect(cleanupPlan.title).toBe('Parent Plan - Cleanup');
      expect(cleanupPlan.parent).toBe(10);
      expect(cleanupPlan.status).toBe('pending');

      const parentPlan = (await resolvePlanByNumericId(10, tempDir)).plan;
      expect(parentPlan.dependencies).toEqual([11]);
    });

    test('creates cleanup plan with custom title', async () => {
      await createExistingPlan(
        20,
        {
          title: 'Original Plan',
          goal: 'Test original goal',
          details: 'Test original details',
        },
        '20-original-plan.yml'
      );

      // Run handler directly with --cleanup option and custom title
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand(['Custom', 'Cleanup', 'Title'], { cleanup: 20 }, command);

      const cleanupPlan = (await resolvePlanByNumericId(21, tempDir)).plan;
      expect(cleanupPlan.id).toBe(21);
      expect(cleanupPlan.title).toBe('Custom Cleanup Title'); // Custom title, not default
      expect(cleanupPlan.parent).toBe(20);
      expect(cleanupPlan.status).toBe('pending');

      const parentPlan = (await resolvePlanByNumericId(20, tempDir)).plan;
      expect(parentPlan.dependencies).toEqual([21]);
    });

    test('aggregates changedFiles from parent and done child plans into rmfilter', async () => {
      await createExistingPlan(
        30,
        {
          title: 'Parent With Files',
          goal: 'Test parent goal',
          details: 'Test parent details',
          changedFiles: ['src/file1.ts', 'src/file2.ts', 'shared.ts'],
        },
        '30-parent-with-files.yml'
      );
      await createExistingPlan(
        31,
        {
          title: 'Done Child Plan',
          goal: 'Test child goal',
          details: 'Test child details',
          status: 'done',
          parent: 30,
          changedFiles: ['src/file3.ts', 'shared.ts', 'test/file.test.ts'],
        },
        '31-done-child.yml'
      );
      await createExistingPlan(
        32,
        {
          title: 'Pending Child Plan',
          goal: 'Test pending child goal',
          details: 'Test pending child details',
          status: 'pending',
          parent: 30,
          changedFiles: ['src/ignored.ts'],
        },
        '32-pending-child.yml'
      );

      // Run handler directly with --cleanup option
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 30 }, command);

      const cleanupPlan = (await resolvePlanByNumericId(33, tempDir)).plan;
      expect(cleanupPlan.id).toBe(33);
      expect(cleanupPlan.title).toBe('Parent With Files - Cleanup');
      expect(cleanupPlan.parent).toBe(30);

      const parentPlan = (await resolvePlanByNumericId(30, tempDir)).plan;
      // Plans 31 and 32 were created with parent: 30, so applyPlanCreate auto-links them
      // as dependencies of plan 30. The cleanup plan 33 is then added by handleAddCommand.
      expect(parentPlan.dependencies).toEqual([31, 32, 33]);
    });

    test('errors when referencing non-existent plan ID', async () => {
      // Run handler directly with non-existent cleanup plan ID
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await expect(handleAddCommand([], { cleanup: 999 }, command)).rejects.toThrow(
        'No plan found in the database for identifier: 999'
      );
    });

    test('changes referenced plan status from done to in_progress when adding cleanup dependency', async () => {
      const parentCreatedAt = new Date().toISOString();
      await createExistingPlan(
        40,
        {
          title: 'Done Plan',
          goal: 'Test done plan goal',
          details: 'Test done plan details',
          status: 'done',
          createdAt: parentCreatedAt,
          updatedAt: parentCreatedAt,
        },
        '40-done-plan.yml'
      );

      // Add a small delay to ensure timestamps are different
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Run handler directly with --cleanup option
      const command = {
        parent: {
          opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
        },
      };
      await handleAddCommand([], { cleanup: 40 }, command);

      const cleanupPlan = (await resolvePlanByNumericId(41, tempDir)).plan;
      expect(cleanupPlan.id).toBe(41);
      expect(cleanupPlan.title).toBe('Done Plan - Cleanup');
      expect(cleanupPlan.parent).toBe(40);
      expect(cleanupPlan.status).toBe('pending');

      const parentPlan = (await resolvePlanByNumericId(40, tempDir)).plan;
      expect(parentPlan.dependencies).toEqual([41]);
      expect(parentPlan.status).toBe('in_progress'); // Changed from 'done'
      expect(new Date(parentPlan.updatedAt!).getTime()).toBeGreaterThan(
        new Date(parentCreatedAt).getTime()
      );
    });
  });

  test('creates plan with temp flag set to true', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Temporary', 'Plan'], { temp: true }, command);

    const planPath = path.join(tasksDir, '1-temporary-plan.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Temporary Plan');
    expect(plan.temp).toBe(true);
  });

  test('creates plan with epic flag set to true', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Epic', 'Plan'], { epic: true }, command);

    const planPath = path.join(tasksDir, '1-epic-plan.plan.md');
    expect(await planExists(planPath)).toBe(false);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Epic Plan');
    expect(plan.epic).toBe(true);
  });

  test('creates sanitized external plan when remote contains credentials and query tokens', async () => {
    clearAllTimCaches();

    const fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-home-'));
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-repo-'));
    const originalCwd = process.cwd();
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(fakeHomeDir, '.config');

    const remote =
      'https://user:super-secret-token@github.example.com/Owner/Repo.git?token=abc#frag';

    const osModule = await import('node:os');
    vi.mocked(osModule.homedir).mockReturnValue(fakeHomeDir);

    const logMessages: string[] = [];
    const loggingModule = await import('../../logging.js');
    vi.mocked(loggingModule.log).mockImplementation((message: string) => {
      logMessages.push(message);
    });

    try {
      await $`git init`.cwd(repoDir).quiet();
      await $`git remote add origin ${remote}`.cwd(repoDir).quiet();

      process.chdir(repoDir);

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleAddCommand(['External', 'Plan'], {}, command);

      const repositoryDir = path.join(
        fakeHomeDir,
        '.config',
        'tim',
        'repositories',
        'github.example.com__Owner__Repo'
      );
      const tasksDirectory = path.join(repositoryDir, 'tasks');
      const planPath = path.join(tasksDirectory, '1-external-plan.plan.md');
      expect(await planExists(planPath)).toBe(false);
      expect(repositoryDir.includes('token')).toBe(false);
      expect(tasksDirectory.includes('token')).toBe(false);
      // Verify no credentials leaked into any log messages
      expect(logMessages.some((message) => /super-secret-token|token=abc/.test(message))).toBe(
        false
      );
    } finally {
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      process.chdir(originalCwd);
      await fs.rm(repoDir, { recursive: true, force: true });
      await fs.rm(fakeHomeDir, { recursive: true, force: true });
      clearAllTimCaches();
    }
  });

  test('creates plan with normalized initial tags', async () => {
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleAddCommand(['Tagged', 'Plan'], { tag: ['Frontend', 'Bug', 'frontend'] }, command);

    const plan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(plan.tags).toEqual(['bug', 'frontend']);
  });

  test('rejects initial tags not in allowlist', async () => {
    const configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: tasksDir },
        tags: { allowed: ['frontend'] },
      })
    );
    clearAllTimCaches();

    // Mock the config loader to return our test config
    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
      tags: { allowed: ['frontend'] },
    } as any);

    const command = {
      parent: {
        opts: () => ({ config: configPath }),
      },
    };

    await expect(
      handleAddCommand(['Tagged', 'Plan'], { tag: ['backend'] }, command)
    ).rejects.toThrow(/Invalid tag/);
  });

  test('creates plan with discoveredFrom reference', async () => {
    await createExistingPlan(
      1,
      {
        title: 'Source Plan',
        goal: 'Source goal',
        details: 'Source details',
        status: 'in_progress',
      },
      '1-source-plan.yml'
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Discovered', 'Plan'], { discoveredFrom: 1 }, command);

    const plan = (await resolvePlanByNumericId(2, tempDir)).plan;
    expect(plan.discoveredFrom).toBe(1);

    const sourcePlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(sourcePlan.uuid).toMatch(UUID_REGEX);
  });

  test('creates plan with both parent and dependsOn references', async () => {
    const parentUuid = crypto.randomUUID();
    await createExistingPlan(
      1,
      {
        uuid: parentUuid,
        title: 'Parent',
        goal: 'Parent goal',
        details: '',
      },
      '1-parent.yml'
    );
    await createExistingPlan(
      2,
      {
        title: 'Dependency',
        goal: 'Dep goal',
        details: '',
      },
      '2-dep.yml'
    );

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };
    await handleAddCommand(['Child', 'Plan'], { parent: 1, dependsOn: [2] }, command);

    const childPlan = (await resolvePlanByNumericId(3, tempDir)).plan;
    expect(childPlan.parent).toBe(1);
    expect(childPlan.dependencies).toEqual([2]);

    const parentPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(parentPlan.dependencies).toContain(3);
    expect(parentPlan.uuid).toBe(parentUuid);

    const depPlan = (await resolvePlanByNumericId(2, tempDir)).plan;
    expect(depPlan.uuid).toMatch(UUID_REGEX);
  });
});
