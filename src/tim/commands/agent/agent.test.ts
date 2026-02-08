import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { timAgent, handleAgentCommand } from './agent.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../../plans.js';
import { runWithLogger, type LoggerAdapter } from '../../../logging/adapter.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import { createRecordingAdapter } from '../../../logging/test_helpers.js';
import { markParentInProgress } from './parent_plans.js';
import type { PlanSchema, PlanSchemaInputWithFilename } from '../../planSchema.js';
import { ModuleMocker } from '../../../testing.js';

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

describe('timAgent - Parent Plan Status Updates', () => {
  let tempDir: string;
  let tasksDir: string;
  let config: any;
  let parentPlanFile: string;
  let childPlanFile: string;

  beforeEach(async () => {
    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    config = { paths: { tasks: tasksDir } };

    parentPlanFile = path.join(tasksDir, '100-parent-plan.yml');
    childPlanFile = path.join(tasksDir, '101-child-plan.yml');

    const parentPlan: PlanSchema = {
      id: 100,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'pending',
      tasks: [],
      updatedAt: new Date().toISOString(),
    };

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
          steps: [],
        },
      ],
      updatedAt: new Date().toISOString(),
    };

    await writePlanFile(parentPlanFile, parentPlan);
    await writePlanFile(childPlanFile, childPlan);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks parent plan as in_progress when child plan starts', async () => {
    const { adapter, calls } = createRecordingAdapter();
    await runWithLogger(adapter, () => markParentInProgress(100, config));

    const parentPlan = await readPlanFile(parentPlanFile);
    const childPlan = await readPlanFile(childPlanFile);
    const structuredMessages = calls
      .filter((call) => call.method === 'sendStructured')
      .map((call) => call.args[0] as StructuredMessage);

    expect(childPlan.status).toBe('pending');
    expect(parentPlan.status).toBe('in_progress');

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'workflow_progress',
        phase: 'parent-plan-start',
        message: 'Parent plan "Parent Plan" marked as in_progress',
      })
    );
  });

  test('does not mark already in_progress parent', async () => {
    const parentPlan = await readPlanFile(parentPlanFile);
    parentPlan.status = 'in_progress';
    await writePlanFile(parentPlanFile, parentPlan);

    const { adapter, calls } = createRecordingAdapter();
    await runWithLogger(adapter, () => markParentInProgress(100, config));
    const structuredMessages = calls
      .filter((call) => call.method === 'sendStructured')
      .map((call) => call.args[0] as StructuredMessage);

    const updatedParentPlan = await readPlanFile(parentPlanFile);

    expect(updatedParentPlan.status).toBe('in_progress');
    expect(
      structuredMessages.filter(
        (message) => message.type === 'workflow_progress' && message.phase === 'parent-plan-start'
      )
    ).toHaveLength(0);
  });
});

