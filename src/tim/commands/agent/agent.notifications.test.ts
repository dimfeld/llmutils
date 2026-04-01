import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { timAgent, handleAgentCommand } from './agent.js';
import { getDefaultConfig as realGetDefaultConfig } from '../../configSchema.js';

const {
  logSpy,
  warnSpy,
  errorSpy,
  openLogFileSpy,
  closeLogFileSpy,
  spawnAndLogOutputSpy,
  executeStubPlanSpy,
  executeBatchModeSpy,
  buildExecutorAndLogSpy,
  findNextPlanFromDbSpy,
  resolvePlanFromDbOrSyncFileSpy,
  loadEffectiveConfigSpy,
  loadGlobalConfigForNotificationsSpy,
  getGitRootSpy,
} = vi.hoisted(() => ({
  logSpy: vi.fn(() => {}),
  warnSpy: vi.fn(() => {}),
  errorSpy: vi.fn(() => {}),
  openLogFileSpy: vi.fn(() => {}),
  closeLogFileSpy: vi.fn(async () => {}),
  spawnAndLogOutputSpy: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    killedByInactivity: false,
  })),
  executeStubPlanSpy: vi.fn(async () => ({})),
  executeBatchModeSpy: vi.fn(async () => undefined),
  buildExecutorAndLogSpy: vi.fn(() => ({ execute: vi.fn(async () => {}), filePathPrefix: '' })),
  findNextPlanFromDbSpy: vi.fn(async () => undefined),
  resolvePlanFromDbOrSyncFileSpy: vi.fn(async () => null as any),
  loadEffectiveConfigSpy: vi.fn(async () => ({}) as any),
  loadGlobalConfigForNotificationsSpy: vi.fn(async () => ({}) as any),
  getGitRootSpy: vi.fn(async () => '/tmp'),
}));

let mockConfig: {
  notifications?: { command: string };
  models: { execution: string };
  postApplyCommands: string[];
};

vi.mock('../../../logging.js', () => ({
  log: logSpy,
  warn: warnSpy,
  error: errorSpy,
  openLogFile: openLogFileSpy,
  closeLogFile: closeLogFileSpy,
  boldMarkdownHeaders: (s: string) => s,
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
  runWithLogger: vi.fn(async (_adapter: any, fn: () => any) => fn()),
  writeStdout: vi.fn(() => {}),
  writeStderr: vi.fn(() => {}),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: getGitRootSpy,
}));

vi.mock('../../../common/process.js', () => ({
  logSpawn: vi.fn(() => ({ exited: Promise.resolve(0) })),
  spawnAndLogOutput: spawnAndLogOutputSpy,
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
  loadGlobalConfigForNotifications: loadGlobalConfigForNotificationsSpy,
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: buildExecutorAndLogSpy,
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../plans.js', () => ({
  readPlanFile: vi.fn(async (p: string) => {
    const content = await fs.readFile(p, 'utf-8');
    return yaml.parse(content);
  }),
  writePlanFile: vi.fn(async (p: string, data: any) => {
    await fs.writeFile(p, yaml.stringify(data));
  }),
  generatePlanFileContent: vi.fn(() => ''),
  resolvePlanFromDb: vi.fn(async () => ({
    plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
    planPath: '/tmp/plan.yml',
  })),
}));

vi.mock('../../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: resolvePlanFromDbOrSyncFileSpy,
}));

vi.mock('../plan_discovery.js', () => ({
  findNextPlanFromDb: findNextPlanFromDbSpy,
  findLatestPlanFromDb: vi.fn(async () => null),
  findNextReadyDependencyFromDb: vi.fn(async () => ({ plan: null, message: '' })),
  toHeadlessPlanSummary: vi.fn((plan: any) => plan),
}));

vi.mock('./stub_plan.js', () => ({
  executeStubPlan: executeStubPlanSpy,
}));

vi.mock('./batch_mode.js', () => ({
  executeBatchMode: executeBatchModeSpy,
}));

