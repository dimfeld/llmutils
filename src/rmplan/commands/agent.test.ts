import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { rmplanAgent, handleAgentCommand } from './agent.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock logging functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});

// Mock inquirer prompts
const selectSpy = mock(async () => 'generate');

// Mock executor
const executorExecuteSpy = mock(async () => {});
const buildExecutorAndLogSpy = mock(() => ({
  execute: executorExecuteSpy,
}));

// Mock actions functions
const preparePhase = mock(async () => {});
const setPlanStatusSpy = mock(async () => {});
const findPendingTaskSpy = mock(() => null); // Return null to indicate no more tasks
const findNextActionableItemSpy = mock(() => null); // Return null to indicate no more tasks
const prepareNextStepSpy = mock(async () => null);
const markStepDoneSpy = mock(async () => ({ message: 'Done', planComplete: true }));

// Mock other dependencies
const resolvePlanFileSpy = mock(async (planFile: string) => planFile);
const loadEffectiveConfigSpy = mock(async () => ({}));
const getGitRootSpy = mock(async () => '/test/project');
const openLogFileSpy = mock(() => {});
const closeLogFileSpy = mock(async () => {});

describe('rmplanAgent - Parent Plan Status Updates', () => {
  let tempDir: string;
  let parentPlanFile: string;
  let childPlanFile: string;

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    selectSpy.mockClear();
    executorExecuteSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    preparePhase.mockClear();
    setPlanStatusSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    getGitRootSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    findPendingTaskSpy.mockClear();
    findNextActionableItemSpy.mockClear();
    prepareNextStepSpy.mockClear();
    markStepDoneSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-test-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    parentPlanFile = path.join(tasksDir, '100-parent-plan.yml');
    childPlanFile = path.join(tasksDir, '101-child-plan.yml');

    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 100,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'pending',
      tasks: [],
      filename: parentPlanFile,
    };

    // Create child plan with parent reference
    const childPlan: PlanSchema = {
      id: 101,
      title: 'Child Plan',
      goal: 'Child goal',
      details: 'Child details',
      status: 'pending',
      parent: 100,
      tasks: [
        {
          title: 'Child Task',
          description: 'Do something',
        },
      ],
      filename: childPlanFile,
    };

    await fs.writeFile(parentPlanFile, yaml.stringify(parentPlan));
    await fs.writeFile(childPlanFile, yaml.stringify(childPlan));

    // Mock dependencies with proper handling for parent/child plans
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      select: selectSpy,
      input: mock(async () => ''),
      confirm: mock(async () => true),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: () => 'test-model',
    }));

    await moduleMocker.mock('../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
      markTaskDone: mock(async () => ({ message: 'Done', planComplete: true })),
    }));

    await moduleMocker.mock('../plans/find_next.js', () => ({
      findPendingTask: findPendingTaskSpy,
      findNextActionableItem: findNextActionableItemSpy,
    }));

    await moduleMocker.mock('../plans/prepare_phase.js', () => ({
      preparePhase,
    }));

    await moduleMocker.mock('../plans/prepare_step.js', () => ({
      prepareNextStep: prepareNextStepSpy,
    }));

    await moduleMocker.mock('../actions.js', () => ({
      preparePhase,
      prepareNextStep: prepareNextStepSpy,
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
      writePlanFile: async (filePath: string, plan: PlanSchema) => {
        await fs.writeFile(filePath, yaml.stringify(plan));
      },
      setPlanStatus: setPlanStatusSpy,
      clearPlanCache,
      readAllPlans: async () => {
        const parentContent = await fs.readFile(parentPlanFile, 'utf-8');
        const childContent = await fs.readFile(childPlanFile, 'utf-8');
        const parentPlan = yaml.parse(parentContent) as PlanSchema;
        const childPlan = yaml.parse(childContent) as PlanSchema;
        const plans = new Map();
        plans.set(100, parentPlan);
        plans.set(101, childPlan);
        return { plans, errors: [] };
      },
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../configSchema.js', () => ({
      resolveTasksDir: async () => tasksDir,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));

    await moduleMocker.mock('../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
    }));

    await moduleMocker.mock('chalk', () => ({
      default: {
        yellow: (text: string) => text,
        green: (text: string) => text,
      },
    }));

    // Set up default mock implementations
    buildExecutorAndLogSpy.mockReturnValue({
      execute: executorExecuteSpy,
    });
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks parent plan as in_progress when child plan starts', async () => {
    // Mock to resolve child plan file and stop after one iteration
    resolvePlanFileSpy.mockResolvedValue(childPlanFile);
    findNextActionableItemSpy
      .mockReturnValueOnce({ type: 'task', taskIndex: 0, task: { title: 'Child Task' } })
      .mockReturnValueOnce(null); // Stop after first iteration

    const options = { 'no-log': true, nonInteractive: true };
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await rmplanAgent(childPlanFile, options, globalCliOptions);

    // Read both plan files to check their status
    const parentContent = await fs.readFile(parentPlanFile, 'utf-8');
    const childContent = await fs.readFile(childPlanFile, 'utf-8');
    const parentPlan = yaml.parse(parentContent) as PlanSchema;
    const childPlan = yaml.parse(childContent) as PlanSchema;

    // Verify child plan is marked as in_progress
    expect(childPlan.status).toBe('in_progress');

    // Verify parent plan is also marked as in_progress
    expect(parentPlan.status).toBe('in_progress');

    // Verify log was called to indicate parent was marked
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Parent plan "Parent Plan" marked as in_progress')
    );
  });

  test('does not mark already in_progress parent', async () => {
    // Set parent plan to already be in_progress
    const parentContent = await fs.readFile(parentPlanFile, 'utf-8');
    const parentPlan = yaml.parse(parentContent) as PlanSchema;
    parentPlan.status = 'in_progress';
    await fs.writeFile(parentPlanFile, yaml.stringify(parentPlan));

    // Mock to resolve child plan file and stop after one iteration
    resolvePlanFileSpy.mockResolvedValue(childPlanFile);
    findNextActionableItemSpy
      .mockReturnValueOnce({ type: 'task', taskIndex: 0, task: { title: 'Child Task' } })
      .mockReturnValueOnce(null); // Stop after first iteration

    const options = { 'no-log': true, nonInteractive: true };
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await rmplanAgent(childPlanFile, options, globalCliOptions);

    // Read parent plan to check status
    const updatedParentContent = await fs.readFile(parentPlanFile, 'utf-8');
    const updatedParentPlan = yaml.parse(updatedParentContent) as PlanSchema;

    // Verify parent plan is still in_progress (not changed)
    expect(updatedParentPlan.status).toBe('in_progress');

    // Verify log was NOT called to indicate parent was marked
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('Parent plan "Parent Plan" marked as in_progress')
    );
  });
});

