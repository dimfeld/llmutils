import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleListCommand } from './list.js';
import { clearPlanCache } from '../plans.js';

// Mock logging functions
const mockLog = mock(() => {});
const mockError = mock(() => {});
const mockWarn = mock(() => {});

mock.module('../../logging.js', () => ({
  log: mockLog,
  error: mockError,
  warn: mockWarn,
}));

// Mock chalk to avoid ANSI codes in tests
mock.module('chalk', () => ({
  default: {
    green: (str: string) => str,
    yellow: (str: string) => str,
    red: (str: string) => str,
    gray: (str: string) => str,
    bold: (str: string) => str,
    dim: (str: string) => str,
  },
}));

// Mock table to capture output
const mockTable = mock((data: any[]) => {
  return data.map((row) => row.join('\t')).join('\n');
});

mock.module('table', () => ({
  table: mockTable,
}));

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
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('lists no plans when directory is empty', async () => {
    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockLog).toHaveBeenCalledWith('No plan files found in', tasksDir);
    expect(mockTable).not.toHaveBeenCalled();
  });

  test('lists all plans when --all flag is used', async () => {
    // Create test plans with different statuses
    const plans = [
      {
        id: '1',
        title: 'Pending Plan',
        goal: 'Test pending',
        details: 'Details',
        status: 'pending',
        priority: 'medium',
        tasks: [],
      },
      {
        id: '2',
        title: 'In Progress Plan',
        goal: 'Test in progress',
        details: 'Details',
        status: 'in_progress',
        priority: 'high',
        tasks: [],
      },
      {
        id: '3',
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
        priority: 'low',
        tasks: [],
      },
    ];

    // Write plan files
    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      all: true,
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    // Should display all plans
    expect(mockTable).toHaveBeenCalled();
    const tableCall = mockTable.mock.calls[0];
    const tableData = tableCall[0];

    // Header + 3 plans = 4 rows
    expect(tableData).toHaveLength(4);

    // Check that all plans are included
    const planIds = tableData.slice(1).map((row) => row[0]);
    expect(planIds).toContain('1');
    expect(planIds).toContain('2');
    expect(planIds).toContain('3');
  });

  test('filters plans by status when --status flag is used', async () => {
    // Create test plans
    const plans = [
      {
        id: '1',
        title: 'Pending Plan 1',
        goal: 'Test pending',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: '2',
        title: 'Pending Plan 2',
        goal: 'Test pending',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: '3',
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      status: ['done'],
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 1 done plan = 2 rows
    expect(tableData).toHaveLength(2);
    expect(tableData[1][0]).toBe('3'); // Only the done plan
  });

  test('shows only pending and in_progress plans by default', async () => {
    // Create test plans
    const plans = [
      {
        id: '1',
        title: 'Pending Plan',
        goal: 'Test pending',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: '2',
        title: 'In Progress Plan',
        goal: 'Test in progress',
        details: 'Details',
        status: 'in_progress',
        tasks: [],
      },
      {
        id: '3',
        title: 'Done Plan',
        goal: 'Test done',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 2 plans (pending and in_progress) = 3 rows
    expect(tableData).toHaveLength(3);

    const planIds = tableData.slice(1).map((row) => row[0]);
    expect(planIds).toContain('1');
    expect(planIds).toContain('2');
    expect(planIds).not.toContain('3');
  });

  test('filters by ready status', async () => {
    // Create test plans with dependencies
    const plans = [
      {
        id: '1',
        title: 'Dependency Plan',
        goal: 'Test dependency',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: '2',
        title: 'Ready Plan',
        goal: 'Test ready',
        details: 'Details',
        status: 'pending',
        dependencies: ['1'], // Depends on done plan, so it's ready
        tasks: [],
      },
      {
        id: '3',
        title: 'Blocked Plan',
        goal: 'Test blocked',
        details: 'Details',
        status: 'pending',
        dependencies: ['2'], // Depends on pending plan, so it's blocked
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const options = {
      status: ['ready'],
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Header + 1 ready plan = 2 rows
    expect(tableData).toHaveLength(2);
    expect(tableData[1][0]).toBe('2'); // Only the ready plan
  });

  test('uses custom directory when --dir is specified', async () => {
    const customDir = path.join(tempDir, 'custom-tasks');
    await fs.mkdir(customDir, { recursive: true });

    // Create a plan in the custom directory
    const plan = {
      id: '1',
      title: 'Custom Dir Plan',
      goal: 'Test custom dir',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };

    await fs.writeFile(path.join(customDir, '1.yml'), yaml.stringify(plan));

    const options = {
      dir: customDir,
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];
    expect(tableData).toHaveLength(2); // Header + 1 plan
    expect(tableData[1][0]).toBe('1');
  });

  test('handles plans with projects in title display', async () => {
    const plan = {
      id: '1',
      title: 'Plan Title',
      goal: 'Test project',
      details: 'Details',
      status: 'pending',
      project: 'project-123',
      tasks: [],
    };

    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const options = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleListCommand(options);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // The combined title should include the project
    expect(tableData[1][1]).toContain('project-123');
    expect(tableData[1][1]).toContain('Plan Title');
  });
});
