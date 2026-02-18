import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import { ModuleMocker } from '../../../testing.ts';

const moduleMocker = new ModuleMocker(import.meta);

describe('terminal_input_lifecycle', () => {
  beforeEach(() => {
    moduleMocker.clear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  it('emits structured user input even when follow-up send fails', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {
      throw new Error('write failed');
    });
    const stopSpy = mock(() => {});
    const sendStructuredSpy = mock(() => {});
    const debugLogSpy = mock(() => {});
    const stdinEndSpy = mock(async () => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onLine: (line: string) => void;

        constructor(options: { onLine: (line: string) => void }) {
          this.onLine = options.onLine;
        }

        start() {
          this.onLine('follow-up');
          return true;
        }

        stop() {
          stopSpy();
        }
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: stdinEndSpy,
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: debugLogSpy,
      onReaderError: mock(() => {}),
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
    const sendInitialPromptSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {});
    const stopSpy = mock(() => {});
    const stdinEndSpy = mock(async () => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }

        stop() {
          stopSpy();
        }
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: stdinEndSpy,
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });

    controller.onResultMessage();
    await controller.awaitAndCleanup();

    expect(stopSpy).toHaveBeenCalledTimes(2);
    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
  });

  it('does not send an initial prompt when none is provided', async () => {
    const sendInitialPromptSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }

        stop() {}
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });

    await controller.awaitAndCleanup();

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(0);
  });

  it('closes subprocess stdin when terminal reader closes while active (Ctrl+D)', async () => {
    const stdinEndSpy = mock(async () => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onCloseWhileActive?: () => void;

        constructor(options: { onCloseWhileActive?: () => void }) {
          this.onCloseWhileActive = options.onCloseWhileActive;
        }

        start() {
          this.onCloseWhileActive?.();
          return true;
        }

        stop() {}
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: stdinEndSpy,
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });

    expect(stdinEndSpy).toHaveBeenCalledTimes(1);
  });

  it('logs debug output when closing stdin fails', async () => {
    const debugLogSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }

        stop() {}
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {
            throw new Error('close failed');
          }),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: mock(() => {}),
      debugLog: debugLogSpy,
      onReaderError: mock(() => {}),
    });

    controller.onResultMessage();
    await Promise.resolve();

    expect(debugLogSpy).toHaveBeenCalled();
  });

  it('forwards terminal input through tunnel server when provided', async () => {
    const sendStructuredSpy = mock(() => {});
    const sendUserInputSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onLine: (line: string) => void;

        constructor(options: { onLine: (line: string) => void }) {
          this.onLine = options.onLine;
        }

        start() {
          this.onLine('from terminal');
          return true;
        }

        stop() {}
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: mock(() => {}),
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
    const stopSpy = mock(() => {});
    const stdinEndSpy = mock(async () => {});
    const debugLogSpy = mock(() => {});
    const sendStructuredSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {});
    const sendUserInputSpy = mock(() => {
      throw new Error('tunnel write failed');
    });

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onLine: (line: string) => void;

        constructor(options: { onLine: (line: string) => void }) {
          this.onLine = options.onLine;
        }

        start() {
          this.onLine('forward me');
          return true;
        }

        stop() {
          stopSpy();
        }
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: stdinEndSpy,
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: sendStructuredSpy,
      debugLog: debugLogSpy,
      onReaderError: mock(() => {}),
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: mock(() => {}),
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
    const sendFollowUpMessageSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        constructor(options: { onLine: (line: string) => void }) {
          onLine = options.onLine;
        }

        start() {
          return true;
        }

        stop() {}
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const controller = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'initial prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });

    controller.onResultMessage();
    onLine?.('late message');
    await controller.awaitAndCleanup();

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(0);
  });

  it('creates and cleans up terminal input lifecycle independently across sequential runs', async () => {
    let startCalls = 0;
    let stopCalls = 0;

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          startCalls++;
          return true;
        }

        stop() {
          stopCalls++;
        }
      },
    }));

    const { setupTerminalInput } = await import('./terminal_input_lifecycle.ts');

    const first = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'first',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });
    await first.awaitAndCleanup();

    const second = setupTerminalInput({
      streaming: {
        stdin: {
          write: mock(() => 0),
          end: mock(async () => {}),
        },
        result: Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }),
        kill: mock(() => {}),
      } as unknown as StreamingProcess,
      prompt: 'second',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      onReaderError: mock(() => {}),
    });
    await second.awaitAndCleanup();

    expect(startCalls).toBe(2);
    expect(stopCalls).toBe(2);
  });
});

