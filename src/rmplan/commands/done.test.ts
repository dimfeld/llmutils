import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleDoneCommand } from './done.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

mock.module('../../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: mock(() => {}),
}));

// Mock markStepDone from actions.js
const markStepDoneSpy = mock(async () => ({
  planComplete: false,
  markedCount: 1,
}));
mock.module('../actions.js', () => ({
  markStepDone: markStepDoneSpy,
}));

// Mock WorkspaceLock
const releaseLockSpy = mock(async () => {});
mock.module('../workspace/workspace_lock.js', () => ({
  WorkspaceLock: {
    releaseLock: releaseLockSpy,
  },
}));

// Mock process.exit
const originalExit = process.exit;
const exitSpy = mock(() => {
  throw new Error('process.exit called');
});

describe('handleDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
    markStepDoneSpy.mockClear();
    releaseLockSpy.mockClear();

    // Mock process.exit
    process.exit = exitSpy as any;

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock config loader
    mock.module('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    // Mock utils
    mock.module('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Restore process.exit
    process.exit = originalExit;

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '1',
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '3',
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      task: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      steps: '1',
      commit: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock markStepDone to return planComplete: true
    markStepDoneSpy.mockResolvedValue({
      planComplete: true,
      markedCount: 1,
    });

    const options = {
      steps: '1',
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand('1', options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    // Mock markStepDone to throw an error
    markStepDoneSpy.mockRejectedValue(new Error('Test error'));

    const options = {
      steps: '1',
      parent: {
        opts: () => ({}),
      },
    };

    try {
      await handleDoneCommand('1', options);
    } catch (e) {
      // Expected due to process.exit mock
    }

    expect(errorSpy).toHaveBeenCalledWith('Failed to process plan: Error: Test error');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('handles non-existent plan file', async () => {
    const options = {
      steps: '1',
      parent: {
        opts: () => ({}),
      },
    };

    try {
      await handleDoneCommand('nonexistent', options);
    } catch (e) {
      // Expected due to process.exit mock
    }

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
