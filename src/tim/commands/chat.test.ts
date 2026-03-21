import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TimConfig } from '../configSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleChatCommand', () => {
  const loadEffectiveConfigSpy = mock(async () => ({
    defaultExecutor: undefined,
    terminalInput: true,
  }));
  const isTunnelActiveSpy = mock(() => false);
  const mockExecutorExecute = mock(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };
  const buildExecutorAndLogSpy = mock(() => mockExecutor);
  const runWithHeadlessAdapterIfEnabledSpy = mock(async (options: any) => options.callback());
  const getGitRootSpy = mock(async () => '/repo-root');
  const commitAllSpy = mock(async () => 0);
  const setupWorkspaceSpy = mock(async (_options: any, _baseDir: string, planFile?: string) => ({
    baseDir: '/repo-root/workspaces/task-123',
    planFile: planFile ?? '',
    workspaceTaskId: 'task-123',
    isNewWorkspace: false,
  }));
  const prepareWorkspaceRoundTripSpy = mock(async () => null);
  const runPreExecutionWorkspaceSyncSpy = mock(async () => {});
  const runPostExecutionWorkspaceSyncSpy = mock(async () => {});
  const resolvePlanFileSpy = mock(async () => '/repo-root/tasks/123-test.plan.md');
  const readPlanFileSpy = mock(async () => ({
    id: 123,
    uuid: '11111111-1111-4111-8111-111111111111',
    title: 'Test plan',
    status: 'pending',
    priority: 'medium',
    issue: ['https://example.com/issues/42'],
    tasks: [],
  }));
  const buildDescriptionFromPlanSpy = mock(() => 'Plan description');
  const getCombinedTitleFromSummarySpy = mock(() => 'Combined test plan');
  const getWorkspaceInfoByPathSpy = mock(() => ({
    taskId: 'task-123',
    workspacePath: '/repo-root/workspaces/task-123',
  }));
  const patchWorkspaceInfoSpy = mock(() => {});
  const touchWorkspaceInfoSpy = mock(() => {});
  const warnSpy = mock(() => {});

  const originalStdinIsTTY = process.stdin.isTTY;
  const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    moduleMocker.clear();

    loadEffectiveConfigSpy.mockClear();
    isTunnelActiveSpy.mockClear();
    mockExecutorExecute.mockClear();
    buildExecutorAndLogSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockClear();
    getGitRootSpy.mockClear();
    commitAllSpy.mockClear();
    setupWorkspaceSpy.mockClear();
    prepareWorkspaceRoundTripSpy.mockClear();
    runPreExecutionWorkspaceSyncSpy.mockClear();
    runPostExecutionWorkspaceSyncSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    readPlanFileSpy.mockClear();
    buildDescriptionFromPlanSpy.mockClear();
    getCombinedTitleFromSummarySpy.mockClear();
    getWorkspaceInfoByPathSpy.mockClear();
    patchWorkspaceInfoSpy.mockClear();
    touchWorkspaceInfoSpy.mockClear();
    warnSpy.mockClear();

    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: undefined,
      terminalInput: true,
      workspaceSync: { pushTarget: 'origin' },
    }));
    isTunnelActiveSpy.mockImplementation(() => false);
    getGitRootSpy.mockImplementation(async () => '/repo-root');
    commitAllSpy.mockImplementation(async () => 0);
    setupWorkspaceSpy.mockImplementation(
      async (_options: any, _baseDir: string, planFile?: string) => ({
        baseDir: '/repo-root/workspaces/task-123',
        planFile: planFile ?? '',
        workspaceTaskId: 'task-123',
        isNewWorkspace: false,
      })
    );
    prepareWorkspaceRoundTripSpy.mockImplementation(async () => null);
    runPreExecutionWorkspaceSyncSpy.mockImplementation(async () => {});
    runPostExecutionWorkspaceSyncSpy.mockImplementation(async () => {});
    resolvePlanFileSpy.mockImplementation(async () => '/repo-root/tasks/123-test.plan.md');
    readPlanFileSpy.mockImplementation(async () => ({
      id: 123,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Test plan',
      status: 'pending',
      priority: 'medium',
      issue: ['https://example.com/issues/42'],
      tasks: [],
    }));
    buildDescriptionFromPlanSpy.mockImplementation(() => 'Plan description');
    getCombinedTitleFromSummarySpy.mockImplementation(() => 'Combined test plan');
    getWorkspaceInfoByPathSpy.mockImplementation(() => ({
      taskId: 'task-123',
      workspacePath: '/repo-root/workspaces/task-123',
    }));
    patchWorkspaceInfoSpy.mockImplementation(() => {});
    touchWorkspaceInfoSpy.mockImplementation(() => {});
    warnSpy.mockImplementation(() => {});
    delete process.env.CODEX_USE_APP_SERVER;

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../headless.js', () => ({
      runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
      updateHeadlessSessionInfo: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: commitAllSpy,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      warn: warnSpy,
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: isTunnelActiveSpy,
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'claude-code',
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: readPlanFileSpy,
    }));

    await moduleMocker.mock('../display_utils.js', () => ({
      buildDescriptionFromPlan: buildDescriptionFromPlanSpy,
      getCombinedTitleFromSummary: getCombinedTitleFromSummarySpy,
    }));

    await moduleMocker.mock('../workspace/workspace_info.js', () => ({
      getWorkspaceInfoByPath: getWorkspaceInfoByPathSpy,
      patchWorkspaceInfo: patchWorkspaceInfoSpy,
      touchWorkspaceInfo: touchWorkspaceInfoSpy,
    }));

    await moduleMocker.mock('../workspace/workspace_setup.js', () => ({
      setupWorkspace: setupWorkspaceSpy,
    }));

    await moduleMocker.mock('../workspace/workspace_roundtrip.js', () => ({
      prepareWorkspaceRoundTrip: prepareWorkspaceRoundTripSpy,
      runPreExecutionWorkspaceSync: runPreExecutionWorkspaceSyncSpy,
      runPostExecutionWorkspaceSync: runPostExecutionWorkspaceSyncSpy,
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalCodexUseAppServer == null) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
    }
  });

  test('defaults to claude-code executor and enables terminal input', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Help me debug this', {}, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      baseDir: originalCwd,
      terminalInput: true,
      closeTerminalInputOnResult: false,
      noninteractive: undefined,
    });
    expect(setupWorkspaceSpy).not.toHaveBeenCalled();
    expect(getGitRootSpy).not.toHaveBeenCalled();
  });

  test('passes --model through to shared executor options for claude', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Help me debug this', { model: 'sonnet' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      model: 'sonnet',
    });
  });

  test('passes prompt through to executor in bare mode', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Initial prompt', {}, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('Initial prompt');
    expect(mockExecutorExecute.mock.calls[0][1]).toEqual({
      planId: 'chat',
      planTitle: 'Chat Session',
      planFilePath: '',
      executionMode: 'bare',
    });
  });

  test('allows starting without an initial prompt when terminal input is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand(undefined, {}, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('wraps execution in the headless adapter with the chat command type', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
      callback: expect.any(Function),
    });
  });

  test('disables headless adapter wrapping when tunnel is already active', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: false,
      command: 'chat',
    });
  });

  test('forces headless adapter wrapping when tunnel is active and --headless-adapter is set', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await handleChatCommand('hello', { headlessAdapter: true }, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
    });
  });

  test('throws when there is no prompt and non-interactive mode is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand(undefined, { nonInteractive: true }, {})).rejects.toThrow(
      'No input provided. Pass a prompt argument, --prompt-file, or stdin when running without terminal input.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('allows no prompt in non-interactive mode when tunnel forwarding is active', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await expect(
      handleChatCommand(undefined, { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('rejects codex-cli without an explicit prompt when app-server mode is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand(undefined, { executor: 'codex-cli' }, {})).rejects.toThrow(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('allows codex-cli without an explicit prompt when app-server mode is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli' }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('');
  });

  test('accepts codex alias and keeps terminal input forwarding in default mode', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Summarize this repository', { executor: 'codex' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
      closeTerminalInputOnResult: false,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('Summarize this repository');
  });

  test('passes --model through to shared executor options for codex', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Summarize this repository', { executor: 'codex', model: 'gpt-5' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
    });
  });

  test('rejects codex-cli when tunnel is active without an initial prompt and app-server is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli', nonInteractive: true }, {})
    ).rejects.toThrow(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('uses configured default executor when provided', async () => {
    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: 'codex-cli',
      terminalInput: true,
    }));

    const { handleChatCommand } = await import('./chat.js');

    await expect(
      handleChatCommand('Prompt text', { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: false,
      noninteractive: true,
      closeTerminalInputOnResult: false,
    });
  });

  test('throws when --executor is an incompatible executor', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand('hello', { executor: 'copy-only' }, {})).rejects.toThrow(
      "Executor 'copy-only' is not supported by 'tim chat'"
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('falls back to claude-code when config defaultExecutor is incompatible', async () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: 'copy-only',
      terminalInput: true,
    }));

    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("defaultExecutor 'copy-only' is not supported");

    console.warn = originalWarn;
  });

  test('passes the loaded config through to the headless adapter', async () => {
    const config: Partial<TimConfig> = {
      defaultExecutor: 'claude-code',
      terminalInput: true,
    };
    loadEffectiveConfigSpy.mockImplementation(async () => config);

    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0].config).toBe(config);
  });

  test('enters workspace mode and passes workspace options through setupWorkspace', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', { workspace: 'task-123', nonInteractive: true }, {});

    expect(getGitRootSpy).toHaveBeenCalledWith(originalCwd);
    expect(setupWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(setupWorkspaceSpy.mock.calls[0]).toEqual([
      {
        workspace: 'task-123',
        autoWorkspace: false,
        newWorkspace: undefined,
        nonInteractive: true,
        requireWorkspace: false,
        createBranch: false,
        planUuid: undefined,
        base: undefined,
        allowPrimaryWorkspaceWhenLocked: true,
      },
      '/repo-root',
      undefined,
      expect.objectContaining({
        terminalInput: true,
      }),
      'tim chat',
    ]);
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      baseDir: '/repo-root/workspaces/task-123',
      noninteractive: true,
    });
  });

  test('resolves --plan and uses plan data for workspace setup and headless metadata', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', { autoWorkspace: true, plan: '123' }, { config: 'tim.json' });

    expect(resolvePlanFileSpy).toHaveBeenCalledWith('123', 'tim.json');
    expect(readPlanFileSpy).toHaveBeenCalledWith('/repo-root/tasks/123-test.plan.md');
    expect(setupWorkspaceSpy.mock.calls[0][0]).toMatchObject({
      autoWorkspace: true,
      planUuid: '11111111-1111-4111-8111-111111111111',
      createBranch: false,
    });
    expect(setupWorkspaceSpy.mock.calls[0][2]).toBe('/repo-root/tasks/123-test.plan.md');
    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      plan: {
        id: 123,
        title: 'Test plan',
      },
    });
    expect(patchWorkspaceInfoSpy).toHaveBeenCalledWith('/repo-root/workspaces/task-123', {
      description: '123 - Plan description',
      planId: '123',
      planTitle: 'Combined test plan',
      issueUrls: ['https://example.com/issues/42'],
    });
  });

  test('--plan alone implies auto-workspace selection', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', { plan: '123' }, { config: 'tim.json' });

    expect(setupWorkspaceSpy).toHaveBeenCalledTimes(1);
    expect(setupWorkspaceSpy.mock.calls[0][0]).toMatchObject({
      autoWorkspace: true,
      planUuid: '11111111-1111-4111-8111-111111111111',
      createBranch: false,
    });
    expect(resolvePlanFileSpy).toHaveBeenCalledWith('123', 'tim.json');
  });

  test('passes --base through with createBranch disabled when no plan is provided', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', { workspace: 'task-123', base: 'feature-branch' }, {});

    expect(setupWorkspaceSpy.mock.calls[0][0]).toMatchObject({
      workspace: 'task-123',
      base: 'feature-branch',
      createBranch: false,
      planUuid: undefined,
    });
    expect(resolvePlanFileSpy).not.toHaveBeenCalled();
    expect(readPlanFileSpy).not.toHaveBeenCalled();
  });

  test('commits after execution when --commit is set', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', { workspace: 'task-123', commit: true }, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(commitAllSpy).toHaveBeenCalledTimes(1);
    expect(commitAllSpy).toHaveBeenCalledWith(
      'workspace chat session',
      '/repo-root/workspaces/task-123'
    );
  });

  test('runs workspace roundtrip hooks in order', async () => {
    const { handleChatCommand } = await import('./chat.js');
    const callOrder: string[] = [];
    setupWorkspaceSpy.mockImplementationOnce(
      async (_options: any, _baseDir: string, planFile?: string) => {
        callOrder.push('setup');
        return {
          baseDir: '/repo-root/workspaces/task-123',
          planFile: planFile ?? '',
          workspaceTaskId: 'task-123',
          isNewWorkspace: false,
        };
      }
    );
    prepareWorkspaceRoundTripSpy.mockImplementationOnce(async () => {
      callOrder.push('prepare');
      return {
        workspacePath: '/repo-root/workspaces/task-123',
        syncTarget: 'primary',
      } as any;
    });
    runPreExecutionWorkspaceSyncSpy.mockImplementationOnce(async () => {
      callOrder.push('pre');
    });
    mockExecutorExecute.mockImplementationOnce(async () => {
      callOrder.push('execute');
    });
    runPostExecutionWorkspaceSyncSpy.mockImplementationOnce(async () => {
      callOrder.push('post');
    });
    touchWorkspaceInfoSpy.mockImplementationOnce(() => {
      callOrder.push('touch');
    });

    await handleChatCommand('hello', { workspace: 'task-123' }, {});

    expect(prepareWorkspaceRoundTripSpy).toHaveBeenCalledWith({
      workspacePath: '/repo-root/workspaces/task-123',
      workspaceSyncEnabled: true,
      syncTarget: 'origin',
    });
    expect(runPreExecutionWorkspaceSyncSpy).toHaveBeenCalledTimes(1);
    expect(runPostExecutionWorkspaceSyncSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: '/repo-root/workspaces/task-123',
      }),
      'workspace chat session'
    );
    expect(touchWorkspaceInfoSpy).toHaveBeenCalledWith('/repo-root/workspaces/task-123');
    expect(callOrder).toEqual(['setup', 'prepare', 'pre', 'execute', 'post', 'touch']);
  });

  test('still runs post-sync and touch cleanup when execution fails', async () => {
    const { handleChatCommand } = await import('./chat.js');
    const executionFailure = new Error('executor failed');
    prepareWorkspaceRoundTripSpy.mockImplementationOnce(
      async () =>
        ({
          workspacePath: '/repo-root/workspaces/task-123',
          syncTarget: 'origin',
        }) as any
    );
    mockExecutorExecute.mockImplementationOnce(async () => {
      throw executionFailure;
    });

    await expect(handleChatCommand('hello', { workspace: 'task-123' }, {})).rejects.toThrow(
      'executor failed'
    );

    expect(runPostExecutionWorkspaceSyncSpy).toHaveBeenCalledTimes(1);
    expect(touchWorkspaceInfoSpy).toHaveBeenCalledWith('/repo-root/workspaces/task-123');
  });
});

describe('resolveOptionalPromptText', () => {
  test('returns positional prompt with tty stdin', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { stdinIsTTY: true },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-arg');
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('prefers positional prompt over stdin in non-tty mode when no prompt file is provided', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { stdinIsTTY: false },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-arg');
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('reads stdin in non-tty mode when no positional prompt or prompt file is provided', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      undefined,
      { stdinIsTTY: false, tunnelActive: false },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-stdin');
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  test('skips stdin in non-tty mode when tunnel forwarding is active', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      undefined,
      { stdinIsTTY: false, tunnelActive: true },
      {
        readStdin,
      }
    );

    expect(prompt).toBeUndefined();
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('prompt file overrides positional prompt', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { promptFile: 'prompt.txt', stdinIsTTY: false },
      {
        readFile: async () => 'from-file',
        readStdin: async () => 'from-stdin',
      }
    );

    expect(prompt).toBe('from-file');
  });

  test('returns undefined for whitespace-only prompt file and does not fall back to positional prompt', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { promptFile: 'prompt.txt', stdinIsTTY: true },
      {
        readFile: async () => '   \n\t  ',
      }
    );

    expect(prompt).toBeUndefined();
  });
});
