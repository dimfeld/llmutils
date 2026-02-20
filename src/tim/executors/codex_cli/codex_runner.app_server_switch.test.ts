import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('executeCodexStep app-server switch', () => {
  let moduleMocker: ModuleMocker;
  const originalEnv = process.env.CODEX_USE_APP_SERVER;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
    delete process.env.CODEX_USE_APP_SERVER;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalEnv;
    }
    moduleMocker.clear();
  });

  test('routes to app-server runner when CODEX_USE_APP_SERVER is unset (default enabled)', async () => {
    const appServerRunnerMock = mock(async () => 'from app server');
    const spawnMock = mock(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    }));

    await moduleMocker.mock('./app_server_runner.ts', () => ({
      executeCodexStepViaAppServer: appServerRunnerMock,
    }));

    await moduleMocker.mock('../../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../../../logging.ts', () => ({
      debugLog: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => true),
    }));

    await moduleMocker.mock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async () => ({ close: mock(() => {}) })),
    }));

    await moduleMocker.mock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: mock(() => mock(() => {})),
    }));

    await moduleMocker.mock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    await moduleMocker.mock('./format.ts', () => ({
      createCodexStdoutFormatter: mock(() => ({
        formatChunk: mock(() => ''),
        getFinalAgentMessage: mock(() => 'unused'),
        getFailedAgentMessage: mock(() => undefined),
        getThreadId: mock(() => 'thread-1'),
        getSessionId: mock(() => 'session-1'),
      })),
    }));

    const { executeCodexStep } = await import(
      `./codex_runner.ts?test=${Date.now()}-${Math.random()}`
    );

    const output = await executeCodexStep('prompt', '/repo', {} as any, { model: 'gpt-5' });

    expect(output).toBe('from app server');
    expect(appServerRunnerMock).toHaveBeenCalledTimes(1);
    expect(appServerRunnerMock.mock.calls[0]?.[3]).toMatchObject({ model: 'gpt-5' });
    expect(spawnMock).toHaveBeenCalledTimes(0);
  });

  test('uses codex exec path when CODEX_USE_APP_SERVER is explicitly disabled', async () => {
    const appServerRunnerMock = mock(async () => 'from app server');
    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('{"type":"noop"}');
      }

      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      };
    });

    await moduleMocker.mock('./app_server_runner.ts', () => ({
      executeCodexStepViaAppServer: appServerRunnerMock,
    }));

    await moduleMocker.mock('../../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../../../logging.ts', () => ({
      debugLog: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: mock(() => true),
    }));

    await moduleMocker.mock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: mock(async () => ({ close: mock(() => {}) })),
    }));

    await moduleMocker.mock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: mock(() => mock(() => {})),
    }));

    await moduleMocker.mock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    await moduleMocker.mock('./format.ts', () => ({
      createCodexStdoutFormatter: mock(() => ({
        formatChunk: mock(() => ''),
        getFinalAgentMessage: mock(() => 'from exec'),
        getFailedAgentMessage: mock(() => undefined),
        getThreadId: mock(() => 'thread-1'),
        getSessionId: mock(() => 'session-1'),
      })),
    }));

    process.env.CODEX_USE_APP_SERVER = 'false';

    const { executeCodexStep } = await import(
      `./codex_runner.ts?test=${Date.now()}-${Math.random()}`
    );

    const output = await executeCodexStep('prompt', '/repo', {} as any, { model: 'gpt-5' });

    expect(output).toBe('from exec');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0]?.[0] as string[];
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
    expect(appServerRunnerMock).toHaveBeenCalledTimes(0);
  });
});
