import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { readPlanFile, resolvePlanByNumericId, writePlanFile } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { handleAddCommand } from './commands/add.js';
import { handleAddTaskCommand } from './commands/add-task.js';
import { handleDoneCommand } from './commands/done.js';
import { handleRemoveTaskCommand } from './commands/remove-task.js';

// Handlers that rely on mocked modules are imported dynamically in beforeEach
let handleListCommand: any;
let handleShowCommand: any;

// Mock the logging module
const { mockLog } = vi.hoisted(() => ({
  mockLog: vi.fn(() => {}),
}));

// Import mocked modules for setup
import { table } from 'table';
import { getGitRoot, getCurrentBranchName } from '../common/git.js';

vi.mock('../logging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../logging.js')>();
  return {
    ...actual,
    log: mockLog,
    debugLog: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  };
});

// Mock the table module
vi.mock('table', () => ({
  table: vi.fn((data: any[]) => data.map((row: any[]) => row.join('\t')).join('\n')),
}));

// Mock the git module
vi.mock('../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(),
    getCurrentBranchName: vi.fn(),
  };
});

// Helper to get typed mock
const mockGetGitRoot = getGitRoot as ReturnType<typeof vi.fn>;
const mockGetCurrentBranchName = getCurrentBranchName as ReturnType<typeof vi.fn>;

