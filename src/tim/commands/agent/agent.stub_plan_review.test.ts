import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';
import { clearPlanCache } from '../../plans.js';
import { getDefaultConfig as realGetDefaultConfig } from '../../configSchema.js';

describe('timAgent stub plan review continuation', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  let planFile: string;

  const promptConfirmSpy = mock(async () => true);
  const executeStubPlanSpy = mock(async () => ({ tasksAppended: 0 }));
  const executeBatchModeSpy = mock(async () => undefined);
  const closeLogFileSpy = mock(async () => undefined);
  const buildExecutorAndLogSpy = mock(() => ({ execute: mock(async () => undefined) }));
  const resolvePlanFileSpy = mock(async (input: string) => input);
  const loadEffectiveConfigSpy = mock(async () => ({
    ...realGetDefaultConfig(),
    models: { execution: 'test-model' },
    postApplyCommands: [],
  }));

  async function writePlan(tasks: any[] = []) {
    const plan = {
      id: 242,
      title: 'Stub Review Plan',
      goal: 'Goal',
      details: 'Details',
      status: 'pending',
      tasks,
    };
    await fs.writeFile(planFile, yaml.stringify(plan));
  }

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    clearPlanCache();
    promptConfirmSpy.mockClear();
    executeStubPlanSpy.mockClear();
    executeBatchModeSpy.mockClear();
    closeLogFileSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-stub-review-test-'));
    planFile = path.join(tempDir, 'plan.yml');
    await writePlan();

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: (value: string) => value,
      sendStructured: mock(() => {}),
    }));

    await moduleMocker.mock('../../../common/input.js', () => ({
      promptConfirm: promptConfirmSpy,
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentBranchName: mock(async () => 'feature/test'),
      getTrunkBranch: mock(async () => 'main'),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exited: Promise.resolve(0) })),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      getDefaultConfig: realGetDefaultConfig,
      resolveTasksDir: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: mock(async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content);
      }),
      writePlanFile: mock(async (filePath: string, data: any) => {
        await fs.writeFile(filePath, yaml.stringify(data));
      }),
    }));

    await moduleMocker.mock('./stub_plan.js', () => ({
      executeStubPlan: executeStubPlanSpy,
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
      writeOrDisplaySummary: mock(async () => undefined),
    }));

    await moduleMocker.mock('../../utils/references.js', () => ({
      ensureUuidsAndReferences: mock(async () => ({ errors: [] })),
    }));

    await moduleMocker.mock('../../workspace/workspace_setup.js', () => ({
      setupWorkspace: mock(async (_options: any, baseDir: string, currentPlanFile: string) => ({
        baseDir,
        planFile: currentPlanFile,
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_roundtrip.js', () => ({
      prepareWorkspaceRoundTrip: mock(async () => null),
      runPostExecutionWorkspaceSync: mock(async () => undefined),
      runPreExecutionWorkspaceSync: mock(async () => undefined),
    }));

    await moduleMocker.mock('../../workspace/workspace_info.js', () => ({
      getWorkspaceInfoByPath: mock(() => null),
      patchWorkspaceInfo: mock(() => undefined),
      touchWorkspaceInfo: mock(() => undefined),
    }));

    await moduleMocker.mock('../../assignments/auto_claim.js', () => ({
      autoClaimPlan: mock(async () => undefined),
      isAutoClaimEnabled: mock(() => false),
    }));

    await moduleMocker.mock('../../notifications.js', () => ({
      sendNotification: mock(async () => true),
    }));

    await moduleMocker.mock('../../headless.js', () => ({
      runWithHeadlessAdapterIfEnabled: mock(async ({ run }: { run: () => Promise<unknown> }) =>
        run()
      ),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => false),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    clearPlanCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('continues into batch mode when stub review appends tasks and user confirms', async () => {
    executeStubPlanSpy.mockResolvedValueOnce({ tasksAppended: 2 });
    promptConfirmSpy.mockResolvedValueOnce(true);

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false, summary: false }, {});

    expect(executeStubPlanSpy).toHaveBeenCalledTimes(1);
    expect(promptConfirmSpy).toHaveBeenCalledWith({
      message:
        '2 new task(s) added from review to plan 242. You can edit the plan first if needed. Continue running?',
      default: true,
    });
    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    expect(closeLogFileSpy).toHaveBeenCalledTimes(1);
  });

  test('stops after stub review appends tasks when user declines to continue', async () => {
    executeStubPlanSpy.mockResolvedValueOnce({ tasksAppended: 2 });
    promptConfirmSpy.mockResolvedValueOnce(false);

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false, summary: false }, {});

    expect(executeStubPlanSpy).toHaveBeenCalledTimes(1);
    expect(promptConfirmSpy).toHaveBeenCalledTimes(1);
    expect(executeBatchModeSpy).not.toHaveBeenCalled();
    expect(closeLogFileSpy).toHaveBeenCalledTimes(1);
  });
});
