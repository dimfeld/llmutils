import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude_code',
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(),
    writePlanToDb: vi.fn(),
  };
});

vi.mock('../db/plan_sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/plan_sync.js')>();
  return {
    ...actual,
    syncPlanToDb: vi.fn(),
  };
});

vi.mock('./prompts.js', () => ({
  buildPromptText: vi.fn(),
  findMostRecentlyUpdatedPlan: vi.fn(async () => null),
  getPlanTimestamp: vi.fn(async () => 0),
  parseIsoTimestamp: vi.fn(() => undefined),
}));

vi.mock('../assignments/auto_claim.js', () => ({
  isAutoClaimEnabled: vi.fn(),
  autoClaimPlan: vi.fn(),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(),
  patchWorkspaceInfo: vi.fn(),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../../common/process.js', () => ({
  commitAll: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(),
  runPostExecutionWorkspaceSync: vi.fn(),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
  getCurrentBranchName: vi.fn(),
  getTrunkBranch: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(),
}));

vi.mock('../plan_file_watcher.js', () => ({
  watchPlanFile: vi.fn(() => ({ close: vi.fn(), closeAndFlush: vi.fn() })),
}));

vi.mock('./plan_discovery.js', () => ({
  findNextReadyDependencyFromDb: vi.fn(),
  findLatestPlanFromDb: vi.fn(async () => null),
}));

import { handleGenerateCommand } from './generate.js';
import { generateClaudeCodePlanningPrompt } from '../prompt.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { log, warn } from '../../logging.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { resolvePlanByNumericId } from '../plans.js';
import { buildPromptText } from './prompts.js';
import { isAutoClaimEnabled, autoClaimPlan } from '../assignments/auto_claim.js';
import {
  getWorkspaceInfoByPath,
  patchWorkspaceInfo,
  touchWorkspaceInfo,
} from '../workspace/workspace_info.js';
import { commitAll } from '../../common/process.js';
import {
  prepareWorkspaceRoundTrip,
  runPreExecutionWorkspaceSync,
  runPostExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot, getCurrentBranchName, getTrunkBranch } from '../../common/git.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import * as adapterModule from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { findNextReadyDependencyFromDb, findLatestPlanFromDb } from './plan_discovery.js';

const isTunnelActiveSpy = vi.mocked(isTunnelActive);
const runWithHeadlessAdapterIfEnabledSpy = vi.mocked(runWithHeadlessAdapterIfEnabled);
const writePlanToDbSpy = vi.mocked(writePlanToDb);
const watchPlanFileSpy = vi.mocked(watchPlanFile);