vi.mock('../../configSchema.js', () => ({
  getDefaultConfig: vi.fn(() => mockConfig),
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

let tempDir: string;
let planFile: string;

async function writePlan(tasks: any[] = []) {
  const plan = {
    id: 1,
    title: 'Notify Plan',
    goal: 'Goal',
    details: 'Details',
    status: 'pending',
    tasks,
  };
  await fs.writeFile(planFile, yaml.stringify(plan));
}

describe('timAgent notifications', () => {
  beforeEach(async () => {
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    spawnAndLogOutputSpy.mockClear();
    executeStubPlanSpy.mockClear();
    executeBatchModeSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    findNextPlanFromDbSpy.mockClear();
    resolvePlanFromDbOrSyncFileSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notify-test-'));
    planFile = path.join(tempDir, 'plan.yml');
    await writePlan();
    delete process.env.TIM_NOTIFY_SUPPRESS;
    // Start from real defaults so the mocked config stays aligned with configSchema changes.
    mockConfig = {
      ...realGetDefaultConfig(),
      notifications: { command: 'notify' },
      models: { execution: 'test-model' },
      postApplyCommands: [],
    };

    loadEffectiveConfigSpy.mockImplementation(async () => mockConfig);
    loadGlobalConfigForNotificationsSpy.mockImplementation(async () => mockConfig);

    // Update getGitRoot mock to use tempDir
    getGitRootSpy.mockImplementation(async () => tempDir);

    // Update resolvePlanFromDbOrSyncFile to use current planFile
    resolvePlanFromDbOrSyncFileSpy.mockImplementation(async (planArg: string) => {
      const resolvedPath = path.resolve(planArg);
      const content = await fs.readFile(resolvedPath, 'utf-8');
      return {
        plan: yaml.parse(content),
        planPath: resolvedPath,
      };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.TIM_NOTIFY_SUPPRESS;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('mock config includes the default config shape', () => {
    const defaults = realGetDefaultConfig();
    for (const key of Object.keys(defaults)) {
      expect(mockConfig).toHaveProperty(key);
    }
  });

  test('sends notification on success', async () => {
    await timAgent(planFile, { log: false, summary: false }, {} as any);

    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('sends notification on error', async () => {
    executeStubPlanSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    await expect(timAgent(planFile, { log: false, summary: false }, {} as any)).rejects.toThrow(
      'boom'
    );

    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('error');
    expect(payload.message).toContain('failed');
    expect(payload.message).toContain('boom');
    expect(payload.errorMessage).toContain('boom');
  });

  test('sends notification when plan resolution fails', async () => {
    resolvePlanFromDbOrSyncFileSpy.mockImplementationOnce(async () => {
      throw new Error('duplicate plan id');
    });

    await expect(timAgent(planFile, { log: false, summary: false }, {} as any)).rejects.toThrow(
      'duplicate plan id'
    );

    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('error');
    expect(payload.message).toContain('failed');
    expect(payload.errorMessage).toContain('duplicate plan id');
  });

  test('sends notification after batch mode execution', async () => {
    await writePlan([{ title: 'Task 1' }]);

    await timAgent(planFile, { log: false, summary: false }, {} as any);

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('sends notification after serial execution', async () => {
    await writePlan([{ title: 'Task 1', done: true }]);

    await timAgent(planFile, { log: false, summary: false, serialTasks: true }, {} as any);

    expect(executeBatchModeSpy).not.toHaveBeenCalled();
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('sends notification in dry-run mode', async () => {
    await timAgent(planFile, { log: false, summary: false, dryRun: true }, {} as any);

    expect(executeStubPlanSpy).toHaveBeenCalledTimes(1);
    expect(executeStubPlanSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('suppresses notification when env flag is set', async () => {
    process.env.TIM_NOTIFY_SUPPRESS = '1';

    await timAgent(planFile, { log: false, summary: false }, {} as any);

    expect(spawnAndLogOutputSpy).not.toHaveBeenCalled();
  });

  test('skips notification when config is missing', async () => {
    mockConfig = {
      ...realGetDefaultConfig(),
      models: { execution: 'test-model' },
      postApplyCommands: [],
    };
    delete mockConfig.notifications;
    loadEffectiveConfigSpy.mockImplementation(async () => mockConfig);

    await timAgent(planFile, { log: false, summary: false }, {} as any);

    expect(spawnAndLogOutputSpy).not.toHaveBeenCalled();
  });

  test('sends notification when config load fails', async () => {
    loadEffectiveConfigSpy.mockImplementationOnce(async () => {
      throw new Error('config boom');
    });

    await expect(handleAgentCommand(planFile, {}, {} as any)).rejects.toThrow('config boom');

    expect(loadGlobalConfigForNotificationsSpy).toHaveBeenCalledTimes(1);
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('error');
    expect(payload.message).toContain('config boom');
  });

  test('sends notification when --next finds no plan', async () => {
    await handleAgentCommand(undefined, { next: true }, {} as any);

    expect(findNextPlanFromDbSpy).toHaveBeenCalledTimes(1);
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('No ready plans found');
  });
});
