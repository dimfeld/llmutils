import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleSetTaskDoneCommand } from './set-task-done.js';
import type { PlanSchema } from '../planSchema.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../plans/mark_done.js', () => ({
  setTaskDone: vi.fn(),
  markStepDone: vi.fn(),
  markTaskDone: vi.fn(),
}));

vi.mock('../workspace/workspace_lock.js', () => ({
  WorkspaceLock: {
    releaseLock: vi.fn(),
  },
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

describe('handleSetTaskDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let logSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  let setTaskDoneSpy: ReturnType<typeof vi.fn>;
  let releaseLockSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-set-task-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    const loggingModule = await import('../../logging.js');
    logSpy = vi.mocked(loggingModule.log);
    errorSpy = vi.mocked(loggingModule.error);
    logSpy.mockReset().mockImplementation(() => {});
    errorSpy.mockReset().mockImplementation(() => {});
    vi.mocked(loggingModule.warn)
      .mockReset()
      .mockImplementation(() => {});

    const markDoneModule = await import('../plans/mark_done.js');
    setTaskDoneSpy = vi.mocked(markDoneModule.setTaskDone);
    setTaskDoneSpy.mockReset().mockResolvedValue({
      planComplete: false,
      message: 'Marked task done',
    });
    vi.mocked(markDoneModule.markStepDone)
      .mockReset()
      .mockResolvedValue({ planComplete: false, message: 'unused' });
    vi.mocked(markDoneModule.markTaskDone)
      .mockReset()
      .mockResolvedValue({ planComplete: false, message: 'unused' });

    const workspaceLockModule = await import('../workspace/workspace_lock.js');
    releaseLockSpy = vi.mocked(workspaceLockModule.WorkspaceLock.releaseLock);
    releaseLockSpy.mockReset().mockResolvedValue(undefined);

    const configLoaderModule = await import('../configLoader.js');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
    } as any);

    const gitModule = await import('../../common/git.js');
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
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

    await handleSetTaskDoneCommand('1', { title: 'Task Two' }, { parent: { opts: () => ({}) } });

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        taskIdentifier: 'Task Two',
        commit: undefined,
      },
      tempDir,
      {
        paths: {
          tasks: tasksDir,
        },
      },
      undefined
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

    await handleSetTaskDoneCommand('1', { index: 2 }, { parent: { opts: () => ({}) } });

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        taskIdentifier: 2,
        commit: undefined,
      },
      tempDir,
      {
        paths: {
          tasks: tasksDir,
        },
      },
      undefined
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
      '1',
      { title: 'Task One', commit: true },
      { parent: { opts: () => ({}) } }
    );

    expect(setTaskDoneSpy).toHaveBeenCalledWith(
      '1',
      {
        taskIdentifier: 'Task One',
        commit: true,
      },
      tempDir,
      {
        paths: {
          tasks: tasksDir,
        },
      },
      undefined
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
      handleSetTaskDoneCommand('1', {}, { parent: { opts: () => ({}) } })
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
      handleSetTaskDoneCommand('1', { title: 'Task', index: 1 }, { parent: { opts: () => ({}) } })
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

    await handleSetTaskDoneCommand('1', { title: 'Last Task' }, { parent: { opts: () => ({}) } });

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

    await handleSetTaskDoneCommand('1', { title: 'First Task' }, { parent: { opts: () => ({}) } });

    expect(releaseLockSpy).not.toHaveBeenCalled();
  });
});