describe('handleGenerateCommand', () => {
  let tempDir: string;
  let tasksDir: string;
  let loadedConfig: any;

  const logSpy = vi.mocked(log);
  const warnSpy = vi.mocked(warn);

  // Mock executor
  const mockExecutorExecute = vi.fn(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };
  const buildExecutorAndLogSpy = vi.mocked(buildExecutorAndLog);
  const setupWorkspaceSpy = vi.mocked(setupWorkspace);
  const buildPromptTextSpy = vi.mocked(buildPromptText);
  const isAutoClaimEnabledSpy = vi.mocked(isAutoClaimEnabled);
  const autoClaimPlanSpy = vi.mocked(autoClaimPlan);
  let trackedWorkspacePath: string | undefined;
  const getWorkspaceInfoByPathSpy = vi.mocked(getWorkspaceInfoByPath);
  const patchWorkspaceInfoSpy = vi.mocked(patchWorkspaceInfo);
  const touchWorkspaceInfoSpy = vi.mocked(touchWorkspaceInfo);
  const commitAllSpy = vi.mocked(commitAll);
  const getCurrentBranchNameSpy = vi.mocked(getCurrentBranchName);
  const getTrunkBranchSpy = vi.mocked(getTrunkBranch);
  const prepareWorkspaceRoundTripSpy = vi.mocked(prepareWorkspaceRoundTrip);
  const runPreExecutionWorkspaceSyncSpy = vi.mocked(runPreExecutionWorkspaceSync);
  const runPostExecutionWorkspaceSyncSpy = vi.mocked(runPostExecutionWorkspaceSync);
  const resolvePlanByNumericIdSpy = vi.mocked(resolvePlanByNumericId);

  beforeEach(async () => {
    vi.clearAllMocks();
    mockExecutorExecute.mockImplementation(async () => {});
    buildExecutorAndLogSpy.mockImplementation(() => mockExecutor as any);
    setupWorkspaceSpy.mockImplementation(
      async (options: any, baseDir: string, planFile: string) =>
        ({
          baseDir,
          planFile,
          workspaceTaskId: options.workspace,
          isNewWorkspace: false,
        }) as any
    );
    buildPromptTextSpy.mockResolvedValue('Generated prompt text');
    isAutoClaimEnabledSpy.mockReturnValue(false);
    autoClaimPlanSpy.mockResolvedValue(undefined as any);
    commitAllSpy.mockResolvedValue(0);
    getCurrentBranchNameSpy.mockResolvedValue('main');
    getTrunkBranchSpy.mockResolvedValue('main');
    prepareWorkspaceRoundTripSpy.mockResolvedValue(null as any);
    runPreExecutionWorkspaceSyncSpy.mockResolvedValue(undefined);
    runPostExecutionWorkspaceSyncSpy.mockResolvedValue(undefined);
    resolvePlanByNumericIdSpy.mockImplementation(async (planArg: number | string) => {
      const planPath =
        typeof planArg === 'number'
          ? path.join(tasksDir, `${planArg}-test-plan.plan.md`)
          : String(planArg);
      return {
        plan: await readPlanFile(planPath),
        planPath,
      };
    });
    writePlanToDbSpy.mockResolvedValue({} as any);
    watchPlanFileSpy.mockReturnValue({ close: vi.fn(), closeAndFlush: vi.fn() });
    trackedWorkspacePath = undefined;
    getWorkspaceInfoByPathSpy.mockImplementation((baseDir: string) => {
      return baseDir === trackedWorkspacePath
        ? ({ taskId: 'ws-tracked', workspacePath: baseDir } as any)
        : null;
    });
    patchWorkspaceInfoSpy.mockReturnValue({} as any);
    touchWorkspaceInfoSpy.mockReturnValue({} as any);
    isTunnelActiveSpy.mockReturnValue(false);
    runWithHeadlessAdapterIfEnabledSpy.mockImplementation(async (options: any) =>
      options.callback()
    );

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    loadedConfig = {
      paths: { tasks: tasksDir },
      models: { stepGeneration: 'test-model' },
    };

    vi.mocked(loadEffectiveConfig).mockResolvedValue(loadedConfig as any);
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function buildCommand() {
    return {
      parent: { opts: () => ({}) },
    };
  }

  async function createStubPlan(id: number, overrides: Partial<PlanSchema> = {}): Promise<string> {
    const planPath = path.join(tasksDir, `${id}-test-plan.plan.md`);
    await writePlanFile(planPath, {
      id,
      title: 'Test Plan',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      details: 'Test details',
      tasks: [],
      ...overrides,
    });
    return planPath;
  }

  test('generates plan with executor and new prompt system', async () => {
    const planPath = await createStubPlan(101);

    // Simulate executor adding tasks
    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [
        { title: 'Task 1', description: 'Description 1', done: false },
        { title: 'Task 2', description: 'Description 2', done: false },
      ];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    // Verify buildPromptText was called with 'generate-plan'
    expect(buildPromptTextSpy).toHaveBeenCalledTimes(1);
    expect(buildPromptTextSpy.mock.calls[0][0]).toBe('generate-plan');
    expect(buildPromptTextSpy.mock.calls[0][1]).toMatchObject({
      plan: '101',
      allowMultiplePlans: true,
    });

    // Verify executor was called
    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][1]).toMatchObject({
      planId: '101',
      executionMode: 'planning',
    });
    expect(writePlanToDbSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101 }),
      expect.objectContaining({
        cwdForIdentity: tempDir,
        config: loadedConfig,
      })
    );
  });

  test('uses generate-plan-simple prompt when --simple flag is set', async () => {
    const planPath = await createStubPlan(102);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath, simple: true }, buildCommand());

    expect(buildPromptTextSpy.mock.calls[0][0]).toBe('generate-plan-simple');
  });

  test('uses simple prompt when plan has simple: true', async () => {
    const planPath = await createStubPlan(103, { simple: true });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(buildPromptTextSpy.mock.calls[0][0]).toBe('generate-plan-simple');
  });

  test('returns early when plan already contains tasks', async () => {
    const planPath = await createStubPlan(104, {
      tasks: [{ title: 'Existing Task', description: 'Already there', done: false }],
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    // Should not call executor
    expect(mockExecutorExecute).not.toHaveBeenCalled();
    // Should log warning about existing tasks
    const logMessages = logSpy.mock.calls.map((args) => String(args[0]));
    expect(logMessages.some((msg) => msg.includes('already contains tasks'))).toBe(true);
  });

  test('warns about done plan status', async () => {
    const planPath = await createStubPlan(105, { status: 'done' });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('already marked as "done"'))).toBe(true);
  });

  test('warns when no tasks are created and plan is not epic', async () => {
    const planPath = await createStubPlan(106);

    mockExecutorExecute.mockImplementationOnce(async () => {});

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('No tasks were created'))).toBe(true);
  });

  test('logs epic creation when no tasks are created but plan is epic', async () => {
    const planPath = await createStubPlan(107);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.epic = true;
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    const logMessages = logSpy.mock.calls.map((args) => String(args[0]));
    expect(logMessages.some((msg) => msg.includes('Plan was created as an epic'))).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('passes workspace options to setupWorkspace', async () => {
    const planPath = await createStubPlan(108, {
      uuid: '11111111-1111-4111-8111-111111111111',
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      {
        plan: planPath,
        workspace: 'ws-123',
        autoWorkspace: true,
        newWorkspace: true,
        nonInteractive: true,
        requireWorkspace: true,
      },
      buildCommand()
    );

    expect(setupWorkspaceSpy).toHaveBeenCalledTimes(1);
    const [wsOptions] = setupWorkspaceSpy.mock.calls[0];
    expect(wsOptions).toMatchObject({
      workspace: 'ws-123',
      autoWorkspace: true,
      newWorkspace: true,
      nonInteractive: true,
      requireWorkspace: true,
      planId: 108,
      planUuid: '11111111-1111-4111-8111-111111111111',
      allowPrimaryWorkspaceWhenLocked: true,
    });
  });

  test('passes explicit createBranch through to setupWorkspace', async () => {
    const planPath = await createStubPlan(109, {
      uuid: '22222222-2222-4222-8222-222222222222',
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      {
        plan: planPath,
        autoWorkspace: true,
        createBranch: false,
      },
      buildCommand()
    );

    const [wsOptions] = setupWorkspaceSpy.mock.calls.at(-1) ?? [];
    expect(wsOptions).toMatchObject({
      autoWorkspace: true,
      createBranch: false,
      planId: 109,
    });
  });

  test('uses workspace-aware baseDir for executor', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-dir');
    await fs.mkdir(workspaceDir, { recursive: true });

    const planPath = await createStubPlan(109);
    const wsPlanPath = path.join(workspaceDir, path.basename(planPath));

    // Copy plan to workspace
    await fs.copyFile(planPath, wsPlanPath);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: workspaceDir,
      planFile: wsPlanPath,
      workspaceTaskId: 'ws-test',
      isNewWorkspace: true,
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(wsPlanPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(wsPlanPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, workspace: 'ws-test' },
      buildCommand()
    );

    // Verify executor was built with workspace baseDir
    const executorOpts = buildExecutorAndLogSpy.mock.calls[0][1];
    expect(executorOpts.baseDir).toBe(workspaceDir);
  });

  test('commits changes when --commit flag is set', async () => {
    const planPath = await createStubPlan(110, { title: 'Commit Test Plan' });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath, commit: true }, buildCommand());

    expect(commitAllSpy).toHaveBeenCalledTimes(1);
    expect(commitAllSpy.mock.calls[0][0]).toContain('Commit Test Plan');
  });

  test('updates workspace metadata from plan when workspace is tracked', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-tracked');
    await fs.mkdir(workspaceDir, { recursive: true });
    trackedWorkspacePath = workspaceDir;

    const planPath = await createStubPlan(113, {
      title: 'Tracked Workspace Plan',
      issue: ['https://github.com/org/repo/issues/55'],
    });
    const wsPlanPath = path.join(workspaceDir, path.basename(planPath));
    await fs.copyFile(planPath, wsPlanPath);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: workspaceDir,
      planFile: wsPlanPath,
      workspaceTaskId: 'ws-tracked',
      isNewWorkspace: true,
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(wsPlanPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(wsPlanPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, workspace: 'ws-tracked' },
      buildCommand()
    );

    expect(patchWorkspaceInfoSpy).toHaveBeenCalledTimes(1);
    expect(touchWorkspaceInfoSpy).toHaveBeenCalledTimes(1);
    expect(patchWorkspaceInfoSpy.mock.calls[0][0]).toBe(workspaceDir);
    expect(touchWorkspaceInfoSpy.mock.calls[0][0]).toBe(workspaceDir);
    expect(patchWorkspaceInfoSpy.mock.calls[0][1]).toMatchObject({
      description: '113 - #55 Tracked Workspace Plan',
      planId: '113',
      planTitle: 'Tracked Workspace Plan',
      issueUrls: ['https://github.com/org/repo/issues/55'],
    });
  });

  test('does not update branch after generation on a non-trunk branch', async () => {
    const planPath = await createStubPlan(210, { branch: 'feature/old-branch' });
    getCurrentBranchNameSpy.mockResolvedValueOnce('feature/latest-branch');
    getTrunkBranchSpy.mockResolvedValueOnce('main');

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.branch).toBe('feature/old-branch');
  });

  test('does not set branch when generation runs on trunk branch', async () => {
    const planPath = await createStubPlan(211);
    getCurrentBranchNameSpy.mockResolvedValueOnce('main');
    getTrunkBranchSpy.mockResolvedValueOnce('main');

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    const updatedPlan = await readPlanFile(planPath);
    expect(updatedPlan.branch).toBeUndefined();
  });

  test('does not commit when --commit is not set', async () => {
    const planPath = await createStubPlan(111);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(commitAllSpy).not.toHaveBeenCalled();
  });

  test('auto-claims plan when enabled', async () => {
    const planPath = await createStubPlan(112, { uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
    isAutoClaimEnabledSpy.mockReturnValue(true);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    expect(autoClaimPlanSpy.mock.calls[0][1]).toMatchObject({
      cwdForIdentity: tempDir,
    });
  });

  test('auto-claim uses workspace-aware cwdForIdentity', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-claim');
    await fs.mkdir(workspaceDir, { recursive: true });
    isAutoClaimEnabledSpy.mockReturnValue(true);

    const planPath = await createStubPlan(113, { uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901' });
    const wsPlanPath = path.join(workspaceDir, path.basename(planPath));
    await fs.copyFile(planPath, wsPlanPath);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: workspaceDir,
      planFile: wsPlanPath,
      workspaceTaskId: 'ws-claim',
      isNewWorkspace: true,
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(wsPlanPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(wsPlanPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, workspace: 'ws-claim' },
      buildCommand()
    );

    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    expect(autoClaimPlanSpy.mock.calls[0][1]).toMatchObject({
      cwdForIdentity: workspaceDir,
    });
  });

  test('auto-claim happens before executor execution', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-order');
    await fs.mkdir(workspaceDir, { recursive: true });
    isAutoClaimEnabledSpy.mockReturnValue(true);

    const planPath = await createStubPlan(120, { uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012' });
    const wsPlanPath = path.join(workspaceDir, path.basename(planPath));
    await fs.copyFile(planPath, wsPlanPath);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: workspaceDir,
      planFile: wsPlanPath,
      workspaceTaskId: 'ws-order',
      isNewWorkspace: true,
    });

    // Track call ordering
    const callOrder: string[] = [];
    autoClaimPlanSpy.mockImplementation(async () => {
      callOrder.push('autoClaimPlan');
    });
    mockExecutorExecute.mockImplementation(async () => {
      callOrder.push('executorExecute');
      const plan = await readPlanFile(wsPlanPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(wsPlanPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, workspace: 'ws-order' },
      buildCommand()
    );

    // auto-claim should happen before executor execution
    expect(callOrder).toEqual(['autoClaimPlan', 'executorExecute']);
    // auto-claim should use workspace-aware baseDir
    expect(autoClaimPlanSpy.mock.calls[0][1]).toMatchObject({
      cwdForIdentity: workspaceDir,
    });
  });

  test('throws error when no plan option is provided', async () => {
    await expect(handleGenerateCommand(undefined, {}, buildCommand())).rejects.toThrow(
      'You must provide one and only one of'
    );
  });

  test('throws when workspace setup leaves the plan file unset', async () => {
    const planPath = await createStubPlan(130);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: tempDir,
      planFile: '',
      workspaceTaskId: 'ws-missing-plan',
      isNewWorkspace: true,
    });

    await expect(
      handleGenerateCommand(
        undefined,
        { plan: planPath, workspace: 'ws-missing-plan' },
        buildCommand()
      )
    ).rejects.toThrow('Plan file not materialized');
  });

  test('throws error when plan argument is not a numeric ID', async () => {
    await expect(
      handleGenerateCommand(undefined, { plan: 'not-a-plan' }, buildCommand())
    ).rejects.toThrow('no such file or directory');
  });

  test('accepts positional plan argument', async () => {
    const planPath = await createStubPlan(114);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(planPath, {}, buildCommand());

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
  });

  test('uses custom executor when --executor is specified', async () => {
    const planPath = await createStubPlan(115);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, executor: 'custom_executor' },
      buildCommand()
    );

    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('custom_executor');
  });

  test('uses generate.defaultExecutor before global defaultExecutor', async () => {
    const planPath = await createStubPlan(123);
    loadedConfig.generate = { defaultExecutor: 'codex-cli' };
    loadedConfig.defaultExecutor = 'claude-code';

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
  });

  test('uses global defaultExecutor when generate.defaultExecutor is not set', async () => {
    const planPath = await createStubPlan(124);
    loadedConfig.defaultExecutor = 'codex-cli';

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
  });

  test('computes terminal input enabled by default', async () => {
    const planPath = await createStubPlan(116);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    const executorOpts = buildExecutorAndLogSpy.mock.calls[0][1];
    // terminalInput should be based on process.stdin.isTTY
    // In test environment it may not be a TTY, but the option should be set
    expect(executorOpts).toHaveProperty('terminalInput');
  });

  test('disables terminal input when --non-interactive is set', async () => {
    const planPath = await createStubPlan(117);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, nonInteractive: true },
      buildCommand()
    );

    const executorOpts = buildExecutorAndLogSpy.mock.calls[0][1];
    expect(executorOpts.terminalInput).toBe(false);
    expect(executorOpts.noninteractive).toBe(true);
  });

  test('disables terminal input when --no-terminal-input is set', async () => {
    const planPath = await createStubPlan(118);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(
      undefined,
      { plan: planPath, terminalInput: false },
      buildCommand()
    );

    const executorOpts = buildExecutorAndLogSpy.mock.calls[0][1];
    expect(executorOpts.terminalInput).toBe(false);
  });

  test('keeps terminal input open until EOF by default', async () => {
    const planPath = await createStubPlan(119);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    const executorOpts = buildExecutorAndLogSpy.mock.calls[0][1];
    expect(executorOpts.closeTerminalInputOnResult).toBe(false);
  });

  test('wraps generation in headless adapter when tunnel is not active', async () => {
    const planPath = await createStubPlan(121);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'generate',
      plan: { id: 121, title: 'Test Plan' },
    });
  });

  test('starts and closes the plan watcher when a headless adapter is active', async () => {
    const planPath = await createStubPlan(111);
    const closeAndFlushSpy = vi.fn();
    watchPlanFileSpy.mockReturnValue({ close: vi.fn(), closeAndFlush: closeAndFlushSpy });
    const headlessAdapter = Object.assign(Object.create(HeadlessAdapter.prototype), {
      sendPlanContent: vi.fn(),
    }) as HeadlessAdapter;
    const getLoggerAdapterSpy = vi
      .spyOn(adapterModule, 'getLoggerAdapter')
      .mockReturnValue(headlessAdapter);

    try {
      await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());
    } finally {
      getLoggerAdapterSpy.mockRestore();
    }

    expect(watchPlanFileSpy).toHaveBeenCalledWith(planPath, expect.any(Function));
    expect(closeAndFlushSpy).toHaveBeenCalledTimes(1);
  });

  test('disables headless adapter when tunnel is active', async () => {
    const planPath = await createStubPlan(122);
    isTunnelActiveSpy.mockReturnValueOnce(true);

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: false,
      command: 'generate',
    });
  });

  test('runs pre-execution sync whenever workspace round-trip setup returns a context', async () => {
    const planPath = await createStubPlan(123);

    setupWorkspaceSpy.mockResolvedValueOnce({
      baseDir: '/tmp/execution-workspace',
      planFile: planPath,
      workspaceTaskId: 'ws-123',
      isNewWorkspace: false,
      branchCreatedDuringSetup: true,
    });
    prepareWorkspaceRoundTripSpy.mockResolvedValueOnce({
      executionWorkspacePath: '/tmp/execution-workspace',
      primaryWorkspacePath: '/tmp/primary-workspace',
      refName: 'feature/test-branch',
      branchCreatedDuringSetup: true,
    });

    mockExecutorExecute.mockImplementationOnce(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Task 1', description: 'Description', done: false }];
      await writePlanFile(planPath, plan);
    });

    await handleGenerateCommand(undefined, { plan: planPath }, buildCommand());

    expect(prepareWorkspaceRoundTripSpy).toHaveBeenCalledWith({
      workspacePath: '/tmp/execution-workspace',
      workspaceSyncEnabled: true,
      branchCreatedDuringSetup: true,
    });
    expect(runPreExecutionWorkspaceSyncSpy).toHaveBeenCalledTimes(1);
    expect(runPreExecutionWorkspaceSyncSpy).toHaveBeenCalledWith({
      executionWorkspacePath: '/tmp/execution-workspace',
      primaryWorkspacePath: '/tmp/primary-workspace',
      refName: 'feature/test-branch',
      branchCreatedDuringSetup: true,
    });
  });
});

