import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAgentCommand } from './agent.js';
import * as agentModule from './agent.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile } from '../../plans.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { clearPlanSyncContext } from '../../db/plan_sync.js';
import { HeadlessAdapter } from '../../../logging/headless_adapter.js';
import { watchPlanFile } from '../../plan_file_watcher.js';
import * as adapterModule from '../../../logging/adapter.js';
import { getLoggerAdapter, runWithLogger, type LoggerAdapter } from '../../../logging/adapter.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import { markParentInProgress } from './parent_plans.js';
import type { PlanSchema } from '../../planSchema.js';

// Module-level control variables
let tempDir = '';
// planFile for workspace_setup mock to return
let currentTestPlanFile = '';

// Batch tasks mode describe state
let workingCopyStatusCallCount = 0;

// Simple mode flag plumbing describe state - executor and batch mode control
const executeBatchModeSpy = vi.fn(async () => undefined);
// When true, executeBatchMode uses the spy (for simple mode tests);
// when false, it delegates to the real implementation (for batch mode tests)
let useBatchModeSpy = true;
// When true, getAllIncompleteTasks uses the real implementation (for batch mode tests)
let useRealFindNext = false;
const buildExecutorAndLogSpy = vi.fn(() => ({
  execute: executorExecuteSpy,
  filePathPrefix: '',
}));
const executorExecuteSpy = vi.fn(async () => {});

// For serial mode in simple mode tests
let serialFindNextActionableItemImpl: () => any = () => null;
let serialPrepareNextStepImpl: () => Promise<any> = async () => null;
let serialMarkStepDoneImpl: () => Promise<any> = async () => ({
  message: 'Marked',
  planComplete: false,
});
let serialMarkTaskDoneImpl: () => Promise<any> = async () => ({
  message: 'Task updated',
  planComplete: false,
});

// For batch mode tests - TestBatchExecutor instance
let testBatchExecutor: TestBatchExecutor | null = null;

// ensure_plan_in_db control
let resolvePlanFromDbOrSyncFileImpl: (
  planArg: string,
  repoRoot: string,
  tasksDir?: string
) => Promise<any> = async (planArg: string) => {
  const resolvedPath = path.resolve(planArg);
  const plan = await readPlanFile(resolvedPath);
  return { plan, planPath: resolvedPath };
};

// plan_discovery control
let findNextReadyDependencyFromDbImpl: (...args: any[]) => Promise<any> = async () => ({
  plan: null,
  message: '',
});

// headless control
let loadEffectiveConfigImpl: () => Promise<any> = async () => ({
  models: {},
  postApplyCommands: [],
});
let runWithHeadlessAdapterIfEnabledImpl: (options: any) => Promise<any> = async (options: any) =>
  options.callback();

// configSchema control
let defaultConfigValue: any = {};

vi.mock('../../../logging.js', () => ({
  boldMarkdownHeaders: (text: string) => text,
  closeLogFile: vi.fn(async () => {}),
  error: vi.fn(() => {}),
  log: vi.fn(() => {}),
  openLogFile: vi.fn(() => {}),
  sendStructured: vi.fn((msg: any) => {
    // Forward to any active logger adapter (for runWithLogger in tests)
    // getLoggerAdapter is imported from logging/adapter.js at module top
    getLoggerAdapter()?.sendStructured(msg);
  }),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
  runWithLogger: vi.fn(async (adapter: any, fn: () => any) => fn()),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async (...args: any[]) => loadEffectiveConfigImpl()),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../configSchema.js', () => ({
  getDefaultConfig: vi.fn(() => defaultConfigValue),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn((...args: any[]) => buildExecutorAndLogSpy(...args)),
  DEFAULT_EXECUTOR: 'fall-back-executor',
  defaultModelForExecutor: vi.fn(() => 'default-model'),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => tempDir),
  getCurrentBranchName: vi.fn(async () => 'feature/batch-test'),
  getTrunkBranch: vi.fn(async () => 'main'),
  getWorkingCopyStatus: vi.fn(async () => ({
    hasChanges: true,
    diffHash: `diff-${workingCopyStatusCallCount++}`,
    checkFailed: false,
    output: '',
  })),
  getChangedFilesOnBranch: vi.fn(async () => []),
  getChangedFilesBetween: vi.fn(async () => []),
  getCurrentCommitHash: vi.fn(async () => 'abc123'),
}));

vi.mock('../../../common/process.js', () => ({
  logSpawn: vi.fn(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
  commitAll: vi.fn(async () => 0),
  spawnAndLogOutput: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    killedByInactivity: false,
  })),
}));

vi.mock('./batch_mode.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./batch_mode.js')>();
  return {
    ...actual,
    executeBatchMode: vi.fn(async (...args: any[]) => {
      if (useBatchModeSpy) {
        return executeBatchModeSpy(...args);
      }
      return actual.executeBatchMode(...args);
    }),
  };
});

