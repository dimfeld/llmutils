import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';

// Top-level mock functions for ./streaming_input.ts - defined with vi.hoisted so they are
// available when vi.mock() factory runs (which is hoisted to the top of the file)
const { mockSendInitialPrompt, mockSendFollowUpMessage } = vi.hoisted(() => ({
  mockSendInitialPrompt: vi.fn(),
  mockSendFollowUpMessage: vi.fn(),
}));

const { mockLoggerAdapter, FakeTunnelAdapter, FakeHeadlessAdapter } = vi.hoisted(() => {
  class FakeTunnelAdapter {
    userInputHandler: ((content: string) => void) | undefined;

    setUserInputHandler(callback: ((content: string) => void) | undefined): void {
      this.userInputHandler = callback;
    }
  }

  class FakeHeadlessAdapter {
    userInputHandler: ((content: string) => void) | undefined;
    endSessionHandler: (() => void) | undefined;
    forceEndSessionHandler: (() => void) | undefined;

    setUserInputHandler(callback: ((content: string) => void) | undefined): void {
      this.userInputHandler = callback;
    }

    setEndSessionHandler(callback: (() => void) | undefined): void {
      this.endSessionHandler = callback;
    }

    setForceEndSessionHandler(callback: (() => void) | undefined): void {
      this.forceEndSessionHandler = callback;
    }
  }

  return {
    mockLoggerAdapter: { current: {} as unknown },
    FakeTunnelAdapter,
    FakeHeadlessAdapter,
  };
});

vi.mock('./streaming_input.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming_input.js')>();
  return {
    ...actual,
    sendInitialPrompt: mockSendInitialPrompt,
    sendFollowUpMessage: mockSendFollowUpMessage,
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
  getLoggerAdapter: () => mockLoggerAdapter.current,
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  TunnelAdapter: FakeTunnelAdapter,
}));

vi.mock('../../../logging/headless_adapter.js', () => ({
  HeadlessAdapter: FakeHeadlessAdapter,
}));

const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');

function makeStreaming(
  overrides: Partial<{
    stdinEnd: () => Promise<void>;
    result: Promise<SpawnAndLogOutputResult>;
  }> = {}
): StreamingProcess {
  return {
    stdin: {
      write: vi.fn(() => 0),
      end: overrides.stdinEnd ?? vi.fn(async () => {}),
    },
    result:
      overrides.result ??
      Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      } as SpawnAndLogOutputResult),
    kill: vi.fn(() => {}),
  } as unknown as StreamingProcess;
}

type TerminalInputReaderOpts = {
  onLine?: (line: string) => void;
  onCloseWhileActive?: () => void;
  onError?: (err: Error) => void;
};

function makeController(
  opts: {
    terminalInputEnabled?: boolean;
    tunnelForwardingEnabled?: boolean;
    keepInteractiveInputOpenOnResult?: boolean;
    pendingResult?: Promise<SpawnAndLogOutputResult>;
    readerFactory?: (options: TerminalInputReaderOpts) => {
      start: () => boolean;
      stop: () => void;
    };
  } = {}
): {
  controller: ReturnType<typeof executeWithTerminalInput>;
  stdinEndSpy: ReturnType<typeof vi.fn>;
} {
  const terminalInputEnabled = opts.terminalInputEnabled ?? true;
  const tunnelForwardingEnabled = opts.tunnelForwardingEnabled ?? false;
  const stdinEndSpy = vi.fn(async () => {});

  if (terminalInputEnabled) {
    mockTerminalInputReaderFactory =
      opts.readerFactory ??
      ((_: TerminalInputReaderOpts) => ({
        start: () => true as boolean,
        stop: () => {},
      }));
  }

  const controller = executeWithTerminalInput({
    streaming: makeStreaming({
      stdinEnd: stdinEndSpy,
      ...(opts.pendingResult !== undefined ? { result: opts.pendingResult } : {}),
    }),
    prompt: 'initial prompt',
    sendStructured: vi.fn(() => {}),
    debugLog: vi.fn(() => {}),
    errorLog: vi.fn(() => {}),
    log: vi.fn(() => {}),
    label: 'Claude',
    terminalInputEnabled,
    tunnelForwardingEnabled,
    keepInteractiveInputOpenOnResult: opts.keepInteractiveInputOpenOnResult,
  });

  return { controller, stdinEndSpy };
}

