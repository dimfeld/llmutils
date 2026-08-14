import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SpawnAndLogOutputResult } from '../../../common/process.ts';
import type { AgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';

const mockSpawnWithStreamingIO = vi.fn();

vi.mock('../../../common/process.js', () => ({
  spawnWithStreamingIO: mockSpawnWithStreamingIO,
  createLineSplitter: vi.fn(() => (input: string) => input.split('\n').filter(Boolean)),
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
});
