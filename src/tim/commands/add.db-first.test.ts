import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleAddCommand } from './add.js';

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

describe('tim add DB-first command', () => {
  let tempDir: string;
  let tasksDir: string;
  let command: any;

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-db-first-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, '.tim.yml'), 'paths:\n  tasks: tasks\n');
    vi.mocked((await import('../../common/git.js')).getGitRoot).mockResolvedValue(tempDir);
    command = { parent: { opts: () => ({ config: path.join(tempDir, '.tim.yml') }) } };
  });

  afterEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('creates a new plan in the DB without creating a task file', async () => {
    await handleAddCommand(['DB', 'First', 'Plan'], {}, command);

    const resolved = await resolvePlanFromDb('1', tempDir);
    expect(resolved.plan.title).toBe('DB First Plan');
    expect(resolved.plan.status).toBe('pending');

    const taskFiles = (await fs.readdir(tasksDir)).filter((entry) => entry.endsWith('.md'));
    expect(taskFiles).toHaveLength(0);
  });

  test('updates the parent plan dependency in the DB', async () => {
    const parentPath = path.join(tasksDir, '1-parent.plan.md');
    const parent: PlanSchema = {
      id: 1,
      title: 'Parent',
      goal: 'parent goal',
      details: '',
      status: 'done',
      epic: true,
      tasks: [],
    };
    await writePlanFile(parentPath, parent);

    await handleAddCommand(['Child'], { parent: 1 }, command);

    const child = await resolvePlanFromDb('2', tempDir);
    const updatedParent = await resolvePlanFromDb('1', tempDir);
    expect(child.plan.parent).toBe(1);
    expect(updatedParent.plan.dependencies).toContain(2);
    expect(updatedParent.plan.status).toBe('in_progress');
  });

  test('uses the config path repo root when invoked outside the repository', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-outside-'));
    const originalCwd = process.cwd();
    process.chdir(outsideDir);

    try {
      await handleAddCommand(['Config', 'Scoped', 'Plan'], {}, command);
      const resolved = await resolvePlanFromDb('1', tempDir);
      expect(resolved.plan.title).toBe('Config Scoped Plan');
    } finally {
      process.chdir(originalCwd);
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});
