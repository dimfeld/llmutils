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
import { handleReadyCommand } from './ready.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

describe('handleReadyCommand', () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-ready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Set up mocks
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

    // Mock getGitRoot for JSON format tests
    await moduleMocker.mock('../../common/git.js', () => ({
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

  // Helper function to create command object
  function createCommand() {
    return {
      parent: {
        opts: () => ({}),
      },
    };
  }

  // Helper function to create a plan
  async function createPlan(plan: PlanSchema) {
    const filename = path.join(tasksDir, `${plan.id}-test.yml`);
    await fs.writeFile(filename, yaml.stringify(plan));
  }

  // Test 1: Shows all ready pending plans
  test('shows all ready pending plans', async () => {
    // Create 2 pending plans with tasks and no dependencies
    await createPlan({
      id: 1,
      goal: 'First pending plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Second pending plan',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    // Verify both plans appear in output
    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (2)');
    expect(logOutput).toContain('[1]');
    expect(logOutput).toContain('First pending plan');
    expect(logOutput).toContain('[2]');
    expect(logOutput).toContain('Second pending plan');
  });

  // Test 2: Shows all ready in_progress plans
  test('shows all ready in_progress plans', async () => {
    await createPlan({
      id: 1,
      goal: 'In progress plan',
      status: 'in_progress',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('[1]');
    expect(logOutput).toContain('In progress plan');
    expect(logOutput).toContain('Status: in_progress');
  });

  // Test 3: Excludes in_progress with --pending-only flag
  test('excludes in_progress with --pending-only flag', async () => {
    await createPlan({
      id: 1,
      goal: 'Pending plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'In progress plan',
      status: 'in_progress',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { pendingOnly: true };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('[1]');
    expect(logOutput).toContain('Pending plan');
    expect(logOutput).not.toContain('In progress plan');
  });

  // Test 4: Shows empty when no plans are ready
  test('shows empty message when no plans are ready', async () => {
    // Create only done/cancelled plans
    await createPlan({
      id: 1,
      goal: 'Done plan',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Cancelled plan',
      status: 'cancelled',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    expect(mockLog).toHaveBeenCalledWith('No plans are currently ready to execute.');
  });

  // Test 5: Filters by priority correctly
  test('filters by priority correctly', async () => {
    await createPlan({
      id: 1,
      goal: 'High priority plan',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Low priority plan',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 3,
      goal: 'Medium priority plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { priority: 'high' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('High priority plan');
    expect(logOutput).not.toContain('Low priority plan');
    expect(logOutput).not.toContain('Medium priority plan');
  });

  // Test 6: Sorts by priority correctly
  test('sorts by priority correctly (descending by default: urgent to low)', async () => {
    await createPlan({
      id: 1,
      goal: 'Low priority plan',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Urgent priority plan',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 3,
      goal: 'High priority plan',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 4,
      goal: 'Medium priority plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    // Find the order of plan IDs in output
    const urgentIndex = logOutput.indexOf('[2]');
    const highIndex = logOutput.indexOf('[3]');
    const mediumIndex = logOutput.indexOf('[4]');
    const lowIndex = logOutput.indexOf('[1]');

    // Verify order: urgent, high, medium, low (descending order)
    expect(urgentIndex).toBeLessThan(highIndex);
    expect(highIndex).toBeLessThan(mediumIndex);
    expect(mediumIndex).toBeLessThan(lowIndex);
  });

  // Test 7: Sorts by alternative fields (id, title, created)
  test('sorts by id when --sort id is specified', async () => {
    await createPlan({
      id: 3,
      goal: 'Plan 3',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 1,
      goal: 'Plan 1',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Plan 2',
      status: 'pending',
      priority: 'urgent',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { sort: 'id' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    const plan1Index = logOutput.indexOf('[1]');
    const plan2Index = logOutput.indexOf('[2]');
    const plan3Index = logOutput.indexOf('[3]');

    expect(plan1Index).toBeLessThan(plan2Index);
    expect(plan2Index).toBeLessThan(plan3Index);
  });

  test('sorts by title when --sort title is specified', async () => {
    await createPlan({
      id: 1,
      goal: 'Zebra plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Apple plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 3,
      goal: 'Mango plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { sort: 'title' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    const appleIndex = logOutput.indexOf('Apple plan');
    const mangoIndex = logOutput.indexOf('Mango plan');
    const zebraIndex = logOutput.indexOf('Zebra plan');

    expect(appleIndex).toBeLessThan(mangoIndex);
    expect(mangoIndex).toBeLessThan(zebraIndex);
  });

  // Test 8: Reverse flag works
  test('reverse flag inverts sort order', async () => {
    await createPlan({
      id: 1,
      goal: 'Plan 1',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Plan 2',
      status: 'pending',
      priority: 'low',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { sort: 'priority', reverse: true };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    const plan1Index = logOutput.indexOf('[1]'); // high priority
    const plan2Index = logOutput.indexOf('[2]'); // low priority

    // With reverse on priority sort, low should come before high (ascending)
    expect(plan2Index).toBeLessThan(plan1Index);
  });

  // Test 9: Includes plans without tasks
  test('includes plans without tasks', async () => {
    await createPlan({
      id: 1,
      goal: 'Plan with tasks',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Plan without tasks',
      status: 'pending',
      priority: 'medium',
      tasks: [],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (2)');
    expect(logOutput).toContain('Plan with tasks');
    expect(logOutput).toContain('Plan without tasks');
  });

  // Test 10: Excludes plans with incomplete dependencies
  test('excludes plans with incomplete dependencies', async () => {
    // Create plan A (pending)
    await createPlan({
      id: 1,
      goal: 'Plan A',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create plan B (depends on A, which is not done)
    await createPlan({
      id: 2,
      goal: 'Plan B',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [1],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('Plan A');
    expect(logOutput).not.toContain('Plan B');
  });

  // Test 11: Shows plans with all dependencies done
  test('shows plans with all dependencies done', async () => {
    // Create plan A (done)
    await createPlan({
      id: 1,
      goal: 'Plan A',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create plan B (done)
    await createPlan({
      id: 2,
      goal: 'Plan B',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create plan C (depends on A and B, both done)
    await createPlan({
      id: 3,
      goal: 'Plan C',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [1, 2],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('[3]');
    expect(logOutput).toContain('Plan C');
    expect(logOutput).toContain('All dependencies done');
    expect(logOutput).toContain('1 (done)');
    expect(logOutput).toContain('2 (done)');
  });

  // Test 12: Table format works
  test('table format displays correctly', async () => {
    await createPlan({
      id: 1,
      goal: 'Test plan',
      status: 'pending',
      priority: 'high',
      tasks: [
        { title: 'Task 1', description: 'Do task', done: false },
        { title: 'Task 2', description: 'Do task', done: true },
      ],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { format: 'table' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    expect(mockTable).toHaveBeenCalled();
    const tableData = mockTable.mock.calls[0][0];

    // Check that table was called with array data
    expect(Array.isArray(tableData)).toBe(true);
    expect(tableData.length).toBeGreaterThan(0);

    // Check header row
    const headerRow = tableData[0];
    expect(headerRow).toBeDefined();
    expect(headerRow).toContain('ID');
    expect(headerRow).toContain('Title');

    // Check data row exists
    expect(tableData[1]).toBeDefined();
    const dataRow = tableData[1];
    expect(dataRow[0]).toBe(1); // ID is passed as number to chalk
    expect(dataRow[1]).toBe('Test plan');
    expect(dataRow[4]).toBe('1/2'); // 1 done out of 2 tasks
  });

  // Test 13: JSON format works
  test('json format outputs valid JSON structure', async () => {
    await createPlan({
      id: 1,
      goal: 'Test plan',
      title: 'Test Plan Title',
      status: 'pending',
      priority: 'high',
      tasks: [
        { title: 'Task 1', description: 'Do task', done: false },
        { title: 'Task 2', description: 'Do task', done: true },
      ],
      dependencies: [],
      assignedTo: 'alice',
      createdAt: '2025-01-15T10:30:00Z',
      updatedAt: '2025-01-20T14:22:00Z',
    });

    const options = { format: 'json' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    // Get the logged output
    const logCalls = mockLog.mock.calls;
    const jsonOutput = logCalls[0][0];

    // Parse the JSON
    const result = JSON.parse(jsonOutput);

    expect(result.count).toBe(1);
    expect(result.plans).toHaveLength(1);

    const plan = result.plans[0];
    expect(plan.id).toBe(1);
    expect(plan.title).toBe('Test Plan Title');
    expect(plan.goal).toBe('Test plan');
    expect(plan.priority).toBe('high');
    expect(plan.status).toBe('pending');
    expect(plan.taskCount).toBe(2);
    expect(plan.completedTasks).toBe(1);
    expect(plan.dependencies).toEqual([]);
    expect(plan.assignedTo).toBe('alice');
    expect(plan.createdAt).toBe('2025-01-15T10:30:00Z');
    expect(plan.updatedAt).toBe('2025-01-20T14:22:00Z');
    expect(plan.filename).toBeDefined();
  });

  // Test 14: Verbose mode shows file paths
  test('verbose mode shows file paths', async () => {
    await createPlan({
      id: 1,
      goal: 'Test plan',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = { verbose: true };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('File:');
    expect(logOutput).toContain('1-test.yml');
  });

  // Test 15: Handles edge cases
  test('handles plans with no priority (defaults to 0 for sorting, comes last)', async () => {
    await createPlan({
      id: 1,
      goal: 'Plan without priority',
      status: 'pending',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Plan with high priority',
      status: 'pending',
      priority: 'high',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    // High priority (value 4) should come before no priority (value 0) in descending order
    const noPriorityIndex = logOutput.indexOf('[1]');
    const highIndex = logOutput.indexOf('[2]');

    expect(highIndex).toBeLessThan(noPriorityIndex);
  });

  test('handles plans with maybe priority', async () => {
    await createPlan({
      id: 1,
      goal: 'Maybe priority plan',
      status: 'pending',
      priority: 'maybe',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('Maybe priority plan');
    expect(logOutput).toContain('Priority: maybe');
  });

  test('handles missing dependency plans gracefully', async () => {
    // Create a plan that depends on a non-existent plan
    await createPlan({
      id: 1,
      goal: 'Plan with missing dependency',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [999], // Non-existent plan
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    // Plan should not be shown because dependency is not found
    expect(logOutput).toContain('No plans are currently ready to execute');
  });

  test('handles circular dependencies without crashing', async () => {
    // Create plans with circular dependencies
    await createPlan({
      id: 1,
      goal: 'Plan A',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [2],
      createdAt: new Date().toISOString(),
    });

    await createPlan({
      id: 2,
      goal: 'Plan B',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: [1],
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    // Should not crash
    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    // Neither plan should be shown as ready
    expect(logOutput).toContain('No plans are currently ready to execute');
  });

  test('handles mixed numeric and string dependency IDs', async () => {
    // Create a done plan
    await createPlan({
      id: 1,
      goal: 'Done plan',
      status: 'done',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: true }],
      dependencies: [],
      createdAt: new Date().toISOString(),
    });

    // Create a plan with string dependency ID
    await createPlan({
      id: 2,
      goal: 'Plan with string dependency',
      status: 'pending',
      priority: 'medium',
      tasks: [{ title: 'Task 1', description: 'Do task', done: false }],
      dependencies: ['1' as any], // String ID
      createdAt: new Date().toISOString(),
    });

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logCalls = mockLog.mock.calls.map((call) => call[0]);
    const logOutput = logCalls.join('\n');

    // Plan should be shown as ready because string '1' should resolve to numeric 1
    expect(logOutput).toContain('Ready Plans (1)');
    expect(logOutput).toContain('Plan with string dependency');
  });
});