// TODO timing out, probably missing mocks on prompts
describe.skip('timAgent - Direct Execution Flow', () => {
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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-test-'));
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
    await moduleMocker.mock('../../../logging.js', () => ({
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

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: () => 'test-model',
    }));

    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
      markTaskDone: mock(async () => ({ message: 'Done', planComplete: true })),
    }));

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findPendingTask: findPendingTaskSpy,
      findNextActionableItem: findNextActionableItemSpy,
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: prepareNextStepSpy,
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      preparePhase,
      prepareNextStep: prepareNextStepSpy,
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
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

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));

    await moduleMocker.mock('../../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
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

    const options = { log: false } as any;
    const globalCliOptions = {};

    await timAgent(stubPlanFile, options, globalCliOptions);

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

    const options = { log: false } as any;
    const globalCliOptions = {};

    await timAgent(stubPlanFile, options, globalCliOptions);

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

    const options = { log: false, nonInteractive: true } as any;
    const globalCliOptions = {};

    await timAgent(stubPlanFile, options, globalCliOptions);

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

describe('timAgent - simple mode flag plumbing', () => {
  let tempDir: string;
  let simplePlanFile: string;
  const executeBatchModeSpy = mock(async () => undefined);
  const testExecutor = {
    execute: executorExecuteSpy,
  };
  const defaultConfig = {
    defaultExecutor: 'test-executor',
    executors: {},
    models: {},
    postApplyCommands: [],
  };
  const serialFindNextActionableItemSpy = mock(() => null);
  const serialPrepareNextStepSpy = mock(async () => null);
  const serialMarkStepDoneSpy = mock(async () => ({ message: 'Marked', planComplete: false }));
  const serialMarkTaskDoneSpy = mock(async () => ({
    message: 'Task updated',
    planComplete: false,
  }));

  beforeEach(async () => {
    clearPlanCache();
    defaultConfig.executors = {};

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-simple-flag-test-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    simplePlanFile = path.join(tasksDir, '123-simple-plan.yml');
    const planContent = `---\n${yaml.stringify({
      id: 123,
      title: 'Simple Flag Plan',
      goal: 'Exercise executor plumbing',
      details: 'Ensure simple flag flows through to executor builder',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Has explicit steps so preparation is skipped',
          done: false,
          steps: [{ prompt: 'Do the work', done: false }],
        },
      ],
    })}---\n`;
    await fs.writeFile(simplePlanFile, planContent, 'utf-8');

    buildExecutorAndLogSpy.mockReset();
    executorExecuteSpy.mockReset();
    executeBatchModeSpy.mockReset();
    serialFindNextActionableItemSpy.mockReset();
    serialPrepareNextStepSpy.mockReset();
    serialMarkStepDoneSpy.mockReset();
    serialMarkTaskDoneSpy.mockReset();
    buildExecutorAndLogSpy.mockReturnValue(testExecutor);

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'fall-back-executor',
      defaultModelForExecutor: mock(() => 'default-model'),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => defaultConfig),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: executeBatchModeSpy,
    }));

    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: class {
        recordExecutionStart() {}
        addError() {}
        addStepResult() {}
        setBatchIterations() {}
        recordExecutionEnd() {}
        async trackFileChanges() {}
        getExecutionSummary() {
          return {};
        }
      },
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: serialFindNextActionableItemSpy,
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: serialPrepareNextStepSpy,
    }));

    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: serialMarkStepDoneSpy,
      markTaskDone: serialMarkTaskDoneSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('omits simple executor options when flag is not set', async () => {
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName, sharedOptions, config, executorOptions] =
      buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('test-executor');
    expect(sharedOptions).toMatchObject({
      baseDir: tempDir,
      model: 'default-model',
      simpleMode: undefined,
    });
    expect(config).toBe(defaultConfig);
    expect(executorOptions).toBeUndefined();
    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executor: testExecutor, executionMode: 'normal' });
  });

  test('passes review executor override through to executor builder', async () => {
    await timAgent(simplePlanFile, { log: false, reviewExecutor: 'claude-code' } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ reviewExecutor: 'claude-code' });
  });

  test('passes simpleMode flag through to executor builder', async () => {
    await timAgent(simplePlanFile, { log: false, simple: true } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName, sharedOptions, config, executorOptions] =
      buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('test-executor');
    expect(sharedOptions).toMatchObject({
      baseDir: tempDir,
      model: 'default-model',
      simpleMode: true,
    });
    expect(config).toBe(defaultConfig);
    expect(executorOptions).toEqual({ simpleMode: true });
    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executor: testExecutor, executionMode: 'simple' });
  });

  test('enables simpleMode when configured on executor', async () => {
    defaultConfig.executors = {
      'test-executor': {
        simpleMode: true,
      },
    };

    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName, sharedOptions, config, executorOptions] =
      buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('test-executor');
    expect(sharedOptions).toMatchObject({
      baseDir: tempDir,
      model: 'default-model',
      simpleMode: true,
    });
    expect(config).toBe(defaultConfig);
    expect(executorOptions).toBeUndefined();
    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executor: testExecutor, executionMode: 'simple' });
  });

  test('passes simpleMode to batch execution when dry-run is enabled', async () => {
    await timAgent(simplePlanFile, { log: false, simple: true, dryRun: true } as any, {});

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({
      executor: testExecutor,
      executionMode: 'simple',
      dryRun: true,
    });
  });

  test('serial task execution forwards simple mode to executor calls', async () => {
    serialFindNextActionableItemSpy
      .mockReturnValueOnce({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: {
          title: 'Task 1',
          description: 'Has explicit steps so preparation is skipped',
          steps: [{ prompt: 'Do the work', done: false }],
        },
      })
      .mockReturnValueOnce(null);
    serialPrepareNextStepSpy.mockResolvedValueOnce({
      prompt: 'Prepared step context',
      promptFilePath: undefined,
      taskIndex: 0,
      stepIndex: 0,
      numStepsSelected: 1,
      rmfilterArgs: undefined,
    });
    serialMarkStepDoneSpy.mockResolvedValueOnce({ message: 'marked', planComplete: false });

    await timAgent(
      simplePlanFile,
      { log: false, serialTasks: true, simple: true, nonInteractive: true } as any,
      {}
    );

    expect(executeBatchModeSpy).not.toHaveBeenCalled();
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const [, execOptions] = executorExecuteSpy.mock.calls[0];
    expect(execOptions).toMatchObject({ executionMode: 'simple' });
    expect(serialMarkStepDoneSpy).toHaveBeenCalled();
  });

  test('serial task execution emits matching step start and end structured messages', async () => {
    serialFindNextActionableItemSpy
      .mockReturnValueOnce({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: {
          title: 'Task 1',
          description: 'Has explicit steps so preparation is skipped',
          steps: [{ prompt: 'Do the work', done: false }],
        },
      })
      .mockReturnValueOnce(null);
    serialPrepareNextStepSpy.mockResolvedValueOnce({
      prompt: 'Prepared step context',
      promptFilePath: undefined,
      taskIndex: 0,
      stepIndex: 0,
      numStepsSelected: 1,
      rmfilterArgs: undefined,
    });
    serialMarkStepDoneSpy.mockResolvedValueOnce({ message: 'marked', planComplete: false });

    const { adapter, calls } = createRecordingAdapter();
    await runWithLogger(adapter, () =>
      timAgent(simplePlanFile, { log: false, serialTasks: true, nonInteractive: true } as any, {})
    );

    const structuredMessages = calls
      .filter((call) => call.method === 'sendStructured')
      .map((call) => call.args[0] as StructuredMessage);
    expect(
      structuredMessages.filter(
        (message) => message.type === 'agent_step_start' && message.phase === 'execution'
      )
    ).toHaveLength(1);
    expect(
      structuredMessages.filter(
        (message) =>
          message.type === 'agent_step_end' && message.phase === 'execution' && message.success
      )
    ).toHaveLength(1);
  });

  test('serial mode emits structured plan completion when no actionable item remains', async () => {
    const { adapter, calls } = createRecordingAdapter();

    await runWithLogger(adapter, () =>
      timAgent(simplePlanFile, { log: false, serialTasks: true, nonInteractive: true } as any, {})
    );

    const structuredMessages = calls
      .filter((call) => call.method === 'sendStructured')
      .map((call) => call.args[0] as StructuredMessage);
    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'task_completion',
        planComplete: true,
      })
    );
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
  const timAgentSpy = mock();
  type LogCapture = { logs: string[]; errors: string[]; warnings: string[] };

  function createCaptureAdapter(
    structuredMessages: StructuredMessage[],
    capturedLogs?: LogCapture
  ): LoggerAdapter {
    return {
      log: (...args: unknown[]) =>
        capturedLogs?.logs.push(args.map((arg) => String(arg)).join(' ')),
      error: (...args: unknown[]) =>
        capturedLogs?.errors.push(args.map((arg) => String(arg)).join(' ')),
      warn: (...args: unknown[]) =>
        capturedLogs?.warnings.push(args.map((arg) => String(arg)).join(' ')),
      writeStdout: () => {},
      writeStderr: () => {},
      debugLog: () => {},
      sendStructured: (message: StructuredMessage) => {
        structuredMessages.push(message);
      },
    };
  }

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    timAgentSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-next-ready-test-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    parentPlanFile = path.join(tasksDir, '100-parent-plan.yml');
    readyPlanFile = path.join(tasksDir, '101-ready-plan.yml');
    inProgressPlanFile = path.join(tasksDir, '102-in-progress-plan.yml');
    notReadyPlanFile = path.join(tasksDir, '103-not-ready-plan.yml');

    // Create parent plan
    const parentPlan: PlanSchemaInputWithFilename = {
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
    const readyPlan: PlanSchemaInputWithFilename = {
      id: 101,
      title: 'Ready Dependency Plan',
      goal: 'Ready goal',
      details: 'Ready details',
      status: 'pending',
      tasks: [{ title: 'Ready task', description: 'Ready task description', steps: [] }],
      filename: readyPlanFile,
    };

    // Create in-progress dependency plan
    const inProgressPlan: PlanSchemaInputWithFilename = {
      id: 102,
      title: 'In Progress Plan',
      goal: 'In progress goal',
      details: 'In progress details',
      status: 'in_progress',
      tasks: [
        {
          title: 'In progress task',
          description: 'In progress task description',
          steps: [],
          done: false,
        },
      ],
      filename: inProgressPlanFile,
    };

    // Create not ready dependency plan (has unfulfilled dependencies)
    const notReadyPlan: PlanSchemaInputWithFilename = {
      id: 103,
      title: 'Not Ready Plan',
      goal: 'Not ready goal',
      details: 'Not ready details',
      status: 'pending',
      dependencies: [999], // Non-existent dependency
      tasks: [{ title: 'Not ready task', description: 'Not ready task description', steps: [] }],
      filename: notReadyPlanFile,
    };

    await fs.writeFile(parentPlanFile, yaml.stringify(parentPlan));
    await fs.writeFile(readyPlanFile, yaml.stringify(readyPlan));
    await fs.writeFile(inProgressPlanFile, yaml.stringify(inProgressPlan));
    await fs.writeFile(notReadyPlanFile, yaml.stringify(notReadyPlan));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        postApplyCommands: [],
      })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: mock(async () => tasksDir),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (planFile: string) => planFile),
      readPlanFile: async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content) as PlanSchema;
      },
    }));

    await moduleMocker.mock('.././find_next_dependency.js', () => ({
      findNextReadyDependency: findNextReadyDependencySpy,
    }));

    await moduleMocker.mock('./agent.js', () => ({
      timAgent: timAgentSpy,
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
    const structuredMessages: StructuredMessage[] = [];

    await runWithLogger(createCaptureAdapter(structuredMessages), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    // Verify findNextReadyDependency was called with correct parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'plan_discovery',
        planId: 101,
        title: 'Ready Dependency Plan',
      })
    );

    // Verify timAgent was called with the ready plan's filename
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
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
    const structuredMessages: StructuredMessage[] = [];

    await runWithLogger(createCaptureAdapter(structuredMessages), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    // Verify findNextReadyDependency was called with correct parent plan ID (100)
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'plan_discovery',
        planId: 101,
        title: 'Ready Dependency Plan',
      })
    );

    // Verify timAgent was called with the ready plan's filename
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles no ready dependencies found', async () => {
    findNextReadyDependencySpy.mockResolvedValue({
      plan: null,
      message: 'No ready dependencies found',
    });

    const options = { nextReady: '100' };
    const globalCliOptions = {};
    const structuredMessages: StructuredMessage[] = [];
    const capturedLogs: LogCapture = { logs: [], errors: [], warnings: [] };

    await runWithLogger(createCaptureAdapter(structuredMessages, capturedLogs), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    // Verify findNextReadyDependency was called
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(100, expect.any(String));

    // Verify warning message was logged
    expect(capturedLogs.logs).toContain('No ready dependencies found');

    // Verify timAgent was NOT called
    expect(timAgentSpy).not.toHaveBeenCalled();
  });

  test('handles invalid parent plan ID', async () => {
    const options = { nextReady: '999' }; // Non-existent plan ID
    const globalCliOptions = {};
    const structuredMessages: StructuredMessage[] = [];
    const capturedLogs: LogCapture = { logs: [], errors: [], warnings: [] };

    findNextReadyDependencySpy.mockResolvedValue({
      plan: null,
      message: 'Plan not found: 999',
    });

    await runWithLogger(createCaptureAdapter(structuredMessages, capturedLogs), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    // Verify warning message was logged
    expect(capturedLogs.logs).toContain('Plan not found: 999');

    // Verify timAgent was NOT called
    expect(timAgentSpy).not.toHaveBeenCalled();
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

    // Verify timAgent was called with all options intact
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
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

    // Verify timAgent was called with all execution options intact
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles findNextReadyDependency throwing error', async () => {
    findNextReadyDependencySpy.mockRejectedValue(new Error('Dependency traversal failed'));

    const options = { nextReady: '100' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      'Dependency traversal failed'
    );

    // Verify timAgent was NOT called when dependency finding fails
    expect(timAgentSpy).not.toHaveBeenCalled();
  });

  test('handles plan file resolution errors', async () => {
    // Mock resolvePlanFile to throw an error when trying to resolve the parent plan file
    await moduleMocker.mock('../../plans.js', () => ({
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
    expect(timAgentSpy).not.toHaveBeenCalled();
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
      message:
        'Found ready plan: Ready Dependency Plan (ID: 101) with goal: Implement authentication system',
    });

    const options = { nextReady: '100' };
    const globalCliOptions = {};
    const structuredMessages: StructuredMessage[] = [];

    await runWithLogger(createCaptureAdapter(structuredMessages), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'plan_discovery',
        planId: 101,
        title: 'Ready Dependency Plan',
      })
    );

    // Verify timAgent was called with the ready plan's filename
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
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
      log: false,
      verbose: true,
    } as any;
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify timAgent was called with logging options intact
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
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
        postApplyCommands: [{ title: 'Test command', command: 'echo test' }],
      },
    };

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify complex global CLI options are passed through
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);
  });

  test('handles plan with string ID correctly', async () => {
    // Create a plan with string ID
    const stringIdPlanFile = path.join(tempDir, 'tasks', 'string-plan.yml');
    const stringIdPlan: PlanSchemaInputWithFilename = {
      id: 'feature-123',
      title: 'String ID Plan',
      goal: 'Test string ID handling',
      details: 'Test details',
      status: 'pending',
      tasks: [{ title: 'Test task', description: 'Test description', steps: [] }],
      filename: stringIdPlanFile,
    };
    await fs.writeFile(stringIdPlanFile, yaml.stringify(stringIdPlan));

    // Update the mock to handle string IDs
    await moduleMocker.mock('../../plans.js', () => ({
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

    // Verify timAgent was NOT called
    expect(timAgentSpy).not.toHaveBeenCalled();
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
    const structuredMessages: StructuredMessage[] = [];

    await runWithLogger(createCaptureAdapter(structuredMessages), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    // Verify timAgent was called with the redirected plan file (not the parent)
    expect(timAgentSpy).toHaveBeenCalledWith(readyPlanFile, options, globalCliOptions);

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'plan_discovery',
        planId: 101,
        title: 'Ready Dependency Plan',
      })
    );

    // Verify all workspace options are preserved when redirecting
    const callArgs = timAgentSpy.mock.calls[0];
    expect(callArgs[1]).toEqual(
      expect.objectContaining({
        workspace: 'test-workspace-123',
        autoWorkspace: true,
        newWorkspace: true,
        nextReady: '100', // Original flag should remain
      })
    );
  });
});

