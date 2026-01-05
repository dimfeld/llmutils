import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { rmplanAgent, handleAgentCommand } from './agent.js';
import { ModuleMocker } from '../../../testing.js';
import { getDefaultConfig as realGetDefaultConfig } from '../../configSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

const logSpy = mock(() => {});
const warnSpy = mock(() => {});
const errorSpy = mock(() => {});
const openLogFileSpy = mock(() => {});
const closeLogFileSpy = mock(async () => {});
const spawnAndLogOutputSpy = mock(async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  signal: null,
  killedByInactivity: false,
}));

const executeStubPlanSpy = mock(async () => {});
const executeBatchModeSpy = mock(async () => undefined);
const buildExecutorAndLogSpy = mock(() => ({ execute: mock(async () => {}), filePathPrefix: '' }));
const findNextPlanSpy = mock(async () => undefined);
const resolvePlanFileSpy = mock(async (p: string) => p);
let loadEffectiveConfigSpy: ReturnType<typeof mock>;
let loadGlobalConfigForNotificationsSpy: ReturnType<typeof mock>;

let tempDir: string;
let planFile: string;
let mockConfig: {
  notifications?: { command: string };
  models: { execution: string };
  postApplyCommands: string[];
};

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

describe('rmplanAgent notifications', () => {
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
    findNextPlanSpy.mockClear();
    resolvePlanFileSpy.mockClear();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-notify-test-'));
    planFile = path.join(tempDir, 'plan.yml');
    await writePlan();
    delete process.env.RMPLAN_NOTIFY_SUPPRESS;
    // Start from real defaults so the mocked config stays aligned with configSchema changes.
    mockConfig = {
      ...realGetDefaultConfig(),
      notifications: { command: 'notify' },
      models: { execution: 'test-model' },
      postApplyCommands: [],
    };

    loadEffectiveConfigSpy = mock(async () => mockConfig);
    loadGlobalConfigForNotificationsSpy = mock(async () => mockConfig);

    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
      error: errorSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: (s: string) => s,
      debugLog: mock(() => {}),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exited: Promise.resolve(0) })),
      spawnAndLogOutput: spawnAndLogOutputSpy,
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
      loadGlobalConfigForNotifications: loadGlobalConfigForNotificationsSpy,
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: mock(async (p: string) => {
        const content = await fs.readFile(p, 'utf-8');
        return yaml.parse(content);
      }),
      writePlanFile: mock(async (p: string, data: any) => {
        await fs.writeFile(p, yaml.stringify(data));
      }),
      findNextPlan: findNextPlanSpy,
    }));

    await moduleMocker.mock('./stub_plan.js', () => ({
      executeStubPlan: executeStubPlanSpy,
    }));

    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: executeBatchModeSpy,
    }));

    await moduleMocker.mock('../../utils/references.js', () => ({
      ensureUuidsAndReferences: mock(async () => ({ errors: [] })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      getDefaultConfig: mock(() => mockConfig),
      resolveTasksDir: mock(async () => tempDir),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    delete process.env.RMPLAN_NOTIFY_SUPPRESS;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('mock config includes the default config shape', () => {
    const defaults = realGetDefaultConfig();
    for (const key of Object.keys(defaults)) {
      expect(mockConfig).toHaveProperty(key);
    }
  });

  test('sends notification on success', async () => {
    await rmplanAgent(planFile, { log: false, summary: false }, {} as any);

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

    await expect(rmplanAgent(planFile, { log: false, summary: false }, {} as any)).rejects.toThrow(
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
    resolvePlanFileSpy.mockImplementationOnce(async () => {
      throw new Error('duplicate plan id');
    });

    await expect(rmplanAgent(planFile, { log: false, summary: false }, {} as any)).rejects.toThrow(
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

    await rmplanAgent(planFile, { log: false, summary: false }, {} as any);

    expect(executeBatchModeSpy).toHaveBeenCalledTimes(1);
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('sends notification after serial execution', async () => {
    await writePlan([{ title: 'Task 1', done: true }]);

    await rmplanAgent(planFile, { log: false, summary: false, serialTasks: true }, {} as any);

    expect(executeBatchModeSpy).not.toHaveBeenCalled();
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('sends notification in dry-run mode', async () => {
    await rmplanAgent(planFile, { log: false, summary: false, dryRun: true }, {} as any);

    expect(executeStubPlanSpy).toHaveBeenCalledTimes(1);
    expect(executeStubPlanSpy).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('completed');
  });

  test('suppresses notification when env flag is set', async () => {
    process.env.RMPLAN_NOTIFY_SUPPRESS = '1';

    await rmplanAgent(planFile, { log: false, summary: false }, {} as any);

    expect(spawnAndLogOutputSpy).not.toHaveBeenCalled();
  });

  test('skips notification when config is missing', async () => {
    mockConfig = {
      ...realGetDefaultConfig(),
      models: { execution: 'test-model' },
      postApplyCommands: [],
    };
    delete mockConfig.notifications;

    await rmplanAgent(planFile, { log: false, summary: false }, {} as any);

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

    expect(findNextPlanSpy).toHaveBeenCalledTimes(1);
    expect(spawnAndLogOutputSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnAndLogOutputSpy.mock.calls[0];
    const payload = JSON.parse(options.stdin.trim());
    expect(payload.command).toBe('agent');
    expect(payload.event).toBe('agent_done');
    expect(payload.status).toBe('success');
    expect(payload.message).toContain('No ready plans found');
  });
});
