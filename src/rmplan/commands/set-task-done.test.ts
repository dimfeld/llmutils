import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleSetTaskDoneCommand } from './set-task-done.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

// Mock setTaskDone from mark_done.js
const setTaskDoneSpy = mock(async () => ({
  planComplete: false,
  message: 'Marked task done',
}));

// Mock WorkspaceLock
const releaseLockSpy = mock(async () => {});

describe('handleSetTaskDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    setTaskDoneSpy.mockClear();
    releaseLockSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-set-task-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../plans/mark_done.js', () => ({
      setTaskDone: setTaskDoneSpy,
      markStepDone: mock(async () => ({ planComplete: false, message: 'unused' })),
      markTaskDone: mock(async () => ({ planComplete: false, message: 'unused' })),
    }));

    await moduleMocker.mock('../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        releaseLock: releaseLockSpy,
      },
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    // Mock utils
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('calls setTaskDone with title', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task One',
          description: 'First task',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Task Two',
          description: 'Second task',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleSetTaskDoneCommand(
      planFile,
      { title: 'Task Two' },
      { parent: { opts: () => ({}) } }
    );

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      planFile,
      {
        taskIdentifier: 'Task Two',
        commit: undefined,
      },
      tempDir,
      expect.any(Object)
    );
  });

  test('calls setTaskDone with index', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task One',
          description: 'First task',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        {
          title: 'Task Two',
          description: 'Second task',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleSetTaskDoneCommand(planFile, { index: 2 }, { parent: { opts: () => ({}) } });

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      planFile,
      {
        taskIdentifier: 2,
        commit: undefined,
      },
      tempDir,
      expect.any(Object)
    );
  });

  test('calls setTaskDone with commit option', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task One',
          description: 'First task',
          done: false,
          files: [],
          steps: [{ prompt: 'Step 1', done: false }],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleSetTaskDoneCommand(
      planFile,
      { title: 'Task One', commit: true },
      { parent: { opts: () => ({}) } }
    );

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      planFile,
      {
        taskIdentifier: 'Task One',
        commit: true,
      },
      tempDir,
      expect.any(Object)
    );
  });

  test('throws error when neither title nor index is provided', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      handleSetTaskDoneCommand(planFile, {}, { parent: { opts: () => ({}) } })
    ).rejects.toThrow('You must specify either --title or --index to identify the task');
  });

  test('throws error when both title and index are provided', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await expect(
      handleSetTaskDoneCommand(
        planFile,
        { title: 'Task', index: 1 },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('Please specify either --title or --index, not both');
  });

  test.skip('releases workspace lock when plan is complete', async () => {
    setTaskDoneSpy.mockResolvedValueOnce({
      planComplete: true,
      message: 'Plan complete',
    });

    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'Last Task',
          description: 'The final task',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleSetTaskDoneCommand(
      planFile,
      { title: 'Last Task' },
      { parent: { opts: () => ({}) } }
    );

    expect(releaseLockSpy).toHaveBeenCalledWith(tempDir);
    expect(logSpy).toHaveBeenCalledWith('Released workspace lock');
  });

  test('does not release workspace lock when plan is not complete', async () => {
    setTaskDoneSpy.mockResolvedValueOnce({
      planComplete: false,
      message: 'Task marked done',
    });

    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      status: 'in_progress',
      tasks: [
        {
          title: 'First Task',
          description: 'A task',
          done: false,
          files: [],
          steps: [],
        },
      ],
    };

    const planFile = path.join(tasksDir, '1.yml');
    await fs.writeFile(planFile, yaml.stringify(plan));

    await handleSetTaskDoneCommand(
      planFile,
      { title: 'First Task' },
      { parent: { opts: () => ({}) } }
    );

    expect(releaseLockSpy).not.toHaveBeenCalled();
  });
});
