import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CleanupRegistry } from '../../../common/cleanup_registry.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { readPlanFile, writePlanFile } from '../../plans.js';
import { resetShutdownState, setShuttingDown } from '../../shutdown_state.js';

let tempDir = '';
let planFile = '';
let effectiveConfig: Record<string, unknown> = {};

// Per-test control vars
let findNextActionableItemImpl: () => any = () => null;
let executeBatchModeImpl: () => Promise<any> = async () => undefined;
let prepareNextStepImpl: () => Promise<any> = async () => ({
  prompt: 'CTX',
  promptFilePath: undefined,
  rmfilterArgs: undefined,
  taskIndex: 0,
  stepIndex: 0,
  numStepsSelected: 1,
});

// summaryOrder is not used in vi.mock factories but is used in spy implementations below
const summaryOrder: string[] = [];

// Declare with vi.hoisted so they're available inside vi.mock() factory functions
const {
  buildExecutorAndLogSpy,
  getWorkspaceInfoByPathSpy,
  touchWorkspaceInfoSpy,
  sendNotificationSpy,
  closeLogFileSpy,
  openLogFileSpy,
  loadEffectiveConfigSpy,
  markStepDoneSpy,
  markTaskDoneSpy,
  runUpdateDocsSpy,
  runUpdateLessonsSpy,
  executePostApplyCommandSpy,
  trackFileChangesSpy,
  writeOrDisplaySummarySpy,
} = vi.hoisted(() => ({
  buildExecutorAndLogSpy: vi.fn(() => ({
    execute: vi.fn(async () => ({ success: true })),
    filePathPrefix: '',
  })),
  getWorkspaceInfoByPathSpy: vi.fn(() => ({
    workspaceType: 'auto' as const,
  })),
  touchWorkspaceInfoSpy: vi.fn(() => {}),
  sendNotificationSpy: vi.fn(async () => {}),
  closeLogFileSpy: vi.fn(async () => {}),
  openLogFileSpy: vi.fn(() => {}),
  loadEffectiveConfigSpy: vi.fn(async () => ({}) as Record<string, unknown>),
  markStepDoneSpy: vi.fn(async () => ({ message: 'Step marked', planComplete: false })),
  markTaskDoneSpy: vi.fn(async () => ({ message: 'Task marked', planComplete: false })),
  runUpdateDocsSpy: vi.fn(async () => {}),
  runUpdateLessonsSpy: vi.fn(async () => true),
  executePostApplyCommandSpy: vi.fn(async () => true),
  trackFileChangesSpy: vi.fn(async () => {}),
  writeOrDisplaySummarySpy: vi.fn(async () => {}),
}));

vi.mock('../../../logging.js', () => ({
  boldMarkdownHeaders: (text: string) => text,
  closeLogFile: vi.fn(async () => {
    summaryOrder.push('close-log');
    await closeLogFileSpy();
  }),
  error: vi.fn(() => {}),
  log: vi.fn(() => {}),
  openLogFile: openLogFileSpy,
  sendStructured: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
  writeStdout: vi.fn(() => {}),
  writeStderr: vi.fn(() => {}),
  runWithLogger: vi.fn(async (_adapter: any, fn: () => any) => fn()),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => tempDir),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../configSchema.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../configSchema.js')>()),
  getDefaultConfig: vi.fn(() => ({})),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: buildExecutorAndLogSpy,
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => undefined),
}));

vi.mock('../../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async () => ({
    baseDir: tempDir,
    planFile,
  })),
}));

vi.mock('../../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: getWorkspaceInfoByPathSpy,
  patchWorkspaceInfo: vi.fn(() => {}),
  touchWorkspaceInfo: touchWorkspaceInfoSpy,
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../../summary/collector.js', () => {
  class SummaryCollector {
    constructor(_opts: any) {}
    recordExecutionStart() {}
    recordExecutionEnd() {
      summaryOrder.push('record-end');
    }
    addStepResult() {}
    addError() {}
    async trackFileChanges() {
      summaryOrder.push('track-files');
      await trackFileChangesSpy();
    }
    getExecutionSummary() {
      return {};
    }
    setBatchIterations() {}
  }
  return { SummaryCollector };
});

