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

import { spawnAndLogOutput } from '../../../common/process.js';
import { createCodexStdoutFormatter } from './format.js';
import { executeCodexStep } from './codex_runner.js';

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
