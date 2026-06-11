import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', async (importOriginal) => {
  const realFs = await importOriginal<typeof import('node:fs')>();
  const mockedFs = {
    ...realFs,
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    closeSync: vi.fn(),
    readFileSync: vi.fn(),
  };

  return {
    ...mockedFs,
    default: mockedFs,
  };
});

vi.mock('$common/env.js', () => ({
  buildWorkspaceCommandEnv: vi.fn(async () => ({ PATH: '/usr/bin' })),
}));

import {
  formatLogFileName,
  spawnAgentMultiProcess,
  spawnAgentProcess,
  spawnAutoreviewProcess,
  spawnChatProcess,
  spawnGenerateProcess,
  spawnPrFixForPrProcess,
  spawnRebaseProcess,
  spawnReviewIssuesFixProcess,
  spawnShellProcess,
  spawnUpdateDocsProcess,
} from './plan_actions.js';
import { buildWorkspaceCommandEnv } from '$common/env.js';

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
  const originalTimPath = process.env.TIM_PATH;

  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.TIM_PATH;
    vi.setSystemTime(new Date('2026-04-19T00:00:00.000Z'));
    vi.mocked(fs.mkdirSync).mockImplementation(() => {});
    vi.mocked(fs.openSync).mockReturnValue(7);
    vi.mocked(fs.closeSync).mockImplementation(() => {});
    vi.mocked(fs.readFileSync).mockImplementation(() => '');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalTimPath === undefined) {
      delete process.env.TIM_PATH;
    } else {
      process.env.TIM_PATH = originalTimPath;
    }
    vi.restoreAllMocks();
  });

  test('spawnGenerateProcess starts tim generate in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'generate', '189', '--auto-workspace', '--no-terminal-input']);
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
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(
      '[web-ui] Starting tim generate 189 --auto-workspace --no-terminal-input for plan 189 in /tmp/primary-workspace'
    );
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(
      '[web-ui] Started tim generate 189 --auto-workspace --no-terminal-input for plan 189; waiting 2000ms for early exit'
    );
    expect(vi.mocked(console.info)).toHaveBeenCalledWith(
      '[web-ui] tim generate 189 --auto-workspace --no-terminal-input for plan 189 is running detached'
    );
  });

  test('spawnGenerateProcess uses TIM_PATH as the tim executable when set', async () => {
    process.env.TIM_PATH = '/opt/tim/bin/tim';
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args] = spawnSpy.mock.calls[0];
    expect(args).toEqual([
      '/opt/tim/bin/tim',
      'generate',
      '189',
      '--auto-workspace',
      '--no-terminal-input',
    ]);
    expect(result).toEqual({ success: true, planId: 189 });
  });

  test('spawnGenerateProcess falls back to tim when TIM_PATH is blank', async () => {
    process.env.TIM_PATH = '   ';
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnGenerateProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'generate', '189', '--auto-workspace', '--no-terminal-input']);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    expect(vi.mocked(console.error)).toHaveBeenCalledWith(
      '[web-ui] Failed to start tim generate 191 --auto-workspace --no-terminal-input for plan 191',
      expect.any(Error)
    );
  });

  test('spawnAgentProcess starts tim agent in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnAgentProcess(189, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toEqual({ success: true, planId: 201, earlyExit: true });
  });

  test('spawnRebaseProcess returns error when the process exits with non-zero during the early-exit window', async () => {
    const proc = createFakeProcess({
      exitCode: 1,
    });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnRebaseProcess(202, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
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

  test('spawnUpdateDocsProcess starts tim update-docs in detached mode and unrefs it after the early-exit window', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnUpdateDocsProcess(204, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'update-docs', '204', '--auto-workspace', '--no-terminal-input']);
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(options.env).toBeDefined();
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, planId: 204 });
  });

  test('web-launched shell and autoreview request hidden plan details', async () => {
    vi.mocked(buildWorkspaceCommandEnv).mockResolvedValue({ PATH: '/usr/bin' });
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const shellPromise = spawnShellProcess(205, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(shellPromise).resolves.toEqual({ success: true, planId: 205 });

    const autoreviewPromise = spawnAutoreviewProcess(206, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    await expect(autoreviewPromise).resolves.toEqual({ success: true, planId: 206 });

    expect(spawnSpy.mock.calls[0][0]).toEqual([
      'tim',
      'shell',
      '205',
      '--auto-workspace',
      '--non-interactive',
    ]);
    expect(spawnSpy.mock.calls[1][0]).toEqual(['tim', 'autoreview', '206', '--no-terminal-input']);
    expect(vi.mocked(buildWorkspaceCommandEnv)).toHaveBeenCalledWith('/tmp/primary-workspace', {
      TIM_HIDE_PLAN_DETAILS: '1',
    });
  });

  test('spawnAgentMultiProcess passes the epic plan id to the CLI', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnAgentMultiProcess(300, [301, 302], '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args] = spawnSpy.mock.calls[0];
    expect(args).toEqual([
      'tim',
      'agent-multi',
      '301',
      '302',
      '--epic',
      '300',
      '--no-terminal-input',
      '--non-interactive',
    ]);
    expect(result).toEqual({ success: true, planId: 300 });
  });

  test('formatLogFileName uses planId, timestamp, and command in the expected order', () => {
    const filename = formatLogFileName(189, 'generate', new Date('2026-04-19T00:00:00.000Z'));

    expect(filename).toBe('189-2026-04-19T00-00-00-000Z-generate.log');
  });

  test('spawnPrFixForPrProcess spawns tim pr fix --pr with the PR URL and auto-workspace flags', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const prUrl = 'https://github.com/owner/repo/pull/5';
    const resultPromise = spawnPrFixForPrProcess(prUrl, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual([
      'tim',
      'pr',
      'fix',
      '--pr',
      prUrl,
      '--auto-workspace',
      '--no-terminal-input',
    ]);
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(proc.unref).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true });
    expect((result as { planId?: number }).planId).toBeUndefined();
  });

  test('spawnReviewIssuesFixProcess spawns prompt-driven saved review issue fixer', async () => {
    const proc = createFakeProcess({ exitCode: null });
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnReviewIssuesFixProcess(207, '/tmp/primary-workspace');
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'review-issues', 'fix', '207', '--auto-workspace']);
    expect(options).toMatchObject({
      cwd: '/tmp/primary-workspace',
      stdin: 'ignore',
      detached: true,
    });
    expect(result).toEqual({ success: true, planId: 207 });
  });

  test('spawnPrFixForPrProcess returns earlyExit true when process exits with code 0', async () => {
    const proc = createFakeProcess({ exitCode: 0 });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);

    const resultPromise = spawnPrFixForPrProcess(
      'https://github.com/owner/repo/pull/5',
      '/tmp/primary-workspace'
    );
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(result).toEqual({ success: true, earlyExit: true });
    expect((result as { planId?: number }).planId).toBeUndefined();
  });

  test('spawnPrFixForPrProcess returns error when process exits with non-zero code', async () => {
    const proc = createFakeProcess({ exitCode: 1, stderrText: 'token error' });
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never);
    vi.mocked(fs.readFileSync).mockReturnValue('token error' as never);

    const resultPromise = spawnPrFixForPrProcess(
      'https://github.com/owner/repo/pull/5',
      '/tmp/primary-workspace'
    );
    await vi.advanceTimersByTimeAsync(2000);
    const result = await resultPromise;

    expect(proc.unref).not.toHaveBeenCalled();
    expect(result).toEqual({ success: false, error: 'token error' });
  });

  test('spawnPrFixForPrProcess returns a spawn error when Bun.spawn throws', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation(() => {
      throw new Error('spawn failed');
    });

    const result = await spawnPrFixForPrProcess(
      'https://github.com/owner/repo/pull/5',
      '/tmp/primary-workspace'
    );

    expect(result).toEqual({
      success: false,
      error: 'Failed to start tim pr: Error: spawn failed',
    });
  });
});
