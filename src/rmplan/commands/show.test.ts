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

  test('shows condensed summary with --short', async () => {
    const plan = {
      id: '2',
      title: 'Condensed Plan',
      goal: 'Should be hidden in short view',
      details: 'This detail text should not appear in short mode.',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task Title 1',
          description: 'Hidden description',
          steps: [{ prompt: 'Hidden step', done: true }],
        },
        {
          title: 'Task Title 2',
          description: 'Another hidden description',
          steps: [],
        },
      ],
      progressNotes: [
        { timestamp: new Date('2024-02-01T00:00:00Z').toISOString(), text: 'Earlier note' },
        {
          timestamp: new Date('2024-02-02T12:00:00Z').toISOString(),
          text: 'Latest note with more details',
          source: 'implementer: Task Beta',
        },
      ],
    } as any;

    await fs.writeFile(path.join(tasksDir, '2.yml'), yaml.stringify(plan));

    const options = { short: true } as any;
    const command = { parent: { opts: () => ({}) } } as any;

    await handleShowCommand('2', options, command);

    const logs = logSpy.mock.calls.map((call) => call[0]).join('\n');

    const stripped = logs.replace(/\x1b\[[0-9;]*m/g, '');

    expect(stripped).toContain('Plan Summary');
    expect(stripped).toContain('Condensed Plan');
    expect(stripped).toContain('Latest Progress Note');
    expect(stripped).toContain('Latest note with more details');
    expect(stripped).toContain('[implementer: Task Beta]');
    expect(stripped).toContain('Earlier note');
    expect(stripped).toContain('Tasks:');
    expect(stripped).toContain('✓  1. Task Title 1');
    expect(stripped).toContain('○  2. Task Title 2');
    expect(stripped).not.toContain('Goal:');
    expect(stripped).not.toContain('Details:');
    expect(stripped).not.toContain('Hidden description');
    expect(stripped).not.toContain('Hidden step');
  });

  test('displays progress notes count and formatted list (default)', async () => {
    const notes = [] as Array<{ timestamp: string; text: string; source?: string }>;
    // Create 12 notes to exercise truncation to last 10
    for (let i = 1; i <= 12; i++) {
      notes.push({
        timestamp: new Date(2024, 0, i, 12, 0, 0).toISOString(),
        text: i === 12 ? 'A multi-line\nnote with details' : `Note ${i} text goes here`,
      });
    }

    const plan = {
      id: '55',
      title: 'Notes Plan',
      goal: 'Test notes',
      details: 'Details',
      status: 'pending',
      tasks: [],
      progressNotes: notes,
    } as any;

    await fs.writeFile(path.join(tasksDir, '55.yml'), yaml.stringify(plan));

    const options = {};
    const command = { parent: { opts: () => ({}) } } as any;

    await handleShowCommand('55', options, command);

    const logs = logSpy.mock.calls.map((c) => c[0]).join('\n');
    // Section header present
    expect(logs).toContain('Progress Notes:');
    // Shows only last 10, so Note 1 and Note 2 should be hidden
    expect(logs).not.toContain('Note 1 text goes here');
    expect(logs).not.toContain('Note 2 text goes here');
    // Note 3..12 should appear. We check a few
    expect(logs).toContain('Note 3 text goes here');
    // Latest note appears, collapsed to single line
    expect(logs).toContain('A multi-line note with details');
    // Default view flattens whitespace to single line
    expect(logs).toContain('A multi-line note with details');
    // Hidden count displayed (standardized ASCII)
    expect(logs).toContain('... and 2 more earlier note(s)');
    // Timestamps are shown in show output (they are omitted only in prompts)
    expect(logs).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
  });

  test('displays full progress notes with --full preserving line breaks', async () => {
    const notes = [
      { timestamp: new Date('2024-01-01T00:00:00.000Z').toISOString(), text: 'First line' },
      {
        timestamp: new Date('2024-01-02T00:00:00.000Z').toISOString(),
        text: 'Line A\nLine B\nLine C',
        source: 'tester: Task Foo',
      },
    ];

    const plan = {
      id: '56',
      title: 'Notes Full Plan',
      goal: 'Test notes full',
      details: 'Details',
      status: 'pending',
      tasks: [],
      progressNotes: notes,
    } as any;

    await fs.writeFile(path.join(tasksDir, '56.yml'), yaml.stringify(plan));

    const options = { full: true } as any;
    const command = { parent: { opts: () => ({}) } } as any;

    await handleShowCommand('56', options, command);

    const logs = logSpy.mock.calls.map((c) => c[0]).join('\n');
    // Both notes visible, no truncation message
    expect(logs).toContain('First line');
    expect(logs).toContain('Line A');
    expect(logs).toContain('Line B');
    expect(logs).toContain('Line C');
    expect(logs).not.toContain('more earlier note(s)');
    expect(logs).toContain('[tester: Task Foo]');
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

  test('finds most recently updated plan with --latest flag', async () => {
    const olderTime = new Date('2024-01-01T00:00:00Z').toISOString();
    const newerTime = new Date('2024-03-05T10:00:00Z').toISOString();

    const plans = [
      {
        id: '10',
        title: 'Older Plan',
        goal: 'Earlier work',
        details: 'Older details',
        status: 'pending',
        updatedAt: olderTime,
        tasks: [],
      },
      {
        id: '11',
        title: 'Latest Plan',
        goal: 'Newest goal',
        details: 'Latest details',
        status: 'pending',
        updatedAt: newerTime,
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      latest: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand(undefined, options, command);

    const logs = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = logs.replace(/\x1b\[[0-9;]*m/g, '');

    expect(stripped).toContain('Found latest plan: 11 - Latest Plan');
    expect(stripped).toContain('Latest Plan');
    expect(stripped).toContain('Newest goal');
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
      'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
    );
  });
});