vi.mock('../../summary/collector.js', () => ({
  SummaryCollector: class {
    recordExecutionStart = vi.fn(() => {});
    addError = vi.fn(() => {});
    addStepResult = vi.fn(() => {});
    setBatchIterations = vi.fn(() => {});
    recordExecutionEnd = vi.fn(() => {});
    trackFileChanges = vi.fn(async () => {});
    getExecutionSummary = vi.fn(() => ({}));
  },
}));

vi.mock('../../summary/display.js', () => ({
  writeOrDisplaySummary: vi.fn(async () => {}),
  formatExecutionSummaryToLines: vi.fn(() => []),
  displayExecutionSummary: vi.fn(() => {}),
}));

vi.mock('../../plans/find_next.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plans/find_next.js')>();
  return {
    ...actual,
    findNextActionableItem: vi.fn(() => serialFindNextActionableItemImpl()),
    getAllIncompleteTasks: vi.fn((...args: any[]) =>
      useRealFindNext ? actual.getAllIncompleteTasks(...(args as [any])) : []
    ),
    findPendingTask: vi.fn(() => null),
  };
});

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async (...args: any[]) => serialPrepareNextStepImpl()),
}));

vi.mock('../../plans/mark_done.js', () => ({
  markStepDone: vi.fn(async (...args: any[]) => serialMarkStepDoneImpl()),
  markTaskDone: vi.fn(async (...args: any[]) => serialMarkTaskDoneImpl()),
}));

vi.mock('../../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async () => ({
    baseDir: tempDir,
    planFile: currentTestPlanFile,
  })),
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../../plan_file_watcher.js', () => ({
  watchPlanFile: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(() => {}),
  touchWorkspaceInfo: vi.fn(() => {}),
  findWorkspaceInfosByTaskId: vi.fn(() => []),
  workspaceRowToInfo: vi.fn(() => null),
  findWorkspaceInfosByRepositoryId: vi.fn(() => []),
  findPrimaryWorkspaceForRepository: vi.fn(() => null),
  listAllWorkspaceInfos: vi.fn(() => []),
}));

vi.mock('../../notifications.js', () => ({
  sendNotification: vi.fn(async () => {}),
}));

vi.mock('../update-docs.js', () => ({
  runUpdateDocs: vi.fn(async () => {}),
}));

vi.mock('../update-lessons.js', () => ({
  runUpdateLessons: vi.fn(async () => {}),
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: vi.fn(async () => true),
}));

vi.mock('../../assignments/auto_claim.js', () => ({
  autoClaimPlan: vi.fn(async () => null),
  isAutoClaimEnabled: vi.fn(() => false),
  isAutoClaimDisabled: vi.fn(() => true),
  enableAutoClaim: vi.fn(() => {}),
  disableAutoClaim: vi.fn(() => {}),
}));

vi.mock('../review.js', () => ({
  handleReviewCommand: vi.fn(async () => {}),
}));

vi.mock('../../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) =>
    runWithHeadlessAdapterIfEnabledImpl(options)
  ),
  createHeadlessAdapterForCommand: vi.fn(async () => null),
  updateHeadlessSessionInfo: vi.fn(() => {}),
  buildHeadlessSessionInfo: vi.fn(async () => null),
  resetHeadlessWarningStateForTests: vi.fn(() => {}),
  resolveHeadlessUrl: vi.fn(() => 'ws://localhost:8123/tim-agent'),
  DEFAULT_HEADLESS_URL: 'ws://localhost:8123/tim-agent',
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn(async (...args: any[]) =>
    resolvePlanFromDbOrSyncFileImpl(args[0], args[1], args[2])
  ),
  isPlanNotFoundError: vi.fn((err: unknown) => false),
}));

vi.mock('../plan_discovery.js', () => ({
  findNextReadyDependencyFromDb: vi.fn(async (...args: any[]) =>
    findNextReadyDependencyFromDbImpl(...args)
  ),
  findLatestPlanFromDb: vi.fn(async () => null),
  findNextPlanFromDb: vi.fn(async () => null),
  toHeadlessPlanSummary: vi.fn((plan: Pick<PlanSchema, 'id' | 'uuid' | 'title'>) => ({
    id: plan.id,
    uuid: plan.uuid,
    title: plan.title,
  })),
  findNextPlanFromCollection: vi.fn(() => null),
  findNextReadyDependencyFromCollection: vi.fn(() => null),
  loadDbPlans: vi.fn(async () => []),
}));

vi.mock('chalk', () => ({
  default: {
    green: (text: string) => text,
    yellow: (text: string) => text,
    gray: (text: string) => text,
    bold: (text: string) => text,
    red: (text: string) => text,
    cyan: (text: string) => text,
  },
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'Test prompt for task'),
}));

vi.mock('../../db/plan_sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/plan_sync.js')>();
  return {
    ...actual,
    syncPlanToDb: vi.fn(async () => {}),
    clearPlanSyncContext: vi.fn(() => {}),
  };
});

