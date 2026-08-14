import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SpawnAndLogOutputResult } from '../../../common/process.ts';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';

const mockSpawnWithStreamingIO = vi.fn();
const mockGetCurrentSessionProcessOwner = vi.fn(() => undefined);

vi.mock('../../../common/process.js', () => ({
  spawnWithStreamingIO: mockSpawnWithStreamingIO,
  createLineSplitter: vi.fn(() => (input: string) => input.split('\n').filter(Boolean)),
}));

vi.mock('../../../common/session_process_control.js', () => ({
  getCurrentSessionProcessOwner: mockGetCurrentSessionProcessOwner,
}));

vi.mock('../../../logging.js', () => ({
  debugLog: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
  sendStructured: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../logging/adapter.js', () => ({
  getLoggerAdapter: vi.fn(() => ({})),
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../../logging/tunnel_server.js', () => ({
  createTunnelServer: vi.fn(),
  createExecutorTunnelServer: vi.fn(),
}));

vi.mock('../../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../../../logging/tunnel_protocol.js', () => ({
  TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
}));

vi.mock('../../../common/subprocess_monitor.js', () => ({
  normalizeSubprocessMonitorRules: vi.fn(),
  startSubprocessMonitor: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => {
    throw new Error('not configured');
  }),
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../db/permission.js', () => ({
  getPermissions: vi.fn(() => ({ allow: [] })),
}));

vi.mock('../../db/project.js', () => ({
  getOrCreateProject: vi.fn(),
}));

vi.mock('./permissions_mcp_setup.js', () => ({
  setupPermissionsMcp: vi.fn(),
}));

const { runClaudeSubprocess } = await import('./run_claude_subprocess.js');

const SESSION_ID = 'session-1';

const RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: '',
  session_id: SESSION_ID,
  total_cost_usd: 0,
});

const FAILED_RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'error_max_turns',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: true,
  num_turns: 1,
  session_id: SESSION_ID,
  total_cost_usd: 0,
});

function makeSubprocessOptions() {
  return {
    prompt: 'test prompt',
    cwd: process.cwd(),
    label: 'test',
    noninteractive: true,
    terminalInput: false,
    claudeCodeOptions: { includeDefaultTools: false },
    processFormattedMessages: () => {},
  };
}

