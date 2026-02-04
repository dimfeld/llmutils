import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('executeCodexStep retries', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('retries when codex exits non-zero and then succeeds', async () => {
    let attempts = 0;
    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('chunk');
      }

      attempts += 1;
      const exitCode = attempts === 1 ? 1 : 0;
      return { exitCode, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    await moduleMocker.mock('../../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../../../logging.ts', () => ({
      error: mock(() => {}),
      warn: mock(() => {}),
      log: mock(() => {}),
    }));

    await moduleMocker.mock('./format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'ok',
        getFailedAgentMessage: () => undefined,
        getThreadId: () => 'thread-123',
        getSessionId: () => undefined,
      }),
    }));

    const { executeCodexStep } = await import('./codex_runner.ts');

    const output = await executeCodexStep('prompt', '/tmp', {} as any);

    expect(output).toBe('ok');
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const firstArgs = spawnMock.mock.calls[0][0] as string[];
    const secondArgs = spawnMock.mock.calls[1][0] as string[];

    expect(firstArgs.slice(-2)).toEqual(['--json', 'prompt']);
    expect(secondArgs.slice(-4)).toEqual(['--json', 'resume', 'thread-123', 'continue']);
  });

  test('stops after three failed attempts when codex keeps exiting', async () => {
    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts?.formatStdout) {
        opts.formatStdout('chunk');
      }
      return { exitCode: 1, stdout: '', stderr: '', signal: null, killedByInactivity: false };
    });

    await moduleMocker.mock('../../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../../../logging.ts', () => ({
      error: mock(() => {}),
      warn: mock(() => {}),
      log: mock(() => {}),
    }));

    await moduleMocker.mock('./format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'never-called',
        getFailedAgentMessage: () => undefined,
        getThreadId: () => 'thread-123',
        getSessionId: () => undefined,
      }),
    }));

    const { executeCodexStep } = await import('./codex_runner.ts');

    await expect(executeCodexStep('prompt', '/tmp', {} as any)).rejects.toThrow(
      /failed after 3 attempts/i
    );

    expect(spawnMock).toHaveBeenCalledTimes(3);
  });
});
