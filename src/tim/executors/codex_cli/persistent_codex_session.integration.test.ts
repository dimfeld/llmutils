import { afterEach, describe, expect, it, vi } from 'vitest';

describe('persistent Codex setup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.TIM_OUTPUT_SOCKET;
  });

  it('uses a private named owner, registers a sibling thread, and keeps tools installed', async () => {
    vi.resetModules();

    const connectionOptions: { current?: Record<string, unknown> } = {};
    const connectionCreate = vi.fn(async (options: Record<string, unknown>) => {
      connectionOptions.current = options;
      return connection;
    });
    const connection = {
      isAlive: true,
      pid: 4242,
      processControlId: 'codex-process-1',
      setGracefulEndHandler: vi.fn(),
      updateMetadata: vi.fn(),
      threadStart: vi.fn(async () => ({ threadId: 'thread-1' })),
      turnStart: vi.fn(async () => ({ turnId: 'turn-1' })),
      close: vi.fn(async () => {}),
    };
    const logicalEndHandlers: Array<(() => void) | undefined> = [];
    const logicalLifecycle = {
      processId: 'logical-thread-1',
      setGracefulEndHandler: vi.fn((handler: (() => void) | undefined) => {
        logicalEndHandlers.push(handler);
      }),
      updateMetadata: vi.fn(),
      markStarted: vi.fn(),
      markExited: vi.fn(),
    };
    const owner = {
      prepareLogicalExecutor: vi.fn(() => logicalLifecycle),
    };

    vi.doMock('./app_server_connection.js', () => ({
      CodexAppServerConnection: { create: connectionCreate },
    }));
    vi.doMock('../../../common/session_process_control.js', () => ({
      getCurrentSessionProcessOwner: vi.fn(() => owner),
    }));
    vi.doMock('../../../logging', () => ({
      debugLog: vi.fn(),
      sendStructured: vi.fn(),
    }));
    vi.doMock('../../../logging/adapter.js', () => ({
      getLoggerAdapter: vi.fn(() => undefined),
    }));
    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => true),
      TunnelAdapter: class {},
    }));
    vi.doMock('../../../logging/headless_adapter.js', () => ({
      HeadlessAdapter: class {},
    }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createExecutorTunnelServer: vi.fn(),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));
    vi.doMock('./app_server_approval.js', () => ({
      createApprovalHandler: vi.fn(() => vi.fn(async () => ({ decision: 'accept' }))),
    }));

    const { createCodexAgentToolProvider } = await import('./codex_agent_tools.js');
    const { formatAgentProcessLabel } =
      await import('../../agent_messaging/agent_process_labels.js');
    const { CODEX_PERSISTENT_AGENT_MODE } = await import('./persistent_agent_contract.js');
    const { startPersistentCodexAgent } = await import('./persistent_codex_session.js');

    const identity = {
      id: 'agent-1',
      name: 'worker-a',
      role: 'subagent' as const,
      type: 'implementer' as const,
      executor: 'codex-cli' as const,
    };
    const provider = createCodexAgentToolProvider({
      caller: identity,
      dispatcher: {
        startAgent: async () => ({
          name: 'worker-b',
          id: 'agent-2',
          type: 'tester',
          executor: 'codex-cli',
          state: 'starting',
        }),
        listAgents: () => ({ agents: [] }),
        sendAgentMessage: async () => ({
          name: 'worker-b',
          messageId: 'message-1',
          delivery: 'queued' as const,
        }),
        stopAgent: async () => ({
          name: 'worker-b',
          mode: 'graceful-requested' as const,
          state: 'stopping' as const,
        }),
        finishAgent: async () => ({ state: 'finishing' as const }),
      },
    });
    const callbacks = {
      outputActivity: vi.fn(),
      completedAssistantMessage: vi.fn(),
      turnComplete: vi.fn(),
      exit: vi.fn(),
    };

    const handle = await startPersistentCodexAgent({
      mode: CODEX_PERSISTENT_AGENT_MODE,
      identity,
      prompt: 'Initial assignment',
      cwd: '/repo',
      timConfig: {},
      dynamicToolProvider: provider,
      processLabel: formatAgentProcessLabel('codex-cli', identity.name),
      lifecycleCallbacks: callbacks,
      sessionProcessOwner: owner,
    });

    expect(connectionOptions.current).toEqual(
      expect.objectContaining({
        privateOwner: true,
        experimentalApi: true,
        sessionProcessLabel: 'Codex app-server (worker-a)',
      })
    );
    expect(connectionOptions.current?.onServerRequest).toEqual(expect.any(Function));
    expect(owner.prepareLogicalExecutor).toHaveBeenCalledWith({
      label: 'Codex thread (worker-a)',
      command: 'codex thread thread-1',
      threadId: 'thread-1',
    });
    expect(logicalLifecycle.markStarted).toHaveBeenCalledTimes(1);
    expect(handle.providerThreadId).toBe('thread-1');
    await expect(handle.ready).resolves.toBeUndefined();

    expect(connectionOptions.current?.onServerRequest).toEqual(expect.any(Function));
    const serverRequest = connectionOptions.current?.onServerRequest as (
      method: string,
      id: number,
      params: unknown
    ) => Promise<unknown>;
    await expect(
      serverRequest('item/tool/call', 1, {
        threadId: 'thread-1',
        turnId: 'turn-1',
        callId: 'call-1',
        tool: 'ListAgents',
        arguments: {},
      })
    ).resolves.toMatchObject({ success: true });

    const processEndHandler = logicalEndHandlers
      .toReversed()
      .find((handler): handler is () => void => handler !== undefined);
    const connectionEndHandler = connection.setGracefulEndHandler.mock.calls
      .map(([handler]) => handler)
      .find((handler): handler is () => void => handler !== undefined);
    connectionEndHandler?.();
    processEndHandler?.();
    processEndHandler?.();
    await expect(handle.completion).resolves.toEqual({});
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(logicalLifecycle.markExited).toHaveBeenCalledTimes(1);
    expect(callbacks.exit).toHaveBeenCalledTimes(1);
  });
});
