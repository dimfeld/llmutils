import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../plan_repo_root.js', () => ({
  resolveRepoRoot: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('../../common/process.js', () => ({
  commitAll: vi.fn(),
}));

vi.mock('../../logging.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude-code',
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    readPlanFile: vi.fn(),
    resolvePlanByNumericId: vi.fn(),
  };
});

vi.mock('../db/plan_sync.js', () => ({
  syncPlanToDb: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../plan_materialize.js', () => ({
  resolveProjectContext: vi.fn(),
}));

vi.mock('../display_utils.js', () => ({
  buildDescriptionFromPlan: vi.fn(),
  getCombinedTitleFromSummary: vi.fn(),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(),
  patchWorkspaceInfo: vi.fn(),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(),
  runPreExecutionWorkspaceSync: vi.fn(),
  runPostExecutionWorkspaceSync: vi.fn(),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../plan_file_watcher.js', () => ({
  watchPlanFile: vi.fn(() => ({ close: vi.fn(), closeAndFlush: vi.fn() })),
}));

vi.mock('./branch.js', () => ({
  generateBranchNameFromPlan: vi.fn(),
  resolveBranchPrefix: vi.fn(() => ''),
}));

import { handleChatCommand, resolveOptionalPromptText } from './chat.js';
import * as adapterModule from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';
import { watchPlanFile } from '../plan_file_watcher.js';
import { getGitRoot } from '../../common/git.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { commitAll } from '../../common/process.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  prepareWorkspaceRoundTrip,
  runPreExecutionWorkspaceSync,
  runPostExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import { readPlanFile, resolvePlanByNumericId } from '../plans.js';
import { buildDescriptionFromPlan, getCombinedTitleFromSummary } from '../display_utils.js';
import {
  getWorkspaceInfoByPath,
  patchWorkspaceInfo,
  touchWorkspaceInfo,
} from '../workspace/workspace_info.js';
import { generateBranchNameFromPlan, resolveBranchPrefix } from './branch.js';
import { getDatabase } from '../db/database.js';
import { resolveProjectContext } from '../plan_materialize.js';
import { syncPlanToDb } from '../db/plan_sync.js';
import { warn as warnFn } from '../../logging.js';