// Test executor that actually modifies plan files for testing batch execution
class TestBatchExecutor {
  public executeCalls: number = 0;
  private taskCompletionStrategy: 'all-at-once' | 'incremental' | 'none' | 'error' = 'all-at-once';
  private tasksPerIteration: number = 2;

  constructor(
    strategy: 'all-at-once' | 'incremental' | 'none' | 'error' = 'all-at-once',
    tasksPerIteration: number = 2
  ) {
    this.taskCompletionStrategy = strategy;
    this.tasksPerIteration = tasksPerIteration;
  }

  async execute(prompt: string, options: any) {
    this.executeCalls++;

    if (this.taskCompletionStrategy === 'error') {
      throw new Error('Test executor failure');
    }

    if (this.taskCompletionStrategy === 'none') {
      // Don't modify the plan file - simulate executor that doesn't complete tasks
      return;
    }

    // Read and modify the plan file using real plan reading logic
    const { readPlanFile, writePlanFile } = await import('../../plans.js');
    const plan = await readPlanFile(options.planFilePath);

    if (this.taskCompletionStrategy === 'all-at-once') {
      // Mark all incomplete tasks as done
      plan.tasks.forEach((task) => {
        if (!task.done) {
          task.done = true;
        }
      });
    } else if (this.taskCompletionStrategy === 'incremental') {
      // Mark a limited number of tasks as done per iteration
      let tasksMarked = 0;
      for (const task of plan.tasks) {
        if (!task.done && tasksMarked < this.tasksPerIteration) {
          task.done = true;
          tasksMarked++;
        }
      }
    }

    // Use real plan writing logic to maintain frontmatter format
    await writePlanFile(options.planFilePath, plan);
  }
}

