import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

type NotificationHandler = (method: string, params: unknown) => void;
type ServerRequestHandler = (method: string, id: number, params: unknown) => Promise<unknown>;

interface Harness {
  moduleMocker: ModuleMocker;
  executeCodexStepViaAppServer: (
    prompt: string,
    cwd: string,
    timConfig: Record<string, unknown>,
    options?: Record<string, unknown>
  ) => Promise<string>;
  connectionCreateMock: ReturnType<typeof mock>;
  connection: {
    isAlive: boolean;
    threadStart: ReturnType<typeof mock>;
    turnStart: ReturnType<typeof mock>;
    turnSteer: ReturnType<typeof mock>;
    turnInterrupt: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
  };
  formatter: {
    handleNotification: ReturnType<typeof mock>;
    getThreadId: ReturnType<typeof mock>;
    getFinalAgentMessage: ReturnType<typeof mock>;
    getFailedAgentMessage: ReturnType<typeof mock>;
  };
  createApprovalHandlerMock: ReturnType<typeof mock>;
  approvalHandler: ReturnType<typeof mock>;
  isTunnelActiveMock: ReturnType<typeof mock>;
  createTunnelServerMock: ReturnType<typeof mock>;
  tunnelCloseMock: ReturnType<typeof mock>;
  createPromptRequestHandlerMock: ReturnType<typeof mock>;
  sendStructuredMock: ReturnType<typeof mock>;
  warnMock: ReturnType<typeof mock>;
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
}) {
  const moduleMocker = new ModuleMocker(import.meta);

  const connectionCreateOptions: { current?: any } = {};
  const connectionHandlers: {
    onNotification?: NotificationHandler;
    onServerRequest?: ServerRequestHandler;
  } = {};

  const tunnelCloseMock = mock(() => {});
  const createTunnelServerMock = mock(async () => ({ close: tunnelCloseMock }));
  const createPromptRequestHandlerMock = mock(() => mock(async () => ({ action: 'cancel' })));
  const isTunnelActiveMock = mock(() => options?.tunnelActive ?? true);

  const sendStructuredMock = mock(() => {});
  const warnMock = mock(() => {});

  const formatter = {
    handleNotification: mock(() => ({})),
    getThreadId: mock(() => 'thread-from-formatter'),
    getFinalAgentMessage: mock(() => options?.finalMessage ?? 'final agent message'),
    getFailedAgentMessage: mock(() => options?.failedMessage),
  };

  const approvalHandler = mock(async () => ({ decision: 'accept' as const }));
  const createApprovalHandlerMock = mock(() => approvalHandler);

  const connection = {
    isAlive: true,
    threadStart: mock(async () => ({ threadId: 'thread-1' })),
    turnStart: mock(async () => ({ turnId: 'turn-1' })),
    turnSteer: mock(async () => ({ turnId: 'turn-1' })),
    turnInterrupt: mock(async () => {}),
    close: mock(async () => {}),
  };

  const connectionCreateMock = mock(async (createOptions: any) => {
    connectionCreateOptions.current = createOptions;
    connectionHandlers.onNotification = createOptions.onNotification;
    connectionHandlers.onServerRequest = createOptions.onServerRequest;
    return connection;
  });

  await moduleMocker.mock('../../../logging.ts', () => ({
    debugLog: mock(() => {}),
    error: mock(() => {}),
    log: mock(() => {}),
    sendStructured: sendStructuredMock,
    warn: warnMock,
  }));

  await moduleMocker.mock('../../../logging/tunnel_client.js', () => ({
    isTunnelActive: isTunnelActiveMock,
  }));

  await moduleMocker.mock('../../../logging/tunnel_server.js', () => ({
    createTunnelServer: createTunnelServerMock,
  }));

  await moduleMocker.mock('../../../logging/tunnel_prompt_handler.js', () => ({
    createPromptRequestHandler: createPromptRequestHandlerMock,
  }));

  await moduleMocker.mock('../../../logging/tunnel_protocol.js', () => ({
    TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
  }));

  await moduleMocker.mock('./app_server_connection.ts', () => ({
    CodexAppServerConnection: {
      create: connectionCreateMock,
    },
  }));

  await moduleMocker.mock('./app_server_approval.ts', () => ({
    createApprovalHandler: createApprovalHandlerMock,
  }));

  await moduleMocker.mock('./app_server_format.ts', () => ({
    createAppServerFormatter: mock(() => formatter),
  }));

  await moduleMocker.mock('../claude_code/terminal_input.ts', () => ({
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
        for (const line of options?.terminalInputLines ?? []) {
          this.onLine(line);
        }
        this.onCloseWhileActive();
        return true;
      }

      stop() {}
    },
  }));

  const mod = await import(`./app_server_runner.ts?test=${Date.now()}-${Math.random()}`);

  const harness: Harness = {
    moduleMocker,
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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
    expect(createOptions?.env?.TIM_OUTPUT_SOCKET).toBeString();

    harness.moduleMocker.clear();
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
    });

    expect(harness.connectionCreateOptions.current?.onServerRequest).toBe(harness.approvalHandler);

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
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

    harness.moduleMocker.clear();
  });
});