describe('handleGenerateCommand with --next-ready flag', () => {
  let tempDir: string;
  let tasksDir: string;

  const findNextReadyDependencyFromDbSpy = vi.mocked(findNextReadyDependencyFromDb);
  const resolvePlanByNumericIdSpy = vi.mocked(resolvePlanByNumericId);
  const logSpy = vi.mocked(log);

  beforeEach(async () => {
    vi.clearAllMocks();

    findNextReadyDependencyFromDbSpy.mockResolvedValue({
      plan: null as any,
      message: 'No ready dependencies found',
    });
    resolvePlanByNumericIdSpy.mockResolvedValue({
      plan: {
        id: 123,
        title: 'Mock Plan',
        tasks: [{ title: 'Task', description: 'Desc', done: false }],
      } as any,
      planPath: '/mock/plan/path.plan.md',
    });
    vi.mocked(buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () => {}),
      filePathPrefix: '',
    } as any);
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValue(null as any);
    vi.mocked(runPreExecutionWorkspaceSync).mockResolvedValue(undefined);
    vi.mocked(runPostExecutionWorkspaceSync).mockResolvedValue(undefined);
    isTunnelActiveSpy.mockReturnValue(false);
    runWithHeadlessAdapterIfEnabledSpy.mockImplementation(async (options: any) =>
      options.callback()
    );
    writePlanToDbSpy.mockResolvedValue({} as any);
    vi.mocked(isAutoClaimEnabled).mockReturnValue(false);
    vi.mocked(autoClaimPlan).mockResolvedValue(undefined as any);
    vi.mocked(commitAll).mockResolvedValue(0);
    vi.mocked(getCurrentBranchName).mockResolvedValue('main');
    vi.mocked(getTrunkBranch).mockResolvedValue('main');
    vi.mocked(setupWorkspace).mockImplementation(
      async (_opts: any, baseDir: string, planFile: string) =>
        ({
          baseDir,
          planFile,
        }) as any
    );
    vi.mocked(buildPromptText).mockResolvedValue('Generated prompt');

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-nextready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
      models: { stepGeneration: 'test-model' },
    } as any);
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('successfully finds and operates on a ready dependency with numeric ID', async () => {
    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencyFromDbSpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: 123,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID
    expect(findNextReadyDependencyFromDbSpy).toHaveBeenCalledWith(123, tempDir, tempDir, true);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe(456);
  });

  test('successfully finds and operates on a ready dependency with plan ID', async () => {
    const parentPlanId = 123;

    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencyFromDbSpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: parentPlanId,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(resolvePlanByNumericIdSpy).toHaveBeenCalledWith(456, tempDir);
    expect(findNextReadyDependencyFromDbSpy).toHaveBeenCalledWith(123, tempDir, tempDir, true);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    expect(options.plan).toBe(456);
  });

  test('handles case when no ready dependencies exist', async () => {
    findNextReadyDependencyFromDbSpy.mockResolvedValueOnce({
      plan: null,
      message: 'No ready or pending dependencies found',
    });

    const options = {
      nextReady: 123,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(findNextReadyDependencyFromDbSpy).toHaveBeenCalledWith(123, tempDir, tempDir, true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No ready or pending dependencies found')
    );
  });

  test('handles invalid parent plan ID', async () => {
    findNextReadyDependencyFromDbSpy.mockResolvedValueOnce({
      plan: null,
      message: 'Plan not found: 999',
    });

    const options = {
      nextReady: 999,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(findNextReadyDependencyFromDbSpy).toHaveBeenCalledWith(999, tempDir, tempDir, true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan not found: 999'));
  });
});

describe('blocking subissue prompts', () => {
  test('generateClaudeCodePlanningPrompt includes blocking instructions when enabled', () => {
    const prompt = generateClaudeCodePlanningPrompt('Feature overview', {
      withBlockingSubissues: true,
      parentPlanId: 42,
    });

    expect(prompt).toContain('# Blocking Subissues');
    expect(prompt).toContain('tim add "Blocking Title" --parent 42 --discovered-from 42');
    expect(prompt).toContain('## Blocking Subissue: [Title]');
    expect(prompt).toContain('- Tasks: [High-level task list]');
    expect(prompt).toContain('# Discovered Issues');
    expect(prompt).toContain('tim add "Discovered Issue Title" --discovered-from 42');
    expect(prompt).toContain('## Discovered Issue: [Title]');
  });
});
