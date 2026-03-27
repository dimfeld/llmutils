import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker, clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleAddTaskCommand } from './add-task.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleAddTaskCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let planUuid: string;
  let configPath: string;
  let command: any;
  const logSpy = mock(() => {});

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-add-task-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    configPath = path.join(tempDir, '.tim.yml');
    await fs.writeFile(configPath, 'paths:\n  tasks: tasks\n');
    planFile = path.join(tasksDir, '100-add-task.plan.md');
    planUuid = crypto.randomUUID();
    command = { parent: { opts: () => ({ config: configPath }) } };

    const plan: PlanSchema = {
      id: 100,
      uuid: planUuid,
      title: 'Base Plan',
      goal: 'Do something great',
      status: 'pending',
      tasks: [
        {
          title: 'Initial task',
          description: 'Existing work item',
          done: false,
        },
      ],
    };

    await writePlanFile(planFile, plan);

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: mock(() => {}),
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockReset();
  });

  test('adds a task using explicit options', async () => {
    await handleAddTaskCommand(
      planFile,
      {
        title: 'Add logging',
        description: 'Introduce structured logging across modules',
      },
      command
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    const newTask = updated.tasks[1];
    expect(newTask?.title).toBe('Add logging');
    expect(newTask?.description).toBe('Introduce structured logging across modules');
    expect(newTask?.done).toBeFalse();
    expect(logSpy).toHaveBeenCalled();
  });

  test('adds a task interactively via prompt helper', async () => {
    const promptSpy = mock(async () => ({
      title: 'Interactive Task',
      description: 'Captured via prompts',
      files: ['src/app.ts'],
      docs: [],
    }));

    await moduleMocker.mock('../utils/task_operations.js', () => ({
      promptForTaskInfo: promptSpy,
    }));

    await handleAddTaskCommand(
      planFile,
      {
        interactive: true,
      },
      command
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    const newTask = updated.tasks[1];
    expect(newTask?.title).toBe('Interactive Task');
    expect(newTask?.description).toBe('Captured via prompts');
    expect(promptSpy).toHaveBeenCalledTimes(1);
  });

  test('uses editor when --editor flag provided', async () => {
    const editorSpy = mock(async () => 'Description from editor');

    await moduleMocker.mock('@inquirer/prompts', () => ({
      editor: editorSpy,
    }));

    await handleAddTaskCommand(
      planFile,
      {
        title: 'Editor Task',
        editor: true,
      },
      command
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    const newTask = updated.tasks[1];
    expect(newTask?.title).toBe('Editor Task');
    expect(newTask?.description).toBe('Description from editor');
    expect(editorSpy).toHaveBeenCalledTimes(1);
  });

  test('throws when required fields are missing in non-interactive mode', async () => {
    await expect(
      handleAddTaskCommand(
        planFile,
        {
          title: 'Incomplete task',
        },
        command
      )
    ).rejects.toThrow(
      'Task description is required unless using --interactive or providing one via --editor.'
    );
  });

  test('throws when title is missing in non-interactive mode', async () => {
    await expect(
      handleAddTaskCommand(
        planFile,
        {
          description: 'Missing the title field',
        },
        command
      )
    ).rejects.toThrow('Task title is required unless using --interactive.');
  });
});
