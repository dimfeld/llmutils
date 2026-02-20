import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TimConfig } from '../configSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleChatCommand', () => {
  const loadEffectiveConfigSpy = mock(async () => ({
    defaultExecutor: undefined,
    terminalInput: true,
  }));
  const isTunnelActiveSpy = mock(() => false);
  const mockExecutorExecute = mock(async () => {});
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };
  const buildExecutorAndLogSpy = mock(() => mockExecutor);
  const runWithHeadlessAdapterIfEnabledSpy = mock(async (options: any) => options.callback());

  const originalStdinIsTTY = process.stdin.isTTY;
  const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;

  beforeEach(async () => {
    moduleMocker.clear();

    loadEffectiveConfigSpy.mockClear();
    isTunnelActiveSpy.mockClear();
    mockExecutorExecute.mockClear();
    buildExecutorAndLogSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockClear();

    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: undefined,
      terminalInput: true,
    }));
    isTunnelActiveSpy.mockImplementation(() => false);
    delete process.env.CODEX_USE_APP_SERVER;

    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../headless.js', () => ({
      runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
    }));

    await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
      isTunnelActive: isTunnelActiveSpy,
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'claude-code',
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalStdinIsTTY,
      configurable: true,
    });
    if (originalCodexUseAppServer == null) {
      delete process.env.CODEX_USE_APP_SERVER;
    } else {
      process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
    }
  });

  test('defaults to claude-code executor and enables terminal input', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Help me debug this', {}, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      closeTerminalInputOnResult: false,
      noninteractive: undefined,
    });
  });

  test('passes --model through to shared executor options for claude', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Help me debug this', { model: 'sonnet' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      model: 'sonnet',
    });
  });

  test('passes prompt through to executor in bare mode', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Initial prompt', {}, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('Initial prompt');
    expect(mockExecutorExecute.mock.calls[0][1]).toEqual({
      planId: 'chat',
      planTitle: 'Chat Session',
      planFilePath: '',
      executionMode: 'bare',
    });
  });

  test('allows starting without an initial prompt when terminal input is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand(undefined, {}, {});

    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('wraps execution in the headless adapter with the chat command type', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
      callback: expect.any(Function),
    });
  });

  test('disables headless adapter wrapping when tunnel is already active', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: false,
      command: 'chat',
    });
  });

  test('forces headless adapter wrapping when tunnel is active and --headless-adapter is set', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await handleChatCommand('hello', { headlessAdapter: true }, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0]).toMatchObject({
      enabled: true,
      command: 'chat',
    });
  });

  test('throws when there is no prompt and non-interactive mode is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand(undefined, { nonInteractive: true }, {})).rejects.toThrow(
      'No input provided. Pass a prompt argument, --prompt-file, or stdin when running without terminal input.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('allows no prompt in non-interactive mode when tunnel forwarding is active', async () => {
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await expect(
      handleChatCommand(undefined, { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBeUndefined();
  });

  test('rejects codex-cli without an explicit prompt when app-server mode is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand(undefined, { executor: 'codex-cli' }, {})).rejects.toThrow(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('allows codex-cli without an explicit prompt when app-server mode is enabled', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli' }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('');
  });

  test('accepts codex alias and keeps terminal input forwarding in default mode', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Summarize this repository', { executor: 'codex' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: true,
      noninteractive: undefined,
      closeTerminalInputOnResult: false,
    });
    expect(mockExecutorExecute).toHaveBeenCalledTimes(1);
    expect(mockExecutorExecute.mock.calls[0][0]).toBe('Summarize this repository');
  });

  test('passes --model through to shared executor options for codex', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('Summarize this repository', { executor: 'codex', model: 'gpt-5' }, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      model: 'gpt-5',
    });
  });

  test('rejects codex-cli when tunnel is active without an initial prompt and app-server is disabled', async () => {
    process.env.CODEX_USE_APP_SERVER = 'false';
    const { handleChatCommand } = await import('./chat.js');
    isTunnelActiveSpy.mockImplementation(() => true);

    await expect(
      handleChatCommand(undefined, { executor: 'codex-cli', nonInteractive: true }, {})
    ).rejects.toThrow(
      'codex-cli requires an explicit prompt. Provide a prompt via argument, --prompt-file, or stdin.'
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('uses configured default executor when provided', async () => {
    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: 'codex-cli',
      terminalInput: true,
    }));

    const { handleChatCommand } = await import('./chat.js');

    await expect(
      handleChatCommand('Prompt text', { nonInteractive: true }, {})
    ).resolves.toBeUndefined();

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('codex-cli');
    expect(buildExecutorAndLogSpy.mock.calls[0][1]).toMatchObject({
      terminalInput: false,
      noninteractive: true,
      closeTerminalInputOnResult: false,
    });
  });

  test('throws when --executor is an incompatible executor', async () => {
    const { handleChatCommand } = await import('./chat.js');

    await expect(handleChatCommand('hello', { executor: 'copy-only' }, {})).rejects.toThrow(
      "Executor 'copy-only' is not supported by 'tim chat'"
    );

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(0);
    expect(mockExecutorExecute).toHaveBeenCalledTimes(0);
  });

  test('falls back to claude-code when config defaultExecutor is incompatible', async () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    loadEffectiveConfigSpy.mockImplementation(async () => ({
      defaultExecutor: 'copy-only',
      terminalInput: true,
    }));

    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(buildExecutorAndLogSpy).toHaveBeenCalledTimes(1);
    expect(buildExecutorAndLogSpy.mock.calls[0][0]).toBe('claude-code');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("defaultExecutor 'copy-only' is not supported");

    console.warn = originalWarn;
  });

  test('passes the loaded config through to the headless adapter', async () => {
    const config: Partial<TimConfig> = {
      defaultExecutor: 'claude-code',
      terminalInput: true,
    };
    loadEffectiveConfigSpy.mockImplementation(async () => config);

    const { handleChatCommand } = await import('./chat.js');

    await handleChatCommand('hello', {}, {});

    expect(runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0].config).toBe(config);
  });
});

