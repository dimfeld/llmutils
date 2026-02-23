import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleGenerateCommand } from './generate.js';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeSimplePlanningPrompt,
} from '../prompt.js';
import { clearPlanCache, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);
const isTunnelActiveSpy = mock(() => false);
const runWithHeadlessAdapterIfEnabledSpy = mock(async (options: any) => options.callback());

describe('handleGenerateCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  const logSpy = mock(() => {});
  const warnSpy = mock(() => {});

  // Mock executor
  const mockExecutorExecute = mock(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };
  const buildExecutorAndLogSpy = mock(() => mockExecutor);

  // Mock workspace setup
  const setupWorkspaceSpy = mock(async (options: any, baseDir: string, planFile: string) => ({
    baseDir,
    planFile,
    workspaceTaskId: options.workspace,
    isNewWorkspace: false,
  }));

  // Mock buildPromptText
  const buildPromptTextSpy = mock(async () => 'Generated prompt text');

  // Mock auto-claim
  const isAutoClaimEnabledSpy = mock(() => false);
  const autoClaimPlanSpy = mock(async () => {});

  // Mock commitAll
  const commitAllSpy = mock(async () => 0);
  const getCurrentBranchNameSpy = mock(async () => 'main');
  const getTrunkBranchSpy = mock(async () => 'main');

  beforeEach(async () => {
    logSpy.mockClear();
    warnSpy.mockClear();
    mockExecutorExecute.mockClear();
    buildExecutorAndLogSpy.mockClear();
    setupWorkspaceSpy.mockClear();
    buildPromptTextSpy.mockClear();
    isAutoClaimEnabledSpy.mockClear();
    autoClaimPlanSpy.mockClear();
    commitAllSpy.mockClear();
    getCurrentBranchNameSpy.mockClear();
    getTrunkBranchSpy.mockClear();
    isTunnelActiveSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockClear();

    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: mock(() => {}),
      warn: warnSpy,
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'claude_code',
    }));

    await moduleMocker.mock('../workspace/workspace_setup.js', () => ({
      setupWorkspace: setupWorkspaceSpy,
    }));

    await moduleMocker.mock('./prompts.js', () => ({
      buildPromptText: buildPromptTextSpy,
      findMostRecentlyUpdatedPlan: mock(async () => null),
      getPlanTimestamp: mock(async () => 0),
      parseIsoTimestamp: mock(() => undefined),
    }));

    await moduleMocker.mock('../assignments/auto_claim.js', () => ({
      isAutoClaimEnabled: isAutoClaimEnabledSpy,
      autoClaimPlan: autoClaimPlanSpy,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: commitAllSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
        models: { stepGeneration: 'test-model' },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
      getCurrentBranchName: getCurrentBranchNameSpy,
      getTrunkBranch: getTrunkBranchSpy,
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: isTunnelActiveSpy,
    }));

    await moduleMocker.mock('../headless.js', () => ({
      runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
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
      plan: planPath,
      allowMultiplePlans: true,
    });

    // Verify executor was called
    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][1]).toMatchObject({
      planId: '101',
      executionMode: 'planning',
    });
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
      planUuid: '11111111-1111-4111-8111-111111111111',
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

  test('sets branch to current non-trunk branch after generation', async () => {
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
    expect(updatedPlan.branch).toBe('feature/latest-branch');
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

  test('throws error when plan file is not valid YAML', async () => {
    const invalidPath = path.join(tempDir, 'not-a-plan.txt');
    await fs.writeFile(invalidPath, 'this is not yaml');

    await expect(
      handleGenerateCommand(undefined, { plan: invalidPath }, buildCommand())
    ).rejects.toThrow('Failed to read plan file');
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
});

describe('handleGenerateCommand with --next-ready flag', () => {
  let tempDir: string;
  let tasksDir: string;

  const logSpy = mock(() => {});
  const findNextReadyDependencySpy = mock(async () => ({
    plan: null as any,
    message: 'No ready dependencies found',
  }));
  const resolvePlanFileSpy = mock(async () => '/mock/plan/path.plan.md');
  const readPlanFileSpy = mock(async () => ({
    id: 123,
    title: 'Mock Plan',
    tasks: [{ title: 'Task', description: 'Desc', done: false }],
  }));

  const mockExecutorExecute = mock(async () => {});
  const buildExecutorAndLogSpy = mock(() => ({
    execute: mockExecutorExecute,
    filePathPrefix: '',
  }));

  beforeEach(async () => {
    logSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    resolvePlanFileSpy.mockClear();
    readPlanFileSpy.mockClear();
    mockExecutorExecute.mockClear();
    buildExecutorAndLogSpy.mockClear();
    isTunnelActiveSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockClear();

    clearPlanCache();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-nextready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('./find_next_dependency.js', () => ({
      findNextReadyDependency: findNextReadyDependencySpy,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      ...require('../plans.js'),
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: readPlanFileSpy,
      clearPlanCache: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: tasksDir },
        models: { stepGeneration: 'test-model' },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
      getCurrentBranchName: mock(async () => 'main'),
      getTrunkBranch: mock(async () => 'main'),
    }));

    await moduleMocker.mock('../workspace/workspace_setup.js', () => ({
      setupWorkspace: mock(async (_opts: any, baseDir: string, planFile: string) => ({
        baseDir,
        planFile,
      })),
    }));

    await moduleMocker.mock('./prompts.js', () => ({
      buildPromptText: mock(async () => 'Generated prompt'),
      findMostRecentlyUpdatedPlan: mock(async () => null),
      getPlanTimestamp: mock(async () => 0),
      parseIsoTimestamp: mock(() => undefined),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'claude_code',
    }));

    await moduleMocker.mock('../assignments/auto_claim.js', () => ({
      isAutoClaimEnabled: mock(() => false),
      autoClaimPlan: mock(async () => {}),
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: isTunnelActiveSpy,
    }));

    await moduleMocker.mock('../headless.js', () => ({
      runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
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

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: '123',
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('successfully finds and operates on a ready dependency with file path', async () => {
    const parentPlanPath = '/mock/parent/plan.plan.md';

    resolvePlanFileSpy.mockResolvedValueOnce(parentPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      id: 123,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
    });

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

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: parentPlanPath,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(resolvePlanFileSpy).toHaveBeenCalledWith(parentPlanPath, undefined);
    expect(readPlanFileSpy).toHaveBeenCalledWith(parentPlanPath);
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('handles case when no ready dependencies exist', async () => {
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'No ready or pending dependencies found',
    });

    const options = {
      nextReady: '123',
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No ready or pending dependencies found')
    );
  });

  test('handles invalid parent plan ID', async () => {
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'Plan not found: 999',
    });

    const options = {
      nextReady: '999',
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(999, tasksDir, true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan not found: 999'));
  });

  test('handles parent plan file without valid ID', async () => {
    const invalidPlanPath = '/mock/invalid/plan.plan.md';

    resolvePlanFileSpy.mockResolvedValueOnce(invalidPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      title: 'Parent Plan Without ID',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
    });

    const options = {
      nextReady: invalidPlanPath,
    };

    const command = {
      parent: { opts: () => ({}) },
    };

    await expect(handleGenerateCommand(undefined, options, command)).rejects.toThrow(
      'does not have a valid ID'
    );
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

  test('generateClaudeCodeSimplePlanningPrompt includes blocking instructions when enabled', () => {
    const prompt = generateClaudeCodeSimplePlanningPrompt('Simple task', {
      withBlockingSubissues: true,
      parentPlanId: 7,
    });

    expect(prompt).toContain('# Blocking Subissues');
    expect(prompt).toContain('tim add "Blocking Title" --parent 7 --discovered-from 7');
    expect(prompt).toContain('## Blocking Subissue: [Title]');
    expect(prompt).toContain('- Tasks: [High-level task list]');
    expect(prompt).toContain('# Discovered Issues');
    expect(prompt).toContain('tim add "Discovered Issue Title" --discovered-from 7');
    expect(prompt).toContain('## Discovered Issue: [Title]');
  });
});
