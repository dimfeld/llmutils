import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';

// Top-level mock functions for ./streaming_input.ts - defined with vi.hoisted so they are
// available when vi.mock() factory runs (which is hoisted to the top of the file)
const { mockSendInitialPrompt, mockSendFollowUpMessage } = vi.hoisted(() => ({
  mockSendInitialPrompt: vi.fn(),
  mockSendFollowUpMessage: vi.fn(),
}));

vi.mock('./streaming_input.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming_input.js')>();
  return {
    ...actual,
    sendInitialPrompt: mockSendInitialPrompt,
    sendFollowUpMessage: mockSendFollowUpMessage,
    sendSinglePromptAndWait: vi.fn(),
    closeStdinAndWait: vi.fn(),
    buildSingleUserInputMessageLine: vi.fn((content: string) => content),
  };
});

// Top-level mock for TerminalInputReader - we use a factory pattern
// so we can control behavior per-test via the mockTerminalInputReaderFactory
type TerminalInputReaderOptions = {
  onLine?: (line: string) => void;
  onCloseWhileActive?: () => void;
  onError?: (err: Error) => void;
};

let mockTerminalInputReaderFactory: (options: TerminalInputReaderOptions) => {
  start: () => boolean;
  stop: () => void;
  pause?: () => void;
  resume?: () => void;
};

vi.mock('./terminal_input.ts', () => ({
  TerminalInputReader: class {
    private options: TerminalInputReaderOptions;

    constructor(options: TerminalInputReaderOptions) {
      this.options = options;
    }

    start() {
      return mockTerminalInputReaderFactory
        ? mockTerminalInputReaderFactory(this.options).start()
        : true;
    }

    stop() {
      mockTerminalInputReaderFactory?.(this.options)?.stop();
    }
  },
}));

vi.mock('../../../logging/adapter.js', () => ({
  getLoggerAdapter: () => ({}),
}));

const { executeWithTerminalInput, setupTerminalInput } = await import(
  './terminal_input_lifecycle.ts'
);

function makeStreaming(
  overrides: Partial<{ stdinEnd: () => Promise<void> }> = {}
): StreamingProcess {
  return {
    stdin: {
      write: vi.fn(() => 0),
      end: overrides.stdinEnd ?? vi.fn(async () => {}),
    },
    result: Promise.resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    } as SpawnAndLogOutputResult),
    kill: vi.fn(() => {}),
  } as unknown as StreamingProcess;
}

