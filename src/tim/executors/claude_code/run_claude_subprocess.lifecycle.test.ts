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

  test('background task keeps stdin open past result; closes after grace once task ends', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    // Emit task_started: background task begins
    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-bg1',
        description: 'running tests',
        task_type: 'local_bash',
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

    // Emit task_notification (task stopped) → tracker starts grace timer
    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-bg1',
        status: 'stopped',
        output_file: '',
        summary: 'tests passed',
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

  test('ScheduleWakeup keeps stdin open past result; new-turn activity + final result closes after grace', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    // Emit ScheduleWakeup tool use in an assistant message
    formatStdout(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-wakeup',
              name: 'ScheduleWakeup',
              input: { delaySeconds: 270, reason: 'waiting for task', prompt: 'continue' },
            },
          ],
        },
        session_id: SESSION_ID,
      })}\n`
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Emit result: turn ends with wakeup pending → stdin must NOT close
    formatStdout(`${RESULT_LINE}\n`);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Switch to fake timers before the grace timer could be created
    vi.useFakeTimers();

    // Grace must not fire while wakeup is pending
    vi.advanceTimersByTime(15_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Emit a fresh assistant turn (wakeup "fires" — turn activity resets wakeupPending)
    formatStdout(
      `${JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Resuming work...' }] },
        session_id: SESSION_ID,
      })}\n`
    );

    // Emit final result: no pending activity, everDeferred=true → grace timer starts
    formatStdout(`${RESULT_LINE}\n`);
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
        subtype: 'task_started',
        task_id: 'task-bg1',
        description: 'running tests',
        task_type: 'local_bash',
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

  test('pending wakeup result is not treated as completed when subprocess exits nonzero before close', async () => {
    const stdinWriteSpy = vi.fn((_value: string) => {});
    const { stdinEndSpy, formatStdout, resolveStreamingResult, executePromise } =
      await setupRunClaudeSubprocess(stdinWriteSpy);

    formatStdout(
      `${JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-wakeup',
              name: 'ScheduleWakeup',
              input: { delaySeconds: 270, reason: 'waiting for task', prompt: 'continue' },
            },
          ],
        },
        session_id: SESSION_ID,
      })}\n`
    );
    formatStdout(`${RESULT_LINE}\n`);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

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
        subtype: 'task_started',
        task_id: 'task-bg1',
        description: 'running tests',
        task_type: 'local_bash',
        uuid: 'uuid-1',
        session_id: SESSION_ID,
      })}\n`
    );
    formatStdout(`${RESULT_LINE}\n`);

    vi.useFakeTimers();
    formatStdout(
      `${JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-bg1',
        status: 'stopped',
        output_file: '',
        summary: 'tests passed',
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
