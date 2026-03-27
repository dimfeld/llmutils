import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { ModuleMocker, stringifyPlanWithFrontmatter } from '../../testing.js';
import { clearConfigCache } from '../configLoader.js';
import type { PlanSchema } from '../planSchema.js';

describe('tim cleanup-temp command', () => {
  let tempDir: string;
  let tasksDir: string;
  let moduleMocker: ModuleMocker;
  let currentPlans: Map<number, PlanSchema & { filename: string }>;
  let removePlanFromDbMock: ReturnType<typeof mock>;

  beforeEach(async () => {
    clearConfigCache();
    moduleMocker = new ModuleMocker(import.meta);
    currentPlans = new Map();
    removePlanFromDbMock = mock(async () => {});

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-cleanup-temp-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file that points to tasks directory
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
  });

  afterEach(async () => {
    clearConfigCache();
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function loadCommand(options?: { unlinkImpl?: (path: string) => Promise<void> }) {
    if (options?.unlinkImpl) {
      await moduleMocker.mock('node:fs/promises', () => ({
        unlink: options.unlinkImpl,
      }));
    }
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({ paths: { tasks: tasksDir } }),
    }));
    await moduleMocker.mock('../path_resolver.js', () => ({
      resolvePlanPathContext: async () => ({ tasksDir }),
    }));
    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: `test-repo-${tempDir}`,
        remoteUrl: null,
        gitRoot: tempDir,
      }),
    }));
    await moduleMocker.mock('../plans_db.js', () => ({
      loadPlansFromDb: () => ({ plans: currentPlans, duplicates: {} }),
    }));
    await moduleMocker.mock('../db/plan_sync.js', () => ({
      removePlanFromDb: removePlanFromDbMock,
    }));

    return import('./cleanup-temp.js');
  }

  test('deletes only plans with temp: true', async () => {
    const { handleCleanupTempCommand } = await loadCommand();

    // Create a temporary plan
    await fs.writeFile(
      path.join(tasksDir, '1-temp-plan.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Temp Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        temp: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    currentPlans.set(1, {
      id: 1,
      title: 'Temp Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      temp: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: path.join(tasksDir, '1-temp-plan.plan.md'),
    });

    // Create a permanent plan
    await fs.writeFile(
      path.join(tasksDir, '2-permanent-plan.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 2,
        title: 'Permanent Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        temp: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    currentPlans.set(2, {
      id: 2,
      title: 'Permanent Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      temp: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: path.join(tasksDir, '2-permanent-plan.plan.md'),
    });

    // Create a plan without temp field (should be treated as false)
    await fs.writeFile(
      path.join(tasksDir, '3-normal-plan.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 3,
        title: 'Normal Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    currentPlans.set(3, {
      id: 3,
      title: 'Normal Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: path.join(tasksDir, '3-normal-plan.plan.md'),
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify temp plan was deleted
    const tempPlanExists = await fs
      .access(path.join(tasksDir, '1-temp-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(tempPlanExists).toBe(false);

    // Verify permanent plan still exists
    const permanentPlanExists = await fs
      .access(path.join(tasksDir, '2-permanent-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(permanentPlanExists).toBe(true);

    // Verify normal plan still exists
    const normalPlanExists = await fs
      .access(path.join(tasksDir, '3-normal-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(normalPlanExists).toBe(true);
  });

  test('deletes multiple temporary plans', async () => {
    const { handleCleanupTempCommand } = await loadCommand();

    // Create multiple temporary plans
    for (let i = 1; i <= 3; i++) {
      const filename = path.join(tasksDir, `${i}-temp-plan-${i}.plan.md`);
      await fs.writeFile(
        filename,
        stringifyPlanWithFrontmatter({
          id: i,
          title: `Temp Plan ${i}`,
          goal: 'Test goal',
          details: 'Test details',
          status: 'pending',
          temp: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [],
        } satisfies PlanSchema)
      );
      currentPlans.set(i, {
        id: i,
        title: `Temp Plan ${i}`,
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        temp: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
        filename,
      });
    }

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify all temp plans were deleted
    for (let i = 1; i <= 3; i++) {
      const exists = await fs
        .access(path.join(tasksDir, `${i}-temp-plan-${i}.plan.md`))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  test('handles empty directory gracefully', async () => {
    const { handleCleanupTempCommand } = await loadCommand();

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    // Should not throw an error
    await expect(handleCleanupTempCommand({}, command)).resolves.toBeUndefined();
  });

  test('handles directory with no temp plans', async () => {
    const { handleCleanupTempCommand } = await loadCommand();

    // Create only permanent plans
    await fs.writeFile(
      path.join(tasksDir, '1-permanent-plan.plan.md'),
      stringifyPlanWithFrontmatter({
        id: 1,
        title: 'Permanent Plan',
        goal: 'Test goal',
        details: 'Test details',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      })
    );
    currentPlans.set(1, {
      id: 1,
      title: 'Permanent Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: path.join(tasksDir, '1-permanent-plan.plan.md'),
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    // Verify permanent plan still exists
    const exists = await fs
      .access(path.join(tasksDir, '1-permanent-plan.plan.md'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  test('keeps the DB row when unlink fails with a real error', async () => {
    const unlinkError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const unlinkMock = mock(async () => {
      throw unlinkError;
    });
    const { handleCleanupTempCommand } = await loadCommand({
      unlinkImpl: unlinkMock,
    });

    currentPlans.set(1, {
      id: 1,
      title: 'Temp Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      temp: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: path.join(tasksDir, '1-temp-plan.plan.md'),
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(removePlanFromDbMock).not.toHaveBeenCalled();
  });

  test('removes the DB row when the backing file is already missing', async () => {
    const missingPath = path.join(tasksDir, '1-missing-temp.plan.md');
    const { handleCleanupTempCommand } = await loadCommand();

    currentPlans.set(1, {
      id: 1,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Temp Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      temp: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: missingPath,
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    expect(removePlanFromDbMock).toHaveBeenCalledTimes(1);
    expect(removePlanFromDbMock).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ baseDir: tempDir })
    );
  });

  test('removes DB-only temp plans even when no file was materialized', async () => {
    const dbOnlyPath = path.join(tasksDir, '2-db-only-temp.plan.md');
    const { handleCleanupTempCommand } = await loadCommand({
      unlinkImpl: async () => {
        const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
        throw err;
      },
    });

    currentPlans.set(2, {
      id: 2,
      uuid: '22222222-2222-4222-8222-222222222222',
      title: 'DB-only Temp Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      temp: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      filename: dbOnlyPath,
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    expect(removePlanFromDbMock).toHaveBeenCalledTimes(1);
    expect(removePlanFromDbMock).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ baseDir: tempDir })
    );
  });
});