vi.mock('../../plan_materialize.js', () => ({
  materializePlan: vi.fn(async () => {}),
  syncMaterializedPlan: vi.fn(async () => {}),
  getMaterializedPlanPath: vi.fn(() => '/tmp/plan.md'),
  getShadowPlanPath: vi.fn(() => '/tmp/.plan.md.shadow'),
  materializeRelatedPlans: vi.fn(async () => {}),
  materializeAndPruneRelatedPlans: vi.fn(async () => {}),
  withPlanAutoSync: vi.fn(async (_id: any, _root: any, fn: () => any) => fn()),
  resolveProjectContext: vi.fn(async () => ({
    projectId: 1,
    planRowsByPlanId: new Map(),
    planRowsByUuid: new Map(),
    maxNumericId: 0,
  })),
  readMaterializedPlanRole: vi.fn(async () => null),
  ensureMaterializeDir: vi.fn(async () => '/tmp'),
  parsePlanId: vi.fn((id: string) => parseInt(id)),
  diffPlanFields: vi.fn(() => ({})),
  mergePlanWithShadow: vi.fn((base: any) => base),
  cleanupMaterializedPlans: vi.fn(async () => {}),
  MATERIALIZED_DIR: '.tim/plans',
}));

vi.mock('../../lifecycle.js', () => ({
  LifecycleManager: vi.fn(() => ({
    startup: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    killDaemons: vi.fn(() => {}),
  })),
}));

vi.mock('../../shutdown_state.js', () => ({
  isShuttingDown: vi.fn(() => false),
  setDeferSignalExit: vi.fn(() => {}),
  getSignalExitCode: vi.fn(() => undefined),
  resetShutdownState: vi.fn(() => {}),
  setShuttingDown: vi.fn(() => {}),
  isDeferSignalExit: vi.fn(() => false),
}));

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
      return;
    }

    const plan = await readPlanFile(options.planFilePath);

    if (this.taskCompletionStrategy === 'all-at-once') {
      plan.tasks.forEach((task) => {
        if (!task.done) {
          task.done = true;
        }
      });
    } else if (this.taskCompletionStrategy === 'incremental') {
      let tasksMarked = 0;
      for (const task of plan.tasks) {
        if (!task.done && tasksMarked < this.tasksPerIteration) {
          task.done = true;
          tasksMarked++;
        }
      }
    }

    await writePlanFile(options.planFilePath, plan);
  }
}

