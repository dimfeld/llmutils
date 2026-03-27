import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleRemoveTaskCommand } from './remove-task.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleRemoveTaskCommand', () => {
  let tempDir: string;
  let planFile: string;
  let originalEnv: Partial<Record<string, string>>;
  let originalCwd: string;
  const logSpy = mock(() => {});
  const warnSpy = mock(() => {});

  beforeEach(async () => {
    clearPlanCache();
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-remove-task-'));
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/remove-task.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
    process.chdir(tempDir);
    planFile = path.join(tempDir, '200-remove-task.plan.md');

    const plan: PlanSchema = {
      id: 200,
      title: 'Removal Plan',
      goal: 'Maintain tasks',
      status: 'in_progress',
      tasks: [
        { title: 'Task One', description: 'First', done: false, files: [], docs: [], steps: [] },
        { title: 'Task Two', description: 'Second', done: false, files: [], docs: [], steps: [] },
        { title: 'Task Three', description: 'Third', done: true, files: [], docs: [], steps: [] },
      ],
    };

    await writePlanFile(planFile, plan, { cwdForIdentity: tempDir });

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tempDir },
      }),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
    closeDatabaseForTesting();
    process.chdir(originalCwd);
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockReset();
    warnSpy.mockReset();
  });

  test('removes task by index', async () => {
    await handleRemoveTaskCommand(
      planFile,
      {
        index: 1,
      },
      { parent: { opts: () => ({}) } }
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks.map((t) => t.title)).toEqual(['Task One', 'Task Three']);
    expect(warnSpy).toHaveBeenCalled(); // removal from middle shifts indices
  });

  test('removes task by title', async () => {
    await handleRemoveTaskCommand(
      planFile,
      {
        title: 'Three',
      },
      { parent: { opts: () => ({}) } }
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks.map((t) => t.title)).toEqual(['Task One', 'Task Two']);
    expect(warnSpy).not.toHaveBeenCalled(); // removed last task
  });

  test('removes task via interactive selection', async () => {
    const selectSpy = mock(async () => 0);

    const taskOperations = await import('../utils/task_operations.js');

    await moduleMocker.mock('../utils/task_operations.js', () => ({
      selectTaskInteractive: selectSpy,
      findTaskByTitle: taskOperations.findTaskByTitle,
    }));

    await handleRemoveTaskCommand(
      planFile,
      {
        interactive: true,
      },
      { parent: { opts: () => ({}) } }
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    expect(updated.tasks.map((t) => t.title)).toEqual(['Task Two', 'Task Three']);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  test('throws when index is invalid', async () => {
    await expect(
      handleRemoveTaskCommand(
        planFile,
        {
          index: 99, // 0-based internal index (would be 100 in 1-based user input)
        },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('Task index 100 is out of bounds'); // Error shows 1-based index
  });

  test('throws when no selection mode is provided', async () => {
    await expect(
      handleRemoveTaskCommand(planFile, {}, { parent: { opts: () => ({}) } })
    ).rejects.toThrow('Specify one of --title, --index, or --interactive to choose a task.');
  });

  test('throws when multiple selection modes are provided', async () => {
    await expect(
      handleRemoveTaskCommand(
        planFile,
        {
          title: 'Task One',
          index: 0,
        },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(
      'Please use only one of --title, --index, or --interactive when removing a task.'
    );
  });
});
