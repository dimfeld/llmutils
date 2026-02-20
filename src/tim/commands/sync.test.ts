import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker, clearAllTimCaches, stringifyPlanWithFrontmatter } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getPlansByProject } from '../db/plan.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getProject } from '../db/project.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

const moduleMocker = new ModuleMocker(import.meta);
const mockLog = mock(() => {});

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/sync-tests.git`.cwd(repoDir).quiet();
}

describe('tim sync command', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;
  let configPath: string;
  let originalXdgConfigHome: string | undefined;

  const makeCommand = () => ({
    parent: {
      opts: () => ({ config: configPath }),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-command-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(repoDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `paths:\n  tasks: ${tasksDir}\n`);

    await initializeGitRepository(repoDir);

    mockLog.mockClear();
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      warn: mock(() => {}),
      error: mock(() => {}),
      debugLog: mock(() => {}),
      writeStdout: mock(() => {}),
      writeStderr: mock(() => {}),
      sendStructured: mock(() => {}),
    }));

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg');
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();

    moduleMocker.clear();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('handleSyncCommand syncs plan files into SQLite', async () => {
    await fs.writeFile(
      path.join(tasksDir, '1-alpha.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Alpha',
        goal: 'Sync alpha',
        details: 'Alpha details',
        tasks: [{ title: 'alpha task', description: 'do alpha', done: false }],
      })
    );
    await fs.writeFile(
      path.join(tasksDir, '2-beta.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 2,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Beta',
        goal: 'Sync beta',
        tasks: [],
      })
    );

    const { handleSyncCommand } = await import('./sync.js');
    await handleSyncCommand({}, makeCommand() as any);

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);

    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans).toHaveLength(2);
    expect(plans.map((plan) => plan.uuid).sort()).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(
      plans.find((plan) => plan.uuid === '11111111-1111-4111-8111-111111111111')?.details
    ).toBe('Alpha details');

    expect(mockLog).toHaveBeenCalledWith('Synced 2 plans. Pruned 0 plans. 0 errors.');
  });

  test('handleSyncCommand --plan syncs only the requested plan', async () => {
    await fs.writeFile(
      path.join(tasksDir, '1-alpha.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Alpha',
        goal: 'Sync alpha',
        tasks: [{ title: 'alpha task', description: 'do alpha', done: false }],
      })
    );
    await fs.writeFile(
      path.join(tasksDir, '2-beta.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 2,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Beta',
        goal: 'Sync beta',
        tasks: [],
      })
    );

    const { handleSyncCommand } = await import('./sync.js');
    await handleSyncCommand({ plan: '1' }, makeCommand() as any);

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);

    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.uuid).toBe('11111111-1111-4111-8111-111111111111');

    expect(mockLog).toHaveBeenCalledWith('Synced plan 1 (1-alpha.plan.md).');
  });

  test('handleSyncCommand --force bypasses stale updatedAt checks', async () => {
    const planPath = path.join(tasksDir, '6-stale.plan.md');
    const planUuid = '66666666-6666-4666-8666-666666666666';

    await fs.writeFile(
      planPath,
      stringifyPlanWithFrontmatter({
        id: 6,
        uuid: planUuid,
        title: 'Initial title',
        goal: 'Initial goal',
        updatedAt: '2026-01-01T00:00:00.000Z',
        tasks: [],
      })
    );

    const { handleSyncCommand } = await import('./sync.js');
    await handleSyncCommand({ plan: '6' }, makeCommand() as any);

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();

    db.prepare('UPDATE plan SET updated_at = ? WHERE uuid = ?').run(
      '2026-01-03T00:00:00.000Z',
      planUuid
    );

    await fs.writeFile(
      planPath,
      stringifyPlanWithFrontmatter({
        id: 6,
        uuid: planUuid,
        title: 'Stale update title',
        goal: 'Stale goal',
        updatedAt: '2026-01-02T00:00:00.000Z',
        tasks: [],
      })
    );

    await handleSyncCommand({ plan: '6' }, makeCommand() as any);
    let plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.uuid === planUuid)?.title).toBe('Initial title');

    await handleSyncCommand({ plan: '6', force: true }, makeCommand() as any);
    plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.uuid === planUuid)?.title).toBe('Stale update title');
  });

  test('handleSyncCommand --plan also syncs referenced plans missing from DB', async () => {
    const parentUuid = '77777777-7777-4777-8777-777777777777';
    const childUuid = '88888888-8888-4888-8888-888888888888';

    await fs.writeFile(
      path.join(tasksDir, '7-parent.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 7,
        uuid: parentUuid,
        title: 'Referenced parent',
        goal: 'Should be auto-synced',
        tasks: [],
      })
    );

    await fs.writeFile(
      path.join(tasksDir, '8-child.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 8,
        uuid: childUuid,
        title: 'Child',
        goal: 'Sync target',
        parent: 7,
        dependencies: [7],
        references: {
          '7': parentUuid,
        },
        tasks: [],
      })
    );

    const { handleSyncCommand } = await import('./sync.js');
    await handleSyncCommand({ plan: '8' }, makeCommand() as any);

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();

    const plans = getPlansByProject(db, project!.id);
    expect(plans.map((plan) => plan.uuid).sort()).toEqual([parentUuid, childUuid]);
  });

  test('handleSyncCommand --prune removes SQLite plans not found on disk', async () => {
    const keptUuid = '33333333-3333-4333-8333-333333333333';
    const removedUuid = '44444444-4444-4444-8444-444444444444';

    await fs.writeFile(
      path.join(tasksDir, '3-keep.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 3,
        uuid: keptUuid,
        title: 'Keep me',
        goal: 'Stay in DB',
        tasks: [],
      })
    );
    const removedFilePath = path.join(tasksDir, '4-remove.plan.md');
    await fs.writeFile(
      removedFilePath,
      stringifyPlanWithFrontmatter({
        id: 4,
        uuid: removedUuid,
        title: 'Remove me',
        goal: 'Will be pruned',
        tasks: [],
      })
    );

    const { handleSyncCommand } = await import('./sync.js');
    await handleSyncCommand({}, makeCommand() as any);

    await fs.rm(removedFilePath, { force: true });

    await handleSyncCommand({ prune: true }, makeCommand() as any);

    const repository = await getRepositoryIdentity();
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);

    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.uuid).toBe(keptUuid);

    expect(mockLog).toHaveBeenCalledWith('Synced 1 plan. Pruned 1 plan. 0 errors.');
  });

  test('handleSyncCommand --dir uses repository identity from current git cwd', async () => {
    const externalTasksDir = path.join(tempDir, 'external-tasks');
    await fs.mkdir(externalTasksDir, { recursive: true });
    await fs.writeFile(
      path.join(externalTasksDir, '5-external.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 5,
        uuid: '55555555-5555-4555-8555-555555555555',
        title: 'External',
        goal: 'Sync from outside repo root',
        tasks: [],
      })
    );

    const previousCwd = process.cwd();
    try {
      process.chdir(repoDir);
      const { handleSyncCommand } = await import('./sync.js');
      await handleSyncCommand({ dir: externalTasksDir }, makeCommand() as any);

      const repository = await getRepositoryIdentity();
      const db = getDatabase();
      const project = getProject(db, repository.repositoryId);
      expect(project).not.toBeNull();

      const plans = getPlansByProject(db, project!.id);
      expect(plans.some((plan) => plan.uuid === '55555555-5555-4555-8555-555555555555')).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  test('handleSyncCommand rejects combining --plan and --prune', async () => {
    const { handleSyncCommand } = await import('./sync.js');
    await expect(
      handleSyncCommand({ plan: '1', prune: true }, makeCommand() as any)
    ).rejects.toThrow('--prune cannot be used together with --plan');
  });
});
