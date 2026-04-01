import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { stringifyPlanWithFrontmatter } from '../../testing.js';
import { clearConfigCache } from '../configLoader.js';
import type { PlanSchema } from '../planSchema.js';

let currentPlans: Map<number, PlanSchema>;
let removePlanFromDbMock: ReturnType<typeof vi.fn>;
let unlinkImpl: ((p: string) => Promise<void>) | undefined;

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../configLoader.js')>();
  return {
    ...actual,
    loadEffectiveConfig: vi.fn(),
  };
});

vi.mock('../path_resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../path_resolver.js')>();
  return {
    ...actual,
    resolvePlanPathContext: vi.fn(),
  };
});

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('../plans_db.js', () => ({
  loadPlansFromDb: vi.fn(),
}));

vi.mock('../db/plan_sync.js', () => ({
  removePlanFromDb: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(async (p: string) => {
      if (unlinkImpl) {
        return unlinkImpl(p);
      }
      return actual.unlink(p);
    }),
  };
});

import { handleCleanupTempCommand } from './cleanup-temp.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadPlansFromDb } from '../plans_db.js';
import { removePlanFromDb } from '../db/plan_sync.js';

describe('tim cleanup-temp command', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    clearConfigCache();
    vi.clearAllMocks();
    unlinkImpl = undefined;
    currentPlans = new Map();
    removePlanFromDbMock = vi.mocked(removePlanFromDb);

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-cleanup-temp-test-'));
    tasksDir = path.join(tempDir, '.tim', 'plans');
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

    vi.mocked(loadEffectiveConfig).mockResolvedValue({ paths: { tasks: tasksDir } } as any);
    vi.mocked(resolvePlanPathContext).mockResolvedValue({
      tasksDir,
      gitRoot: tempDir,
      configBaseDir: tempDir,
    } as any);
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: `test-repo-${tempDir}`,
      remoteUrl: null,
      gitRoot: tempDir,
    });
    vi.mocked(loadPlansFromDb).mockReturnValue({ plans: currentPlans, duplicates: {} } as any);
    removePlanFromDbMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    clearConfigCache();
    vi.clearAllMocks();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('deletes only plans with temp: true', async () => {
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
    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    // Should not throw an error
    await expect(handleCleanupTempCommand({}, command)).resolves.toBeUndefined();
  });

  test('handles directory with no temp plans', async () => {
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
    unlinkImpl = async () => {
      throw unlinkError;
    };

    const tempPlanPath = path.join(tasksDir, '1-temp-plan.plan.md');
    await fs.writeFile(
      tempPlanPath,
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
      } satisfies PlanSchema)
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
    });

    const command = {
      parent: {
        opts: () => ({ config: path.join(tempDir, '.rmfilter', 'tim.yml') }),
      },
    };

    await handleCleanupTempCommand({}, command);

    expect(vi.mocked(fs.unlink)).toHaveBeenCalledTimes(1);
    expect(removePlanFromDbMock).not.toHaveBeenCalled();
  });

  test('removes the DB row when the backing file is already missing', async () => {
    const missingPath = path.join(tasksDir, '1-missing-temp.plan.md');

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
    unlinkImpl = async () => {
      const err = Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw err;
    };

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
