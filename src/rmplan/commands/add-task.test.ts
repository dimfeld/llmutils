import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModuleMocker } from '../../testing.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleAddTaskCommand } from './add-task.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleAddTaskCommand', () => {
  let tempDir: string;
  let planFile: string;
  const logSpy = mock(() => {});

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-add-task-'));
    planFile = path.join(tempDir, '100-add-task.plan.md');

    const plan: PlanSchema = {
      id: 100,
      title: 'Base Plan',
      goal: 'Do something great',
      status: 'pending',
      tasks: [
        {
          title: 'Initial task',
          description: 'Existing work item',
          done: false,
          files: [],
          docs: [],
          steps: [],
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
        paths: { tasks: tempDir },
      }),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockReset();
  });

  test('adds a task using explicit options', async () => {
    await handleAddTaskCommand(
      planFile,
      {
        title: 'Add logging',
        description: 'Introduce structured logging across modules',
        files: ['src/server.ts'],
        docs: ['docs/logging.md'],
      },
      { parent: { opts: () => ({}) } }
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    const newTask = updated.tasks[1];
    expect(newTask?.title).toBe('Add logging');
    expect(newTask?.description).toBe('Introduce structured logging across modules');
    expect(newTask?.files).toEqual(['src/server.ts']);
    expect(newTask?.docs).toEqual(['docs/logging.md']);
    expect(newTask?.done).toBeFalse();
    expect(newTask?.steps).toEqual([]);
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
      { parent: { opts: () => ({}) } }
    );

    const updated = await readPlanFile(planFile);
    expect(updated.tasks).toHaveLength(2);
    const newTask = updated.tasks[1];
    expect(newTask?.title).toBe('Interactive Task');
    expect(newTask?.description).toBe('Captured via prompts');
    expect(newTask?.files).toEqual(['src/app.ts']);
    expect(newTask?.docs).toEqual([]);
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
      { parent: { opts: () => ({}) } }
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
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(
      'Task description is required unless using --interactive or providing one via --editor.'
    );
  });
});
