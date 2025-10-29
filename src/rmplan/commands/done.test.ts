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
  const moduleMocker = new ModuleMocker(import.meta);

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(await fs.realpath('/tmp'), 'rmplan-done-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Write config file so plan resolution works
    const configDir = path.join(tempDir, '.rmfilter');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, 'rmplan.yml'),
      `paths:\n  tasks: ${tasksDir}\n`
    );

    // Mock markStepDone
    markStepDoneSpy = mock(async () => ({
      planComplete: false,
      message: 'Task marked as done',
    }));

    await moduleMocker.mock('../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
    }));

    // Mock getGitRoot to return tempDir
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
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
        opts: () => ({ config: path.join(tempDir, '.rmfilter/rmplan.yml') }),
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
        opts: () => ({ config: path.join(tempDir, '.rmfilter/rmplan.yml') }),
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

  test('uses plan ID as first argument', async () => {
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
        opts: () => ({ config: path.join(tempDir, '.rmfilter/rmplan.yml') }),
      },
    };

    await handleDoneCommand('1', options, command);

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