describe('handleChatCommand', () => {
  const watchPlanFileSpy = vi.mocked(watchPlanFile);
  const mockExecutorExecute = vi.fn(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };

  const originalStdinIsTTY = process.stdin.isTTY;
  const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;
  const originalCwd = process.cwd();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: undefined,
      terminalInput: true,
    } as any);

    vi.mocked(isTunnelActive).mockReturnValue(false);
    vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(runWithHeadlessAdapterIfEnabled).mockImplementation(async (options: any) =>
      options.callback()
    );
    vi.mocked(getGitRoot).mockResolvedValue('/repo-root');
    vi.mocked(resolveRepoRoot).mockResolvedValue('/repo-root');
    vi.mocked(commitAll).mockResolvedValue(0);
    vi.mocked(setupWorkspace).mockImplementation(
      async (_options: any, _baseDir: string, planFile?: string) => ({
        baseDir: '/repo-root/workspaces/task-123',
        planFile: planFile ?? '',
        workspaceTaskId: 'task-123',
        isNewWorkspace: false,
      })
    );
    vi.mocked(prepareWorkspaceRoundTrip).mockResolvedValue(null);
    vi.mocked(runPreExecutionWorkspaceSync).mockResolvedValue(undefined);
    vi.mocked(runPostExecutionWorkspaceSync).mockResolvedValue(undefined);
    vi.mocked(readPlanFile).mockResolvedValue({
      id: 123,
      uuid: '11111111-1111-4111-8111-111111111111',
      title: 'Test plan',
      status: 'pending',
      priority: 'medium',
      issue: ['https://example.com/issues/42'],
      tasks: [],
    } as any);
    vi.mocked(resolvePlanByNumericId).mockImplementation(async () => ({
      plan: await vi.mocked(readPlanFile)(''),
      planPath: '/repo-root/tasks/123-test.plan.md',
    }));
    vi.mocked(buildDescriptionFromPlan).mockReturnValue('Plan description');
    vi.mocked(getCombinedTitleFromSummary).mockReturnValue('Combined test plan');
    vi.mocked(getWorkspaceInfoByPath).mockReturnValue({
      taskId: 'task-123',
      workspacePath: '/repo-root/workspaces/task-123',
    } as any);
    vi.mocked(patchWorkspaceInfo).mockReturnValue(undefined);
    vi.mocked(touchWorkspaceInfo).mockReturnValue(undefined);
    vi.mocked(generateBranchNameFromPlan).mockImplementation(
      (_plan, _options) => 'plan-derived-branch'
    );
    vi.mocked(getDatabase).mockReturnValue({} as any);
    vi.mocked(resolveProjectContext).mockResolvedValue({
      projectId: 1,
    } as any);
    vi.mocked(warnFn).mockReturnValue(undefined);
    vi.mocked(syncPlanToDb).mockResolvedValue(undefined);
    watchPlanFileSpy.mockReturnValue({ close: vi.fn(), closeAndFlush: vi.fn() });

    delete process.env.CODEX_USE_APP_SERVER;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
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
    await handleChatCommand('Help me debug this', {}, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      baseDir: originalCwd,
      terminalInput: true,
      closeTerminalInputOnResult: false,
      noninteractive: undefined,
    });
    expect(vi.mocked(setupWorkspace)).not.toHaveBeenCalled();
  });

  test('passes --model through to shared executor options for claude', async () => {
    await handleChatCommand('Help me debug this', { model: 'sonnet' }, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      model: 'sonnet',
    });
  });

  test('passes prompt through to executor in bare mode', async () => {
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
    await handleChatCommand(undefined, {}, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('allows starting without an initial prompt when terminal input is disabled and stdin is not a tty', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    await handleChatCommand(undefined, { terminalInput: false }, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      terminalInput: false,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('wraps execution in the headless adapter with the chat command type', async () => {
    await handleChatCommand('hello', {}, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
      callback: expect.any(Function),
    });
  });

  test('disables headless adapter wrapping when tunnel is already active', async () => {
    vi.mocked(isTunnelActive).mockReturnValue(true);

    await handleChatCommand('hello', {}, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      enabled: false,
      command: 'chat',
    });
  });

  test('forces headless adapter wrapping when tunnel is active and --headless-adapter is set', async () => {
    vi.mocked(isTunnelActive).mockReturnValue(true);

    await handleChatCommand('hello', { headlessAdapter: true }, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
    });
  });

  test('allows no prompt in non-interactive mode when terminal input is disabled', async () => {
    await expect(
      handleChatCommand(undefined, { nonInteractive: true, terminalInput: false }, {})
    ).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('allows no prompt in non-interactive mode when tunnel forwarding is active', async () => {
    vi.mocked(isTunnelActive).mockReturnValue(true);

    await expect(
      handleChatCommand(undefined, { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('allows codex-cli without an explicit prompt when app-server mode is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';

    await expect(handleChatCommand(undefined, { executor: 'codex-cli' }, {})).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('');
  });

  test('allows codex-cli without an explicit prompt when app-server mode is enabled', async () => {
    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli' }, {})
    ).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('');
  });

  test('accepts codex alias and keeps terminal input forwarding in default mode', async () => {
    await handleChatCommand('Summarize this repository', { executor: 'codex' }, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
      closeTerminalInputOnResult: false,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('Summarize this repository');
  });

  test('passes --model through to shared executor options for codex', async () => {
    await handleChatCommand('Summarize this repository', { executor: 'codex', model: 'gpt-5' }, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
    });
  });

  test('allows codex-cli when tunnel is active without an initial prompt and app-server is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    vi.mocked(isTunnelActive).mockReturnValue(true);

    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli', nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('');
  });

  test('uses configured default executor when provided', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
      terminalInput: true,
    } as any);

    await expect(
      handleChatCommand('Prompt text', { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      terminalInput: false,
      noninteractive: true,
      closeTerminalInputOnResult: false,
    });
  });

  test('throws when --executor is an incompatible executor', async () => {
    await expect(handleChatCommand('hello', { executor: 'copy-only' }, {})).rejects.toThrow(
      "Executor 'copy-only' is not supported by 'tim chat'"
    );

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('falls back to claude-code when config defaultExecutor is incompatible', async () => {
    const originalWarn = console.warn;
    const consolewarnSpy = vi.fn();
    console.warn = consolewarnSpy;

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'copy-only',
      terminalInput: true,
    } as any);

    await handleChatCommand('hello', {}, {});

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
    expect(consolewarnSpy).toHaveBeenCalledTimes(1);
    expect(consolewarnSpy.mock.calls[0][0]).toContain(
      "defaultExecutor 'copy-only' is not supported"
    );

    console.warn = originalWarn;
  });

  test('invokes the headless adapter without forwarding config', async () => {
    const config: Partial<TimConfig> = {
      defaultExecutor: 'claude-code',
      terminalInput: true,
    };
    vi.mocked(loadEffectiveConfig).mockResolvedValue(config as any);

    await handleChatCommand('hello', {}, {});

    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).not.toHaveProperty(
      'config'
    );
  });

  test('starts and closes the plan watcher when a headless adapter is active', async () => {
    const closeAndFlushSpy = vi.fn();
    watchPlanFileSpy.mockReturnValue({ close: vi.fn(), closeAndFlush: closeAndFlushSpy });
    const headlessAdapter = Object.assign(Object.create(HeadlessAdapter.prototype), {
      sendPlanContent: vi.fn(),
    }) as HeadlessAdapter;
    const getLoggerAdapterSpy = vi
      .spyOn(adapterModule, 'getLoggerAdapter')
      .mockReturnValue(headlessAdapter);

    try {
      await handleChatCommand('hello', { plan: '123' }, {});
    } finally {
      getLoggerAdapterSpy.mockRestore();
    }

    expect(watchPlanFileSpy).toHaveBeenCalledWith(
      '/repo-root/tasks/123-test.plan.md',
      expect.any(Function)
    );
    expect(closeAndFlushSpy).toHaveBeenCalledTimes(1);
  });

  test('enters workspace mode and passes workspace options through setupWorkspace', async () => {
    await handleChatCommand('hello', { workspace: 'task-123', nonInteractive: true }, {});

    expect(vi.mocked(resolveRepoRoot)).not.toHaveBeenCalled();
    expect(vi.mocked(getGitRoot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupWorkspace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupWorkspace).mock.calls[0]).toEqual([
      {
        workspace: 'task-123',
        autoWorkspace: false,
        newWorkspace: undefined,
        nonInteractive: true,
        requireWorkspace: false,
        createBranch: false,
        planId: undefined,
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
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      baseDir: '/repo-root/workspaces/task-123',
      noninteractive: true,
    });
  });

  test('resolves --plan and uses plan data for workspace setup and headless metadata', async () => {
    await handleChatCommand('hello', { autoWorkspace: true, plan: '123' }, { config: 'tim.json' });

    expect(vi.mocked(resolveRepoRoot)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolvePlanByNumericId)).toHaveBeenCalledWith('123', '/repo-root');
    expect(vi.mocked(generateBranchNameFromPlan)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupWorkspace).mock.calls[0][0]).toMatchObject({
      autoWorkspace: true,
      planId: 123,
      planUuid: '11111111-1111-4111-8111-111111111111',
      createBranch: false,
      checkoutBranch: 'plan-derived-branch',
    });
    expect(vi.mocked(setupWorkspace).mock.calls[0][2]).toBe('/repo-root/tasks/123-test.plan.md');
    expect(vi.mocked(runWithHeadlessAdapterIfEnabled).mock.calls[0][0]).toMatchObject({
      plan: {
        id: 123,
        title: 'Test plan',
      },
    });
    expect(vi.mocked(patchWorkspaceInfo)).toHaveBeenCalledWith('/repo-root/workspaces/task-123', {
      description: '123 - Plan description',
      planId: '123',
      planTitle: 'Combined test plan',
      issueUrls: ['https://example.com/issues/42'],
    });
    expect(vi.mocked(syncPlanToDb)).toHaveBeenCalledWith(
      expect.objectContaining({ id: 123 }),
      expect.objectContaining({
        cwdForIdentity: '/repo-root/workspaces/task-123',
        force: true,
        throwOnError: true,
      })
    );
  });

  test('--plan alone implies auto-workspace selection and derives branch from plan', async () => {
    await handleChatCommand('hello', { plan: '123' }, { config: 'tim.json' });

    expect(vi.mocked(setupWorkspace)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setupWorkspace).mock.calls[0][0]).toMatchObject({
      autoWorkspace: true,
      planId: 123,
      planUuid: '11111111-1111-4111-8111-111111111111',
      createBranch: false,
      checkoutBranch: 'plan-derived-branch',
    });
    expect(vi.mocked(resolvePlanByNumericId)).toHaveBeenCalledWith('123', '/repo-root');
    expect(vi.mocked(generateBranchNameFromPlan)).toHaveBeenCalledTimes(1);
  });

  test('passes config-derived branchPrefix through to generateBranchNameFromPlan for --plan', async () => {
    vi.mocked(loadEffectiveConfig).mockImplementation(async (_override, options) => {
      if (options?.cwd === '/repo-root') {
        return {
          defaultExecutor: undefined,
          terminalInput: true,
          branchPrefix: 'di/',
        } as any;
      }

      return {
        defaultExecutor: undefined,
        terminalInput: true,
      } as any;
    });
    vi.mocked(resolveBranchPrefix).mockImplementation(
      ({ config }: any) => config.branchPrefix ?? ''
    );

    await handleChatCommand('hello', { plan: '123' }, { config: 'tim.json' });

    expect(vi.mocked(resolveBranchPrefix)).toHaveBeenCalledWith({
      config: expect.objectContaining({ branchPrefix: 'di/' }),
      db: expect.anything(),
      projectId: 1,
    });
    expect(vi.mocked(generateBranchNameFromPlan)).toHaveBeenCalledWith(expect.anything(), {
      branchPrefix: 'di/',
    });
  });

  test('uses config-derived repo root for workspace setup when --config targets another repo', async () => {
    vi.mocked(resolveRepoRoot).mockResolvedValue('/other-repo');
    vi.mocked(loadEffectiveConfig).mockImplementation(async (_override, options) => {
      if (options?.cwd === '/other-repo') {
        return {
          defaultExecutor: undefined,
          terminalInput: true,
          branchPrefix: 'di/',
        } as any;
      }

      return {
        defaultExecutor: undefined,
        terminalInput: true,
      } as any;
    });
    vi.mocked(resolvePlanByNumericId).mockResolvedValueOnce({
      plan: {
        id: 123,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Test plan',
        status: 'pending',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: '/other-repo/tasks/123-test.plan.md',
    });

    await handleChatCommand('hello', { plan: '123' }, { config: '/other-repo/.tim.json' });

    expect(vi.mocked(resolvePlanByNumericId)).toHaveBeenCalledWith('123', '/other-repo');
    expect(vi.mocked(setupWorkspace)).toHaveBeenCalledWith(
      expect.anything(),
      '/other-repo',
      '/other-repo/tasks/123-test.plan.md',
      expect.objectContaining({ branchPrefix: 'di/' }),
      'tim chat'
    );
  });

  test('cross-repo --plan uses target repo executor and config in buildExecutorAndLog', async () => {
    vi.mocked(resolveRepoRoot).mockResolvedValue('/other-repo');
    vi.mocked(loadEffectiveConfig).mockImplementation(async (_override, options) => {
      if (options?.cwd === '/other-repo') {
        return {
          defaultExecutor: 'codex-cli',
          terminalInput: false,
        } as any;
      }

      return {
        defaultExecutor: 'claude-code',
        terminalInput: true,
      } as any;
    });
    vi.mocked(resolvePlanByNumericId).mockResolvedValueOnce({
      plan: {
        id: 123,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Test plan',
        status: 'pending',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: '/other-repo/tasks/123-test.plan.md',
    });

    await handleChatCommand('hello', { plan: '123' }, { config: '/other-repo/.tim.json' });

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('codex-cli');
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][1]).toMatchObject({
      terminalInput: false,
    });
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][2]).toMatchObject({
      defaultExecutor: 'codex-cli',
      terminalInput: false,
    });
  });

  test('--executor CLI flag overrides target repo defaultExecutor in cross-repo scenario', async () => {
    vi.mocked(resolveRepoRoot).mockResolvedValue('/other-repo');
    vi.mocked(loadEffectiveConfig).mockImplementation(async (_override, options) => {
      if (options?.cwd === '/other-repo') {
        return {
          defaultExecutor: 'codex-cli',
          terminalInput: true,
        } as any;
      }
      return {
        defaultExecutor: 'claude-code',
        terminalInput: true,
      } as any;
    });
    vi.mocked(resolvePlanByNumericId).mockResolvedValueOnce({
      plan: {
        id: 123,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Test plan',
        status: 'pending',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: '/other-repo/tasks/123-test.plan.md',
    });

    // Pass explicit --executor claude-code, which should override target repo's codex-cli
    await handleChatCommand(
      'hello',
      { plan: '123', executor: 'claude-code' },
      {
        config: '/other-repo/.tim.json',
      }
    );

    expect(vi.mocked(buildExecutorAndLog)).toHaveBeenCalledTimes(1);
    // CLI --executor wins over target repo defaultExecutor
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][0]).toBe('claude-code');
    // Config passed is still from target repo
    expect(vi.mocked(buildExecutorAndLog).mock.calls[0][2]).toMatchObject({
      defaultExecutor: 'codex-cli',
    });
  });

  test('uses explicit branch from plan data without calling generateBranchNameFromPlan', async () => {
    vi.mocked(resolvePlanByNumericId).mockResolvedValue({
      plan: {
        id: 123,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Test plan',
        branch: 'explicit-branch',
        status: 'pending',
        priority: 'medium',
        tasks: [],
      } as any,
      planPath: '/repo-root/tasks/123-test.plan.md',
    });

    await handleChatCommand('hello', { plan: '123' }, {});

    expect(vi.mocked(generateBranchNameFromPlan)).not.toHaveBeenCalled();
    expect(vi.mocked(setupWorkspace).mock.calls[0][0]).toMatchObject({
      checkoutBranch: 'explicit-branch',
    });
  });

  test('throws when --commit is used without workspace options', async () => {
    await expect(handleChatCommand('hello', { commit: true }, {})).rejects.toThrow(
      '--commit requires a workspace option'
    );

    expect(vi.mocked(setupWorkspace)).not.toHaveBeenCalled();
  });

  test('commits after execution when --commit is set', async () => {
    await handleChatCommand('hello', { workspace: 'task-123', commit: true }, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitAll)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitAll)).toHaveBeenCalledWith(
      'workspace chat session',
      '/repo-root/workspaces/task-123'
    );
  });

  test('runs workspace roundtrip hooks in order', async () => {
    const callOrder: string[] = [];
    vi.mocked(setupWorkspace).mockImplementationOnce(
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
    vi.mocked(prepareWorkspaceRoundTrip).mockImplementationOnce(async () => {
      callOrder.push('prepare');
      return {
        executionWorkspacePath: '/repo-root/workspaces/task-123',
      } as any;
    });
    vi.mocked(runPreExecutionWorkspaceSync).mockImplementationOnce(async () => {
      callOrder.push('pre');
    });
    mockExecutorExecute.mockImplementationOnce(async () => {
      callOrder.push('execute');
    });
    vi.mocked(runPostExecutionWorkspaceSync).mockImplementationOnce(async () => {
      callOrder.push('post');
    });
    vi.mocked(touchWorkspaceInfo).mockImplementationOnce(() => {
      callOrder.push('touch');
    });

    await handleChatCommand('hello', { workspace: 'task-123' }, {});

    expect(vi.mocked(prepareWorkspaceRoundTrip)).toHaveBeenCalledWith({
      workspacePath: '/repo-root/workspaces/task-123',
      workspaceSyncEnabled: true,
      branchCreatedDuringSetup: undefined,
    });
    expect(vi.mocked(runPreExecutionWorkspaceSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runPostExecutionWorkspaceSync)).toHaveBeenCalledWith(
      expect.objectContaining({
        executionWorkspacePath: '/repo-root/workspaces/task-123',
      }),
      'workspace chat session'
    );
    expect(vi.mocked(touchWorkspaceInfo)).toHaveBeenCalledWith('/repo-root/workspaces/task-123');
    expect(callOrder).toEqual(['setup', 'prepare', 'pre', 'execute', 'post', 'touch']);
  });

  test('still runs post-sync and touch cleanup when execution fails', async () => {
    const executionFailure = new Error('executor failed');
    vi.mocked(prepareWorkspaceRoundTrip).mockImplementationOnce(
      async () =>
        ({
          executionWorkspacePath: '/repo-root/workspaces/task-123',
        }) as any
    );
    mockExecutorExecute.mockImplementationOnce(async () => {
      throw executionFailure;
    });

    await expect(handleChatCommand('hello', { workspace: 'task-123' }, {})).rejects.toThrow(
      'executor failed'
    );

    expect(vi.mocked(runPostExecutionWorkspaceSync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(touchWorkspaceInfo)).toHaveBeenCalledWith('/repo-root/workspaces/task-123');
  });
});

describe('resolveOptionalPromptText', () => {
  test('returns positional prompt with tty stdin', async () => {
    const readStdin = vi.fn(async () => 'from-stdin');

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
    const readStdin = vi.fn(async () => 'from-stdin');

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
    const readStdin = vi.fn(async () => 'from-stdin');

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
    const readStdin = vi.fn(async () => 'from-stdin');

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
