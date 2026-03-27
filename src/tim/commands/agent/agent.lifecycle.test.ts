import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CleanupRegistry } from '../../../common/cleanup_registry.js';
import { closeDatabaseForTesting } from '../../db/database.js';
import { writePlanFile } from '../../plans.js';
import { ModuleMocker } from '../../../testing.js';
import { resetShutdownState, setShuttingDown } from '../../shutdown_state.js';

describe('timAgent lifecycle integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir: string;
  let planFile: string;
  let originalEnv: Partial<Record<string, string>>;
  let effectiveConfig: Record<string, unknown>;
  const buildExecutorAndLogSpy = mock(() => ({
    execute: mock(async () => ({ success: true })),
    filePathPrefix: '',
  }));
  const getWorkspaceInfoByPathSpy = mock(() => ({
    workspaceType: 'auto' as const,
  }));
  const touchWorkspaceInfoSpy = mock(() => {});
  const sendNotificationSpy = mock(async () => {});
  const closeLogFileSpy = mock(async () => {});
  const openLogFileSpy = mock(() => {});
  const loadEffectiveConfigSpy = mock(async () => effectiveConfig);
  const markStepDoneSpy = mock(async () => ({ message: 'Step marked', planComplete: false }));
  const markTaskDoneSpy = mock(async () => ({ message: 'Task marked', planComplete: false }));
  const runUpdateDocsSpy = mock(async () => {});
  const runUpdateLessonsSpy = mock(async () => {});
  const executePostApplyCommandSpy = mock(async () => true);
  const summaryOrder: string[] = [];
  const trackFileChangesSpy = mock(async () => {});
  const writeOrDisplaySummarySpy = mock(async () => {});

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
    markStepDoneSpy.mockClear();
    markTaskDoneSpy.mockClear();
    runUpdateDocsSpy.mockClear();
    runUpdateLessonsSpy.mockClear();
    executePostApplyCommandSpy.mockClear();
    summaryOrder.length = 0;
    trackFileChangesSpy.mockClear();
    writeOrDisplaySummarySpy.mockClear();

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

    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (text: string) => text,
      closeLogFile: mock(async () => {
        summaryOrder.push('close-log');
        await closeLogFileSpy();
      }),
      error: mock(() => {}),
      log: mock(() => {}),
      openLogFile: openLogFileSpy,
      sendStructured: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      getDefaultConfig: () => ({}),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: mock(() => undefined),
    }));

    await moduleMocker.mock('../../workspace/workspace_setup.js', () => ({
      setupWorkspace: mock(async () => ({
        baseDir: tempDir,
        planFile,
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_info.js', () => ({
      getWorkspaceInfoByPath: getWorkspaceInfoByPathSpy,
      patchWorkspaceInfo: mock(() => {}),
      touchWorkspaceInfo: touchWorkspaceInfoSpy,
    }));

    await moduleMocker.mock('../../workspace/workspace_roundtrip.js', () => ({
      prepareWorkspaceRoundTrip: mock(async () => null),
      runPostExecutionWorkspaceSync: mock(async () => {}),
      runPreExecutionWorkspaceSync: mock(async () => {}),
    }));

    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: class {
        recordExecutionStart = mock(() => {});
        recordExecutionEnd = mock(() => {
          summaryOrder.push('record-end');
        });
        addStepResult = mock(() => {});
        addError = mock(() => {});
        trackFileChanges = mock(async () => {
          summaryOrder.push('track-files');
          await trackFileChangesSpy();
        });
        getExecutionSummary = mock(() => ({}));
        constructor(_init: any) {}
      },
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {
        summaryOrder.push('write-summary');
        await writeOrDisplaySummarySpy();
      }),
    }));

    await moduleMocker.mock('../../notifications.js', () => ({
      sendNotification: sendNotificationSpy,
    }));

    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: markStepDoneSpy,
      markTaskDone: markTaskDoneSpy,
    }));

    await moduleMocker.mock('../update-docs.js', () => ({
      runUpdateDocs: runUpdateDocsSpy,
    }));

    await moduleMocker.mock('../update-lessons.js', () => ({
      runUpdateLessons: runUpdateLessonsSpy,
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: executePostApplyCommandSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
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
    // by having findNextActionableItem trigger the shutdown flag
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => {
        // Simulate SIGINT arriving during execution
        setShuttingDown(130);
        return null;
      }),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(planFile, { log: false, summary: false, serialTasks: true }, {})
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

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => null),
    }));

    const { timAgent } = await import('./agent.ts');
    await timAgent(planFile, { log: true, summary: true, serialTasks: true }, {});

    expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    expect(summaryOrder).toEqual(['record-end', 'track-files', 'write-summary', 'close-log']);
  });

  test('runs lifecycle shutdown for the batch mode execution path', async () => {
    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: mock(async () => undefined),
    }));

    const { timAgent } = await import('./agent.ts');
    await timAgent(planFile, { log: false, summary: false }, {});

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

    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: mock(async () => undefined),
    }));

    const { timAgent } = await import('./agent.ts');
    await timAgent(planFile, { log: true, summary: true }, {});

    expect(await fs.readFile(shutdownFile, 'utf-8')).toBe('stopped');
    expect(summaryOrder).toEqual(['record-end', 'track-files', 'write-summary', 'close-log']);
  });

  test('skips lifecycle startup when shutdown is already requested', async () => {
    // Set shutdown flag BEFORE timAgent starts
    setShuttingDown(130);

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => null),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(planFile, { log: false, summary: false, serialTasks: true }, {})
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

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => ({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      })),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        promptFilePath: undefined,
        rmfilterArgs: undefined,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(planFile, { log: false, summary: false, serialTasks: true }, {})
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

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => ({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      })),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        promptFilePath: undefined,
        rmfilterArgs: undefined,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(planFile, { log: false, summary: false, serialTasks: true }, {})
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

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => ({
        type: 'task',
        taskIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      })),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(planFile, { log: false, summary: false, serialTasks: true }, {})
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

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => ({
        type: 'step',
        taskIndex: 0,
        stepIndex: 0,
        task: { title: 'Task 1', description: 'Do the work', steps: [{ prompt: 'implement' }] },
      })),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CTX',
        promptFilePath: undefined,
        rmfilterArgs: undefined,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const { timAgent } = await import('./agent.ts');

      await expect(
        timAgent(
          planFile,
          { log: false, summary: false, serialTasks: true, finalReview: false },
          {}
        )
      ).rejects.toThrow('process.exit(130)');
    } finally {
      process.exit = originalExit;
    }

    expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
  });
});
