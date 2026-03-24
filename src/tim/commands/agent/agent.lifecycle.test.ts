import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CleanupRegistry } from '../../../common/cleanup_registry.js';
import { writePlanFile } from '../../plans.js';
import { ModuleMocker } from '../../../testing.js';
import { resetShutdownState, setShuttingDown } from '../../shutdown_state.js';

describe('timAgent lifecycle integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let tempDir: string;
  let planFile: string;
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

  beforeEach(async () => {
    CleanupRegistry['instance'] = undefined;
    resetShutdownState();

    buildExecutorAndLogSpy.mockClear();
    getWorkspaceInfoByPathSpy.mockClear();
    touchWorkspaceInfoSpy.mockClear();
    sendNotificationSpy.mockClear();
    closeLogFileSpy.mockClear();
    openLogFileSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-lifecycle-'));
    const tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    planFile = path.join(tasksDir, '1-plan.yml');

    await writePlanFile(planFile, {
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
    });

    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (text: string) => text,
      closeLogFile: closeLogFileSpy,
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
      loadEffectiveConfig: mock(async () => ({
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
      })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      getDefaultConfig: () => ({}),
      resolveTasksDir: mock(async () => tasksDir),
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
        recordExecutionEnd = mock(() => {});
        addStepResult = mock(() => {});
        addError = mock(() => {});
        trackFileChanges = mock(async () => {});
        getExecutionSummary = mock(() => ({}));
        constructor(_init: any) {}
      },
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    await moduleMocker.mock('../../utils/references.js', () => ({
      ensureUuidsAndReferences: mock(async () => ({ errors: [] })),
    }));

    await moduleMocker.mock('../../notifications.js', () => ({
      sendNotification: sendNotificationSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    resetShutdownState();
    CleanupRegistry['instance'] = undefined;
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
    // Lifecycle startup should have run (signal arrives after startup)
    expect(await fs.readFile(path.join(tempDir, 'lifecycle-startup.txt'), 'utf-8')).toBe('started');
    // Lifecycle shutdown should have run in the finally block
    expect(await fs.readFile(path.join(tempDir, 'lifecycle-shutdown.txt'), 'utf-8')).toBe(
      'stopped'
    );
    expect(CleanupRegistry.getInstance().size).toBe(0);
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
});