describe('terminal_input_lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('emits structured user input even when follow-up send fails', async () => {
    const sendInitialPromptSpy = vi.fn(() => {});
    const sendFollowUpMessageSpy = vi.fn(() => {
      throw new Error('write failed');
    });
    const stopSpy = vi.fn(() => {});
    const sendStructuredSpy = vi.fn(() => {});
    const debugLogSpy = vi.fn(() => {});
    const stdinEndSpy = vi.fn(async () => {});

    mockSendInitialPrompt.mockImplementation(sendInitialPromptSpy);
    mockSendFollowUpMessage.mockImplementation(sendFollowUpMessageSpy);

    mockTerminalInputReaderFactory = (options: TerminalInputReaderOptions) => ({
      start: () => {
        options.onLine?.('follow-up');
        return true;
      },
      stop: () => {
        stopSpy();
      },
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming({ stdinEnd: stdinEndSpy }),
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: debugLogSpy,
      onReaderError: vi.fn(() => {}),
    });

    await Promise.resolve();

    expect(controller.started).toBe(true);
    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(
      sendStructuredSpy.mock.calls.some(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].type === 'user_terminal_input' &&
          call[0].source === 'terminal'
      )
    ).toBe(true);
    expect(stopSpy).toHaveBeenCalled();
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(debugLogSpy).toHaveBeenCalled();
  });

  it('awaitAndCleanup does not unreference stdin', async () => {
    const sendInitialPromptSpy = vi.fn(() => {});
    const sendFollowUpMessageSpy = vi.fn(() => {});
    const stopSpy = vi.fn(() => {});
    const stdinEndSpy = vi.fn(async () => {});

    mockSendInitialPrompt.mockImplementation(sendInitialPromptSpy);
    mockSendFollowUpMessage.mockImplementation(sendFollowUpMessageSpy);

    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => true,
      stop: () => stopSpy(),
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming({ stdinEnd: stdinEndSpy }),
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });

    controller.onResultMessage();
    await controller.awaitAndCleanup();

    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
  });

  it('does not send an initial prompt when none is provided', async () => {
    const sendInitialPromptSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(sendInitialPromptSpy);
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => true,
      stop: () => {},
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming(),
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });

    await controller.awaitAndCleanup();

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(0);
  });

  it('closes subprocess stdin when terminal reader closes while active (Ctrl+D)', async () => {
    const stdinEndSpy = vi.fn(async () => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (options: TerminalInputReaderOptions) => ({
      start: () => {
        options.onCloseWhileActive?.();
        return true;
      },
      stop: () => {},
    });

    setupTerminalInput({
      streaming: makeStreaming({ stdinEnd: stdinEndSpy }),
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
  });

  it('logs debug output when closing stdin fails', async () => {
    const debugLogSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => true,
      stop: () => {},
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming({
        stdinEnd: vi.fn(async () => {
          throw new Error('close failed');
        }),
      }),
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: debugLogSpy,
      onReaderError: vi.fn(() => {}),
    });

    controller.onResultMessage();
    await Promise.resolve();

    expect(debugLogSpy).toHaveBeenCalled();
  });

  it('forwards terminal input through tunnel server when provided', async () => {
    const sendStructuredSpy = vi.fn(() => {});
    const sendUserInputSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (options: TerminalInputReaderOptions) => ({
      start: () => {
        options.onLine?.('from terminal');
        return true;
      },
      stop: () => {},
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming(),
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: vi.fn(() => {}),
        sendUserInput: sendUserInputSpy,
      },
    });

    await Promise.resolve();
    await controller.awaitAndCleanup();

    expect(sendStructuredSpy).toHaveBeenCalled();
    expect(sendUserInputSpy).toHaveBeenCalledTimes(1);
    expect(sendUserInputSpy).toHaveBeenCalledWith('from terminal');
  });

  it('keeps reader active when tunnel forwarding throws', async () => {
    const stopSpy = vi.fn(() => {});
    const stdinEndSpy = vi.fn(async () => {});
    const debugLogSpy = vi.fn(() => {});
    const sendStructuredSpy = vi.fn(() => {});
    const sendFollowUpMessageSpy = vi.fn(() => {});
    const sendUserInputSpy = vi.fn(() => {
      throw new Error('tunnel write failed');
    });

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(sendFollowUpMessageSpy);

    mockTerminalInputReaderFactory = (options: TerminalInputReaderOptions) => ({
      start: () => {
        options.onLine?.('forward me');
        return true;
      },
      stop: () => stopSpy(),
    });

    const controller = setupTerminalInput({
      streaming: makeStreaming({ stdinEnd: stdinEndSpy }),
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: debugLogSpy,
      onReaderError: vi.fn(() => {}),
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: vi.fn(() => {}),
        sendUserInput: sendUserInputSpy,
      },
    });

    await Promise.resolve();
    await controller.awaitAndCleanup();

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendUserInputSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(debugLogSpy).toHaveBeenCalled();
    expect(
      sendStructuredSpy.mock.calls.some(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].type === 'user_terminal_input' &&
          call[0].source === 'terminal'
      )
    ).toBe(true);
  });

  it('ignores deferred onLine writes once stdin has been closed', async () => {
    let onLine: ((line: string) => void) | undefined;
    const sendFollowUpMessageSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(sendFollowUpMessageSpy);

    mockTerminalInputReaderFactory = (options: TerminalInputReaderOptions) => {
      onLine = options.onLine;
      return {
        start: () => true,
        stop: () => {},
      };
    };

    const controller = setupTerminalInput({
      streaming: makeStreaming(),
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });

    controller.onResultMessage();
    onLine?.('late message');
    await controller.awaitAndCleanup();

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(0);
  });

  it('creates and cleans up terminal input lifecycle independently across sequential runs', async () => {
    let startCalls = 0;
    let stopCalls = 0;

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => {
        startCalls++;
        return true;
      },
      stop: () => {
        stopCalls++;
      },
    });

    const first = setupTerminalInput({
      streaming: makeStreaming(),
      prompt: 'first',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });
    await first.awaitAndCleanup();

    const second = setupTerminalInput({
      streaming: makeStreaming(),
      prompt: 'second',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      onReaderError: vi.fn(() => {}),
    });
    await second.awaitAndCleanup();

    expect(startCalls).toBe(2);
    expect(stopCalls).toBe(2);
  });

  it('SIGTERM tears down an active executor session immediately', async () => {
    const listeners = new Map<string, (...args: any[]) => unknown>();
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, listener: any) => {
      listeners.set(event, listener);
      return process;
    }) as typeof process.on);
    const offSpy = vi.spyOn(process, 'off').mockImplementation(((event: string) => {
      listeners.delete(event);
      return process;
    }) as typeof process.off);

    const stdinEndSpy = vi.fn(async () => {});
    const killSpy = vi.fn(() => {});
    const stopSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => true,
      stop: () => {
        stopSpy();
      },
    });

    const streaming = makeStreaming({ stdinEnd: stdinEndSpy });
    (streaming as any).kill = killSpy;

    const controller = executeWithTerminalInput({
      streaming,
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      errorLog: vi.fn(() => {}),
      log: vi.fn(() => {}),
      label: 'Claude',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    const sigtermHandler = listeners.get('SIGTERM');
    expect(sigtermHandler).toEqual(expect.any(Function));

    sigtermHandler?.();

    expect(stopSpy).toHaveBeenCalled();
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');

    controller.cleanup();

    expect(offSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });
});
