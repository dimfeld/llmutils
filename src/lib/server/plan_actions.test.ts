import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { spawnAgentProcess, spawnGenerateProcess } from './plan_actions.js';

interface FakeSubprocess {
  exitCode: number | null;
  stderr: ReadableStream<Uint8Array> | null;
  unref: ReturnType<typeof vi.fn>;
}

function createTextStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function createFakeProcess(options: {
  exitCode: number | null;
  stderrText?: string;
}): FakeSubprocess {
  return {
    exitCode: options.exitCode,
    stderr: options.stderrText ? createTextStream(options.stderrText) : createTextStream(''),
    unref: vi.fn(),
  };
}

describe('lib/server/plan_actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('spawnGenerateProcess starts tim generate in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledWith(
      ['tim', 'generate', '189', '--auto-workspace', '--no-terminal-input'],
      expect.objectContaining({
        cwd: '/tmp/primary-workspace',
        env: process.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        detached: true,
      })
    );
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnGenerateProcess returns stderr when the process exits during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
      stderrText: 'command not found',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'command not found',
    });
  });

  test('spawnGenerateProcess falls back to the exit code when early exit has no stderr', async () => {
    const proc = createFakeProcess({
      exitCode: 127,
      stderrText: '',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim generate exited early with code 127',
    });
  });

  test('spawnGenerateProcess returns a spawn error when Bun.spawn throws', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await spawnGenerateProcess(191, '/tmp/primary-workspace');

    expect(result).toEqual({
      success: false,
      error: 'Failed to start tim generate: Error: spawn failed',
    });
  });

  test('spawnAgentProcess starts tim agent in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnAgentProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledWith(
      ['tim', 'agent', '189', '--auto-workspace', '--no-terminal-input'],
      expect.objectContaining({
        cwd: '/tmp/primary-workspace',
        env: process.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
        detached: true,
      })
    );
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnAgentProcess returns stderr when the process exits during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
      stderrText: 'command not found',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnAgentProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'command not found',
    });
  });

  test('spawnAgentProcess falls back to the exit code when early exit has no stderr', async () => {
    const proc = createFakeProcess({
      exitCode: 127,
      stderrText: '',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnAgentProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim agent exited early with code 127',
    });
  });

  test('spawnAgentProcess returns a spawn error when Bun.spawn throws', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await spawnAgentProcess(191, '/tmp/primary-workspace');

    expect(result).toEqual({
      success: false,
      error: 'Failed to start tim agent: Error: spawn failed',
    });
  });
});