describe('executeWithTerminalInput', () => {
  beforeEach(() => {
    moduleMocker.clear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  function makeStreamingProcess(overrides?: Partial<StreamingProcess>): StreamingProcess {
    return {
      stdin: {
        write: mock(() => 0),
        end: mock(async () => {}),
      },
      result: Promise.resolve({
        exitCode: 0,
        stdout: '',
        stderr: '',
        signal: null,
        killedByInactivity: false,
      }),
      kill: mock(() => {}),
      ...overrides,
    } as unknown as StreamingProcess;
  }

  it('uses terminal input path when terminalInputEnabled is true', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const safeEndStdinSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const logSpy = mock(() => {});
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: logSpy,
      label: 'test',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    await result.resultPromise;

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      'Type a message and press Enter to send input to the agent'
    );
  });

  it('skips initial prompt in terminal input path when no prompt is provided', async () => {
    const sendInitialPromptSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    await result.resultPromise;

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(0);
  });

  it('does not log hint when reader fails to start', async () => {
    const sendInitialPromptSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return false; // Fails to start (e.g., no TTY)
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const logSpy = mock(() => {});
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: logSpy,
      label: 'test',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    await result.resultPromise;

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('uses tunnel forwarding path when tunnelForwardingEnabled is true and terminalInputEnabled is false', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const safeEndStdinSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(() => Promise.resolve());

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    await result.resultPromise;

    // Tunnel path uses sendInitialPrompt, not sendSinglePromptAndWait
    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).not.toHaveBeenCalled();
    // closeStdin is called via the finally of result
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('skips initial prompt in tunnel forwarding path when no prompt is provided', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const safeEndStdinSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    await result.resultPromise;

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(0);
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('uses single prompt path when both flags are false', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }) as Promise<SpawnAndLogOutputResult>
    );

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: false,
    });

    await result.resultPromise;

    expect(sendSinglePromptAndWaitSpy).toHaveBeenCalledTimes(1);
    expect(sendInitialPromptSpy).not.toHaveBeenCalled();
  });

  it('uses headless forwarding path when both flags are false and logger adapter is headless', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const sendSinglePromptAndWaitSpy = mock(
      () =>
        Promise.resolve({
          exitCode: 0,
          stdout: '',
          stderr: '',
          signal: null,
          killedByInactivity: false,
        }) as Promise<SpawnAndLogOutputResult>
    );
    const safeEndStdinSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();
    let resolveResult: ((value: SpawnAndLogOutputResult) => void) | undefined;
    const streamingResult = new Promise<SpawnAndLogOutputResult>((resolve) => {
      resolveResult = resolve;
    });

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: sendSinglePromptAndWaitSpy,
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess({ result: streamingResult });

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: false,
    });

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    expect(sendSinglePromptAndWaitSpy).not.toHaveBeenCalled();
    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(1);
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(0);

    resolveResult?.({
      exitCode: 0,
      stdout: '',
      stderr: '',
      signal: null,
      killedByInactivity: false,
    });
    await result.resultPromise;
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when no prompt is provided and both forwarding modes are disabled', async () => {
    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    expect(() =>
      executeWithTerminalInput({
        streaming,
        sendStructured: mock(() => {}),
        debugLog: mock(() => {}),
        errorLog: mock(() => {}),
        log: mock(() => {}),
        label: 'test',
        terminalInputEnabled: false,
        tunnelForwardingEnabled: false,
      })
    ).toThrow('Prompt is required when terminal input forwarding is disabled');
  });

  it('onResultMessage clears tunnel handler and closes stdin for terminal input path', async () => {
    const safeEndStdinSpy = mock(() => {});
    const stopSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {
          stopSpy();
        }
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    result.onResultMessage();

    // Reader should be stopped and stdin closed
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('onResultMessage closes stdin directly for tunnel forwarding path (no terminal input)', async () => {
    const safeEndStdinSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    result.onResultMessage();

    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('onResultMessage closes stdin for headless forwarding path when both flags are false', async () => {
    const safeEndStdinSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: false,
    });

    result.onResultMessage();
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);

    await result.resultPromise;
  });

  it('onResultMessage does not close stdin when closeOnResultMessage is false', async () => {
    const safeEndStdinSpy = mock(() => {});
    const stopSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {
          stopSpy();
        }
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
      closeOnResultMessage: false,
    });

    result.onResultMessage();

    expect(stopSpy).toHaveBeenCalledTimes(0);
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(0);

    await result.resultPromise;
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(safeEndStdinSpy).toHaveBeenCalledTimes(1);
  });

  it('wires tunnel user input handler when loggerAdapter is TunnelAdapter', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    // Create a mock TunnelAdapter class and a mock instance
    class MockTunnelAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockTunnelAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(
        () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }) as Promise<SpawnAndLogOutputResult>
      ),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: MockTunnelAdapter,
      isTunnelActive: mock(() => true),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    // setUserInputHandler should have been called with a callback
    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(1);
    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;

    // Invoke the handler to simulate tunnel input
    handler('tunnel input message');
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy.mock.calls[0][1]).toBe('tunnel input message');

    await result.resultPromise;
  });

  it('cleanup clears the tunnel user input handler', async () => {
    const setUserInputHandlerSpy = mock(() => {});

    class MockTunnelAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockTunnelAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(
        () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }) as Promise<SpawnAndLogOutputResult>
      ),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: MockTunnelAdapter,
      isTunnelActive: mock(() => true),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    // First call was to set up the handler
    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(1);

    result.cleanup();

    // Second call should clear the handler (pass undefined)
    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(2);
    expect(setUserInputHandlerSpy.mock.calls[1][0]).toBeUndefined();

    await result.resultPromise;
  });

  it('wires headless user input handler and forwards input to subprocess, tunnel, and structured log', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const sendStructuredSpy = mock(() => {});
    const sendUserInputSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(
        () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }) as Promise<SpawnAndLogOutputResult>
      ),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: sendStructuredSpy,
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: mock(() => {}),
        sendUserInput: sendUserInputSpy,
      },
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(1);
    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;
    handler('from headless');

    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy.mock.calls[0][1]).toBe('from headless');
    expect(sendUserInputSpy).toHaveBeenCalledTimes(1);
    expect(sendUserInputSpy).toHaveBeenCalledWith('from headless');
    expect(
      sendStructuredSpy.mock.calls.some(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].type === 'user_terminal_input' &&
          call[0].content === 'from headless' &&
          call[0].source === 'gui'
      )
    ).toBe(true);

    await result.resultPromise;
  });

  it('headless handler forwards input after initial prompt when both flags are false', async () => {
    const sendInitialPromptSpy = mock(() => {});
    const sendFollowUpMessageSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: sendInitialPromptSpy,
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: false,
    });

    expect(sendInitialPromptSpy).toHaveBeenCalledTimes(1);
    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;
    handler('headless follow-up');
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy.mock.calls[0][1]).toBe('headless follow-up');

    await result.resultPromise;
  });

  it('headless user input handler ignores writes once stdin is closed', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const sendStructuredSpy = mock(() => {});
    const sendUserInputSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: sendStructuredSpy,
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: mock(() => {}),
        sendUserInput: sendUserInputSpy,
      },
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;
    result.onResultMessage();
    handler('late headless input');

    expect(sendStructuredSpy).not.toHaveBeenCalled();
    expect(sendFollowUpMessageSpy).not.toHaveBeenCalled();
    expect(sendUserInputSpy).not.toHaveBeenCalled();

    await result.resultPromise;
  });

  it('cleanup clears the headless user input handler', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(
        () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }) as Promise<SpawnAndLogOutputResult>
      ),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(1);
    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;

    result.cleanup();

    expect(setUserInputHandlerSpy).toHaveBeenCalledTimes(2);
    expect(setUserInputHandlerSpy.mock.calls[1][0]).toBeUndefined();

    handler('after cleanup');
    expect(sendFollowUpMessageSpy).not.toHaveBeenCalled();

    await result.resultPromise;
  });

  it('headless handler still forwards input when sendStructured throws', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const sendStructuredSpy = mock(() => {
      throw new Error('structured logging failed');
    });
    const sendUserInputSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});
    const debugLogSpy = mock(() => {});

    class MockHeadlessAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockHeadlessAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(
        () =>
          Promise.resolve({
            exitCode: 0,
            stdout: '',
            stderr: '',
            signal: null,
            killedByInactivity: false,
          }) as Promise<SpawnAndLogOutputResult>
      ),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: MockHeadlessAdapter,
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: sendStructuredSpy,
      debugLog: debugLogSpy,
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      tunnelServer: {
        server: {} as unknown as import('node:net').Server,
        close: mock(() => {}),
        sendUserInput: sendUserInputSpy,
      },
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;
    handler('test input');

    // sendFollowUpMessage and tunnel forwarding should still have been called
    // even though sendStructured throws
    expect(sendFollowUpMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendFollowUpMessageSpy.mock.calls[0][1]).toBe('test input');
    expect(sendUserInputSpy).toHaveBeenCalledTimes(1);
    expect(sendUserInputSpy).toHaveBeenCalledWith('test input');

    // sendStructured was called and threw, debug log should capture it
    expect(sendStructuredSpy).toHaveBeenCalledTimes(1);
    expect(debugLogSpy).toHaveBeenCalled();

    await result.resultPromise;
  });

  it('tunnel handler ignores writes after stdin is closed', async () => {
    const sendFollowUpMessageSpy = mock(() => {});
    const setUserInputHandlerSpy = mock(() => {});
    const safeEndStdinSpy = mock(() => {});

    class MockTunnelAdapter {
      setUserInputHandler = setUserInputHandlerSpy;
    }

    const mockAdapterInstance = new MockTunnelAdapter();

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: sendFollowUpMessageSpy,
      safeEndStdin: safeEndStdinSpy,
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        start() {
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => mockAdapterInstance),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: MockTunnelAdapter,
      isTunnelActive: mock(() => true),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: mock(() => {}),
      debugLog: mock(() => {}),
      errorLog: mock(() => {}),
      log: mock(() => {}),
      label: 'test',
      terminalInputEnabled: false,
      tunnelForwardingEnabled: true,
    });

    const handler = setUserInputHandlerSpy.mock.calls[0][0] as (content: string) => void;

    // Close stdin via onResultMessage
    result.onResultMessage();

    // Now try to send input through the tunnel handler — should be ignored
    handler('late message');
    expect(sendFollowUpMessageSpy).not.toHaveBeenCalled();
  });

  it('emits reader error as workflow progress and error log', async () => {
    const sendStructuredSpy = mock(() => {});
    const errorLogSpy = mock(() => {});

    await moduleMocker.mock('./streaming_input.ts', () => ({
      sendInitialPrompt: mock(() => {}),
      sendFollowUpMessage: mock(() => {}),
      safeEndStdin: mock(() => {}),
      sendSinglePromptAndWait: mock(() => Promise.resolve()),
    }));

    await moduleMocker.mock('./terminal_input.ts', () => ({
      TerminalInputReader: class {
        private readonly onError: (err: unknown) => void;
        constructor(options: { onLine: (line: string) => void; onError: (err: unknown) => void }) {
          this.onError = options.onError;
        }
        start() {
          // Simulate an error after start
          this.onError(new Error('readline crashed'));
          return true;
        }
        stop() {}
      },
    }));

    await moduleMocker.mock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: mock(() => undefined),
    }));

    await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
      TunnelAdapter: class {},
      isTunnelActive: mock(() => false),
    }));

    const { executeWithTerminalInput } = await import('./terminal_input_lifecycle.ts');
    const streaming = makeStreamingProcess();

    const result = executeWithTerminalInput({
      streaming,
      prompt: 'task prompt',
      sendStructured: sendStructuredSpy,
      debugLog: mock(() => {}),
      errorLog: errorLogSpy,
      log: mock(() => {}),
      label: 'Code execution',
      terminalInputEnabled: true,
      tunnelForwardingEnabled: false,
    });

    await result.resultPromise;

    // Check that a workflow_progress message was sent
    const progressCall = sendStructuredSpy.mock.calls.find(
      (call) => call[0] && typeof call[0] === 'object' && call[0].type === 'workflow_progress'
    );
    expect(progressCall).toBeDefined();
    expect(progressCall![0].message).toContain('readline crashed');

    // Check that errorLog was called
    expect(errorLogSpy).toHaveBeenCalled();
    const errorArgs = errorLogSpy.mock.calls[0];
    expect(errorArgs[0]).toContain('Terminal input reader error during Claude Code execution');
  });
});