describe('timAgent - Batch Tasks Mode', () => {
  let tempDir: string;
  let batchPlanFile: string;
  let testExecutor: TestBatchExecutor;

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-batch-test-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    batchPlanFile = path.join(tasksDir, '200-batch-plan.yml');

    // Create a plan with multiple incomplete tasks for batch testing
    const batchPlan: PlanSchema & { filename: string } = {
      id: 200,
      title: 'Batch Test Plan',
      goal: 'Test batch execution mode',
      details: 'Plan with multiple tasks to be processed in batches',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1: Setup Database',
          description: 'Create database schema and connection',
          done: false,
          steps: [
            { done: false, prompt: 'Create the database schema' },
            { done: false, prompt: 'Configure database connection' },
          ],
        },
        {
          title: 'Task 2: Create API Routes',
          description: 'Implement REST endpoints for CRUD operations',
          done: false,
          steps: [
            { done: false, prompt: 'Set up REST API routes' },
            { done: false, prompt: 'Add validation middleware' },
          ],
        },
        {
          title: 'Task 3: Add Authentication',
          description: 'Implement user authentication and authorization',
          done: false,
          steps: [{ done: false, prompt: 'Implement authentication system' }],
        },
        {
          title: 'Task 4: Write Tests',
          description: 'Add comprehensive test coverage',
          done: false,
          steps: [
            { prompt: 'Write unit tests', done: false },
            { prompt: 'Write integration tests', done: false },
          ],
        },
      ],
      filename: batchPlanFile,
    };

    // Use real writePlanFile to create proper plan file format
    const { writePlanFile } = await import('../../plans.js');
    await writePlanFile(batchPlanFile, batchPlan);

    // Create test executor with default strategy
    testExecutor = new TestBatchExecutor();

    // Mock only essential external dependencies, keep core logic real
    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => testExecutor),
      DEFAULT_EXECUTOR: 'test-executor',
      defaultModelForExecutor: () => 'test-model',
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        postApplyCommands: [],
      })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: mock(async () => tasksDir),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => '/test/project'),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    // Mock workspace dependencies to avoid complexity
    await moduleMocker.mock('../../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));

    await moduleMocker.mock('../../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('batch mode executes and actually modifies plan file to mark tasks done', async () => {
    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await timAgent(batchPlanFile, options, globalCliOptions);

    // Verify executor was called
    expect(testExecutor.executeCalls).toBe(1);

    // Verify plan file was actually modified using real plan reading
    const { readPlanFile } = await import('../../plans.js');
    const updatedPlan = await readPlanFile(batchPlanFile);

    // All tasks should be marked as done
    expect(updatedPlan.tasks).toHaveLength(4);
    expect(updatedPlan.tasks.every((task) => task.done === true)).toBe(true);

    // Plan status should be updated to done
    expect(updatedPlan.status).toBe('done');
  });

  test('batch mode completes in multiple iterations with incremental task completion', async () => {
    // Use incremental strategy with 2 tasks per iteration
    testExecutor = new TestBatchExecutor('incremental', 2);

    // Update the mock to use the new executor
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => testExecutor),
      DEFAULT_EXECUTOR: 'test-executor',
      defaultModelForExecutor: () => 'test-model',
    }));

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await timAgent(batchPlanFile, options, globalCliOptions);

    // Batch mode may perform an additional iteration depending on review/task churn.
    expect(testExecutor.executeCalls).toBeGreaterThanOrEqual(2);

    // Verify all tasks are eventually completed using real plan reading
    const { readPlanFile } = await import('../../plans.js');
    const finalPlan = await readPlanFile(batchPlanFile);
    expect(finalPlan.tasks.every((task) => task.done === true)).toBe(true);
    expect(finalPlan.status).toBe('done');
  });

  test('batch mode with all tasks already complete exits immediately', async () => {
    // Pre-mark all tasks as done in the plan file using real plan I/O
    const { readPlanFile, writePlanFile } = await import('../../plans.js');
    const plan = await readPlanFile(batchPlanFile);
    plan.tasks.forEach((task) => {
      task.done = true;
    });
    await writePlanFile(batchPlanFile, plan);

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await timAgent(batchPlanFile, options, globalCliOptions);

    // Verify executor was never called since no tasks to process
    expect(testExecutor.executeCalls).toBe(0);

    // Verify plan file structure is maintained using already imported function
    const unchangedPlan = await readPlanFile(batchPlanFile);
    expect(unchangedPlan.tasks.every((task) => task.done === true)).toBe(true);
  });

  test('batch mode handles executor failure and maintains plan file integrity', async () => {
    // Use error strategy to simulate executor failure
    testExecutor = new TestBatchExecutor('error');

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => testExecutor),
      DEFAULT_EXECUTOR: 'test-executor',
      defaultModelForExecutor: () => 'test-model',
    }));

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    await expect(timAgent(batchPlanFile, options, globalCliOptions)).rejects.toThrow(
      'Batch mode stopped due to error'
    );

    // Verify executor was called but failed
    expect(testExecutor.executeCalls).toBe(1);

    // Verify plan file was not corrupted and tasks remain incomplete using real plan reading
    const { readPlanFile } = await import('../../plans.js');
    const plan = await readPlanFile(batchPlanFile);
    expect(plan.tasks.every((task) => !task.done)).toBe(true);
  });

  test('batch mode correctly updates plan status from pending to in_progress to done', async () => {
    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: { paths: { tasks: path.join(tempDir, 'tasks') } } };

    // Verify initial status using real plan reading
    const { readPlanFile } = await import('../../plans.js');
    let plan = await readPlanFile(batchPlanFile);
    expect(plan.status).toBe('pending');

    await timAgent(batchPlanFile, options, globalCliOptions);

    // Verify final status after completion
    plan = await readPlanFile(batchPlanFile);
    expect(plan.status).toBe('done');
    expect(plan.updatedAt).toBeDefined();
  });
});

