import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock logging functions
const mockLog = mock(() => {});
const mockError = mock(() => {});
const mockWarn = mock(() => {});

// Mock table to capture output
const mockTable = mock((data: any[]) => {
  return data.map((row) => row.join('\t')).join('\n');
});

// Now import the module being tested
import { handleListCommand } from './list.js';
import { clearPlanCache } from '../plans.js';

describe('handleListCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    mockLog.mockClear();
    mockError.mockClear();
    mockWarn.mockClear();
    mockTable.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-list-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    // Set up mocks immediately before imports
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      error: mockError,
      warn: mockWarn,
    }));

    // Mock chalk to avoid ANSI codes in tests
    const chalkMock = (str: string) => str;
    await moduleMocker.mock('chalk', () => ({
      default: {
        green: chalkMock,
        yellow: chalkMock,
        red: chalkMock,
        redBright: chalkMock,
        gray: chalkMock,
        bold: chalkMock,
        dim: chalkMock,
        cyan: chalkMock,
        white: chalkMock,
        magenta: chalkMock,
        blue: chalkMock,
        rgb: () => chalkMock,
        strikethrough: {
          gray: chalkMock,
        },
      },
    }));

    await moduleMocker.mock('table', () => ({
      table: mockTable,
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
    // Clean up filesystem
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    moduleMocker.clear();
  });

  test('lists no plans when directory is empty', async () => {
    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockLog).toHaveBeenCalledWith('No plan files found in', tasksDir);
    expect(mockTable).not.toHaveBeenCalled();
  });

  test('lists all plans when --all flag is used', async () => {
    // Create test plans with different statuses
    const plans = [
      {
        id: 1,
        title: 'Pending Plan',
        goal: 'Test pending',
        details: 'Details',
        status: 'pending',
        priority: 'medium',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: 2,
        title: 'In Progress Plan',
        goal: 'Test in progress',
        details: 'Details',
        status: 'in_progress',
        priority: 'high',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: 3,
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
        priority: 'low',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      all: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    // Should display all plans
    expect(mockTable).toHaveBeenCalled();
    const tableCall = mockTable.mock.calls[0];
    const tableData = tableCall[0];

    // Header + 3 plans = 4 rows
    expect(tableData).toHaveLength(4);

    // Check that all plans are included
    const planIds = tableData.slice(1).map((row) => row[0]);
    expect(planIds).toContain(1);
    expect(planIds).toContain(2);
    expect(planIds).toContain(3);
  });

  test('filters plans by status when --status flag is used', async () => {
    // Create test plans
    const plans = [
      {
        id: 1,
        title: 'Pending Plan 1',
        goal: 'Test pending',
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
      {
        id: 2,
        title: 'Pending Plan 2',
        goal: 'Test pending',
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
      {
        id: 3,
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
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
      status: ['done'],
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 1 done plan = 2 rows
    expect(tableData).toHaveLength(2);
    expect(tableData[1][0]).toBe(3); // Only the done plan
  });

  test('shows only pending and in_progress plans by default', async () => {
    // Create test plans
    const plans = [
      {
        id: 1,
        title: 'Pending Plan',
        goal: 'Test pending',
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
      {
        id: 2,
        title: 'In Progress Plan',
        goal: 'Test in progress',
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
        id: 3,
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
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

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 2 plans (pending and in_progress) = 3 rows
    expect(tableData).toHaveLength(3);

    const planIds = tableData.slice(1).map((row) => row[0]);
    expect(planIds).toContain(1);
    expect(planIds).toContain(2);
    expect(planIds).not.toContain(3);
  });

  test('filters by ready status', async () => {
    // Create a simple pending plan with no dependencies (so it's ready)
    const plan = {
      id: 1,
      title: 'Ready Plan',
      goal: 'Test ready',
      details: 'Details',
      status: 'pending',
      // No dependencies, so it's ready
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [
            {
              description: 'Step 1',
              prompt: 'Do step',
              status: 'pending',
            },
          ],
        },
      ],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      status: ['ready'],
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 1 ready plan = 2 rows
    expect(tableData).toHaveLength(2);
    expect(tableData[1][0]).toBe(1); // The ready plan
  });

  test('uses custom directory when --dir is specified', async () => {
    const customDir = path.join(tempDir, 'custom-tasks');
    await fs.mkdir(customDir, { recursive: true });

    // Create a plan in the custom directory
    const plan = {
      id: 1,
      title: 'Custom Dir Plan',
      goal: 'Test custom dir',
      details: 'Details',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [{ prompt: 'Do step', done: false }],
        },
      ],
    };

    await fs.writeFile(path.join(customDir, '1.yml'), yaml.stringify(plan));

    const options = {
      dir: customDir,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(2); // Header + 1 plan
    expect(tableData[1][0]).toBe(1);
  });

  test('handles plans with projects in title display', async () => {
    const plan = {
      id: 1,
      title: 'Plan Title',
      goal: 'Test project',
      details: 'Details',
      status: 'pending',
      project: {
        title: 'project-123',
        goal: 'Project goal',
        details: 'Project details',
      },
      tasks: [
        {
          title: 'Task 1',
          description: 'Do task',
          steps: [{ prompt: 'Do step', done: false }],
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

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // The combined title should include the project
    expect(tableData[1][1]).toContain('project-123');
    expect(tableData[1][1]).toContain('Plan Title');
  });

  test('displays dependency status indicators', async () => {
    // Create plans with dependencies
    const plans = [
      {
        id: 1,
        title: 'Dependency 1',
        goal: 'First dependency',
        details: 'Details',
        status: 'done',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: 2,
        title: 'Dependency 2',
        goal: 'Second dependency',
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
        id: 3,
        title: 'Dependency 3',
        goal: 'Third dependency',
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
      {
        id: 4,
        title: 'Main Plan',
        goal: 'Test dependencies',
        details: 'Details',
        status: 'pending',
        dependencies: [1, 2, 3, 999], // 999 is non-existent
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Find the main plan row (id=4)
    const mainPlanRow = tableData.find((row) => row[0] === 4);
    expect(mainPlanRow).toBeTruthy();

    // Check dependencies column (index 6)
    const depsColumn = mainPlanRow[6];

    // Should show status indicators:
    // - 1✓ (done)
    // - 2… (in_progress)
    // - 3 (pending)
    // - 999(?) (not found)
    expect(depsColumn).toContain('1✓');
    expect(depsColumn).toContain('2…');
    expect(depsColumn).toContain('3');
    expect(depsColumn).toContain('999(?)');
  });

  test('filters plans by search terms', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();

    // Create test plans with various titles
    const plan1 = {
      id: 1,
      title: 'Implement user authentication',
      goal: 'Add user authentication',
      details: 'Implement basic authentication system',
      status: 'pending',
      tasks: [],
    };
    const plan2 = {
      id: 2,
      title: 'Add OAuth integration',
      goal: 'Integrate OAuth providers',
      details: 'Add support for OAuth authentication',
      status: 'pending',
      tasks: [],
    };
    const plan3 = {
      id: 3,
      title: 'Fix authentication bug',
      goal: 'Fix auth bug',
      details: 'Resolve authentication-related issues',
      status: 'pending',
      tasks: [],
    };
    const plan4 = {
      id: 4,
      title: 'Update database schema',
      goal: 'Update DB schema',
      details: 'Modify database schema for new features',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan1));
    await fs.writeFile(path.join(tasksDir, '2.yml'), yaml.stringify(plan2));
    await fs.writeFile(path.join(tasksDir, '3.yml'), yaml.stringify(plan3));
    await fs.writeFile(path.join(tasksDir, '4.yml'), yaml.stringify(plan4));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Search for 'auth'
    await handleListCommand(options, command, ['auth']);

    // Check that log was called with the right output
    expect(mockLog).toHaveBeenCalled();

    // Debug: print all log calls to understand what's happening
    const logCalls = mockLog.mock.calls;

    // Find the log call that contains "Showing"
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));

    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 3 of 4 plan(s)');

    // Check that table was called and verify contents
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(4); // Header + 3 plans with 'auth'
    expect(tableData[1][1]).toBe('Implement user authentication');
    expect(tableData[2][1]).toBe('Add OAuth integration');
    expect(tableData[3][1]).toBe('Fix authentication bug');
  });

  test('search is case insensitive', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();

    const plan1 = {
      id: 1,
      title: 'Implement USER Authentication',
      goal: 'Add user authentication',
      details: 'Implement authentication system',
      status: 'pending',
      tasks: [],
    };
    const plan2 = {
      id: 2,
      title: 'Add user profile',
      goal: 'User profile feature',
      details: 'Add user profile functionality',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan1));
    await fs.writeFile(path.join(tasksDir, '2.yml'), yaml.stringify(plan2));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Search for 'USER' in uppercase
    await handleListCommand(options, command, ['USER']);

    // Check that log was called with the right output
    expect(mockLog).toHaveBeenCalled();
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 2 of 2 plan(s)');

    // Should find both plans
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(3); // Header + 2 plans
  });

  test('multiple search terms match any term', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();

    const plan1 = {
      id: 1,
      title: 'Implement database migration',
      goal: 'Database migration',
      details: 'Implement database migration system',
      status: 'pending',
      tasks: [],
    };
    const plan2 = {
      id: 2,
      title: 'Add user authentication',
      goal: 'User authentication',
      details: 'Add authentication functionality',
      status: 'pending',
      tasks: [],
    };
    const plan3 = {
      id: 3,
      title: 'Fix CSS bug',
      goal: 'CSS bug fix',
      details: 'Fix styling issues',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan1));
    await fs.writeFile(path.join(tasksDir, '2.yml'), yaml.stringify(plan2));
    await fs.writeFile(path.join(tasksDir, '3.yml'), yaml.stringify(plan3));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Search for 'database' OR 'user'
    await handleListCommand(options, command, ['database', 'user']);

    // Check that log was called with the right output
    expect(mockLog).toHaveBeenCalled();
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 2 of 3 plan(s)');

    // Should find plans 1 and 2
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(3); // Header + 2 plans
    expect(tableData[1][1]).toBe('Implement database migration');
    expect(tableData[2][1]).toBe('Add user authentication');
  });

  test('handles numeric string dependencies', async () => {
    // Create plans where one uses numeric IDs and another uses string dependencies
    const plans = [
      {
        id: 10,
        title: 'Numeric ID Plan',
        goal: 'Has numeric ID',
        details: 'Details',
        status: 'done',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
      {
        id: 11,
        title: 'Main Plan',
        goal: 'Test numeric string dependencies',
        details: 'Details',
        status: 'pending',
        dependencies: [10], // Numeric reference to numeric ID
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      all: true,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Find the main plan row
    const mainPlanRow = tableData.find((row) => row[0] === 11);
    expect(mainPlanRow).toBeTruthy();

    // Check that the dependency is found and shows as done
    const depsColumn = mainPlanRow[6];
    expect(depsColumn).toContain('10✓');
  });

  test('limits results when -n option is used', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();
    mockLog.mockClear();

    // Create 10 test plans
    const plans = [];
    for (let i = 1; i <= 10; i++) {
      plans.push({
        id: i,
        title: `Plan ${i}`,
        goal: `Goal ${i}`,
        details: 'Details',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      });
    }

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      number: 5,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    // Check that table was called and has exactly 6 rows (1 header + 5 data rows)
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(6); // Header + 5 plans

    // Check the status message shows limiting
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 5 of 10 plan(s) (limited to 5)');

    // Verify the last 5 plans are shown (IDs 6-10)
    const shownIds = tableData.slice(1).map((row) => row[0]);
    expect(shownIds).toEqual([6, 7, 8, 9, 10]);
  });

  test('shows all plans when -n is larger than available plans', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();
    mockLog.mockClear();

    // Create 3 test plans
    const plans = [];
    for (let i = 1; i <= 3; i++) {
      plans.push({
        id: i,
        title: `Plan ${i}`,
        goal: `Goal ${i}`,
        details: 'Details',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do task',
            steps: [{ prompt: 'Do step', done: false }],
          },
        ],
      });
    }

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      number: 10,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    // Check that table was called and has 4 rows (1 header + 3 data rows)
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(4); // Header + 3 plans

    // Check the status message doesn't show limiting (since all plans are shown)
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 3 of 3 plan(s)');
  });

  test('combines -n option with status filtering', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();
    mockLog.mockClear();

    // Create plans with different statuses
    const plans = [
      {
        id: 1,
        title: 'Done Plan 1',
        goal: 'Done goal 1',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 2,
        title: 'Done Plan 2',
        goal: 'Done goal 2',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 3,
        title: 'Done Plan 3',
        goal: 'Done goal 3',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 4,
        title: 'Done Plan 4',
        goal: 'Done goal 4',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 5,
        title: 'Pending Plan',
        goal: 'Pending goal',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      status: ['done'],
      number: 2,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    // Check that table was called and has 3 rows (1 header + 2 data rows)
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(3); // Header + 2 plans

    // Check the status message shows limiting applied after filtering
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 2 of 4 plan(s) (limited to 2)');

    // Verify the last 2 done plans are shown (IDs 3 and 4)
    const shownIds = tableData.slice(1).map((row) => row[0]);
    expect(shownIds).toEqual([3, 4]);
  });

  test('combines -n option with sorting', async () => {
    // Clear cache and mocks
    clearPlanCache();
    mockTable.mockClear();
    mockLog.mockClear();

    // Create plans with different IDs, not in order
    const plans = [
      {
        id: 5,
        title: 'Plan 5',
        goal: 'Goal 5',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 1,
        title: 'Plan 1',
        goal: 'Goal 1',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 3,
        title: 'Plan 3',
        goal: 'Goal 3',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 8,
        title: 'Plan 8',
        goal: 'Goal 8',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 2,
        title: 'Plan 2',
        goal: 'Goal 2',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      sort: 'id',
      reverse: true, // Sort by ID in reverse order (highest first)
      number: 3,
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options, command);

    // Check that table was called and has 4 rows (1 header + 3 data rows)
    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(4); // Header + 3 plans

    // Check the status message shows limiting
    const logCalls = mockLog.mock.calls;
    const showingCall = logCalls.find((call) => call[0] && call[0].toString().includes('Showing'));
    expect(showingCall).toBeTruthy();
    expect(showingCall[0]).toBe('Showing 3 of 5 plan(s) (limited to 3)');

    // With reverse sort, the order should be [8, 5, 3, 2, 1]
    // Taking the last 3 should give us [3, 2, 1]
    const shownIds = tableData.slice(1).map((row) => row[0]);
    expect(shownIds).toEqual([3, 2, 1]);
  });
});

// Clean up module-level mocks after all tests
afterAll(() => {
  moduleMocker.clear();
});