async function setupRunClaudeSubprocess(stdinWriteSpy: ReturnType<typeof vi.fn>) {
  const stdinEndSpy = vi.fn(async () => {});
  let formatStdout: ((output: string) => unknown) | undefined;
  let resolveStreamingResult: ((value: SpawnAndLogOutputResult) => void) | undefined;

  mockSpawnWithStreamingIO.mockImplementation(async (_args: string[], opts: any) => {
    formatStdout = opts.formatStdout;
    return {
      pid: 123,
      stdin: { write: stdinWriteSpy, end: stdinEndSpy },
      result: new Promise<SpawnAndLogOutputResult>((resolve) => {
        resolveStreamingResult = resolve;
      }),
      kill: vi.fn(),
    };
  });

  const executePromise = runClaudeSubprocess(makeSubprocessOptions());

  const setupStart = Date.now();
  while (
    (!formatStdout || stdinWriteSpy.mock.calls.length === 0) &&
    Date.now() - setupStart < 1000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { stdinEndSpy, formatStdout: formatStdout!, resolveStreamingResult, executePromise };
}

async function setupPersistentClaudeSubprocess(
  stdinWriteSpy: ReturnType<typeof vi.fn> = vi.fn((_value: string) => {})
) {
  const stdinEndSpy = vi.fn(async () => {});
  let formatStdout: ((output: string) => unknown) | undefined;
  let resolveStreamingResult: ((value: SpawnAndLogOutputResult) => void) | undefined;
  let spawnOptions: Record<string, unknown> | undefined;

  mockSpawnWithStreamingIO.mockImplementation(async (_args: string[], opts: any) => {
    spawnOptions = opts;
    formatStdout = opts.formatStdout;
    opts.onSessionProcessReady?.({
      processId: 'process-1',
      setGracefulEndHandler: vi.fn(),
      updateMetadata: vi.fn(),
      markSpawned: vi.fn(),
      markSpawnFailed: vi.fn(),
      markExited: vi.fn(),
    });
    return {
      pid: 456,
      stdin: { write: stdinWriteSpy, end: stdinEndSpy },
      result: new Promise<SpawnAndLogOutputResult>((resolve) => {
        resolveStreamingResult = resolve;
      }),
      kill: vi.fn(),
    };
  });

  const handlePromise = runClaudeSubprocess({
    ...makeSubprocessOptions(),
    mode: 'persistent-agent',
    processLabel: 'Claude agent (persistent-worker)' as AgentProcessLabel,
  });

  const setupStart = Date.now();
  while ((!formatStdout || !spawnOptions) && Date.now() - setupStart < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return {
    handle: await handlePromise,
    stdinEndSpy,
    stdinWriteSpy,
    formatStdout: formatStdout!,
    resolveStreamingResult: resolveStreamingResult!,
    spawnOptions: spawnOptions!,
  };
}

describe('runClaudeSubprocess lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mockGetCurrentSessionProcessOwner.mockReturnValue(undefined);
  });

  test('normal non-interactive result closes stdin before streaming.result resolves', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    expect(stdinWriteSpy).toHaveBeenCalledTimes(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    formatStdout(`${RESULT_LINE}\n`);

    // stdin closed before streaming.result resolves
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await executePromise;
  });

  test('reuses one formatter across stdout callbacks for tool correlation', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    const toolUseLine = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'cross-callback-tool',
            name: 'Bash',
            input: { command: 'printf hello' },
          },
        ],
      },
      session_id: SESSION_ID,
    });
    const toolResultLine = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'cross-callback-tool',
            content: 'hello',
          },
        ],
      },
      session_id: SESSION_ID,
    });

    formatStdout(`${toolUseLine}\n`);
    const toolResultOutput = formatStdout(`${toolResultLine}\n`);

    expect(toolResultOutput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'llm_tool_result',
          toolName: 'Bash',
        }),
      ])
    );

    formatStdout(`${RESULT_LINE}\n`);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await executePromise;
  });

  test('background task status keeps stdin open past result and closes after empty status', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'task-bg1' }],
        uuid: 'uuid-1',
        session_id: SESSION_ID,
      })}\n`
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Emit result: turn ends, but task is still active → stdin must NOT close
    formatStdout(`${RESULT_LINE}\n`);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Switch to fake timers before the grace timer is created
    vi.useFakeTimers();

    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
        uuid: 'uuid-2',
        session_id: SESSION_ID,
      })}\n`
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(9_999);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1); // grace expires
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await executePromise;
  });

  test('active background task result is not treated as completed when inactivity kills before close', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'task-bg1' }],
        uuid: 'uuid-1',
        session_id: SESSION_ID,
      })}\n`
    );
    formatStdout(`${RESULT_LINE}\n`);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    resolveStreamingResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: true,
    });

    await expect(executePromise).resolves.toMatchObject({
      acceptedFinalResult: false,
      killedByInactivity: true,
    });
  });

  test('normal result is still treated as completed before a later nonzero exit', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(`${RESULT_LINE}\n`);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await expect(executePromise).resolves.toMatchObject({
      acceptedFinalResult: true,
      exitCode: 1,
    });
  });

  test('failed result is not treated as completed before a later nonzero exit', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(`${FAILED_RESULT_LINE}\n`);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await expect(executePromise).resolves.toMatchObject({
      acceptedFinalResult: false,
      exitCode: 1,
    });
  });

  test('background work that drains and closes after grace is treated as completed', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'task-bg1' }],
        uuid: 'uuid-1',
        session_id: SESSION_ID,
      })}\n`
    );
    formatStdout(`${RESULT_LINE}\n`);

    vi.useFakeTimers();
    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
        uuid: 'uuid-2',
        session_id: SESSION_ID,
      })}\n`
    );

    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    resolveStreamingResult?.({
      exitCode: 1,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await expect(executePromise).resolves.toMatchObject({
      acceptedFinalResult: true,
      exitCode: 1,
    });
  });

  test('persistent mode returns after input readiness and keeps the process alive across turns', async () => {
    const setup = await setupPersistentClaudeSubprocess();

    expect(setup.handle.processLabel).toBe('Claude agent (persistent-worker)');
    expect(setup.handle.providerState).toBe('active');
    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(1);
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();
    expect(setup.spawnOptions.disableInactivityKill).toBe(true);

    const firstResult = setup.formatStdout(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'first result',
        session_id: SESSION_ID,
        total_cost_usd: 0,
      })}\n`
    );

    expect(firstResult).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'agent_session_end' })])
    );
    expect(setup.handle.providerState).toBe('idle');
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();

    expect(
      await Promise.resolve(
        setup.handle.input.deliver({
          messageId: 'second-turn',
          source: {} as never,
          content: 'second assignment',
        })
      )
    ).toBe('started-idle-turn');
    expect(setup.handle.providerState).toBe('active');
    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(2);

    setup.formatStdout(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: 'second result',
        session_id: SESSION_ID,
        total_cost_usd: 0,
      })}\n`
    );
    expect(setup.handle.providerState).toBe('idle');
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await expect(setup.handle.completion).resolves.toMatchObject({
      exitCode: 0,
      resultText: 'second result',
      finalMessage: 'second result',
    });
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();
  });

  test('persistent completion captures only complete assistant messages and output activity callbacks are isolated', async () => {
    const outputActivity = vi.fn(() => {
      throw new Error('activity observer failed');
    });
    const setup = await (async () => {
      const stdinWriteSpy = vi.fn((_value: string) => {});
      const stdinEndSpy = vi.fn(async () => {});
      let formatStdout: ((output: string) => unknown) | undefined;
      let resolveStreamingResult: ((value: SpawnAndLogOutputResult) => void) | undefined;
      let spawnOptions: Record<string, unknown> | undefined;
      mockSpawnWithStreamingIO.mockImplementation(async (_args: string[], opts: any) => {
        spawnOptions = opts;
        formatStdout = opts.formatStdout;
        return {
          pid: 789,
          stdin: { write: stdinWriteSpy, end: stdinEndSpy },
          result: new Promise<SpawnAndLogOutputResult>((resolve) => {
            resolveStreamingResult = resolve;
          }),
          kill: vi.fn(),
        };
      });
      const handlePromise = runClaudeSubprocess({
        ...makeSubprocessOptions(),
        mode: 'persistent-agent',
        onOutputActivity: outputActivity,
      });
      const setupStart = Date.now();
      while ((!formatStdout || !spawnOptions) && Date.now() - setupStart < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        handle: await handlePromise,
        formatStdout: formatStdout!,
        resolveStreamingResult: resolveStreamingResult!,
        spawnOptions: spawnOptions!,
      };
    })();

    const assistantLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'complete assistant answer' }] },
      session_id: SESSION_ID,
    });
    setup.formatStdout(`${assistantLine}\n`);
    expect(setup.spawnOptions.onOutputActivity).toBeTypeOf('function');
    expect(() => (setup.spawnOptions.onOutputActivity as () => void)()).not.toThrow();
    expect(outputActivity).toHaveBeenCalledOnce();

    setup.formatStdout(`${RESULT_LINE}\n`);
    setup.resolveStreamingResult({
      exitCode: 1,
      stdout: '',
      stderr: 'provider stopped',
      signal: null,
      killedByInactivity: false,
    });

    await expect(setup.handle.completion).resolves.toMatchObject({
      exitCode: 1,
      lastCompletedAssistantMessage: 'complete assistant answer',
      resultText: '',
      error: expect.any(Error),
    });
  });

  test('graceful shutdown steers an active turn and closes after its result', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    const exits: string[] = [];
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {},
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (classification): void => exits.push(classification),
    });

    await expect(setup.handle.lifecycle.requestGracefulShutdown('finish this work')).resolves.toBe(
      'accepted'
    );
    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(2);
    expect(setup.handle.providerState).toBe('graceful-stop-active');
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();

    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.stdinEndSpy).toHaveBeenCalledOnce();
    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await expect(setup.handle.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(exits).toEqual(['graceful']);
  });

  test('graceful shutdown starts one idle turn and duplicate calls do not write again', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.handle.providerState).toBe('idle');

    const first = setup.handle.lifecycle.requestGracefulShutdown('report final status');
    const second = setup.handle.lifecycle.requestGracefulShutdown('different instruction');
    await expect(first).resolves.toBe('accepted');
    await expect(second).resolves.toBe('accepted');

    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(2);
    expect(setup.handle.providerState).toBe('graceful-stop-active');
    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.stdinEndSpy).toHaveBeenCalledOnce();

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await setup.handle.completion;
  });

  test('busy shutdown input fails without retaining a Claude-local queue', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    let resolveWrite: ((value: number) => void) | undefined;
    setup.stdinWriteSpy.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          resolveWrite = resolve;
        })
    );

    const steering = setup.handle.input.deliver({
      messageId: 'busy-steering',
      source: {} as never,
      content: 'busy steering',
    });
    await expect(
      setup.handle.lifecycle.requestGracefulShutdown('must not be queued')
    ).rejects.toMatchObject({
      operation: 'graceful-shutdown',
      message: expect.stringContaining('temporarily unavailable'),
    });
    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(2);

    resolveWrite?.(1);
    await expect(steering).resolves.toBe('steered');
    await setup.handle.release();
  });

  test('shutdown write failure is reported as a control failure and provider failure', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    setup.stdinWriteSpy.mockImplementationOnce(() => Promise.reject(new Error('stdin failed')));

    await expect(
      setup.handle.lifecycle.requestGracefulShutdown('final status')
    ).rejects.toMatchObject({
      operation: 'graceful-shutdown',
      message: expect.stringContaining('input'),
    });
    expect(setup.handle.providerState).toBe('failed');

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({
      error: expect.any(Error),
    });
  });

  test('close-after-current-turn is graceful and races natural process exit exactly once', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    const exits: string[] = [];
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {},
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (classification): void => exits.push(classification),
    });

    await expect(setup.handle.lifecycle.requestCloseAfterCurrentTurn()).resolves.toBe('accepted');
    setup.formatStdout(`${RESULT_LINE}\n`);
    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await setup.handle.completion;
    expect(exits).toEqual(['graceful']);
    await expect(setup.handle.lifecycle.requestCloseAfterCurrentTurn()).resolves.toBe(
      'already-exited'
    );
  });

  test('force shutdown uses the captured safe owner capability and classifies completion as forced', async () => {
    const terminateExecutor = vi.fn(() => 'terminated');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();

    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    expect(terminateExecutor).toHaveBeenCalledOnce();
    expect(terminateExecutor).toHaveBeenCalledWith('process-1');

    setup.resolveStreamingResult({
      exitCode: 143,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({
      exitCode: 143,
      signal: 'SIGTERM',
    });
  });

  test('force shutdown reports typed non-acceptance and permits a later retry', async () => {
    const terminateExecutor = vi
      .fn<() => 'stale_target' | 'terminated'>()
      .mockReturnValueOnce('stale_target')
      .mockReturnValueOnce('terminated');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();

    await expect(setup.handle.lifecycle.requestForcedShutdown()).rejects.toMatchObject({
      name: 'AgentProviderForceNotAcceptedError',
      operation: 'forced-shutdown',
    });
    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    expect(terminateExecutor).toHaveBeenCalledTimes(2);

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await setup.handle.completion;
  });

  test('force shutdown treats a failed safe-control result as not accepted', async () => {
    const terminateExecutor = vi.fn(() => 'signal_failed');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();

    await expect(setup.handle.lifecycle.requestForcedShutdown()).rejects.toMatchObject({
      name: 'AgentProviderForceNotAcceptedError',
      operation: 'forced-shutdown',
      message: expect.stringContaining('signal_failed'),
    });
    expect(terminateExecutor).toHaveBeenCalledOnce();
    await setup.handle.release();
  });

  test('persistent setup failure before spawn rejects the launch and never leaves completion pending', async () => {
    mockSpawnWithStreamingIO.mockImplementation(async () => {
      throw new Error('spawn boom');
    });

    await expect(
      runClaudeSubprocess({
        ...makeSubprocessOptions(),
        mode: 'persistent-agent',
      })
    ).rejects.toThrow('spawn boom');
  });

  test('a synchronous initial write failure rejects launch before returning a handle', async () => {
    const stdinWriteSpy = vi.fn(() => {
      throw new Error('stdin boom');
    });
    const stdinEndSpy = vi.fn(async () => {});
    mockSpawnWithStreamingIO.mockImplementation(async () => {
      return {
        pid: 456,
        stdin: { write: stdinWriteSpy, end: stdinEndSpy },
        result: new Promise<SpawnAndLogOutputResult>(() => undefined),
        kill: vi.fn(),
      };
    });

    await expect(
      runClaudeSubprocess({
        ...makeSubprocessOptions(),
        mode: 'persistent-agent',
        processLabel: 'Claude agent (persistent-worker)' as AgentProcessLabel,
      })
    ).rejects.toThrow('stdin boom');
    expect(stdinEndSpy).toHaveBeenCalledOnce();
  });

  test('release is idempotent and safe to call before and after natural exit', async () => {
    const setup = await setupPersistentClaudeSubprocess();

    await expect(setup.handle.release()).resolves.toBeUndefined();
    await expect(setup.handle.release()).resolves.toBeUndefined();

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await setup.handle.completion;
    await expect(setup.handle.release()).resolves.toBeUndefined();
  });

  test('close-after-current-turn during a result-pending background turn waits for drain before closing', async () => {
    const setup = await setupPersistentClaudeSubprocess();

    setup.formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ id: 'task-bg1' }],
        uuid: 'uuid-1',
        session_id: SESSION_ID,
      })}\n`
    );
    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.handle.providerState).toBe('result-pending-background');

    await expect(setup.handle.lifecycle.requestCloseAfterCurrentTurn()).resolves.toBe('accepted');
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();

    vi.useFakeTimers();
    setup.formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [],
        uuid: 'uuid-2',
        session_id: SESSION_ID,
      })}\n`
    );
    expect(setup.stdinEndSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(setup.stdinEndSpy).toHaveBeenCalledOnce();

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({ exitCode: 0 });
  });

  test('duplicate graceful shutdown calls while active do not write a second instruction', async () => {
    const setup = await setupPersistentClaudeSubprocess();

    const first = setup.handle.lifecycle.requestGracefulShutdown('please wrap up');
    const second = setup.handle.lifecycle.requestGracefulShutdown('please wrap up again');
    await expect(first).resolves.toBe('accepted');
    await expect(second).resolves.toBe('accepted');

    // One write for the initial prompt, one write for the shutdown instruction.
    expect(setup.stdinWriteSpy).toHaveBeenCalledTimes(2);
    expect(setup.handle.providerState).toBe('graceful-stop-active');

    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.stdinEndSpy).toHaveBeenCalledOnce();

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await setup.handle.completion;
  });

  test('force shutdown from idle uses the safe owner capability', async () => {
    const terminateExecutor = vi.fn(() => 'terminated');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();

    setup.formatStdout(`${RESULT_LINE}\n`);
    expect(setup.handle.providerState).toBe('idle');

    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    expect(terminateExecutor).toHaveBeenCalledOnce();
    expect(terminateExecutor).toHaveBeenCalledWith('process-1');

    setup.resolveStreamingResult({
      exitCode: 143,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({ exitCode: 143 });
  });

  test('force shutdown upgrades an in-progress graceful stop and classifies completion as forced', async () => {
    const terminateExecutor = vi.fn(() => 'terminated');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();
    const exits: string[] = [];
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {},
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (classification): void => exits.push(classification),
    });

    await expect(setup.handle.lifecycle.requestGracefulShutdown('please wrap up')).resolves.toBe(
      'accepted'
    );
    expect(setup.handle.providerState).toBe('graceful-stop-active');

    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    expect(terminateExecutor).toHaveBeenCalledOnce();

    setup.resolveStreamingResult({
      exitCode: 143,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({ exitCode: 143 });
    expect(exits).toEqual(['forced']);
  });

  test('force shutdown treats an already-exited safe-control result as informational, not accepted', async () => {
    const terminateExecutor = vi.fn(() => 'already_exited');
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);
    const setup = await setupPersistentClaudeSubprocess();
    const exits: string[] = [];
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {},
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (classification): void => exits.push(classification),
    });

    await expect(setup.handle.lifecycle.requestForcedShutdown()).resolves.toBe('already-exited');
    expect(terminateExecutor).toHaveBeenCalledOnce();

    setup.formatStdout(`${RESULT_LINE}\n`);
    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await expect(setup.handle.completion).resolves.toMatchObject({ exitCode: 0 });
    // The already-exited report never accepted a force; the natural close
    // path (no close-after-turn request here) still classifies the exit.
    expect(exits).toEqual(['natural']);
  });

  test('force-stopping one persistent agent does not affect a concurrently running second agent', async () => {
    const terminateExecutor = vi.fn((_processId: string) => 'terminated' as const);
    mockGetCurrentSessionProcessOwner.mockReturnValue({ terminateExecutor } as never);

    async function startAgent(processId: string, label: string) {
      const stdinWriteSpy = vi.fn((_value: string) => {});
      const stdinEndSpy = vi.fn(async () => {});
      let formatStdout: ((output: string) => unknown) | undefined;
      let resolveStreamingResult: ((value: SpawnAndLogOutputResult) => void) | undefined;
      let spawnOptions: Record<string, unknown> | undefined;
      mockSpawnWithStreamingIO.mockImplementation(async (_args: string[], opts: any) => {
        spawnOptions = opts;
        formatStdout = opts.formatStdout;
        opts.onSessionProcessReady?.({
          processId,
          setGracefulEndHandler: vi.fn(),
          updateMetadata: vi.fn(),
          markSpawned: vi.fn(),
          markSpawnFailed: vi.fn(),
          markExited: vi.fn(),
        });
        return {
          pid: processId === 'process-a' ? 111 : 222,
          stdin: { write: stdinWriteSpy, end: stdinEndSpy },
          result: new Promise<SpawnAndLogOutputResult>((resolve) => {
            resolveStreamingResult = resolve;
          }),
          kill: vi.fn(),
        };
      });
      const handlePromise = runClaudeSubprocess({
        ...makeSubprocessOptions(),
        mode: 'persistent-agent',
        processLabel: `Claude agent (${label})` as AgentProcessLabel,
      });
      const setupStart = Date.now();
      while ((!formatStdout || !spawnOptions) && Date.now() - setupStart < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return {
        handle: await handlePromise,
        stdinWriteSpy,
        stdinEndSpy,
        formatStdout: formatStdout!,
        resolveStreamingResult: resolveStreamingResult!,
        spawnOptions: spawnOptions!,
      };
    }

    const agentA = await startAgent('process-a', 'agent-a');
    const agentB = await startAgent('process-b', 'agent-b');

    expect(agentA.handle.processLabel).toBe('Claude agent (agent-a)');
    expect(agentB.handle.processLabel).toBe('Claude agent (agent-b)');

    // Force-stop only agent A.
    await expect(agentA.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    expect(terminateExecutor).toHaveBeenCalledExactlyOnceWith('process-a');

    agentA.resolveStreamingResult({
      exitCode: 143,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      killedByInactivity: false,
    });
    await expect(agentA.handle.completion).resolves.toMatchObject({ exitCode: 143 });
    // Repeated release after natural completion must stay idempotent and
    // must not disturb the other agent's still-live process.
    await agentA.handle.release();
    await agentA.handle.release();

    // Agent B must be completely unaffected: no forced call targeted it, its
    // stdin was never closed, and it can still steer a continuation turn.
    expect(agentB.stdinEndSpy).not.toHaveBeenCalled();
    expect(agentB.handle.providerState).toBe('active');
    expect(agentB.stdinWriteSpy).toHaveBeenCalledTimes(1);

    agentB.formatStdout(`${RESULT_LINE}\n`);
    expect(agentB.handle.providerState).toBe('idle');

    expect(
      await Promise.resolve(
        agentB.handle.input.deliver({
          messageId: 'b-continue',
          source: {} as never,
          content: 'continue',
        })
      )
    ).toBe('started-idle-turn');
    expect(agentB.handle.providerState).toBe('active');
    expect(agentB.stdinWriteSpy).toHaveBeenCalledTimes(2);

    agentB.formatStdout(`${RESULT_LINE}\n`);
    agentB.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await expect(agentB.handle.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(terminateExecutor).toHaveBeenCalledExactlyOnceWith('process-a');
  });

  test('concurrent release calls share one cleanup and settle completion exactly once', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    const exits: string[] = [];
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {},
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (classification): void => exits.push(classification),
    });

    // Fire several release() calls back-to-back without awaiting any of them
    // individually, mirroring a caller and the finalizer racing to tear down
    // the same execution at once.
    const releasePromises = [
      setup.handle.release(),
      setup.handle.release(),
      setup.handle.release(),
    ];

    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });

    await Promise.all(releasePromises);
    await setup.handle.completion;
    expect(setup.stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(exits).toEqual(['natural']);

    // A release requested after settlement remains harmless.
    await expect(setup.handle.release()).resolves.toBeUndefined();
    expect(exits).toEqual(['natural']);
  });

  test('output produced after cleanup starts is rejected instead of processed', async () => {
    const processFormattedMessages = vi.fn();
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const stdinEndSpy = vi.fn(async () => {});
    let formatStdout: ((output: string) => unknown) | undefined;
    let resolveStreamingResult: ((value: SpawnAndLogOutputResult) => void) | undefined;
    mockSpawnWithStreamingIO.mockImplementation(async (_args: string[], opts: any) => {
      formatStdout = opts.formatStdout;
      opts.onSessionProcessReady?.({
        processId: 'process-late',
        setGracefulEndHandler: vi.fn(),
        updateMetadata: vi.fn(),
        markSpawned: vi.fn(),
        markSpawnFailed: vi.fn(),
        markExited: vi.fn(),
      });
      return {
        pid: 999,
        stdin: { write: stdinWriteSpy, end: stdinEndSpy },
        result: new Promise<SpawnAndLogOutputResult>((resolve) => {
          resolveStreamingResult = resolve;
        }),
        kill: vi.fn(),
      };
    });

    const handlePromise = runClaudeSubprocess({
      ...makeSubprocessOptions(),
      mode: 'persistent-agent',
      processFormattedMessages,
    });
    const setupStart = Date.now();
    while (!formatStdout && Date.now() - setupStart < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const handle = await handlePromise;
    processFormattedMessages.mockClear();

    // release() starts the idempotent cleanup finalizer synchronously; a
    // process output chunk delivered afterward must not reach the formatter
    // pipeline even though the mocked stdin has not itself been torn down.
    const releasePromise = handle.release();
    expect(() => formatStdout?.(`${RESULT_LINE}\n`)).not.toThrow();
    expect(processFormattedMessages).not.toHaveBeenCalled();

    resolveStreamingResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await releasePromise;
    await handle.completion;

    // Cleanup remains idempotent, and output continues to be rejected after
    // the completion promise has settled.
    expect(() => formatStdout?.(`${RESULT_LINE}\n`)).not.toThrow();
    expect(processFormattedMessages).not.toHaveBeenCalled();
    await handle.release();
  });

  test('a throwing lifecycle observer does not block other observers or output flow', async () => {
    const setup = await setupPersistentClaudeSubprocess();
    const goodObserverActivity = vi.fn();
    setup.handle.lifecycle.subscribe({
      outputActivity: (): void => {
        throw new Error('bad observer');
      },
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (): void => {},
    });
    setup.handle.lifecycle.subscribe({
      outputActivity: goodObserverActivity,
      completedAssistantMessage: (): void => {},
      turnComplete: (): void => {},
      exit: (): void => {},
    });

    expect(() => (setup.spawnOptions.onOutputActivity as () => void)()).not.toThrow();
    expect(goodObserverActivity).toHaveBeenCalledOnce();

    setup.formatStdout(`${RESULT_LINE}\n`);
    setup.resolveStreamingResult({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await setup.handle.completion;
  });
});