vi.mock('../../summary/display.js', () => ({
  writeOrDisplaySummary: vi.fn(async () => {
    summaryOrder.push('write-summary');
    await writeOrDisplaySummarySpy();
  }),
  formatExecutionSummaryToLines: vi.fn(() => []),
  displayExecutionSummary: vi.fn(() => {}),
}));

vi.mock('../../notifications.js', () => ({
  sendNotification: sendNotificationSpy,
}));

vi.mock('../../plans/mark_done.js', () => ({
  markStepDone: markStepDoneSpy,
  markTaskDone: markTaskDoneSpy,
}));

vi.mock('../update-docs.js', () => ({
  runUpdateDocs: runUpdateDocsSpy,
}));

vi.mock('../update-lessons.js', () => ({
  runUpdateLessons: runUpdateLessonsSpy,
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: executePostApplyCommandSpy,
}));

vi.mock('../../plans/find_next.js', () => ({
  findNextActionableItem: vi.fn(() => findNextActionableItemImpl()),
  getAllIncompleteTasks: vi.fn(() => []),
  findPendingTask: vi.fn(() => null),
}));

vi.mock('./batch_mode.js', () => ({
  executeBatchMode: vi.fn(async (...args: any[]) => executeBatchModeImpl()),
}));

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async (...args: any[]) => prepareNextStepImpl()),
}));

vi.mock('../../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(async (planId: number, repoRoot: string) => {
      const plan = await actual.readPlanFile(planFile);
      return { plan, planPath: planFile };
    }),
  };
});

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'test prompt'),
}));

vi.mock('../../db/plan_sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/plan_sync.js')>();
  return {
    ...actual,
    syncPlanToDb: vi.fn(async () => {}),
  };
});

vi.mock('../../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plan_materialize.js')>();
  return {
    ...actual,
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
  };
});

vi.mock('../../assignments/auto_claim.js', () => ({
  autoClaimPlan: vi.fn(async () => null),
  isAutoClaimEnabled: vi.fn(() => false),
}));

vi.mock('../review.js', () => ({
  handleReviewCommand: vi.fn(async () => {}),
}));

vi.mock('../plan_discovery.js', () => ({
  findNextPlanFromDb: vi.fn(async () => null),
  findLatestPlanFromDb: vi.fn(async () => null),
  findNextReadyDependencyFromDb: vi.fn(async () => ({ plan: null, message: '' })),
  toHeadlessPlanSummary: vi.fn((plan: any) => plan),
}));

