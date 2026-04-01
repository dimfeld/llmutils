import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, id: number, params: unknown) => Promise<unknown>;

async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Harness {
  executeCodexStepViaAppServer: (
    prompt: string,
    cwd: string,
    timConfig: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<string>;
  connectionCreateMock: ReturnType<typeof vi.fn>;
  connection: {
    isAlive: boolean;
    threadStart: ReturnType<typeof vi.fn>;
    turnStart: ReturnType<typeof vi.fn>;
    turnSteer: ReturnType<typeof vi.fn>;
    turnInterrupt: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  formatter: {
    handleNotification: ReturnType<typeof vi.fn>;
    getThreadId: ReturnType<typeof vi.fn>;
    getFinalAgentMessage: ReturnType<typeof vi.fn>;
    getFailedAgentMessage: ReturnType<typeof vi.fn>;
  };
  createApprovalHandlerMock: ReturnType<typeof vi.fn>;
  approvalHandler: ReturnType<typeof vi.fn>;
  isTunnelActiveMock: ReturnType<typeof vi.fn>;
  createTunnelServerMock: ReturnType<typeof vi.fn>;
  tunnelCloseMock: ReturnType<typeof vi.fn>;
  createPromptRequestHandlerMock: ReturnType<typeof vi.fn>;
  sendStructuredMock: ReturnType<typeof vi.fn>;
  warnMock: ReturnType<typeof vi.fn>;
  loggerAdapter:
    | {
        setUserInputHandler: ReturnType<typeof vi.fn>;
      }
    | undefined;
  connectionCreateOptions: { current?: any };
  connectionHandlers: {
    onNotification?: NotificationHandler;
    onServerRequest?: ServerRequestHandler;
  };
}

async function createHarness(options?: {
  tunnelActive?: boolean;
  finalMessage?: string;
  failedMessage?: string | undefined;
  terminalInputLines?: string[];
  loggerAdapterKind?: 'headless' | 'tunnel';
}): Promise<Harness> {
  vi.resetModules();

  const connectionCreateOptions: { current?: any } = {};
  const connectionHandlers: {
    onNotification?: NotificationHandler;
    onServerRequest?: ServerRequestHandler;
  } = {};

  const tunnelCloseMock = vi.fn();
  const createTunnelServerMock = vi.fn(async () => ({ close: tunnelCloseMock }));
  const createPromptRequestHandlerMock = vi.fn(() => vi.fn(async () => ({ action: 'cancel' })));
  const isTunnelActiveMock = vi.fn(() => options?.tunnelActive ?? true);

  const sendStructuredMock = vi.fn();
  const warnMock = vi.fn();
  let loggerAdapter:
    | {
        setUserInputHandler: ReturnType<typeof vi.fn>;
      }
    | undefined;

  const formatter = {
    handleNotification: vi.fn(() => ({})),
    getThreadId: vi.fn(() => 'thread-from-formatter'),
    getFinalAgentMessage: vi.fn(() => options?.finalMessage ?? 'final agent message'),
    getFailedAgentMessage: vi.fn(() => options?.failedMessage),
  };

  const approvalHandler = vi.fn(async () => ({ decision: 'accept' as const }));
  const createApprovalHandlerMock = vi.fn(() => approvalHandler);

  const connection = {
    isAlive: true,
    threadStart: vi.fn(async () => ({ threadId: 'thread-1' })),
    turnStart: vi.fn(async () => ({ turnId: 'turn-1' })),
    turnSteer: vi.fn(async () => ({ turnId: 'turn-1' })),
    turnInterrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };

  const connectionCreateMock = vi.fn(async (createOptions: any) => {
    connectionCreateOptions.current = createOptions;
    connectionHandlers.onNotification = createOptions.onNotification;
    connectionHandlers.onServerRequest = createOptions.onServerRequest;
    return connection;
  });

  vi.doMock('../../../logging.ts', () => ({
    debugLog: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
    sendStructured: sendStructuredMock,
    warn: warnMock,
  }));

  class MockHeadlessAdapter {
    setUserInputHandler = vi.fn();
  }

  class MockTunnelAdapter {
    setUserInputHandler = vi.fn();
  }

  if (options?.loggerAdapterKind === 'headless') {
    loggerAdapter = new MockHeadlessAdapter();
  } else if (options?.loggerAdapterKind === 'tunnel') {
    loggerAdapter = new MockTunnelAdapter();
  }

  vi.doMock('../../../logging/adapter.js', () => ({
    getLoggerAdapter: vi.fn(() => loggerAdapter),
  }));

  vi.doMock('../../../logging/headless_adapter.js', () => ({
    HeadlessAdapter: MockHeadlessAdapter,
  }));

  vi.doMock('../../../logging/tunnel_client.js', () => ({
    isTunnelActive: isTunnelActiveMock,
    TunnelAdapter: MockTunnelAdapter,
  }));

  vi.doMock('../../../logging/tunnel_server.js', () => ({
    createTunnelServer: createTunnelServerMock,
  }));

  vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
    createPromptRequestHandler: createPromptRequestHandlerMock,
  }));

  vi.doMock('../../../logging/tunnel_protocol.js', () => ({
    TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
  }));

  vi.doMock('./app_server_connection.ts', () => ({
    CodexAppServerConnection: {
      create: connectionCreateMock,
    },
  }));

  vi.doMock('./app_server_approval.ts', () => ({
    createApprovalHandler: createApprovalHandlerMock,
  }));

  vi.doMock('./app_server_format.ts', () => ({
    createAppServerFormatter: vi.fn(() => formatter),
  }));

  const terminalInputLines = options?.terminalInputLines ?? [];
  vi.doMock('../claude_code/terminal_input.ts', () => ({
    TerminalInputReader: class {
      private readonly onLine: (line: string) => void;
      private readonly onCloseWhileActive: () => void;
      constructor(readerOptions: {
        onLine: (line: string) => void;
        onCloseWhileActive?: () => void;
      }) {
        this.onLine = readerOptions.onLine;
        this.onCloseWhileActive = readerOptions.onCloseWhileActive ?? (() => {});
      }

      start() {
        for (const line of terminalInputLines) {
          this.onLine(line);
        }
        this.onCloseWhileActive();
        return true;
      }

      stop() {}
    },
  }));

  const mod = await import('./app_server_runner.js');

  const harness: Harness = {
    executeCodexStepViaAppServer: mod.executeCodexStepViaAppServer,
    connectionCreateMock,
    connection,
    formatter,
    createApprovalHandlerMock,
    approvalHandler,
    isTunnelActiveMock,
    createTunnelServerMock,
    tunnelCloseMock,
    createPromptRequestHandlerMock,
    sendStructuredMock,
    warnMock,
    loggerAdapter,
    connectionCreateOptions,
    connectionHandlers,
  };

  return harness;
}