describe('rmplanAgent - Direct Execution Flow', () => {
  let tempDir: string;
  let stubPlanFile: string;

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    selectSpy.mockClear();
    executorExecuteSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    preparePhase.mockClear();
    setPlanStatusSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    getGitRootSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    findPendingTaskSpy.mockClear();
    findNextActionableItemSpy.mockClear();
    prepareNextStepSpy.mockClear();
    markStepDoneSpy.mockClear();

    // Reset mocks to default behavior
    findNextActionableItemSpy.mockReturnValue(null);

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-test-'));
    stubPlanFile = path.join(tempDir, 'stub-plan.yml');

    // Create a stub plan file (plan with no steps)
    const stubPlan: PlanSchema = {
      id: 'test-stub-plan',
      title: 'Test Stub Plan',
      goal: 'Implement a simple feature',
      details: 'Add a new function that returns hello world',
      status: 'pending',
      tasks: [
        {
          title: 'Main Task',
          description: 'The main implementation task',
          steps: [], // Empty steps - this makes it a stub plan
        },
      ],
    };

    await fs.writeFile(stubPlanFile, yaml.stringify(stubPlan));

    // Mock dependencies
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      select: selectSpy,
      input: mock(async () => ''),
      confirm: mock(async () => true),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: () => 'test-model',
    }));

    await moduleMocker.mock('../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
      markTaskDone: mock(async () => ({ message: 'Done', planComplete: true })),
    }));

    await moduleMocker.mock('../plans/find_next.js', () => ({
      findPendingTask: findPendingTaskSpy,
      findNextActionableItem: findNextActionableItemSpy,
    }));

    await moduleMocker.mock('../plans/prepare_phase.js', () => ({
      preparePhase,
    }));

    await moduleMocker.mock('../plans/prepare_step.js', () => ({
      prepareNextStep: prepareNextStepSpy,
    }));

    await moduleMocker.mock('../actions.js', () => ({
      preparePhase,
      prepareNextStep: prepareNextStepSpy,
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
      writePlanFile: async (filePath: string, plan: PlanSchema) => {
        await fs.writeFile(filePath, yaml.stringify(plan));
      },
      setPlanStatus: setPlanStatusSpy,
      clearPlanCache,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));

    await moduleMocker.mock('../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
    }));

    await moduleMocker.mock('../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'Test prompt for task'),
    }));

    // Set up default mock implementations
    resolvePlanFileSpy.mockResolvedValue(stubPlanFile);
    buildExecutorAndLogSpy.mockReturnValue({
      execute: executorExecuteSpy,
    });
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('interactive "run directly" flow', async () => {
    // Mock user selecting "direct" option
    selectSpy.mockResolvedValue('direct');

    // Mock findNextActionableItem to return the simple task, then null to end loop
    findNextActionableItemSpy
      .mockReturnValueOnce({
        type: 'task',
        taskIndex: 0,
        task: { title: 'Main Task', description: 'The main implementation task' },
      })
      .mockReturnValueOnce(null);

    const options = { 'no-log': true };
    const globalCliOptions = {};

    await rmplanAgent(stubPlanFile, options, globalCliOptions);

    // Verify user was prompted with correct choices
    expect(selectSpy).toHaveBeenCalledWith({
      message: 'This plan lacks detailed steps. How would you like to proceed?',
      choices: [
        {
          name: 'Generate detailed steps first',
          value: 'generate',
          description: 'Create step-by-step instructions before execution',
        },
        {
          name: 'Run the simple plan directly',
          value: 'direct',
          description: 'Execute using just the high-level goal and details',
        },
      ],
    });

    // Verify preparePhase was NOT called (since user chose direct)
    expect(preparePhase).not.toHaveBeenCalled();

    // Verify the main execution loop was entered
    expect(findNextActionableItemSpy).toHaveBeenCalled();

    // Since the user chose direct execution, the simple task should be executed
    expect(executorExecuteSpy).toHaveBeenCalled();
  });

  test('interactive "generate steps" flow', async () => {
    // Mock user selecting "generate" option
    selectSpy.mockResolvedValue('generate');

    const options = { 'no-log': true };
    const globalCliOptions = {};

    await rmplanAgent(stubPlanFile, options, globalCliOptions);

    // Verify user was prompted
    expect(selectSpy).toHaveBeenCalled();

    // Verify preparePhase was called
    expect(preparePhase).toHaveBeenCalledWith(
      stubPlanFile,
      {},
      {
        model: undefined,
        direct: undefined,
      }
    );

    // Verify the main execution loop was entered after preparePhase
    expect(findNextActionableItemSpy).toHaveBeenCalled();

    // Since findNextActionableItemSpy returns null, no execution should happen
    expect(executorExecuteSpy).not.toHaveBeenCalled();
  });

  test('non-interactive mode defaults to generate steps', async () => {
    // In non-interactive mode, after preparePhase generates steps,
    // the plan would have steps to execute. Mock this behavior.
    preparePhase.mockImplementation(async () => {
      // Simulate that preparePhase adds steps to the plan
      const planContent = await fs.readFile(stubPlanFile, 'utf-8');
      const plan = yaml.parse(planContent) as PlanSchema;
      plan.tasks[0].steps = [{ title: 'Generated step 1' }];
      await fs.writeFile(stubPlanFile, yaml.stringify(plan));
    });

    // After preparePhase, findNextActionableItem would find the generated steps
    findNextActionableItemSpy
      .mockReturnValueOnce({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Main Task', steps: [{ title: 'Generated step 1' }] },
      })
      .mockReturnValueOnce(null);

    const options = { 'no-log': true, nonInteractive: true };
    const globalCliOptions = {};

    await rmplanAgent(stubPlanFile, options, globalCliOptions);

    // Verify no interactive prompt was shown
    expect(selectSpy).not.toHaveBeenCalled();

    // Verify preparePhase was called by default
    expect(preparePhase).toHaveBeenCalledWith(
      stubPlanFile,
      {},
      {
        model: undefined,
        direct: undefined,
      }
    );

    // Verify the main execution loop was entered after preparePhase
    expect(findNextActionableItemSpy).toHaveBeenCalled();

    // Since preparePhase generated steps, execution should happen
    expect(executorExecuteSpy).toHaveBeenCalled();
  });
});

