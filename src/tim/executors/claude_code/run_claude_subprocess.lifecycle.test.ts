import { afterEach, describe, expect, test, vi } from 'vitest';
import type { SpawnAndLogOutputResult } from '../../../common/process.ts';

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

function makeSubprocessOptions(processFormattedMessages: (messages: unknown[]) => void = () => {}) {
  return {
    prompt: 'test prompt',
    cwd: process.cwd(),
    label: 'test',
    noninteractive: true,
    terminalInput: false,
    claudeCodeOptions: { includeDefaultTools: false },
    processFormattedMessages,
  };
}

async function setupRunClaudeSubprocess(
  stdinWriteSpy: ReturnType<typeof vi.fn>,
  options = makeSubprocessOptions()
) {
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

  const executePromise = runClaudeSubprocess(options);

  const setupStart = Date.now();
  while (
    (!formatStdout || stdinWriteSpy.mock.calls.length === 0) &&
    Date.now() - setupStart < 1000
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { stdinEndSpy, formatStdout: formatStdout!, resolveStreamingResult, executePromise };
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
});