describe('terminal_input_lifecycle - background activity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoggerAdapter.current = {};
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('non-interactive runs stay open for active background tasks and close after drain grace', () => {
    vi.useFakeTimers();
    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });
    vi.advanceTimersByTime(9_999);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('display-only task backgrounding does not remove task from active set or trigger close', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    // Backgrounding is display-only and does not emit an actionable lifecycle signal.
    controller.observeFormattedMessage({ type: 'system' });
    controller.onResultMessage(true);

    // The active task remains active, so stdin stays open.
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(10_000);
    // Still no close — task is still considered active
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.cleanup();
  });

  it('display-only task backgrounding does not clear a pending wakeup', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController();

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({ type: 'system' });

    vi.advanceTimersByTime(10_000);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.cleanup();
  });

  it('SIGTERM while a grace timer is pending cancels the timer and shuts down immediately', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
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

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));
    mockTerminalInputReaderFactory = (_options: TerminalInputReaderOptions) => ({
      start: () => true,
      stop: () => {},
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

    // Start a background task, see the result, then let the task end → starts grace timer
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });

    // Grace timer is now running; stdin not yet closed
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Fire SIGTERM — must close immediately and cancel the grace timer
    const sigtermHandler = listeners.get('SIGTERM');
    sigtermHandler?.();

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    // Advance past the grace window — grace timer was cancelled, no double-close
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
    onSpy.mockRestore();
    offSpy.mockRestore();
  });

  it('keeps stdin open after result while a background task is active, then closes after grace', () => {
    vi.useFakeTimers();
    const stopSpy = vi.fn(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      readerFactory: (_: TerminalInputReaderOpts) => ({
        start: () => true,
        stop: () => {
          stopSpy();
        },
      }),
    });

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(stopSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });
    vi.advanceTimersByTime(9_999);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('resets a pending wakeup on new turn activity and closes after the final grace window', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController();

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({ type: 'assistant' });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('keeps a pending wakeup after a background task ends until real turn activity arrives', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });

    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({ type: 'assistant' });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('parse_error and debug messages do not cancel a pending grace timer', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });

    vi.advanceTimersByTime(5_000);
    controller.observeFormattedMessage({ type: 'system' });
    controller.observeFormattedMessage({ type: 'system' });

    vi.advanceTimersByTime(4_999);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('parse_error and debug messages do not clear a pending wakeup', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);

    controller.observeFormattedMessage({ type: 'system' });
    controller.observeFormattedMessage({ type: 'system' });
    controller.onResultMessage(true);

    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.observeFormattedMessage({ type: 'assistant' });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('cancels a pending grace timer during cleanup', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });

    controller.cleanup();
    vi.advanceTimersByTime(10_000);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
  });

  it('non-interactive: wakeup_scheduled keeps stdin open, turn_activity + final result closes after grace', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    // Wakeup scheduled: result must not close
    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Wakeup "fires" — new turn activity resets wakeupPending
    controller.observeFormattedMessage({ type: 'assistant' });

    // Final result: no pending activity, but everDeferred → grace timer
    controller.onResultMessage(true);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(9_999);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('follow-up interception clears accepted final result before a continuation finishes', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.sendFollowUpForInterceptedResult('follow up');

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('interactive keep-open clears accepted final result after terminal follow-up input is sent', () => {
    let onLine: ((line: string) => void) | undefined;

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      keepInteractiveInputOpenOnResult: true,
      readerFactory: (options: TerminalInputReaderOpts) => {
        onLine = options.onLine;
        return {
          start: () => true,
          stop: () => {},
        };
      },
    });

    controller.onResultMessage(true);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    onLine?.('continue from terminal');

    expect(mockSendFollowUpMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'continue from terminal'
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('interactive keep-open does not accept a successful result while a task is pending', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      keepInteractiveInputOpenOnResult: true,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });
    vi.advanceTimersByTime(9_999);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    vi.advanceTimersByTime(1);

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    controller.cleanup();
  });

  it('interactive keep-open does not accept a successful result while a wakeup is pending', () => {
    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      keepInteractiveInputOpenOnResult: true,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.observeFormattedMessage({ type: 'assistant' });
    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    controller.cleanup();
  });

  it('interactive keep-open clears accepted final result after tunnel follow-up input is sent', () => {
    const tunnelAdapter = new FakeTunnelAdapter();
    mockLoggerAdapter.current = tunnelAdapter;

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
      keepInteractiveInputOpenOnResult: true,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.onResultMessage(true);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    tunnelAdapter.userInputHandler?.('continue from tunnel');

    expect(mockSendFollowUpMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'continue from tunnel'
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('interactive keep-open clears accepted final result after headless follow-up input is sent', () => {
    const headlessAdapter = new FakeHeadlessAdapter();
    mockLoggerAdapter.current = headlessAdapter;

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      keepInteractiveInputOpenOnResult: true,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.onResultMessage(true);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    headlessAdapter.userInputHandler?.('continue from headless');

    expect(mockSendFollowUpMessage).toHaveBeenCalledWith(
      expect.any(Object),
      'continue from headless'
    );
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('interactive headless keep-open closes stdin only when the session is ended', () => {
    const headlessAdapter = new FakeHeadlessAdapter();
    mockLoggerAdapter.current = headlessAdapter;

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      keepInteractiveInputOpenOnResult: true,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.onResultMessage(true);

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    headlessAdapter.endSessionHandler?.();

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
  });

  it('task_started after an accepted interactive result clears accepted final result', () => {
    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      keepInteractiveInputOpenOnResult: true,
    });

    controller.onResultMessage(true);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('fast no-op retry interception clears accepted final result before the retry finishes', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.sendFollowUpForInterceptedResult('continue');

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('wakeup resume clears stale successful result until the resumed turn has a final result', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({ type: 'assistant' });

    expect(stdinEndSpy).toHaveBeenCalledTimes(0);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.cleanup();
  });

  it('deferred task drain accepts a successful result only when grace closes stdin', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController({
      terminalInputEnabled: false,
      pendingResult: new Promise<SpawnAndLogOutputResult>(() => {}),
    });

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });
    vi.advanceTimersByTime(10_000);

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(controller.acceptedSuccessfulFinalResult()).toBe(true);

    controller.cleanup();
  });

  it('non-interactive: SIGTERM while a grace timer is pending cancels it and shuts down immediately', () => {
    vi.useFakeTimers();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
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
    const pendingResult = new Promise<SpawnAndLogOutputResult>(() => {});

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));

    const streaming = makeStreaming({ stdinEnd: stdinEndSpy, result: pendingResult });
    (streaming as any).kill = killSpy;

    const controller = executeWithTerminalInput({
      streaming,
      prompt: 'initial prompt',
      sendStructured: vi.fn(() => {}),
      debugLog: vi.fn(() => {}),
      errorLog: vi.fn(() => {}),
      log: vi.fn(() => {}),
      label: 'Claude',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: false,
    });

    // Background task starts, result arrives, task ends → grace timer running
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_started', taskId: 'task-1' },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'task_stopped', taskId: 'task-1' },
    });
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // SIGTERM must cancel the grace timer and shut down immediately
    const sigtermHandler = listeners.get('SIGTERM');
    sigtermHandler?.();

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(controller.acceptedSuccessfulFinalResult()).toBe(false);

    // Advancing past the grace window must not trigger a double-close
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);

    controller.cleanup();
    onSpy.mockRestore();
    offSpy.mockRestore();
  });

  it('task_progress system message does not reset a pending wakeup (not a turn_activity signal)', () => {
    vi.useFakeTimers();

    mockSendInitialPrompt.mockImplementation(vi.fn(() => {}));
    mockSendFollowUpMessage.mockImplementation(vi.fn(() => {}));

    const { controller, stdinEndSpy } = makeController();

    // Schedule a wakeup — wakeupPending = true
    controller.observeFormattedMessage({
      type: 'assistant',
      backgroundActivity: { kind: 'wakeup_scheduled' },
    });
    controller.onResultMessage(true);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    // Emit a task_progress system message — must NOT reset wakeupPending
    // (type is 'system', no backgroundActivity field)
    controller.observeFormattedMessage({ type: 'system' });

    // Wakeup is still pending: advancing past the grace window must not close
    vi.advanceTimersByTime(10_000);
    expect(stdinEndSpy).toHaveBeenCalledTimes(0);

    controller.cleanup();
  });
});
