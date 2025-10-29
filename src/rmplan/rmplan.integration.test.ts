import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { clearPlanCache, readPlanFile, readAllPlans } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { handleAddCommand } from './commands/add.js';
import { handleAddTaskCommand } from './commands/add-task.js';
import { handleDoneCommand } from './commands/done.js';
import { handleRemoveTaskCommand } from './commands/remove-task.js';
import { ModuleMocker } from '../testing.js';

// Handlers that rely on mocked modules are imported dynamically in beforeEach
let handleListCommand: any;
let handleShowCommand: any;

describe('rmplan CLI integration tests (internal handlers)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  const moduleMocker = new ModuleMocker(import.meta);
  const mockLog = mock(() => {});

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: {
          tasks: 'tasks',
        },
      })
    );

    // Set up logging/table mocks and dynamically import handlers that use them
    mockLog.mockClear();
    await moduleMocker.mock('../logging.js', () => ({
      log: mockLog,
      error: mockLog,
      warn: mockLog,
    }));
    await moduleMocker.mock('table', () => ({
      table: (data: any[]) => data.map((row: any[]) => row.join('\t')).join('\n'),
    }));
    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
    ({ handleListCommand } = await import('./commands/list.js'));
    ({ handleShowCommand } = await import('./commands/show.js'));
  });

  afterEach(async () => {
    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  test('rmplan add creates a new plan', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } };
    await handleAddCommand(['Integration', 'Test', 'Plan'], {}, command);

    // Check that file was created
    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(1);
    expect(planFiles[0]).toBe('1-integration-test-plan.plan.md');

    // Verify plan content
    const plan = await readPlanFile(path.join(tasksDir, '1-integration-test-plan.plan.md'));
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Integration Test Plan');
  });

  test('rmplan list shows created plans', async () => {
    // Create a test plan
    const plan = {
      id: 1,
      title: 'List Test Plan',
      goal: 'Test listing',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleListCommand({ sort: 'created' }, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('List Test Plan');
  });

  test('rmplan show displays plan details', async () => {
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
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleShowCommand('1', {}, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('Show Test Plan');
    expect(calls).toContain('Task 1');
  });

  test('rmplan done marks task as complete', async () => {
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
    await fs.writeFile(path.join(tasksDir, '1.yml'), yaml.stringify(plan));

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    await handleDoneCommand('1', {}, command);

    // Verify the task was marked as done
    const updatedPlan = await readPlanFile(path.join(tasksDir, '1.yml'));

    // The plan should have tasks
    expect(updatedPlan.tasks).toBeDefined();
    expect(updatedPlan.tasks.length).toBeGreaterThan(0);

    // Check task status
    expect(updatedPlan.tasks[0].done).toBe(true);
  });

  test('rmplan add-task appends a new task to an existing plan', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;

    await handleAddCommand(['Integration', 'AddTask', 'Plan'], {}, command);

    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(1);
    const planFilePath = path.join(tasksDir, planFiles[0] as string);

    const initialPlan = await readPlanFile(planFilePath);
    expect(initialPlan.tasks ?? []).toHaveLength(0);

    mockLog.mockClear();
    await handleAddTaskCommand(
      planFilePath,
      {
        title: 'Integration Task',
        description: 'Created via add-task integration test',
        files: ['src/service.ts'],
      },
      command
    );

    const updatedPlan = await readPlanFile(planFilePath);
    expect(updatedPlan.tasks).toHaveLength(1);
    const [task] = updatedPlan.tasks;
    expect(task?.title).toBe('Integration Task');
    expect(task?.description).toBe('Created via add-task integration test');
    expect(task?.files).toEqual(['src/service.ts']);
    expect(task?.docs).toEqual([]);
    expect(task?.steps).toEqual([]);
    expect(task?.done).toBeFalse();
    expect(typeof updatedPlan.updatedAt).toBe('string');

    const logOutput = mockLog.mock.calls.flat().join('\n');
    expect(logOutput).toContain('Added task "Integration Task"');
  });

  test('rmplan list --status filters by status', async () => {
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
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
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

  test('rmplan remove-task deletes the selected task and reports shifts', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;

    await handleAddCommand(['Integration', 'Task', 'Removal'], {}, command);

    const planFiles = await fs.readdir(tasksDir);
    expect(planFiles).toHaveLength(1);
    const planFilePath = path.join(tasksDir, planFiles[0] as string);

    await handleAddTaskCommand(
      planFilePath,
      {
        title: 'First Task',
        description: 'Initial task to remove later',
      },
      command
    );
    await handleAddTaskCommand(
      planFilePath,
      {
        title: 'Second Task',
        description: 'Task that should remain',
      },
      command
    );
    const preRemovalPlan = await readPlanFile(planFilePath);
    expect(preRemovalPlan.tasks).toHaveLength(2);

    mockLog.mockClear();
    await handleRemoveTaskCommand(
      planFilePath,
      {
        index: 0,
        yes: true,
      },
      command
    );

    const updatedPlan = await readPlanFile(planFilePath);
    expect(updatedPlan.tasks).toHaveLength(1);
    expect(updatedPlan.tasks[0]?.title).toBe('Second Task');
    expect(typeof updatedPlan.updatedAt).toBe('string');

    const logOutput = mockLog.mock.calls.flat().join('\n');
    expect(logOutput).toContain('Removed task "First Task"');
    expect(logOutput).toContain('have shifted');
  });

  test('rmplan show --next finds next ready plan', async () => {
    // Clear the plan cache again to be sure
    clearPlanCache();

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
      await fs.writeFile(path.join(tasksDir, `${plan.id}.yml`), yaml.stringify(plan));
    }

    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    mockLog.mockClear();
    await handleShowCommand(undefined, { next: true }, command);
    const calls = mockLog.mock.calls.flat().map(String).join('\n');
    expect(calls).toContain('Found next ready plan: 2');
    expect(calls).toContain('Ready Plan');
  });

  test('rmplan add with dependencies and priority', async () => {
    const command = { parent: { opts: () => ({ config: configPath }) } } as any;
    // First create a plan to depend on
    await handleAddCommand(['First', 'Plan'], {}, command);

    // Create a plan with dependencies and priority
    await handleAddCommand(
      ['Dependent', 'Plan'],
      { dependsOn: [1, 3], priority: 'high', debug: true },
      command
    );

    // Verify the plan has dependencies and priority
    const files = await fs.readdir(tasksDir);
    const depFile = files.find((f) => f.endsWith('-dependent-plan.plan.md'));
    expect(depFile).toBeDefined();
    const created = await readPlanFile(path.join(tasksDir, depFile!));
    expect(created.dependencies).toEqual([1, 3]);
    expect(created.priority).toBe('high');
  });
});
