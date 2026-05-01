import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;

beforeEach(() => {
  process.env.CODEX_USE_APP_SERVER = 'false';
});

afterEach(() => {
  if (originalCodexUseAppServer === undefined) {
    delete process.env.CODEX_USE_APP_SERVER;
  } else {
    process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
  }
  vi.clearAllMocks();
});

vi.mock('../../../common/process.ts', () => ({
  spawnAndLogOutput: vi.fn(),
}));

vi.mock('../../../logging.ts', () => ({
  error: vi.fn(),
  warn: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('./format.ts', () => ({
  createCodexStdoutFormatter: vi.fn(),
}));

vi.mock('./app_server_runner.ts', () => ({
  executeCodexStepViaAppServer: vi.fn(),
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => true),
}));

vi.mock('../../../logging/tunnel_server.js', () => ({
  createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
}));

vi.mock('../../../logging/tunnel_prompt_handler.js', () => ({
  createPromptRequestHandler: vi.fn(() => vi.fn()),
}));

vi.mock('../../../logging/tunnel_protocol.js', () => ({
  TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
}));

vi.mock('../../../common/subprocess_monitor.ts', () => ({
  startSubprocessMonitor: vi.fn(() => ({ stop: vi.fn() })),
  normalizeSubprocessMonitorRules: vi.fn(() => []),
}));

import { spawnAndLogOutput } from '../../../common/process.js';
import { createCodexStdoutFormatter } from './format.js';
import { executeCodexStep } from './codex_runner.js';
import { startSubprocessMonitor } from '../../../common/subprocess_monitor.js';

describe('executeCodexStep retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('retries when codex exits non-zero and then succeeds', async () => {
    let attempts = 0;
    vi.mocked(spawnAndLogOutput).mockImplementation(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('chunk');
      }

      attempts += 1;
      const exitCode = attempts === 1 ? 1 : 0;
      return { exitCode, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    vi.mocked(createCodexStdoutFormatter).mockReturnValue({
      formatChunk: () => '',
      getFinalAgentMessage: () => 'ok',
      getFailedAgentMessage: () => undefined,
      getThreadId: () => 'thread-123',
      getSessionId: () => undefined,
    } as any);

    const output = await executeCodexStep('prompt', '/tmp', {} as any);

    expect(output).toBe('ok');
    expect(vi.mocked(spawnAndLogOutput)).toHaveBeenCalledTimes(2);

    const firstArgs = vi.mocked(spawnAndLogOutput).mock.calls[0][0] as string[];
    const secondArgs = vi.mocked(spawnAndLogOutput).mock.calls[1][0] as string[];

    expect(firstArgs.slice(-2)).toEqual(['--json', 'prompt']);
    expect(secondArgs.slice(-4)).toEqual(['--json', 'resume', 'thread-123', 'continue']);
  });

  test('stops after three failed attempts when codex keeps exiting', async () => {
    vi.mocked(spawnAndLogOutput).mockImplementation(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('chunk');
      }
      return { exitCode: 1, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    vi.mocked(createCodexStdoutFormatter).mockReturnValue({
      formatChunk: () => '',
      getFinalAgentMessage: () => 'never-called',
      getFailedAgentMessage: () => undefined,
      getThreadId: () => 'thread-123',
      getSessionId: () => undefined,
    } as any);

    await expect(executeCodexStep('prompt', '/tmp', {} as any)).rejects.toThrow(
      /failed after 3 attempts/i
    );

    expect(vi.mocked(spawnAndLogOutput)).toHaveBeenCalledTimes(3);
  });
});

describe('executeCodexStep subprocess monitor wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupSuccessfulSpawn(fakePid = 42) {
    vi.mocked(spawnAndLogOutput).mockImplementation(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('chunk');
      }
      opts?.onSpawn?.(fakePid);
      return { exitCode: 0, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    vi.mocked(createCodexStdoutFormatter).mockReturnValue({
      formatChunk: () => '',
      getFinalAgentMessage: () => 'done',
      getFailedAgentMessage: () => undefined,
      getThreadId: () => undefined,
      getSessionId: () => undefined,
    } as any);
  }

  test('starts monitor when subprocessMonitor.rules is non-empty', async () => {
    setupSuccessfulSpawn(99);

    const timConfig = {
      subprocessMonitor: {
        rules: [{ match: 'pnpm test', timeoutSeconds: 60 }],
      },
    } as any;

    await executeCodexStep('prompt', '/tmp', timConfig);

    expect(vi.mocked(startSubprocessMonitor)).toHaveBeenCalledOnce();
    const callArg = vi.mocked(startSubprocessMonitor).mock.calls[0][0];
    expect(callArg.rootPid).toBe(99);
    expect(callArg.rules).toEqual([{ match: 'pnpm test', timeoutSeconds: 60 }]);
  });

  test('does not start monitor when subprocessMonitor.rules is empty', async () => {
    setupSuccessfulSpawn();

    const timConfig = {
      subprocessMonitor: {
        rules: [],
      },
    } as any;

    await executeCodexStep('prompt', '/tmp', timConfig);

    expect(vi.mocked(startSubprocessMonitor)).not.toHaveBeenCalled();
  });

  test('does not start monitor when subprocessMonitor is not configured', async () => {
    setupSuccessfulSpawn();

    await executeCodexStep('prompt', '/tmp', {} as any);

    expect(vi.mocked(startSubprocessMonitor)).not.toHaveBeenCalled();
  });

  test('stops monitor in finally block even when codex fails', async () => {
    const mockStop = vi.fn();
    vi.mocked(startSubprocessMonitor).mockReturnValue({ stop: mockStop });

    vi.mocked(spawnAndLogOutput).mockImplementation(async (_args: string[], opts: any) => {
      opts?.onSpawn?.(55);
      return { exitCode: 1, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    vi.mocked(createCodexStdoutFormatter).mockReturnValue({
      formatChunk: () => '',
      getFinalAgentMessage: () => undefined,
      getFailedAgentMessage: () => undefined,
      getThreadId: () => undefined,
      getSessionId: () => undefined,
    } as any);

    const timConfig = {
      subprocessMonitor: {
        rules: [{ match: 'pnpm test', timeoutSeconds: 60 }],
      },
    } as any;

    // Three failed attempts but monitor stop should be called each attempt
    await expect(executeCodexStep('prompt', '/tmp', timConfig)).rejects.toThrow(
      /failed after 3 attempts/i
    );

    // stop() should be called once per attempt (3 retries)
    expect(mockStop).toHaveBeenCalledTimes(3);
  });

  test('passes pollIntervalSeconds to monitor when configured', async () => {
    setupSuccessfulSpawn(77);

    const timConfig = {
      subprocessMonitor: {
        pollIntervalSeconds: 10,
        rules: [{ match: 'vitest run', timeoutSeconds: 300 }],
      },
    } as any;

    await executeCodexStep('prompt', '/tmp', timConfig);

    expect(vi.mocked(startSubprocessMonitor)).toHaveBeenCalledOnce();
    const callArg = vi.mocked(startSubprocessMonitor).mock.calls[0][0];
    expect(callArg.pollIntervalSeconds).toBe(10);
  });
});
