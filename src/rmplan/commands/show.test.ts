import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleShowCommand } from './show.js';
import { clearPlanCache } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

describe('handleShowCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-show-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
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
    await moduleMocker.mock('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('shows plan details when given valid plan ID', async () => {
    // Create a test plan
    const plan = {
      id: '1',
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      priority: 'medium',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do something',
          steps: [
            {
              prompt: 'Do step 1',
              done: true,
            },
            {
              prompt: 'Do step 2',
              done: false,
            },
          ],
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

    await handleShowCommand('1', options, command);

    // Should display plan details
    expect(logSpy).toHaveBeenCalled();

    // Check that key information is displayed
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');

    expect(allOutput).toContain('Test Plan');
    expect(allOutput).toContain('Test goal');
  });

  test('shows error when plan file not found', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleShowCommand('nonexistent', options, command)).rejects.toThrow();
  });

  test('finds next ready plan with --next flag', async () => {
    // Clear the plan cache before creating plans
    clearPlanCache();

    // Create a simple pending plan with no dependencies
    const plan = {
      id: '1',
      title: 'Ready Plan',
      goal: 'Ready to start',
      details: 'Details',
      status: 'pending',
      priority: 'high',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task 1',
          steps: [
            {
              prompt: 'Do step 1',
              done: false,
            },
          ],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      next: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');

    expect(allOutput).toContain('Found next ready plan: 1');
    expect(allOutput).toContain('Ready Plan');
    expect(allOutput).toContain('Ready to start');
  });

  test('finds current in-progress plan with --current flag', async () => {
    // Create plans
    const plans = [
      {
        id: '1',
        title: 'In Progress Plan',
        goal: 'Currently working on',
        details: 'Details',
        status: 'in_progress',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: '2',
        title: 'Pending Plan',
        goal: 'Not started',
        details: 'Details',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      current: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');

    expect(allOutput).toContain('Found current plan: 1');
    expect(allOutput).toContain('In Progress Plan');
  });

  test('shows message when no ready plans found', async () => {
    // Create only blocked plans
    const plan = {
      id: '1',
      title: 'Blocked Plan',
      goal: 'Blocked by dependencies',
      details: 'Details',
      status: 'pending',
      dependencies: ['nonexistent'],
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [{ prompt: 'Do step', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      next: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    expect(logSpy).toHaveBeenCalledWith(
      'No ready plans found. All pending plans have incomplete dependencies.'
    );
  });

  test('shows error when no plan file provided and no flags', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleShowCommand(undefined, options, command)).rejects.toThrow(
      'Please provide a plan file or use --next/--current/--next-ready to find a plan'
    );
  });
});
