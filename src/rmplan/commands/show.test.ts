import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import stripAnsi from 'strip-ansi';
import { handleShowCommand } from './show.js';
import { clearPlanCache } from '../plans.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});

describe('handleShowCommand', () => {
  let tempDir: string;
  let repoDir: string;
  let tasksDir: string;
  let repositoryId: string;
  let assignmentsData: Record<string, any>;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-show-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    repositoryId = 'show-tests';
    assignmentsData = {};

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
      }),
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.ts', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId,
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: repoDir,
      }),
    }));

    await moduleMocker.mock('../assignments/assignments_io.js', () => ({
      readAssignments: async () => ({
        repositoryId,
        repositoryRemoteUrl: 'https://example.com/repo.git',
        version: 0,
        assignments: assignmentsData,
      }),
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
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Test Plan');
    expect(stripped).toContain('Test goal');
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

    const stripped = stripAnsi(logs);

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
    const stripped = stripAnsi(logs);
    // Section header present
    expect(stripped).toContain('Progress Notes:');
    // Shows only last 10, so Note 1 and Note 2 should be hidden
    expect(stripped).not.toContain('Note 1 text goes here');
    expect(stripped).not.toContain('Note 2 text goes here');
    // Note 3..12 should appear. We check a few
    expect(stripped).toContain('Note 3 text goes here');
    // Latest note appears, collapsed to single line
    expect(stripped).toContain('A multi-line note with details');
    // Default view flattens whitespace to single line
    expect(stripped).toContain('A multi-line note with details');
    // Hidden count displayed (standardized ASCII)
    expect(stripped).toContain('... and 2 more earlier note(s)');
    // Timestamps are shown in show output (they are omitted only in prompts)
    expect(stripped).toMatch(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
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
    const stripped = stripAnsi(logs);
    // Both notes visible, no truncation message
    expect(stripped).toContain('First line');
    expect(stripped).toContain('Line A');
    expect(stripped).toContain('Line B');
    expect(stripped).toContain('Line C');
    expect(stripped).not.toContain('more earlier note(s)');
    expect(stripped).toContain('[tester: Task Foo]');
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
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Found next ready plan: 1');
    expect(stripped).toContain('Ready Plan');
    expect(stripped).toContain('Ready to start');
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
    const stripped = stripAnsi(allOutput);

    expect(stripped).toContain('Found current plan: 1');
    expect(stripped).toContain('In Progress Plan');
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
    const stripped = stripAnsi(logs);

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

  test('displays workspace and user assignments when present', async () => {
    const now = new Date().toISOString();
    const plan = {
      id: '8',
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Assignment Plan',
      goal: 'Show assignment info',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '8.yml'), yaml.stringify(plan));

    assignmentsData = {
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
        planId: 8,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('8', options, command);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Workspace:');
    expect(stripped).toContain('Users: alice');
  });

  test('warns when a plan is claimed in multiple workspaces', async () => {
    const plan = {
      id: '9',
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Conflicted Plan',
      goal: 'Warn on conflicts',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '9.yml'), yaml.stringify(plan));

    assignmentsData = {
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': {
        planId: 9,
        workspacePaths: [repoDir, path.join(tempDir, 'other-workspace')],
        users: ['alice', 'bob'],
        status: 'pending',
        assignedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('9', options, command);

    expect(warnSpy).toHaveBeenCalled();
  });

  test('falls back to assignedTo when no shared assignment exists', async () => {
    const plan = {
      id: '10',
      title: 'Legacy Assignment Plan',
      goal: 'Check assignedTo fallback',
      status: 'pending',
      assignedTo: 'carol',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '10.yml'), yaml.stringify(plan));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleShowCommand('10', options, command);

    const output = logSpy.mock.calls.map((call) => call[0]).join('\n');
    const stripped = stripAnsi(output);
    expect(stripped).toContain('Assigned To: carol');
  });
});
