import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { getDefaultConfig as realGetDefaultConfig } from '../../configSchema.js';

let tempDir = '';
let planFile = '';

const promptConfirmSpy = vi.fn(async () => true);
const executeStubPlanSpy = vi.fn(async () => ({ tasksAppended: 0 }));
const executeBatchModeSpy = vi.fn(async () => undefined);
const closeLogFileSpy = vi.fn(async () => undefined);
const buildExecutorAndLogSpy = vi.fn(() => ({
  execute: vi.fn(async () => undefined),
  filePathPrefix: '',
}));
const resolvePlanFileSpy = vi.fn(async (input: string) => input);
const loadEffectiveConfigSpy = vi.fn(async () => ({
  ...realGetDefaultConfig(),
  models: { execution: 'test-model' },
  postApplyCommands: [],
}));

vi.mock('../../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  error: vi.fn(() => {}),
  openLogFile: vi.fn(() => {}),
  closeLogFile: closeLogFileSpy,
  boldMarkdownHeaders: (value: string) => value,
  sendStructured: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
}));

vi.mock('../../../common/input.js', () => ({
  promptConfirm: promptConfirmSpy,
  promptSelect: vi.fn(async () => ''),
  promptInput: vi.fn(async () => ''),
  promptCheckbox: vi.fn(async () => []),
  promptPrefixSelect: vi.fn(async () => ({ prefix: '', value: '' })),
  isPromptTimeoutError: vi.fn(() => false),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => tempDir),
  getCurrentBranchName: vi.fn(async () => 'feature/test'),
  getTrunkBranch: vi.fn(async () => 'main'),
}));

vi.mock('../../../common/process.js', () => ({
  logSpawn: vi.fn(() => ({ exited: Promise.resolve(0) })),
  spawnAndLogOutput: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    killedByInactivity: false,
  })),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: buildExecutorAndLogSpy,
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../plans.js', () => {
  class PlanNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PlanNotFoundError';
    }
  }
  class NoFrontmatterError extends Error {
    constructor(filePath: string) {
      super(`File lacks frontmatter: ${filePath}`);
      this.name = 'NoFrontmatterError';
    }
  }
  return {
    PlanNotFoundError,
    NoFrontmatterError,
    resolvePlanFile: resolvePlanFileSpy,
    readPlanFile: vi.fn(async (filePath: string) => {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(filePath, 'utf-8');
      const yaml = await import('yaml');
      return yaml.default.parse(content);
    }),
    writePlanFile: vi.fn(async (filePath: string, data: any) => {
      const { writeFile } = await import('node:fs/promises');
      const yaml = await import('yaml');
      await writeFile(filePath, yaml.default.stringify(data));
    }),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
    setPlanStatus: vi.fn(async () => {}),
    setPlanStatusById: vi.fn(async () => {}),
    isTaskDone: vi.fn(() => false),
    getBlockedPlans: vi.fn(() => []),
    getChildPlans: vi.fn(() => []),
    getDiscoveredPlans: vi.fn(() => []),
    getMaxNumericPlanId: vi.fn(async () => 0),
    parsePlanIdentifier: vi.fn(() => ({})),
    isPlanReady: vi.fn(() => true),
    collectDependenciesInOrder: vi.fn(async () => []),
    generateSuggestedFilename: vi.fn(async () => 'plan.yml'),
  };
});

vi.mock('./stub_plan.js', () => ({
  executeStubPlan: executeStubPlanSpy,
}));

vi.mock('./batch_mode.js', () => ({
  executeBatchMode: executeBatchModeSpy,
}));

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
  writeOrDisplaySummary: vi.fn(async () => undefined),
  formatExecutionSummaryToLines: vi.fn(() => []),
  displayExecutionSummary: vi.fn(() => {}),
}));

vi.mock('../../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async (_options: any, baseDir: string, currentPlanFile: string) => ({
    baseDir,
    planFile: currentPlanFile,
  })),
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => undefined),
  runPreExecutionWorkspaceSync: vi.fn(async () => undefined),
}));

vi.mock('../../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(() => undefined),
  touchWorkspaceInfo: vi.fn(() => undefined),
}));

vi.mock('../../assignments/auto_claim.js', () => ({
  autoClaimPlan: vi.fn(async () => undefined),
  isAutoClaimEnabled: vi.fn(() => false),
  enableAutoClaim: vi.fn(() => {}),
  disableAutoClaim: vi.fn(() => {}),
}));

vi.mock('../../notifications.js', () => ({
  sendNotification: vi.fn(async () => true),
}));

vi.mock('../../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async ({ run }: { run: () => Promise<unknown> }) => run()),
  createHeadlessAdapterForCommand: vi.fn(async () => null),
  updateHeadlessSessionInfo: vi.fn(() => {}),
  DEFAULT_HEADLESS_URL: 'ws://localhost:8123/tim-agent',
  resolveHeadlessUrl: vi.fn(() => 'ws://localhost:8123/tim-agent'),
  buildHeadlessSessionInfo: vi.fn(async () => ({})),
  resetHeadlessWarningStateForTests: vi.fn(() => {}),
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
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

describe('timAgent stub plan review continuation', () => {
  beforeEach(async () => {
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
  });

  afterEach(async () => {
    vi.clearAllMocks();
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