describe('timAgent - Parent Plan Status Updates', () => {
  let tasksDir: string;
  let config: any;
  let parentPlanFile: string;
  let childPlanFile: string;
  let originalCwd: string;
  let originalEnv: Partial<Record<string, string>>;

  async function writeDbBackedPlan(planPath: string, plan: PlanSchema) {
    await writePlanFile(planPath, plan, {
      cwdForIdentity: tempDir,
    });
  }

  async function readDbPlan(planId: number): Promise<PlanSchema> {
    return (await resolvePlanFromDb(planId, tempDir)).plan;
  }

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-test.git`.cwd(tempDir).quiet();
    process.chdir(tempDir);
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
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

    await writeDbBackedPlan(parentPlanFile, parentPlan);
    await writeDbBackedPlan(childPlanFile, childPlan);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks parent plan as in_progress when child plan starts', async () => {
    const loggingMod = await import('../../../logging.js');
    vi.mocked(loggingMod.sendStructured).mockClear();

    await markParentInProgress(100, config);

    const parentPlan = await readDbPlan(100);
    const childPlan = await readPlanFile(childPlanFile);

    const structuredMessageCalls = vi
      .mocked(loggingMod.sendStructured)
      .mock.calls.map((c) => c[0] as StructuredMessage);

    expect(childPlan.status).toBe('pending');
    expect(parentPlan.status).toBe('in_progress');

    expect(structuredMessageCalls).toContainEqual(
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
    await writeDbBackedPlan(parentPlanFile, parentPlan);

    const loggingMod = await import('../../../logging.js');
    vi.mocked(loggingMod.sendStructured).mockClear();

    await markParentInProgress(100, config);

    const structuredMessageCalls = vi
      .mocked(loggingMod.sendStructured)
      .mock.calls.map((c) => c[0] as StructuredMessage);

    const updatedParentPlan = await readDbPlan(100);

    expect(updatedParentPlan.status).toBe('in_progress');
    expect(
      structuredMessageCalls.filter(
        (message) => message.type === 'workflow_progress' && message.phase === 'parent-plan-start'
      )
    ).toHaveLength(0);
  });
});

describe('timAgent - simple mode flag plumbing', () => {
  let simplePlanFile: string;
  let originalEnv: Partial<Record<string, string>>;
  let originalCwd: string;
  const watchPlanFileSpy = vi.mocked(watchPlanFile);
  const defaultConfig = {
    defaultOrchestrator: 'test-executor',
    executors: {} as Record<string, any>,
    models: {},
    postApplyCommands: [],
    terminalInput: undefined as boolean | undefined,
  };
  const testExecutor = {
    execute: executorExecuteSpy,
    filePathPrefix: '',
  };

  beforeEach(async () => {
    clearPlanSyncContext();
    defaultConfig.executors = {};
    defaultConfig.terminalInput = undefined;
    delete (defaultConfig as any).defaultSubagentExecutor;
    delete (defaultConfig as any).dynamicSubagentInstructions;
    delete (defaultConfig as any).tdd;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-simple-flag-test-'));
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-simple.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
    originalCwd = process.cwd();
    process.chdir(tempDir);
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    simplePlanFile = path.join(tasksDir, '123-simple-plan.yml');
    await writePlanFile(
      simplePlanFile,
      {
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
      },
      { cwdForIdentity: tempDir }
    );
    currentTestPlanFile = simplePlanFile;

    buildExecutorAndLogSpy.mockReset();
    executorExecuteSpy.mockReset();
    executeBatchModeSpy.mockReset();
    watchPlanFileSpy.mockReturnValue({ close: vi.fn() });
    buildExecutorAndLogSpy.mockReturnValue(testExecutor);

    // Reset serial impls to defaults
    serialFindNextActionableItemImpl = () => null;
    serialPrepareNextStepImpl = async () => null;
    serialMarkStepDoneImpl = async () => ({ message: 'Marked', planComplete: false });
    serialMarkTaskDoneImpl = async () => ({ message: 'Task updated', planComplete: false });

    loadEffectiveConfigImpl = async () => defaultConfig;
    defaultConfigValue = defaultConfig;
    workingCopyStatusCallCount = 0;
    useBatchModeSpy = true;
    useRealFindNext = false;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    clearPlanSyncContext();
    closeDatabaseForTesting();
    process.chdir(originalCwd);
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('omits simple executor options when flag is not set', async () => {
    const { timAgent } = await import('./agent.js');
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
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, reviewExecutor: 'claude-code' } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ reviewExecutor: 'claude-code' });
  });

  test('uses config terminalInput value when CLI flag is not provided', async () => {
    defaultConfig.terminalInput = false;

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ terminalInput: false });
  });

  test('defaults terminalInput to process.stdin.isTTY when config and CLI do not set it', async () => {
    delete defaultConfig.terminalInput;
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const { timAgent } = await import('./agent.js');
    try {
      await timAgent(simplePlanFile, { log: false } as any, {});
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ terminalInput: true });
  });

  test('CLI --no-terminal-input overrides config terminalInput', async () => {
    defaultConfig.terminalInput = true;

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, terminalInput: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ terminalInput: false });
  });

  test('TTY is required for terminalInput even when config enables it', async () => {
    defaultConfig.terminalInput = true;
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const { timAgent } = await import('./agent.js');
    try {
      await timAgent(simplePlanFile, { log: false } as any, {});
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ terminalInput: false });
  });

  test('non-interactive mode always disables terminalInput', async () => {
    defaultConfig.terminalInput = true;

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, nonInteractive: true } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ noninteractive: true, terminalInput: false });
  });

  test('passes simpleMode flag through to executor builder', async () => {
    const { timAgent } = await import('./agent.js');
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

  test('starts and closes the plan watcher when a headless adapter is active', async () => {
    const closeSpy = vi.fn();
    watchPlanFileSpy.mockReturnValue({ close: closeSpy });
    const headlessAdapter = Object.assign(Object.create(HeadlessAdapter.prototype), {
      sendPlanContent: vi.fn(),
    }) as HeadlessAdapter;
    const getLoggerAdapterSpy = vi
      .spyOn(adapterModule, 'getLoggerAdapter')
      .mockReturnValue(headlessAdapter as any);

    try {
      const { timAgent } = await import('./agent.js');
      await timAgent(simplePlanFile, { log: false } as any, {});
    } finally {
      getLoggerAdapterSpy.mockRestore();
    }

    expect(watchPlanFileSpy).toHaveBeenCalledWith(simplePlanFile, expect.any(Function));
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test('enables simpleMode when configured on executor', async () => {
    defaultConfig.executors = {
      'test-executor': {
        simpleMode: true,
      },
    };

    const { timAgent } = await import('./agent.js');
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
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, simple: true, dryRun: true } as any, {});

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({
      executor: testExecutor,
      executionMode: 'simple',
      dryRun: true,
    });
  });

  test('sets executionMode to tdd when --tdd is provided', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, tdd: true } as any, {});

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({
      executor: testExecutor,
      executionMode: 'tdd',
    });
  });

  test('enables tdd mode from plan frontmatter when CLI flag is not provided', async () => {
    const plan = await readPlanFile(simplePlanFile);
    (plan as any).tdd = true;
    await writePlanFile(simplePlanFile, plan, { cwdForIdentity: tempDir });

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executionMode: 'tdd' });
  });

  test('CLI --tdd takes precedence over simple mode execution mode selection', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, tdd: true, simple: true } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions).toMatchObject({ simpleMode: true });

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executionMode: 'tdd' });
  });

  test('explicit --no-tdd overrides plan tdd: true', async () => {
    const plan = await readPlanFile(simplePlanFile);
    (plan as any).tdd = true;
    await writePlanFile(simplePlanFile, plan, { cwdForIdentity: tempDir });

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, tdd: false } as any, {});

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    const [batchOptions] = executeBatchModeSpy.mock.calls[0];
    expect(batchOptions).toMatchObject({ executionMode: 'normal' });
  });

  test('serial task execution forwards simple mode to executor calls', async () => {
    serialFindNextActionableItemImpl = vi
      .fn()
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
    serialPrepareNextStepImpl = vi.fn().mockResolvedValueOnce({
      prompt: 'Prepared step context',
      promptFilePath: undefined,
      taskIndex: 0,
      stepIndex: 0,
      numStepsSelected: 1,
      rmfilterArgs: undefined,
    });
    serialMarkStepDoneImpl = vi
      .fn()
      .mockResolvedValueOnce({ message: 'marked', planComplete: false });

    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      { log: false, serialTasks: true, simple: true, nonInteractive: true } as any,
      {}
    );

    expect(executeBatchModeSpy).not.toHaveBeenCalled();
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const [, execOptions] = executorExecuteSpy.mock.calls[0];
    expect(execOptions).toMatchObject({ executionMode: 'simple' });
  });

  test('serial task execution emits matching step start and end structured messages', async () => {
    serialFindNextActionableItemImpl = vi
      .fn()
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
    serialPrepareNextStepImpl = vi.fn().mockResolvedValueOnce({
      prompt: 'Prepared step context',
      promptFilePath: undefined,
      taskIndex: 0,
      stepIndex: 0,
      numStepsSelected: 1,
      rmfilterArgs: undefined,
    });
    serialMarkStepDoneImpl = vi
      .fn()
      .mockResolvedValueOnce({ message: 'marked', planComplete: false });

    const loggingMod = await import('../../../logging.js');
    vi.mocked(loggingMod.sendStructured).mockClear();

    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      { log: false, serialTasks: true, nonInteractive: true } as any,
      {}
    );

    const structuredMessages = vi
      .mocked(loggingMod.sendStructured)
      .mock.calls.map((c) => c[0] as StructuredMessage);
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
    const loggingMod = await import('../../../logging.js');
    vi.mocked(loggingMod.sendStructured).mockClear();

    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      { log: false, serialTasks: true, nonInteractive: true } as any,
      {}
    );

    const structuredMessages = vi
      .mocked(loggingMod.sendStructured)
      .mock.calls.map((c) => c[0] as StructuredMessage);
    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'task_completion',
        planComplete: true,
      })
    );
  });

  test('passes subagentExecutor and dynamicSubagentInstructions to executor builder from CLI options', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      {
        log: false,
        executor: 'codex-cli',
        dynamicInstructions: 'Always use codex.',
      } as any,
      {}
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.subagentExecutor).toBe('codex-cli');
    expect(sharedOptions.dynamicSubagentInstructions).toBe('Always use codex.');
  });

  test('subagentExecutor defaults to dynamic when not specified in CLI or config', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.subagentExecutor).toBe('dynamic');
  });

  test('subagentExecutor falls back to config.defaultSubagentExecutor when CLI option not set', async () => {
    (defaultConfig as any).defaultSubagentExecutor = 'claude-code';

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.subagentExecutor).toBe('claude-code');

    delete (defaultConfig as any).defaultSubagentExecutor;
  });

  test('CLI --executor overrides config.defaultSubagentExecutor', async () => {
    (defaultConfig as any).defaultSubagentExecutor = 'claude-code';

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, executor: 'codex-cli' } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.subagentExecutor).toBe('codex-cli');

    delete (defaultConfig as any).defaultSubagentExecutor;
  });

  test('dynamicSubagentInstructions falls back to config when CLI not set', async () => {
    (defaultConfig as any).dynamicSubagentInstructions = 'Config-level instructions.';

    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.dynamicSubagentInstructions).toBe('Config-level instructions.');

    delete (defaultConfig as any).dynamicSubagentInstructions;
  });

  test('dynamicSubagentInstructions falls back to default when not in CLI or config', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.dynamicSubagentInstructions).toBe(
      'Prefer claude-code for UI tasks, codex-cli for everything else.'
    );
  });

  test('CLI --dynamic-instructions overrides config.dynamicSubagentInstructions', async () => {
    (defaultConfig as any).dynamicSubagentInstructions = 'Config-level instructions.';

    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      { log: false, dynamicInstructions: 'CLI override instructions.' } as any,
      {}
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(sharedOptions.dynamicSubagentInstructions).toBe('CLI override instructions.');

    delete (defaultConfig as any).dynamicSubagentInstructions;
  });

  test('orchestrator flag selects main loop executor independently of subagent executor', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(
      simplePlanFile,
      { log: false, orchestrator: 'codex-cli', executor: 'claude-code' } as any,
      {}
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName, sharedOptions] = buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('codex-cli');
    expect(sharedOptions.subagentExecutor).toBe('claude-code');
  });

  test('orchestrator falls back to config.defaultOrchestrator when CLI not set', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName] = buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('test-executor');
  });

  test('CLI --orchestrator overrides config.defaultOrchestrator', async () => {
    const { timAgent } = await import('./agent.js');
    await timAgent(simplePlanFile, { log: false, orchestrator: 'codex-cli' } as any, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    const [executorName] = buildExecutorAndLogSpy.mock.calls[0];
    expect(executorName).toBe('codex-cli');
  });
});

describe('handleAgentCommand - --next-ready flag', () => {
  let tasksDir: string;
  let parentPlanFile: string;
  let readyPlanFile: string;
  let inProgressPlanFile: string;
  let notReadyPlanFile: string;

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
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-next-ready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    parentPlanFile = path.join(tasksDir, '100-parent-plan.yml');
    readyPlanFile = path.join(tasksDir, '101-ready-plan.yml');
    inProgressPlanFile = path.join(tasksDir, '102-in-progress-plan.yml');
    notReadyPlanFile = path.join(tasksDir, '103-not-ready-plan.yml');

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

    const readyPlan: PlanSchemaInputWithFilename = {
      id: 101,
      title: 'Ready Dependency Plan',
      goal: 'Ready goal',
      details: 'Ready details',
      status: 'pending',
      tasks: [{ title: 'Ready task', description: 'Ready task description', steps: [] }],
      filename: readyPlanFile,
    };

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

    const notReadyPlan: PlanSchemaInputWithFilename = {
      id: 103,
      title: 'Not Ready Plan',
      goal: 'Not ready goal',
      details: 'Not ready details',
      status: 'pending',
      dependencies: [999],
      tasks: [{ title: 'Not ready task', description: 'Not ready task description', steps: [] }],
      filename: notReadyPlanFile,
    };

    await fs.writeFile(parentPlanFile, yaml.stringify(parentPlan));
    await fs.writeFile(readyPlanFile, yaml.stringify(readyPlan));
    await fs.writeFile(inProgressPlanFile, yaml.stringify(inProgressPlan));
    await fs.writeFile(notReadyPlanFile, yaml.stringify(notReadyPlan));

    loadEffectiveConfigImpl = async () => ({
      models: {},
      postApplyCommands: [],
    });

    resolvePlanFromDbOrSyncFileImpl = async (planArg: string) => {
      const resolvedPath = path.resolve(planArg);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        plan: yaml.parse(content) as PlanSchema,
        planPath: resolvedPath,
      };
    };

    findNextReadyDependencyFromDbImpl = async () => ({ plan: null, message: '' });
    workingCopyStatusCallCount = 0;
    // Prevent timAgent from actually running in --next-ready tests;
    // verification is done via runWithHeadlessAdapterIfEnabled mock args
    runWithHeadlessAdapterIfEnabledImpl = async (_opts: any) => {};
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('throws error when --next-ready is provided without a value', async () => {
    const options = { nextReady: true };
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
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
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

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('finds ready dependency using parent plan file path', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = { nextReady: parentPlanFile };
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

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('handles no ready dependencies found', async () => {
    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: null,
      message: 'No ready dependencies found',
    });

    const timAgentSpy = vi.spyOn(agentModule, 'timAgent').mockResolvedValue(undefined as any);

    const options = { nextReady: '100' };
    const globalCliOptions = {};
    const structuredMessages: StructuredMessage[] = [];
    const capturedLogs: LogCapture = { logs: [], errors: [], warnings: [] };

    await runWithLogger(createCaptureAdapter(structuredMessages, capturedLogs), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    expect(timAgentSpy).not.toHaveBeenCalled();
    timAgentSpy.mockRestore();
  });

  test('handles invalid parent plan ID', async () => {
    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: null,
      message: 'Plan not found: 999',
    });

    const timAgentSpy = vi.spyOn(agentModule, 'timAgent').mockResolvedValue(undefined as any);

    const options = { nextReady: '999' };
    const globalCliOptions = {};
    const structuredMessages: StructuredMessage[] = [];
    const capturedLogs: LogCapture = { logs: [], errors: [], warnings: [] };

    await runWithLogger(createCaptureAdapter(structuredMessages, capturedLogs), () =>
      handleAgentCommand(undefined, options, globalCliOptions)
    );

    expect(timAgentSpy).not.toHaveBeenCalled();
    timAgentSpy.mockRestore();
  });

  test('throws error when parent plan file does not have valid ID', async () => {
    const invalidPlanFile = path.join(tempDir, 'tasks', '999-invalid-plan.yml');
    const invalidPlan: Partial<PlanSchema> = {
      title: 'Invalid Plan',
      goal: 'No ID',
      status: 'pending',
    };
    await fs.writeFile(invalidPlanFile, yaml.stringify(invalidPlan));

    resolvePlanFromDbOrSyncFileImpl = async (planArg: string) => {
      const resolvedPath = path.resolve(planArg);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        plan: yaml.parse(content) as PlanSchema,
        planPath: resolvedPath,
      };
    };

    const options = { nextReady: invalidPlanFile };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      `Plan file ${invalidPlanFile} does not have a valid numeric ID`
    );
  });

  test('works with workspace options', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      workspace: 'test-workspace',
      autoWorkspace: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('works with execution options', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      orchestrator: 'claude',
      model: 'claude-3-5-sonnet-20241022',
      steps: '5',
      dryRun: true,
      nonInteractive: true,
    };
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('handles findNextReadyDependency throwing error', async () => {
    findNextReadyDependencyFromDbImpl = vi
      .fn()
      .mockRejectedValue(new Error('Dependency traversal failed'));

    const timAgentSpy = vi.spyOn(agentModule, 'timAgent').mockResolvedValue(undefined as any);

    const options = { nextReady: '100' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      'Dependency traversal failed'
    );

    expect(timAgentSpy).not.toHaveBeenCalled();
    timAgentSpy.mockRestore();
  });

  test('handles plan file resolution errors', async () => {
    resolvePlanFromDbOrSyncFileImpl = async (planFile: string) => {
      if (planFile.includes('non-existent')) {
        throw new Error('File not found');
      }
      const resolvedPath = path.resolve(planFile);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        plan: yaml.parse(content) as PlanSchema,
        planPath: resolvedPath,
      };
    };

    const timAgentSpy = vi.spyOn(agentModule, 'timAgent').mockResolvedValue(undefined as any);

    const options = { nextReady: '/path/to/non-existent-plan.yml' };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      'File not found'
    );

    expect(timAgentSpy).not.toHaveBeenCalled();
    timAgentSpy.mockRestore();
  });

  test('logs specific plan details when dependency is found', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;
    readyPlanContent.goal = 'Implement authentication system';
    readyPlanContent.details = 'Add OAuth and session management';

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
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

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('preserves logging options when redirecting to dependency', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
      message: 'Found ready plan: Ready Dependency Plan (ID: 101)',
    });

    const options = {
      nextReady: '100',
      log: false,
      verbose: true,
    } as any;
    const globalCliOptions = {};

    await handleAgentCommand(undefined, options, globalCliOptions);

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('works with complex globalCliOptions', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
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

    // Verify runWithHeadlessAdapterIfEnabled was called (which would invoke timAgent('101', ...))
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));
  });

  test('handles plan with string ID correctly', async () => {
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

    resolvePlanFromDbOrSyncFileImpl = async (planArg: string) => {
      const resolvedPath = path.resolve(planArg);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        plan: yaml.parse(content) as PlanSchema,
        planPath: resolvedPath,
      };
    };

    const timAgentSpy = vi.spyOn(agentModule, 'timAgent').mockResolvedValue(undefined as any);

    const options = { nextReady: stringIdPlanFile };
    const globalCliOptions = {};

    await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
      `Plan file ${stringIdPlanFile} does not have a valid numeric ID`
    );

    expect(timAgentSpy).not.toHaveBeenCalled();
    timAgentSpy.mockRestore();
  });

  test('ensures workspace operations use the redirected plan filename', async () => {
    const readyPlanContent = yaml.parse(await fs.readFile(readyPlanFile, 'utf-8')) as PlanSchema & {
      filename: string;
    };
    readyPlanContent.filename = readyPlanFile;

    findNextReadyDependencyFromDbImpl = vi.fn().mockResolvedValue({
      plan: readyPlanContent,
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

    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'plan_discovery',
        planId: 101,
        title: 'Ready Dependency Plan',
      })
    );

    // Verify runWithHeadlessAdapterIfEnabled was called with the redirected plan
    const headlessMod = await import('../../headless.js');
    const runWithHeadlessMock = vi.mocked(headlessMod.runWithHeadlessAdapterIfEnabled);
    expect(runWithHeadlessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent',
        plan: expect.objectContaining({ id: 101, title: 'Ready Dependency Plan' }),
      })
    );
  });
});

describe('handleAgentCommand - headless metadata for direct plan argument', () => {
  let tasksDir: string;
  let planPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-headless-direct-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    planPath = path.join(tasksDir, '123-direct-plan.yml');

    const directPlan: PlanSchemaInputWithFilename = {
      id: 123,
      title: 'Direct Plan',
      goal: 'Test direct plan metadata',
      details: 'Ensure headless receives plan metadata',
      status: 'pending',
      tasks: [{ title: 'Task', description: 'Task description', steps: [] }],
      filename: planPath,
    };
    await fs.writeFile(planPath, yaml.stringify(directPlan));

    loadEffectiveConfigImpl = async () => ({
      paths: { tasks: tasksDir },
      models: {},
      postApplyCommands: [],
    });

    resolvePlanFromDbOrSyncFileImpl = async (_planRef: string) => {
      const content = await fs.readFile(planPath, 'utf-8');
      return {
        plan: yaml.parse(content) as PlanSchema,
        planPath,
      };
    };

    // Don't call the callback to avoid running timAgent for real
    // (intra-module calls can't be intercepted by vi.spyOn)
    runWithHeadlessAdapterIfEnabledImpl = async (_opts: any) => {};

    currentTestPlanFile = planPath;
    workingCopyStatusCallCount = 0;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('resolves direct plan argument before constructing headless plan summary', async () => {
    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleAgentCommand('123', {}, {});

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent',
        interactive: true,
        plan: { id: 123, title: 'Direct Plan' },
      })
    );
  });

  test('keeps headless session interactive when terminal input is disabled', async () => {
    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleAgentCommand('123', { terminalInput: false }, {});

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent',
        interactive: true,
      })
    );
  });

  test('marks headless session non-interactive in non-interactive mode', async () => {
    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleAgentCommand('123', { nonInteractive: true }, {});

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent',
        interactive: false,
      })
    );
  });

  test('keeps headless session interactive when config disables terminal input', async () => {
    loadEffectiveConfigImpl = async () => ({
      paths: { tasks: tasksDir },
      models: {},
      postApplyCommands: [],
      terminalInput: false,
    });

    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleAgentCommand('123', {}, {});

    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agent',
        interactive: true,
      })
    );
  });
});

describe('timAgent - Batch Tasks Mode', () => {
  let batchPlanFile: string;
  let originalEnv: Partial<Record<string, string>>;

  beforeEach(async () => {
    workingCopyStatusCallCount = 0;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-batch-test-'));
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-batch.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    batchPlanFile = path.join(tasksDir, '200-batch-plan.yml');

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

    await writePlanFile(batchPlanFile, batchPlan, { cwdForIdentity: tempDir });
    currentTestPlanFile = batchPlanFile;

    testBatchExecutor = new TestBatchExecutor();

    buildExecutorAndLogSpy.mockReset();
    buildExecutorAndLogSpy.mockReturnValue(testBatchExecutor as any);
    executeBatchModeSpy.mockReset();

    loadEffectiveConfigImpl = async () => ({
      models: {},
      postApplyCommands: [],
    });
    defaultConfigValue = { models: {}, postApplyCommands: [] };
    useBatchModeSpy = false; // Use real executeBatchMode for batch mode tests
    useRealFindNext = true; // Use real getAllIncompleteTasks for batch mode tests
    runWithHeadlessAdapterIfEnabledImpl = async (opts: any) => opts.callback();
    // Reset to default so it uses batchPlanFile, not a stale closure from a previous test
    resolvePlanFromDbOrSyncFileImpl = async (planArg: string) => {
      const resolvedPath = path.resolve(planArg);
      const plan = await readPlanFile(resolvedPath);
      return { plan, planPath: resolvedPath };
    };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('batch mode executes and actually modifies plan file to mark tasks done', async () => {
    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    const { timAgent } = await import('./agent.js');
    await timAgent(batchPlanFile, options, globalCliOptions);

    expect(testBatchExecutor!.executeCalls).toBe(1);

    const updatedPlan = await readPlanFile(batchPlanFile);

    expect(updatedPlan.tasks).toHaveLength(4);
    expect(updatedPlan.tasks.every((task) => task.done === true)).toBe(true);

    expect(updatedPlan.status).toBe('needs_review');
  });

  test('batch mode completes in multiple iterations with incremental task completion', async () => {
    testBatchExecutor = new TestBatchExecutor('incremental', 2);
    buildExecutorAndLogSpy.mockReturnValue(testBatchExecutor as any);

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    const { timAgent } = await import('./agent.js');
    await timAgent(batchPlanFile, options, globalCliOptions);

    expect(testBatchExecutor.executeCalls).toBeGreaterThanOrEqual(2);

    const finalPlan = await readPlanFile(batchPlanFile);
    expect(finalPlan.tasks.every((task) => task.done === true)).toBe(true);
    expect(finalPlan.status).toBe('needs_review');
  });

  test('batch mode with all tasks already complete exits immediately', async () => {
    const plan = await readPlanFile(batchPlanFile);
    plan.tasks.forEach((task) => {
      task.done = true;
    });
    await writePlanFile(batchPlanFile, plan);

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    const { timAgent } = await import('./agent.js');
    await timAgent(batchPlanFile, options, globalCliOptions);

    expect(testBatchExecutor!.executeCalls).toBe(0);

    const unchangedPlan = await readPlanFile(batchPlanFile);
    expect(unchangedPlan.tasks.every((task) => task.done === true)).toBe(true);
  });

  test('batch mode handles executor failure and maintains plan file integrity', async () => {
    testBatchExecutor = new TestBatchExecutor('error');
    buildExecutorAndLogSpy.mockReturnValue(testBatchExecutor as any);

    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    const { timAgent } = await import('./agent.js');
    await expect(timAgent(batchPlanFile, options, globalCliOptions)).rejects.toThrow(
      'Batch mode stopped due to error'
    );

    expect(testBatchExecutor.executeCalls).toBe(1);

    const plan = await readPlanFile(batchPlanFile);
    expect(plan.tasks.every((task) => !task.done)).toBe(true);
  });

  test('batch mode correctly updates plan status from pending to in_progress to needs_review', async () => {
    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    let plan = await readPlanFile(batchPlanFile);
    expect(plan.status).toBe('pending');

    const { timAgent } = await import('./agent.js');
    await timAgent(batchPlanFile, options, globalCliOptions);

    plan = await readPlanFile(batchPlanFile);
    expect(plan.status).toBe('needs_review');
    expect(plan.updatedAt).toBeDefined();
  });

  test('batch mode does not update plan branch metadata when running on non-trunk branch', async () => {
    const options = { batchTasks: true, log: false, nonInteractive: true } as any;
    const globalCliOptions = { config: {} };

    const { timAgent } = await import('./agent.js');
    await timAgent(batchPlanFile, options, globalCliOptions);

    const updatedPlan = await readPlanFile(batchPlanFile);
    expect(updatedPlan.branch).toBeUndefined();
  });
});