describe('handleAgentCommand - --next-ready flag', () => {
  let tempDir: string;
  let parentPlanFile: string;
  let readyPlanFile: string;
  let inProgressPlanFile: string;
  let notReadyPlanFile: string;

  // Mock functions specifically for --next-ready tests
  const findNextReadyDependencySpy = mock();
  const rmplanAgentSpy = mock();

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    rmplanAgentSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-next-ready-test-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    parentPlanFile = path.join(tasksDir, '100-parent-plan.yml');
    readyPlanFile = path.join(tasksDir, '101-ready-plan.yml');
    inProgressPlanFile = path.join(tasksDir, '102-in-progress-plan.yml');
    notReadyPlanFile = path.join(tasksDir, '103-not-ready-plan.yml');

    // Create parent plan
    const parentPlan: PlanSchema = {
      id: 100,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'pending',
      tasks: [],
      dependencies: [101, 102],
      filename: parentPlanFile,
    };

    // Create ready dependency plan
    const readyPlan: PlanSchema = {
      id: 101,
      title: 'Ready Dependency Plan',
      goal: 'Ready goal',
      details: 'Ready details',
      status: 'pending',
      tasks: [{ title: 'Ready task', description: 'Ready task description' }],
      filename: readyPlanFile,
    };

    // Create in-progress dependency plan
    const inProgressPlan: PlanSchema = {
      id: 102,
      title: 'In Progress Plan',
      goal: 'In progress goal',
      details: 'In progress details',
      status: 'in_progress',
      tasks: [{ title: 'In progress task', description: 'In progress task description' }],
      filename: inProgressPlanFile,
    };

    // Create not ready dependency plan (has unfulfilled dependencies)
    const notReadyPlan: PlanSchema = {
      id: 103,
      title: 'Not Ready Plan',
      goal: 'Not ready goal',
      details: 'Not ready details',
      status: 'pending',
      dependencies: [999], // Non-existent dependency
      tasks: [{ title: 'Not ready task', description: 'Not ready task description' }],
      filename: notReadyPlanFile,
    };

    await fs.writeFile(parentPlanFile, yaml.stringify(parentPlan));
    await fs.writeFile(readyPlanFile, yaml.stringify(readyPlan));
    await fs.writeFile(inProgressPlanFile, yaml.stringify(inProgressPlan));
    await fs.writeFile(notReadyPlanFile, yaml.stringify(notReadyPlan));

    // Mock dependencies
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({})),
    }));

    await moduleMocker.mock('../configSchema.js', () => ({
      resolveTasksDir: mock(async () => tasksDir),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: mock(async (planFile: string) => planFile),
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
    }));

    await moduleMocker.mock('./find_next_dependency.js', () => ({
      findNextReadyDependency: findNextReadyDependencySpy,
    }));

    await moduleMocker.mock('./agent.js', () => ({
      rmplanAgent: rmplanAgentSpy,
      handleAgentCommand: handleAgentCommand, // Use the real implementation
    }));

    await moduleMocker.mock('chalk', () => ({
      default: {
        green: (text: string) => text,
        yellow: (text: string) => text,
        gray: (text: string) => text,
      },
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('throws error when --next-ready is provided without a value', async () => {
    const options = { nextReady: true }; // Boolean true instead of string value
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      '--next-ready requires a parent plan ID or file path'
    );
  });

  test('throws error when --next-ready is provided with empty string', async () => {
    const options = { nextReady: '' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      '--next-ready requires a parent plan ID or file path'
    );
  });

  test('finds ready dependency using numeric parent plan ID', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = { nextReady: '100' }; // Parent plan ID
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify findNextReadyDependency was called with correct parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    // Verify success messages were logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 101 - Ready Dependency Plan')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: Ready Dependency Plan (ID: 101)')
    );

    // Verify rmplanAgent was called with the ready plan's filename
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('finds ready dependency using parent plan file path', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = { nextReady: parentPlanFile }; // Parent plan file path
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify findNextReadyDependency was called with correct parent plan ID (100)
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    // Verify success messages were logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 101 - Ready Dependency Plan')
    );

    // Verify rmplanAgent was called with the ready plan's filename
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles no ready dependencies found', async () => {
    findNextReadyDependencySpy.mockResolvedValue({
      plan: null,
      message: 'No ready dependencies found',
    });

    const options = { nextReady: '100' };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify findNextReadyDependency was called
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    // Verify warning message was logged
    expect(logSpy).toHaveBeenCalledWith('No ready dependencies found');

    // Verify rmplanAgent was NOT called
    expect(rmplanAgentSpy).not.toHaveBeenCalled();
  });

  test('handles invalid parent plan ID', async () => {
    const options = { nextReady: '999' }; // Non-existent plan ID
    const globalCliOptions = {};

    findNextReadyDependencySpy.mockResolvedValue({
      plan: null,
      message: 'Plan not found: 999',
    });

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify warning message was logged
    expect(logSpy).toHaveBeenCalledWith('Plan not found: 999');

    // Verify rmplanAgent was NOT called
    expect(rmplanAgentSpy).not.toHaveBeenCalled();
  });

  test('throws error when parent plan file does not have valid ID', async () => {
    // Create a plan file without an ID
    const invalidPlanFile = path.join(tempDir, 'tasks', '999-invalid-plan.yml');
    const invalidPlan: Partial<PlanSchema> = {
      title: 'Invalid Plan',
      goal: 'No ID',
      status: 'pending',
    };
    await fs.writeFile(invalidPlanFile, yaml.stringify(invalidPlan));

    const options = { nextReady: invalidPlanFile };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      `Plan file ${invalidPlanFile} does not have a valid numeric ID`
    );
  });

  test('works with workspace options', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      workspace: 'test-workspace',
      autoWorkspace: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify rmplanAgent was called with all options intact
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('works with execution options', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      executor: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      steps: '5',
      dryRun: true,
      nonInteractive: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify rmplanAgent was called with all execution options intact
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles findNextReadyDependency throwing error', async () => {
    findNextReadyDependencySpy.mockRejectedValue(new Error('Dependency traversal failed'));

    const options = { nextReady: '100' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      'Dependency traversal failed'
    );

    // Verify rmplanAgent was NOT called when dependency finding fails
    expect(rmplanAgentSpy).not.toHaveBeenCalled();
  });

  test('handles plan file resolution errors', async () => {
    // Mock resolvePlanFile to throw an error when trying to resolve the parent plan file
    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: mock(async (planFile: string) => {
        if (planFile.includes('non-existent')) {
          throw new Error('File not found');
        }
        return planFile;
      }),
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
    }));

    const options = { nextReady: '/path/to/non-existent-plan.yml' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      'File not found'
    );

    // Verify findNextReadyDependency was NOT called when plan resolution fails
    expect(findNextReadyDependencySpy).not.toHaveBeenCalled();
    expect(rmplanAgentSpy).not.toHaveBeenCalled();
  });

  test('logs specific plan details when dependency is found', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;
    readyPlan.goal = 'Implement authentication system';
    readyPlan.details = 'Add OAuth and session management';

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101) with goal: Implement authentication system',
    });

    const options = { nextReady: '100' };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify detailed success messages were logged
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 101 - Ready Dependency Plan')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: Ready Dependency Plan (ID: 101) with goal: Implement authentication system')
    );

    // Verify rmplanAgent was called with the ready plan's filename
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('preserves logging options when redirecting to dependency', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      'no-log': true,
      verbose: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify rmplanAgent was called with logging options intact
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('works with complex globalCliOptions', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = { nextReady: '100' };
    const globalCliOptions = {
      config: {
        paths: {
          tasks: path.join(tempDir, 'tasks'),
          workspace: path.join(tempDir, 'workspaces'),
        },
        models: {
          execution: 'claude-3-5-sonnet',
        },
        postApplyCommands: [
          { title: 'Test command', command: 'echo test' },
        ],
      },
    };

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify complex global CLI options are passed through
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles plan with string ID correctly', async () => {
    // Create a plan with string ID
    const stringIdPlanFile = path.join(tempDir, 'tasks', 'string-plan.yml');
    const stringIdPlan: PlanSchema = {
      id: 'feature-123',
      title: 'String ID Plan',
      goal: 'Test string ID handling',
      details: 'Test details',
      status: 'pending',
      tasks: [{ title: 'Test task', description: 'Test description' }],
      filename: stringIdPlanFile,
    };
    await fs.writeFile(stringIdPlanFile, yaml.stringify(stringIdPlan));

    // Update the mock to handle string IDs
    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: mock(async (planFile: string) => planFile),
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
    }));

    const options = { nextReady: stringIdPlanFile };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      `Plan file ${stringIdPlanFile} does not have a valid numeric ID`
    );

    // Verify findNextReadyDependency was NOT called for invalid ID
    expect(findNextReadyDependencySpy).not.toHaveBeenCalled();

    // Verify rmplanAgent was NOT called
    expect(rmplanAgentSpy).not.toHaveBeenCalled();
  });

  test('ensures workspace operations use the redirected plan filename', async () => {
    const readyPlan = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlan.filename = readyPlanFile;

    findNextReadyDependencySpy.mockResolvedValue({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      workspace: 'test-workspace-123',
      autoWorkspace: true,
      newWorkspace: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify rmplanAgent was called with the redirected plan file (not the parent)
    expect(rmplanAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);

    // Verify the success message mentions the correct plan
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 101 - Ready Dependency Plan')
    );

    // Verify all workspace options are preserved when redirecting
    const callArgs = rmplanAgentSpy.mock.calls[0];
    expect(callArgs[1]).toEqual(expect.objectContaining({
      workspace: 'test-workspace-123',
      autoWorkspace: true,
      newWorkspace: true,
      nextReady: '100', // Original flag should remain
    }));
  });
});