vi.mock('../../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
  isTunnelActive: vi.fn(() => false),
  toHeadlessPlanSummary: vi.fn((plan: any) => plan),
  createHeadlessAdapterForCommand: vi.fn(async () => null),
  updateHeadlessSessionInfo: vi.fn(() => {}),
  buildHeadlessSessionInfo: vi.fn(async () => null),
  resetHeadlessWarningStateForTests: vi.fn(() => {}),
  resolveHeadlessUrl: vi.fn(() => 'ws://localhost:8123/tim-agent'),
  DEFAULT_HEADLESS_URL: 'ws://localhost:8123/tim-agent',
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

describe('timAgent lifecycle integration', () => {
  let originalEnv: Partial<Record<string, string>>;

  beforeEach(async () => {
    CleanupRegistry['instance'] = undefined;
    resetShutdownState();

    buildExecutorAndLogSpy.mockClear();
    getWorkspaceInfoByPathSpy.mockClear();
    touchWorkspaceInfoSpy.mockClear();
    sendNotificationSpy.mockClear();
    closeLogFileSpy.mockClear();
    openLogFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    loadEffectiveConfigSpy.mockImplementation(async () => effectiveConfig);
    markStepDoneSpy.mockClear();
    markTaskDoneSpy.mockClear();
    runUpdateDocsSpy.mockClear();
    runUpdateLessonsSpy.mockClear();
    executePostApplyCommandSpy.mockClear();
    summaryOrder.length = 0;
    trackFileChangesSpy.mockClear();
    writeOrDisplaySummarySpy.mockClear();

    // Reset per-test behavior
    findNextActionableItemImpl = () => null;
    executeBatchModeImpl = async () => undefined;
    prepareNextStepImpl = async () => ({
      prompt: 'CTX',
      promptFilePath: undefined,
      rmfilterArgs: undefined,
      taskIndex: 0,
      stepIndex: 0,
      numStepsSelected: 1,
    });

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-lifecycle-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-lifecycle.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
    planFile = path.join(tasksDir, '1-plan.yml');

    effectiveConfig = {
      models: {},
      postApplyCommands: [],
      lifecycle: {
        commands: [
          {
            title: 'Lifecycle setup',
            command: `printf started > ${JSON.stringify(path.join(tempDir, 'lifecycle-startup.txt'))}`,
            shutdown: `printf stopped > ${JSON.stringify(path.join(tempDir, 'lifecycle-shutdown.txt'))}`,
          },
        ],
      },
    };

    await writePlanFile(
      planFile,
      {
        id: 1,
        title: 'Lifecycle Plan',
        goal: 'Test lifecycle integration',
        details: 'Exercise shutdown-aware cleanup',
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'Do the work',
            steps: [{ prompt: 'implement', done: false }],
          },
        ],
        updatedAt: new Date().toISOString(),
      },
      { cwdForIdentity: tempDir }
    );

    // workspace_setup mock uses module-level tempDir/planFile refs
  });

  afterEach(async () => {
    vi.clearAllMocks();
    resetShutdownState();
    CleanupRegistry['instance'] = undefined;
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

  test('runs lifecycle startup and shutdown and exits with the captured signal code', async () => {
    // Simulate signal arriving DURING the execution loop (after startup)
    findNextActionableItemImpl = () => {
      setShuttingDown(130);
      return null;
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(touchWorkspaceInfoSpy).toHaveBeenCalledWith(tempDir);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    expect(sendNotificationSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ status: 'interrupted' })
    );
    // Lifecycle startup should have run (signal arrives after startup)
    expect(await fs.readFile(path.join(tempDir, 'lifecycle-startup.txt'), 'utf-8')).toBe('started');
    // Lifecycle shutdown should have run in the finally block
    expect(await fs.readFile(path.join(tempDir, 'lifecycle-shutdown.txt'), 'utf-8')).toBe(
      'stopped'
    );
    expect(summaryOrder).toEqual(['close-log']);
    expect(CleanupRegistry.getInstance().size).toBe(0);
  });

  test('runs lifecycle shutdown before summary tracking and log closure', async () => {
    const shutdownFile = path.join(tempDir, 'lifecycle-shutdown.txt');
    trackFileChangesSpy.mockImplementation(async () => {
      expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    });

    findNextActionableItemImpl = () => null;

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: true, summary: true, serialTasks: true }, {});

    expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    expect(summaryOrder).toEqual(['record-end', 'track-files', 'write-summary', 'close-log']);
  });

  test('runs lifecycle shutdown for the batch mode execution path', async () => {
    executeBatchModeImpl = async () => undefined;

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false }, {});

    expect(await fs.readFile(path.join(tempDir, 'lifecycle-startup.txt'), 'utf-8')).toBe('started');
    expect(await fs.readFile(path.join(tempDir, 'lifecycle-shutdown.txt'), 'utf-8')).toBe(
      'stopped'
    );
    expect(summaryOrder).toEqual(['close-log']);
  });

  test('runs lifecycle shutdown before summary tracking and log closure in batch mode', async () => {
    const shutdownFile = path.join(tempDir, 'lifecycle-shutdown.txt');
    trackFileChangesSpy.mockImplementation(async () => {
      expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    });

    executeBatchModeImpl = async () => undefined;

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: true, summary: true }, {});

    expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    expect(summaryOrder).toEqual(['record-end', 'track-files', 'write-summary', 'close-log']);
  });

  test('skips lifecycle startup when shutdown is already requested', async () => {
    // Set shutdown flag BEFORE timAgent starts
    setShuttingDown(130);

    findNextActionableItemImpl = () => null;

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    // Lifecycle startup should NOT have run
    const startupFileExists = await fs
      .stat(path.join(tempDir, 'lifecycle-startup.txt'))
      .then(() => true)
      .catch(() => false);
    expect(startupFileExists).toBe(false);
  });

  test('serial step execution does not mark the step done after shutdown is requested during docs update', async () => {
    effectiveConfig.updateDocs = { mode: 'after-iteration' };
    runUpdateDocsSpy.mockImplementationOnce(async () => {
      setShuttingDown(130);
    });

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
    expect(markStepDoneSpy).not.toHaveBeenCalled();
  });

  test('serial step execution skips after-iteration docs when shutdown is requested after post-apply commands', async () => {
    effectiveConfig.updateDocs = { mode: 'after-iteration' };
    effectiveConfig.postApplyCommands = [{ title: 'post-apply', command: 'echo ok' }];
    executePostApplyCommandSpy.mockImplementationOnce(async () => {
      setShuttingDown(130);
      return true;
    });

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(markStepDoneSpy).not.toHaveBeenCalled();
  });

  test('serial task execution does not mark the task done after shutdown is requested during docs update', async () => {
    effectiveConfig.updateDocs = { mode: 'after-iteration' };
    runUpdateDocsSpy.mockImplementationOnce(async () => {
      setShuttingDown(130);
    });

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'task',
        taskIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
    expect(markTaskDoneSpy).not.toHaveBeenCalled();
  });

  test('serial step completion skips after-completion docs when shutdown is requested after marking the step done', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion' };
    markStepDoneSpy.mockImplementationOnce(async () => {
      setShuttingDown(130);
      return { message: 'Step marked', planComplete: true };
    });

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.js');

      await expect(
        timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {})
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
  });

  test('manual mode skips both docs and lessons after plan completion (serial step)', async () => {
    effectiveConfig.updateDocs = { mode: 'manual', applyLessons: true };

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
  });

  test('manual mode skips both docs and lessons after plan completion (serial task)', async () => {
    effectiveConfig.updateDocs = { mode: 'manual', applyLessons: true };

    markTaskDoneSpy.mockImplementationOnce(async () => ({
      message: 'Task marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'task',
        taskIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
  });

  test('manual mode skips after-iteration docs in serial step path', async () => {
    effectiveConfig.updateDocs = { mode: 'manual' };

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true }, {});

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
  });

  test('docsUpdatedAt is set after successful runUpdateDocs (after-completion, serial step)', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion' };

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeDefined();
    // Verify it's a valid ISO date
    expect(new Date(updatedPlan.docsUpdatedAt!).toISOString()).toBe(updatedPlan.docsUpdatedAt);
  });

  test('docsUpdatedAt is set after successful runUpdateDocs (after-iteration, serial step)', async () => {
    effectiveConfig.updateDocs = { mode: 'after-iteration' };

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeDefined();
    expect(new Date(updatedPlan.docsUpdatedAt!).toISOString()).toBe(updatedPlan.docsUpdatedAt);
  });

  test('lessonsAppliedAt is set after successful runUpdateLessons (serial step)', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion', applyLessons: true };

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.lessonsAppliedAt).toBeDefined();
    expect(new Date(updatedPlan.lessonsAppliedAt!).toISOString()).toBe(
      updatedPlan.lessonsAppliedAt
    );
  });

  test('after-review mode runs docs and lessons after a clean final review in serial task mode', async () => {
    effectiveConfig.updateDocs = { mode: 'after-review', applyLessons: true };

    const reviewModule = await import('../review.js');
    vi.mocked(reviewModule.handleReviewCommand).mockResolvedValueOnce({
      tasksAppended: 0,
      issuesSaved: 0,
    } as any);

    markTaskDoneSpy.mockImplementationOnce(async () => ({
      message: 'Task marked',
      planComplete: true,
    }));

    const initialPlan = await readPlanFile(planFile);
    initialPlan.tasks = [
      { title: 'Task 0', description: 'Already done', done: true },
      { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
    ];
    await writePlanFile(planFile, initialPlan);

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'task',
        taskIndex: 1,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeDefined();
    expect(updatedPlan.lessonsAppliedAt).toBeDefined();
  });

  test('after-review mode runs docs and lessons when final review is skipped in serial task mode', async () => {
    effectiveConfig.updateDocs = { mode: 'after-review', applyLessons: true };

    markTaskDoneSpy.mockImplementationOnce(async () => ({
      message: 'Task marked',
      planComplete: true,
    }));

    const initialPlan = await readPlanFile(planFile);
    initialPlan.tasks = [
      { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
    ];
    await writePlanFile(planFile, initialPlan);

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'task',
        taskIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeDefined();
    expect(updatedPlan.lessonsAppliedAt).toBeDefined();
  });

  test('after-review mode skips docs and lessons when final review saves issues in serial task mode', async () => {
    effectiveConfig.updateDocs = { mode: 'after-review', applyLessons: true };

    const reviewModule = await import('../review.js');
    vi.mocked(reviewModule.handleReviewCommand).mockResolvedValueOnce({
      tasksAppended: 0,
      issuesSaved: 1,
    } as any);

    markTaskDoneSpy.mockImplementationOnce(async () => ({
      message: 'Task marked',
      planComplete: true,
    }));

    const initialPlan = await readPlanFile(planFile);
    initialPlan.tasks = [
      { title: 'Task 0', description: 'Already done', done: true },
      { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
    ];
    await writePlanFile(planFile, initialPlan);

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'task',
        taskIndex: 1,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true }, {});

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.status).toBe('needs_review');
    expect(updatedPlan.docsUpdatedAt).toBeUndefined();
    expect(updatedPlan.lessonsAppliedAt).toBeUndefined();
  });

  test('docsUpdatedAt is NOT set when runUpdateDocs throws', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion' };

    runUpdateDocsSpy.mockImplementationOnce(async () => {
      throw new Error('docs update failed');
    });

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeUndefined();
  });

  test('lessonsAppliedAt is NOT set when runUpdateLessons throws', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion', applyLessons: true };

    runUpdateLessonsSpy.mockImplementationOnce(async () => {
      throw new Error('lessons failed');
    });

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.lessonsAppliedAt).toBeUndefined();
  });

  test('both docsUpdatedAt and lessonsAppliedAt are set when both run successfully', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion', applyLessons: true };

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.docsUpdatedAt).toBeDefined();
    expect(updatedPlan.lessonsAppliedAt).toBeDefined();
    // Both should be valid ISO timestamps
    expect(new Date(updatedPlan.docsUpdatedAt!).toISOString()).toBe(updatedPlan.docsUpdatedAt);
    expect(new Date(updatedPlan.lessonsAppliedAt!).toISOString()).toBe(
      updatedPlan.lessonsAppliedAt
    );
  });

  test('lessonsAppliedAt is set when runUpdateLessons is skipped due to no lessons', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion', applyLessons: true };

    runUpdateLessonsSpy.mockImplementationOnce(async () => 'skipped-no-lessons' as const);

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.lessonsAppliedAt).toBeDefined();
    expect(new Date(updatedPlan.lessonsAppliedAt!).toISOString()).toBe(
      updatedPlan.lessonsAppliedAt
    );
  });

  test('lessonsAppliedAt is NOT set when runUpdateLessons returns false', async () => {
    effectiveConfig.updateDocs = { mode: 'after-completion', applyLessons: true };

    runUpdateLessonsSpy.mockImplementationOnce(async () => false);

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(1, { log: false, summary: false, serialTasks: true, finalReview: false }, {});

    expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.lessonsAppliedAt).toBeUndefined();
  });

  test('manual mode with applyLessons CLI flag still skips lessons', async () => {
    effectiveConfig.updateDocs = { mode: 'manual' };

    markStepDoneSpy.mockImplementationOnce(async () => ({
      message: 'Step marked',
      planComplete: true,
    }));

    let itemReturned = false;
    findNextActionableItemImpl = () => {
      if (itemReturned) return null;
      itemReturned = true;
      return {
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      };
    };

    const { timAgent } = await import('./agent.js');
    await timAgent(
      1,
      {
        log: false,
        summary: false,
        serialTasks: true,
        finalReview: false,
        applyLessons: true,
      },
      {}
    );

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
  });
});
