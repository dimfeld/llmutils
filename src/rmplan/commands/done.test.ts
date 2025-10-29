import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import yaml from 'yaml';
import { handleDoneCommand } from './done.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

describe('handleDoneCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let markStepDoneSpy: ReturnType<typeof mock>;
  const moduleMocker = new ModuleMocker();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'rmplan-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock markStepDone
    markStepDoneSpy = mock(async () => ({
      planComplete: false,
      message: 'Task marked as done',
    }));

    await moduleMocker.mock('../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('calls markStepDone with correct parameters', async () => {
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
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {};

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
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
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
        commit: true,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });

  test('uses plan from options.plan when provided', async () => {
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
          done: false,
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      plan: '1',
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDoneCommand(undefined, options, command);

    expect(markStepDoneSpy).toHaveBeenCalledWith(
      expect.stringContaining('1.yml'),
      {
        commit: undefined,
      },
      undefined,
      tempDir,
      expect.any(Object)
    );
  });
});
