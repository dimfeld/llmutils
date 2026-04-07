import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const realFs = await importOriginal<typeof import('node:fs')>();
  return {
    ...realFs,
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    closeSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

import {
  spawnAgentProcess,
  spawnChatProcess,
  spawnFinishProcess,
  spawnGenerateProcess,
  spawnRebaseProcess,
} from './plan_actions.js';

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
    vi.mocked(fs.mkdirSync).mockImplementation(() => {});
    vi.mocked(fs.openSync).mockReturnValue(7);
    vi.mocked(fs.closeSync).mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
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

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnSpy.mock.calls[0];
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(options.stdout).toEqual(expect.any(Number));
    expect(options.stderr).toEqual(expect.any(Number));
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnGenerateProcess returns stderr when the process exits during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
      stderrText: 'command not found',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);
    vi.mocked(fs.readFileSync).mockReturnValue('command not found' as never);

    const resultPromise = spawnGenerateProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim generate exited early with code 1',
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

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnSpy.mock.calls[0];
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(options.stdout).toEqual(expect.any(Number));
    expect(options.stderr).toEqual(expect.any(Number));
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnAgentProcess returns stderr when the process exits during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
      stderrText: 'command not found',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);
    vi.mocked(fs.readFileSync).mockReturnValue('command not found' as never);

    const resultPromise = spawnAgentProcess(190, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim agent exited early with code 1',
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

  test('spawnChatProcess starts tim chat in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnChatProcess(189, '/tmp/primary-workspace', 'codex');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [, options] = spawnSpy.mock.calls[0];
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(options.stdout).toEqual(expect.any(Number));
    expect(options.stderr).toEqual(expect.any(Number));
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnChatProcess returns stderr when the process exits during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
      stderrText: 'command not found',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnChatProcess(190, '/tmp/primary-workspace', 'claude');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim chat exited early with code 1',
    });
  });

  test('spawnChatProcess falls back to the exit code when early exit has no stderr', async () => {
    const proc = createFakeProcess({
      exitCode: 127,
      stderrText: '',
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnChatProcess(190, '/tmp/primary-workspace', 'claude');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim chat exited early with code 127',
    });
  });

  test('spawnChatProcess returns a spawn error when Bun.spawn throws', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await spawnChatProcess(191, '/tmp/primary-workspace', 'claude');

    expect(result).toEqual({
      success: false,
      error: 'Failed to start tim chat: Error: spawn failed',
    });
  });

  test('spawnRebaseProcess starts tim rebase in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnRebaseProcess(200, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'rebase', '200', '--auto-workspace', '--no-terminal-input']);
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 200 });
  });

  test('spawnRebaseProcess returns earlyExit true when process exits with code 0 during the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: 0 });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnRebaseProcess(201, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(result).toEqual({ success: true, planId: 201, earlyExit: true });
  });

  test('spawnRebaseProcess returns error when the process exits with non-zero during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnRebaseProcess(202, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: 'tim rebase exited early with code 1',
    });
  });

  test('spawnRebaseProcess returns a spawn error when Bun.spawn throws', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await spawnRebaseProcess(203, '/tmp/primary-workspace');

    expect(result).toEqual({
      success: false,
      error: 'Failed to start tim rebase: Error: spawn failed',
    });
  });

  test('spawnFinishProcess starts tim finish in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnFinishProcess(204, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(500);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual([
      'tim',
      'finish',
      '204',
      '--mark-done',
      '--auto-workspace',
      '--no-terminal-input',
    ]);
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 204 });
  });
});
