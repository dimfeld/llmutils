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
  let repoDir: string;
  let repositoryId: string;
  let assignmentsData: Record<string, any>;

  beforeEach(async () => {
    // Clear mocks
    mockLog.mockClear();
    mockError.mockClear();
    mockWarn.mockClear();
    mockTable.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-ready-test-'));
    repoDir = path.join(tempDir, 'repo');
    tasksDir = path.join(repoDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    repositoryId = 'ready-tests';
    assignmentsData = {};

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

    // Mock git helpers
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => repoDir,
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
    await fs.writeFile(filename, `---\n${yaml.stringify(plan)}---\n`);
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

  // Test 9: Includes plans without tasks (stub plans awaiting task generation)
  test('includes plans without tasks (stub plans ready for task generation)', async () => {
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
      goal: 'Stub plan without tasks',
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

    // Unlike findNextReadyDependency, the ready command includes taskless plans
    // because they are ready to have tasks generated via `tim generate`
    expect(logOutput).toContain('Ready Plans (2)');
    expect(logOutput).toContain('Plan with tasks');
    expect(logOutput).toContain('Stub plan without tasks');
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
    expect(headerRow).toContain('Workspace');

    // Check data row exists
    expect(tableData[1]).toBeDefined();
    const dataRow = tableData[1];
    expect(dataRow[0]).toBe(1); // ID is passed as number to chalk
    expect(dataRow[1]).toBe('Test plan');
    expect(dataRow[4]).toBe('-'); // no tags
    expect(dataRow[5]).toBe('1/2'); // 1 done out of 2 tasks
    expect(dataRow[6]).toBe('unassigned');
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
    expect(plan.workspacePaths).toEqual([]);
    expect(plan.users).toEqual([]);
    expect(plan.isAssignedHere).toBe(false);
    expect(plan.isUnassigned).toBe(true);
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

  test('defaults to showing current workspace assignments and unassigned plans', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      title: 'Unassigned Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    await createPlan({
      id: 2,
      uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Current Workspace Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    await createPlan({
      id: 3,
      uuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      title: 'Other Workspace Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': {
        planId: 2,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: now,
        updatedAt: now,
      },
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc': {
        planId: 3,
        workspacePaths: [path.join(tempDir, 'other-workspace')],
        users: ['bob'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Unassigned Plan');
    expect(logOutput).toContain('Current Workspace Plan');
    expect(logOutput).not.toContain('Other Workspace Plan');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('--all shows plans assigned to other workspaces', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      title: 'Other Workspace Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd': {
        planId: 1,
        workspacePaths: [path.join(tempDir, 'other-workspace')],
        users: ['carol'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = { all: true };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Other Workspace Plan');
  });

  test('--unassigned filters out claimed plans', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      title: 'Available Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    await createPlan({
      id: 2,
      uuid: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      title: 'Claimed Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      'ffffffff-ffff-4fff-8fff-ffffffffffff': {
        planId: 2,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = { unassigned: true };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Available Plan');
    expect(logOutput).not.toContain('Claimed Plan');
  });

  test('--user filters by assignment user', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: '01010101-0101-4010-8010-010101010101',
      title: 'Alice Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    await createPlan({
      id: 2,
      uuid: '02020202-0202-4020-8020-020202020202',
      title: 'Bob Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      '01010101-0101-4010-8010-010101010101': {
        planId: 1,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
      '02020202-0202-4020-8020-020202020202': {
        planId: 2,
        workspacePaths: [path.join(tempDir, 'bob-workspace')],
        users: ['bob'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = { user: 'alice' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Alice Plan');
    expect(logOutput).not.toContain('Bob Plan');
  });

  test('--user falls back to plan assignedTo when assignments are missing', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      title: 'Legacy Alice Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      assignedTo: 'alice',
      createdAt: now,
    });

    await createPlan({
      id: 2,
      title: 'Legacy Bob Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      assignedTo: 'bob',
      createdAt: now,
    });

    assignmentsData = {};

    const options = { user: 'alice' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Legacy Alice Plan');
    expect(logOutput).not.toContain('Legacy Bob Plan');
  });

  test('--user matches assigned users case-insensitively', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Case Alice Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    await createPlan({
      id: 2,
      uuid: '22222222-2222-4222-8222-222222222222',
      title: 'Case Bob Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      '11111111-1111-4111-8111-111111111111': {
        planId: 1,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
      '22222222-2222-4222-8222-222222222222': {
        planId: 2,
        workspacePaths: [path.join(tempDir, 'bob-workspace')],
        users: ['bob'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = { user: 'ALICE' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('Case Alice Plan');
    expect(logOutput).not.toContain('Case Bob Plan');
  });

  test('warns when a plan is claimed in multiple workspaces', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: '03030303-0303-4030-8030-030303030303',
      title: 'Shared Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      '03030303-0303-4030-8030-030303030303': {
        planId: 1,
        workspacePaths: [repoDir, path.join(tempDir, 'teammate-workspace')],
        users: ['alice', 'bob'],
        status: 'pending',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    expect(mockWarn).toHaveBeenCalled();
    const warningOutput = mockWarn.mock.calls.map((call) => call[0]).join('\n');
    expect(warningOutput).toContain('Plan 1 is claimed in multiple workspaces');
  });

  test('assignment status overrides plan file status', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: '04040404-0404-4040-8040-040404040404',
      title: 'In Progress via Assignment',
      status: 'done',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
    });

    assignmentsData = {
      '04040404-0404-4040-8040-040404040404': {
        planId: 1,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = {};
    const command = createCommand();

    await handleReadyCommand(options, command);

    const logOutput = mockLog.mock.calls.map((call) => call[0]).join('\n');

    expect(logOutput).toContain('In Progress via Assignment');
    expect(logOutput).toContain('Status: in_progress');
  });

  test('json output includes assignment metadata', async () => {
    const now = new Date().toISOString();

    await createPlan({
      id: 1,
      uuid: '05050505-0505-4050-8050-050505050505',
      goal: 'JSON plan',
      title: 'JSON Plan',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Do work', done: false }],
      dependencies: [],
      createdAt: now,
      updatedAt: now,
    });

    assignmentsData = {
      '05050505-0505-4050-8050-050505050505': {
        planId: 1,
        workspacePaths: [repoDir],
        users: ['alice'],
        status: 'in_progress',
        assignedAt: now,
        updatedAt: now,
      },
    };

    const options = { format: 'json' };
    const command = createCommand();

    await handleReadyCommand(options, command);

    const jsonOutput = mockLog.mock.calls[0][0];
    const result = JSON.parse(jsonOutput);

    expect(result.count).toBe(1);
    expect(result.plans[0].workspacePaths).toEqual([repoDir]);
    expect(result.plans[0].users).toEqual(['alice']);
    expect(result.plans[0].isAssignedHere).toBe(true);
    expect(result.plans[0].isUnassigned).toBe(false);
  });

  test('filters ready plans by tag', async () => {
    await createPlan({
      id: 10,
      goal: 'Frontend Ready',
      status: 'pending',
      tags: ['frontend'],
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 11,
      goal: 'Backend Ready',
      status: 'pending',
      tags: ['backend'],
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({ tag: ['frontend'] }, createCommand());

    const output = mockLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Frontend Ready');
    expect(output).not.toContain('Backend Ready');
  });

  test('filters ready plans by multiple tags using OR logic', async () => {
    await createPlan({
      id: 12,
      goal: 'Frontend Ready',
      status: 'pending',
      tags: ['frontend'],
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 13,
      goal: 'Backend Ready',
      status: 'pending',
      tags: ['backend'],
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 14,
      goal: 'Infra Ready',
      status: 'pending',
      tags: ['infra'],
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({ tag: ['backend', 'frontend'] }, createCommand());

    const output = mockLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Frontend Ready');
    expect(output).toContain('Backend Ready');
    expect(output).not.toContain('Infra Ready');
  });

  test('matches tag filters case-insensitively and excludes untagged plans', async () => {
    await createPlan({
      id: 15,
      goal: 'Design Review',
      status: 'pending',
      tags: ['Design'],
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 16,
      goal: 'Untagged Plan',
      status: 'pending',
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({ tag: ['design'] }, createCommand());

    const output = mockLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Design Review');
    expect(output).not.toContain('Untagged Plan');
  });

  test('filters ready plans by epic id', async () => {
    await createPlan({
      id: 20,
      goal: 'Epic Plan',
      status: 'pending',
      epic: true,
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 21,
      goal: 'Child Plan',
      status: 'pending',
      parent: 20,
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 22,
      goal: 'Grandchild Plan',
      status: 'pending',
      parent: 21,
      tasks: [],
      dependencies: [],
    });
    await createPlan({
      id: 23,
      goal: 'Unrelated Plan',
      status: 'pending',
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({ epic: 20 }, createCommand());

    const output = mockLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toContain('Epic Plan');
    expect(output).toContain('Child Plan');
    expect(output).toContain('Grandchild Plan');
    expect(output).not.toContain('Unrelated Plan');
  });

  test('displays tags in list output', async () => {
    await createPlan({
      id: 17,
      goal: 'Tagged Work',
      status: 'pending',
      tags: ['frontend', 'urgent'],
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({}, createCommand());

    const output = mockLog.mock.calls.map((call) => call[0]).join('\n');
    expect(output).toMatch(/Tags:\s+frontend, urgent/);
  });

  test('displays tags column in table output', async () => {
    await createPlan({
      id: 18,
      goal: 'Table View Plan',
      status: 'pending',
      tags: ['frontend', 'urgent'],
      tasks: [],
      dependencies: [],
    });

    mockTable.mockClear();
    await handleReadyCommand({ format: 'table' }, createCommand());

    const tableData = mockTable.mock.calls[0][0];
    const headers = tableData[0];
    expect(headers).toContain('Tags');
    const tagsIndex = headers.indexOf('Tags');
    expect(tableData[1][tagsIndex]).toBe('frontend, urgent');
  });

  test('includes tags array in json output', async () => {
    await createPlan({
      id: 19,
      goal: 'JSON Plan with Tags',
      status: 'pending',
      tags: ['frontend', 'urgent'],
      tasks: [],
      dependencies: [],
    });

    mockLog.mockClear();
    await handleReadyCommand({ format: 'json' }, createCommand());

    const jsonOutput = mockLog.mock.calls.at(-1)?.[0] ?? '';
    const parsed = JSON.parse(jsonOutput);
    expect(parsed.plans[0].tags).toEqual(['frontend', 'urgent']);
  });
});
