import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleShowCommand } from './show.js';
import { clearPlanCache } from '../plans.js';

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

mock.module('../../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: mock(() => {}),
}));

// Mock process.exit
const originalExit = process.exit;
const exitSpy = mock(() => {
  throw new Error('process.exit called');
});

describe('handleShowCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();

    // Mock process.exit
    process.exit = exitSpy as any;

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-show-test-'));
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
              description: 'Step 1',
              prompt: 'Do step 1',
              status: 'done',
            },
            {
              description: 'Step 2',
              prompt: 'Do step 2',
              status: 'pending',
            },
          ],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('1', options);

    // Should display plan details
    expect(logSpy).toHaveBeenCalled();

    // Check that key information is displayed
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');

    expect(allOutput).toContain('Test Plan');
    expect(allOutput).toContain('Test goal');
  });

  test('shows error when plan file not found', async () => {
    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    try {
      await handleShowCommand('nonexistent', options);
    } catch (e) {
      // Expected to throw due to process.exit mock
    }

    expect(errorSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('finds next ready plan with --next flag', async () => {
    // Clear the plan cache before creating plans
    clearPlanCache();

    // Create plans with dependencies
    const plans = [
      {
        id: 1, // Use numeric ID to match the expected dependency
        title: 'Done Plan',
        goal: 'Already done',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 2, // Use numeric ID
        title: 'Ready Plan',
        goal: 'Ready to start',
        details: 'Details',
        status: 'pending',
        priority: 'high',
        dependencies: [1], // Use numeric dependency
        tasks: [],
      },
      {
        id: 3, // Use numeric ID
        title: 'Blocked Plan',
        goal: 'Blocked by dependencies',
        details: 'Details',
        status: 'pending',
        dependencies: [2], // Use numeric dependency
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      next: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options);

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');

    expect(allOutput).toContain('Found next ready plan: 2');
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
        tasks: [],
      },
      {
        id: '2',
        title: 'Pending Plan',
        goal: 'Not started',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      current: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options);

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
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      next: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options);

    expect(logSpy).toHaveBeenCalledWith(
      'No ready plans found. All pending plans have incomplete dependencies.'
    );
  });

  test('shows error when no plan file provided and no flags', async () => {
    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    try {
      await handleShowCommand(undefined, options);
    } catch (e) {
      // Expected to throw due to process.exit mock
    }

    expect(errorSpy).toHaveBeenCalledWith(
      'Please provide a plan file or use --next/--current to find a plan'
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