describe('executeCodexStepViaAppServer', () => {
  const originalAllowAllTools = process.env.ALLOW_ALL_TOOLS;
  const originalOutputTimeout = process.env.CODEX_OUTPUT_TIMEOUT_MS;

  beforeEach(() => {
    delete process.env.ALLOW_ALL_TOOLS;
    delete process.env.CODEX_OUTPUT_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalAllowAllTools === undefined) {
      delete process.env.ALLOW_ALL_TOOLS;
    } else {
      process.env.ALLOW_ALL_TOOLS = originalAllowAllTools;
    }
    if (originalOutputTimeout === undefined) {
      delete process.env.CODEX_OUTPUT_TIMEOUT_MS;
    } else {
      process.env.CODEX_OUTPUT_TIMEOUT_MS = originalOutputTimeout;
    }
    vi.resetModules();
  });

  test('returns final agent message on successful turn completion', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', text: 'task complete' },
      });
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed', usage: { inputTokens: 10, outputTokens: 5 } },
      });
      return { turnId: 'turn-1' };
    });

    const output = await harness.executeCodexStepViaAppServer('do work', '/repo', {});

    expect(output).toBe('final agent message');
    expect(harness.connectionCreateMock).toHaveBeenCalledTimes(1);
    expect(harness.connection.threadStart).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  test('treats thread idle status as fallback turn completion in chat sessions', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('thread/status/changed', {
        status: { type: 'running' },
      });
      harness.connectionHandlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', text: 'task complete' },
      });
      harness.connectionHandlers.onNotification?.('thread/status/changed', {
        status: { type: 'idle' },
      });
      return { turnId: 'turn-1' };
    });

    const output = await harness.executeCodexStepViaAppServer(
      'do work',
      '/repo',
      {},
      {
        appServerMode: 'chat-session',
        terminalInput: true,
      }
    );

    expect(output).toBe('final agent message');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  test('does not treat thread idle status as single-turn completion', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('thread/status/changed', {
        status: { type: 'idle' },
      });
      return { turnId: 'turn-1' };
    });

    await expect(
      harness.executeCodexStepViaAppServer('do work', '/repo', {}, { inactivityTimeoutMs: 10 })
    ).rejects.toThrow(/failed after 3 attempts/i);

    expect(harness.connection.turnStart).toHaveBeenCalledTimes(3);
    expect(harness.connection.turnInterrupt).toHaveBeenCalledTimes(3);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  test('interrupts on inactivity and retries with continue prompt', async () => {
    const harness = await createHarness();

    harness.connection.turnInterrupt.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'interrupted' },
      });
    });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('item/started', { item: { type: 'reasoning' } });
      return { turnId: 'turn-timeout' };
    });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-2' };
    });

    const output = await harness.executeCodexStepViaAppServer(
      'initial prompt',
      '/repo',
      {},
      {
        inactivityTimeoutMs: 10,
      }
    );

    expect(output).toBe('final agent message');
    expect(harness.connection.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(2);
    expect(harness.connection.turnStart.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'continue' }],
      })
    );
  });

  test('retries when turnStart hangs without yielding a turn id', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('item/started', { item: { type: 'reasoning' } });
      return await new Promise<never>(() => {});
    });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-2' };
    });

    const output = await harness.executeCodexStepViaAppServer(
      'prompt',
      '/repo',
      {},
      {
        inactivityTimeoutMs: 10,
      }
    );

    expect(output).toBe('final agent message');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(2);
    expect(harness.connection.turnStart.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'continue' }],
      })
    );
  });

  test('retries when turn status is failed', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'failed' },
      });
      return { turnId: 'turn-failed' };
    });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-ok' };
    });

    const output = await harness.executeCodexStepViaAppServer('prompt', '/repo', {});

    expect(output).toBe('final agent message');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(2);
    expect(harness.connection.turnStart.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'continue' }],
      })
    );
  });

  test('throws after max retries are exhausted', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementation(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'failed' },
      });
      return { turnId: 'turn-failed' };
    });

    await expect(harness.executeCodexStepViaAppServer('prompt', '/repo', {})).rejects.toThrow(
      /failed after 3 attempts/i
    );

    expect(harness.connection.turnStart).toHaveBeenCalledTimes(3);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  test('passes output schema through to turnStart', async () => {
    const harness = await createHarness();
    const outputSchema = {
      type: 'object',
      properties: {
        status: { type: 'string' },
      },
    };

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    await harness.executeCodexStepViaAppServer('prompt', '/repo', {}, { outputSchema });

    expect(harness.connection.turnStart.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ outputSchema })
    );
  });

  test('passes model through to threadStart and turnStart', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    await harness.executeCodexStepViaAppServer('prompt', '/repo', {}, { model: 'gpt-5' });

    expect(harness.connection.threadStart.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: 'gpt-5' })
    );
    expect(harness.connection.turnStart.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ model: 'gpt-5' })
    );
  });

  test('creates and cleans up tunnel server when tunnel is not active', async () => {
    const harness = await createHarness({ tunnelActive: false });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    await harness.executeCodexStepViaAppServer('prompt', '/repo', {});

    expect(harness.isTunnelActiveMock).toHaveBeenCalledTimes(1);
    expect(harness.createPromptRequestHandlerMock).toHaveBeenCalledTimes(1);
    expect(harness.createTunnelServerMock).toHaveBeenCalledTimes(1);
    expect(harness.tunnelCloseMock).toHaveBeenCalledTimes(1);

    const createOptions = harness.connectionCreateOptions.current;
    expect(createOptions?.env?.TIM_OUTPUT_SOCKET).toEqual(expect.any(String));
  });

  test('wires approval handler into app-server connection', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    await harness.executeCodexStepViaAppServer('prompt', '/repo', {});

    expect(harness.createApprovalHandlerMock).toHaveBeenCalledTimes(1);
    expect(harness.createApprovalHandlerMock.mock.calls[0]?.[0]).toEqual({
      sandboxAllowsFileWrites: true,
      writableRoots: ['/repo'],
    });

    expect(harness.connectionCreateOptions.current?.onServerRequest).toBe(harness.approvalHandler);
  });

  test('includes external config directory in writable roots passed to approval handler', async () => {
    const harness = await createHarness();

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    await harness.executeCodexStepViaAppServer('prompt', '/repo', {
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/shared-config',
    });

    expect(harness.createApprovalHandlerMock.mock.calls[0]?.[0]).toEqual({
      sandboxAllowsFileWrites: true,
      writableRoots: ['/repo', '/shared-config'],
    });
  });

  test('uses turn/steer while a chat turn is active', async () => {
    const harness = await createHarness({
      terminalInputLines: ['first message', 'second message'],
    });

    harness.connection.turnStart.mockImplementationOnce(async (params: any) => {
      harness.connectionHandlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', text: `reply for ${params.input[0].text}` },
      });
      harness.connectionHandlers.onNotification?.('turn/started', {
        turn: { id: 'turn-1' },
      });
      return { turnId: 'turn-1' };
    });

    harness.connection.turnSteer.mockImplementationOnce(async (params: any) => {
      harness.connectionHandlers.onNotification?.('item/completed', {
        item: { type: 'agentMessage', text: `reply for ${params.input[0].text}` },
      });
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { id: 'turn-1', status: 'completed' },
      });
      return { turnId: 'turn-1' };
    });

    const output = await harness.executeCodexStepViaAppServer(
      '',
      '/repo',
      {},
      {
        appServerMode: 'chat-session',
        terminalInput: true,
      }
    );

    expect(output).toBe('final agent message');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnStart.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'first message' }],
      })
    );
    expect(harness.connection.turnSteer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'second message' }],
        expectedTurnId: 'turn-1',
      })
    );
  });

  test('supports single-turn steering mode and exits after completion', async () => {
    const harness = await createHarness({
      terminalInputLines: ['steer message'],
    });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/started', {
        turn: { id: 'turn-subagent' },
      });
      return { turnId: 'turn-subagent' };
    });

    harness.connection.turnSteer.mockImplementationOnce(async () => {
      harness.connectionHandlers.onNotification?.('turn/completed', {
        turn: { id: 'turn-subagent', status: 'completed' },
      });
      return { turnId: 'turn-subagent' };
    });

    const output = await harness.executeCodexStepViaAppServer(
      'initial prompt',
      '/repo',
      {},
      {
        appServerMode: 'single-turn-with-steering',
        terminalInput: true,
      }
    );

    expect(output).toBe('final agent message');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnStart.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'initial prompt' }],
      })
    );
    expect(harness.connection.turnSteer.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        input: [{ type: 'text', text: 'steer message' }],
        expectedTurnId: 'turn-subagent',
      })
    );
  });

  test('does not emit duplicate structured gui input messages in headless chat sessions', async () => {
    const harness = await createHarness({ loggerAdapterKind: 'headless' });

    harness.connection.turnStart.mockImplementationOnce(async () => {
      throw new Error('stop after gui input');
    });

    const result = harness.executeCodexStepViaAppServer(
      '',
      '/repo',
      {},
      { appServerMode: 'chat-session' }
    );

    await waitFor(() => (harness.loggerAdapter?.setUserInputHandler.mock.calls.length ?? 0) === 1);

    const handler = harness.loggerAdapter?.setUserInputHandler.mock.calls[0]?.[0] as
      | ((content: string) => void)
      | undefined;
    expect(handler).toBeDefined();
    handler?.('gui input');

    await expect(result).rejects.toThrow('stop after gui input');
    expect(
      harness.sendStructuredMock.mock.calls.some(
        (call) =>
          call[0] &&
          typeof call[0] === 'object' &&
          call[0].type === 'user_terminal_input' &&
          call[0].source === 'gui' &&
          call[0].content === 'gui input'
      )
    ).toBe(false);
  });
});