describe('tim CLI integration tests (internal handlers)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    // Clear plan cache

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks',
        },
      })
    );

    // Set up logging mocks and dynamically import handlers that use them
    mockLog.mockClear();

    // Set up mock implementations
    mockGetGitRoot.mockReturnValue(tempDir);
    mockGetCurrentBranchName.mockReturnValue(null);

    // Import handlers that rely on mocked modules
    const listModule = await import('./commands/list.js');
    const showModule = await import('./commands/show.js');
    handleListCommand = listModule.handleListCommand;
    handleShowCommand = showModule.handleShowCommand;
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('tim add creates a new plan', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } };
    await handleAddCommand(['Integration', 'Test', 'Plan'], {}, command);

    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(0);

    const { plan } = await resolvePlanByNumericId(1, tempDir);
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Integration Test Plan');
  });

  test('tim list shows created plans', async () => {
    // Create a test plan
    const plan = {
      id: 1,
      title: 'List Test Plan',
      goal: 'Test listing',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    await writePlanFile(path.join(tasksDir, '1.yml'), plan);

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleListCommand({ sort: 'created' }, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('List Test Plan');
  });

  test('tim show displays plan details', async () => {
    // Create a test plan
    const plan: PlanSchema = {
      id: 1,
      title: 'Show Test Plan',
      goal: 'Test showing plan details',
      details: 'Detailed description of the plan',
      status: 'pending',
      priority: 'high',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
      ],
    };
    await writePlanFile(path.join(tasksDir, '1.yml'), plan);

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleShowCommand(1, {}, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('Show Test Plan');
    expect(calls).toContain('Task 1');
  });

  test('tim done marks task as complete', async () => {
    // Create a test plan with a task
    const plan: PlanSchema = {
      id: 1,
      title: 'Done Test Plan',
      goal: 'Test marking task done',
      details: 'Details',
      status: 'in_progress',
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
        },
      ],
    };
    await writePlanFile(path.join(tasksDir, '1.yml'), plan);

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleDoneCommand(1, {}, command);

    // Verify the task was marked as done
    const updatedPlan = (await resolvePlanByNumericId(1, tempDir)).plan;

    // The plan should have tasks
    expect(updatedPlan.tasks).toBeDefined();
    expect(updatedPlan.tasks.length).toBeGreaterThan(0);

    // Check task status
    expect(updatedPlan.tasks[0].done).toBe(true);
  });

  test('tim add-task appends a new task to an existing plan', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;

    await handleAddCommand(['Integration', 'AddTask', 'Plan'], {}, command);

    const initialPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(initialPlan.tasks ?? []).toHaveLength(0);

    mockLog.mockClear();
    await handleAddTaskCommand(
      1,
      {
        title: 'Integration Task',
        description: 'Created via add-task integration test',
      },
      command
    );

    const updatedPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(updatedPlan.tasks).toHaveLength(1);
    const [task] = updatedPlan.tasks;
    expect(task?.title).toBe('Integration Task');
    expect(task?.description).toBe('Created via add-task integration test');
    expect(task?.done).toBeFalsy();
    expect(typeof updatedPlan.updatedAt).toBe('string');

    const logOutput = mockLog.mock.calls.flat().join('\n');
    expect(logOutput).toContain('Added task "Integration Task"');
  });

  test('tim list --status filters by status', async () => {
    // Create plans with different statuses
    const plans = [
      {
        id: 1,
        title: 'Pending Plan',
        goal: 'Test',
        details: 'Details',
        status: 'pending',
        tasks: [],
      },
      {
        id: 2,
        title: 'Done Plan',
        goal: 'Test',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 3,
        title: 'In Progress Plan',
        goal: 'Test',
        details: 'Details',
        status: 'in_progress',
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await writePlanFile(path.join(tasksDir, `${plan.id}.yml`), plan);
    }

    // Test filtering by done status using internal handler and mocked logger
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleListCommand({ status: ['done'], sort: 'created' }, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('Done Plan');
    expect(calls).not.toContain('Pending Plan');
    expect(calls).not.toContain('In Progress Plan');
  });

  test('tim remove-task deletes the selected task and reports shifts', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;

    await handleAddCommand(['Integration', 'Task', 'Removal'], {}, command);

    await handleAddTaskCommand(
      1,
      {
        title: 'First Task',
        description: 'Initial task to remove later',
      },
      command
    );
    await handleAddTaskCommand(
      1,
      {
        title: 'Second Task',
        description: 'Task that should remain',
      },
      command
    );
    const preRemovalPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(preRemovalPlan.tasks).toHaveLength(2);
    mockLog.mockClear();
    await handleRemoveTaskCommand(
      1,
      {
        index: 0,
      },
      command
    );

    const updatedPlan = (await resolvePlanByNumericId(1, tempDir)).plan;
    expect(updatedPlan.tasks).toHaveLength(1);
    expect(updatedPlan.tasks[0]?.title).toBe('Second Task');
    expect(typeof updatedPlan.updatedAt).toBe('string');

    const logOutput = mockLog.mock.calls.flat().join('\n');
    expect(logOutput).toContain('Removed task "First Task"');
    expect(logOutput).toContain('previously at index 1');
  });

  test('tim show --next finds next ready plan', async () => {
    // Clear the plan cache again to be sure

    // Create plans with dependencies
    const plans = [
      {
        id: 1,
        title: 'Completed Dependency',
        goal: 'Already done',
        details: 'Details',
        status: 'done',
        tasks: [],
      },
      {
        id: 2,
        title: 'Ready Plan',
        goal: 'Ready to start',
        details: 'Details',
        status: 'pending',
        dependencies: [1],
        tasks: [],
      },
      {
        id: 3,
        title: 'Blocked Plan',
        goal: 'Blocked by dependencies',
        details: 'Details',
        status: 'pending',
        dependencies: [2],
        tasks: [],
      },
    ];

    for (const plan of plans) {
      await writePlanFile(path.join(tasksDir, `${plan.id}.yml`), plan);
    }

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleShowCommand(undefined, { next: true }, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('Found next ready plan: 2');
    expect(calls).toContain('Ready Plan');
  });

  test('tim add with dependencies and priority', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    // Create existing dependency plans first.
    await handleAddCommand(['First', 'Plan'], {}, command);
    await handleAddCommand(['Second', 'Plan'], {}, command);

    // Create a plan with dependencies and priority
    await handleAddCommand(
      ['Dependent', 'Plan'],
      { dependsOn: [1, 2], priority: 'high', debug: true },
      command
    );

    // Verify the plan has dependencies and priority
    const created = (await resolvePlanByNumericId(3, tempDir)).plan;
    expect([...(created.dependencies ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(created.priority).toBe('high');
  });
});