describe('resolveOptionalPromptText', () => {
  test('returns positional prompt with tty stdin', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { stdinIsTTY: true },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-arg');
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('prefers positional prompt over stdin in non-tty mode when no prompt file is provided', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { stdinIsTTY: false },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-arg');
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('reads stdin in non-tty mode when no positional prompt or prompt file is provided', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      undefined,
      { stdinIsTTY: false, tunnelActive: false },
      {
        readStdin,
      }
    );

    expect(prompt).toBe('from-stdin');
    expect(readStdin).toHaveBeenCalledTimes(1);
  });

  test('skips stdin in non-tty mode when tunnel forwarding is active', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');
    const readStdin = mock(async () => 'from-stdin');

    const prompt = await resolveOptionalPromptText(
      undefined,
      { stdinIsTTY: false, tunnelActive: true },
      {
        readStdin,
      }
    );

    expect(prompt).toBeUndefined();
    expect(readStdin).toHaveBeenCalledTimes(0);
  });

  test('prompt file overrides positional prompt', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { promptFile: 'prompt.txt', stdinIsTTY: false },
      {
        readFile: async () => 'from-file',
        readStdin: async () => 'from-stdin',
      }
    );

    expect(prompt).toBe('from-file');
  });

  test('returns undefined for whitespace-only prompt file and does not fall back to positional prompt', async () => {
    const { resolveOptionalPromptText } = await import('./chat.js');

    const prompt = await resolveOptionalPromptText(
      'from-arg',
      { promptFile: 'prompt.txt', stdinIsTTY: true },
      {
        readFile: async () => '   \n\t  ',
      }
    );

    expect(prompt).toBeUndefined();
  });
});
