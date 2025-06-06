import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleDoneCommand } from './done.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

// Mock markStepDone from actions.js
const markStepDoneSpy = mock(async () => ({
  planComplete: false,
  message: 'Marked 1 step done',
}));

// Mock WorkspaceLock
const releaseLockSpy = mock(async () => {});

describe('handleDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    markStepDoneSpy.mockClear();
    releaseLockSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../actions.js', () => ({
      markStepDone: markStepDoneSpy,
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

  test('calls markStepDone with correct parameters for single step', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          files: [],
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '1',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options, command);

    // Check that markStepDone was called with correct parameters
    expect(markStepDoneSpy).toHaveBeenCalledWith(
      expect.stringContaining('1.yml'),
      {
        task: undefined,
        steps: 1,
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });

  test('calls markStepDone with multiple steps', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [{ prompt: 'Test step prompt', done: false }],
          files: [],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '3',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      expect.stringContaining('1.yml'),
      {
        task: undefined,
        steps: 3,
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });

  test('calls markStepDone with task flag', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      task: true,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      expect.stringContaining('1.yml'),
      {
        task: true,
        steps: 1,
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });

  test('calls markStepDone with commit flag', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '1',
      commit: true,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      expect.stringContaining('1.yml'),
      {
        task: undefined,
        steps: 1,
        commit: true,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });

  test('releases workspace lock when plan is complete', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock markStepDone to return planComplete: true
    markStepDoneSpy.mockResolvedValue({
      planComplete: true,
      message: 'All steps complete',
    });

    const options = {
      steps: '1',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options, command);

    expect(releaseLockSpy).toHaveBeenCalledWith(tempDir);
    expect(logSpy).toHaveBeenCalledWith('Released workspace lock');
  });

  test('handles errors from markStepDone', async () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Test Task',
          description: 'Test task description',
          steps: [{ prompt: 'Test step prompt', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock markStepDone to throw an error
    markStepDoneSpy.mockImplementation(async () => {
      throw new Error('Test error');
    });

    const options = {
      steps: '1',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleDoneCommand('1', options, command)).rejects.toThrow('Test error');
  });

  test('handles non-existent plan file', async () => {
    const options = {
      steps: '1',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleDoneCommand('nonexistent', options, command)).rejects.toThrow();
  });
});