describe('timAgent - Batch Tasks Mode Integration', () => {
  let tempDir: string;
  let batchPlanFile: string;

  beforeEach(async () => {
    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-batch-integration-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    batchPlanFile = path.join(tasksDir, '300-integration-plan.yml');

    // Create a simpler plan for integration testing
    const integrationPlan: PlanSchemaInputWithFilename = {
      id: 300,
      title: 'Integration Test Plan',
      goal: 'Test real executor integration',
      details: 'Simple plan for testing with copy-only executor',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1: Simple Implementation',
          description: 'First implementation task',
          steps: [{ prompt: 'Set up the basic structure' }],
        },
        {
          title: 'Task 2: Simple Testing',
          description: 'Second testing task',
          steps: [{ prompt: 'Add basic tests' }],
        },
      ],
      filename: batchPlanFile,
    };

    // Use real writePlanFile to create proper plan file format
    const { writePlanFile } = await import('../../plans.js');
    await writePlanFile(batchPlanFile, integrationPlan);

    // Mock only logging to suppress output during test
    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: { tasks: tasksDir },
        models: {},
        postApplyCommands: [],
      })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: mock(async () => tasksDir),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir), // Use actual temp directory
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    // Mock workspace dependencies to avoid complexity
    await moduleMocker.mock('../../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));

    await moduleMocker.mock('../../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
    }));

    // Mock clipboard and terminal operations for the copy-only executor
    await moduleMocker.mock('../../../common/clipboard.ts', () => ({
      write: mock(async () => {}),
      read: mock(async () => ''),
    }));

    await moduleMocker.mock('../../../common/terminal.ts', () => ({
      waitForEnter: mock(async () => ''), // Return empty string to exit the while loop
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test.skip('end-to-end batch mode with copy-only executor', async () => {
    // Create some dummy source files for rmfilter to work with
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(srcDir, 'main.js'), 'console.log("Hello world");');

    const options = {
      log: false,
      nonInteractive: true,
      executor: 'copy-only',
    } as any;
    const globalCliOptions = {
      config: {
        paths: { tasks: path.join(tempDir, 'tasks') },
      },
    };

    // This should work end-to-end with minimal mocking
    await timAgent(batchPlanFile, options, globalCliOptions);

    // Verify plan file was modified using real plan reading
    const { readPlanFile } = await import('../../plans.js');
    const updatedPlan = await readPlanFile(batchPlanFile);

    // With copy-only executor, tasks should be marked as done
    expect(updatedPlan.tasks).toHaveLength(2);
    expect(updatedPlan.tasks[0].done).toBe(true);
    expect(updatedPlan.tasks[1].done).toBe(true);
    expect(updatedPlan.status).toBe('done');
  });
});
