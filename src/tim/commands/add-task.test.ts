import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { handleAddTaskCommand } from './add-task.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../configLoader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../configLoader.js')>()),
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../common/git.js')>()),
  getGitRoot: vi.fn(),
}));

vi.mock('../utils/task_operations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/task_operations.js')>();
  return {
    ...actual,
    promptForTaskInfo: vi.fn(),
  };
});

vi.mock('@inquirer/prompts', () => ({
  editor: vi.fn(),
}));

describe('handleAddTaskCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let planUuid: string;
  let configPath: string;
  let command: any;
  let logSpy: ReturnType<typeof vi.fn>;

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

    // Set up mocks before creating the plan
    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
    } as any);

    const gitModule = await import('../../common/git.js');
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);

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

    const loggingModule = await import('../../logging.js');
    logSpy = vi.mocked(loggingModule.log);
    logSpy.mockReset().mockImplementation(() => {});
    vi.mocked(loggingModule.warn)
      .mockReset()
      .mockImplementation(() => {});
    vi.mocked(loggingModule.error)
      .mockReset()
      .mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    await fs.rm(tempDir, { recursive: true, force: true });
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
    expect(newTask?.done).toBeFalsy();
    expect(logSpy).toHaveBeenCalled();
  });

  test('adds a task interactively via prompt helper', async () => {
    const taskOperationsModule = await import('../utils/task_operations.js');
    const promptSpy = vi.mocked(taskOperationsModule.promptForTaskInfo);
    promptSpy.mockResolvedValue({
      title: 'Interactive Task',
      description: 'Captured via prompts',
      files: ['src/app.ts'],
      docs: [],
    });

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
    const promptsModule = await import('@inquirer/prompts');
    const editorSpy = vi.mocked(promptsModule.editor);
    editorSpy.mockResolvedValue('Description from editor');

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
