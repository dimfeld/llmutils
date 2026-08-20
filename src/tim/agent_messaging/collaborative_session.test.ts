import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  AgentLaunchHandle,
  AgentLaunchRequest,
  AgentProviderExitClassification,
  AgentProviderLifecycleObserver,
} from './agent_manager_types.js';
import type { PreparedSubagentExecution } from '../subagents/types.js';
import type { SubagentPreparationRequest } from '../subagents/types.js';
import type { ClaudePermissionPromptCoordinator } from '../executors/claude_code/claude_mcp_protocol.js';

const mocks = vi.hoisted(() => ({
  prepareSubagentExecution: vi.fn(),
  runClaudeSubprocess: vi.fn(),
  startPersistentCodexAgent: vi.fn(),
  createClaudePermissionPromptCoordinator: vi.fn(),
  throwDuringSessionCreate: false,
}));

vi.mock('../subagents/service.js', () => ({
  prepareSubagentExecution: mocks.prepareSubagentExecution,
}));

vi.mock('../executors/claude_code/run_claude_subprocess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/claude_code/run_claude_subprocess.js')>()),
  runClaudeSubprocess: mocks.runClaudeSubprocess,
}));

vi.mock('../executors/claude_code/claude_mcp_protocol.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../executors/claude_code/claude_mcp_protocol.js')>();
  return {
    ...actual,
    createClaudeAgentToolDispatcher: vi.fn(
      (...args: Parameters<typeof actual.createClaudeAgentToolDispatcher>) => {
        if (mocks.throwDuringSessionCreate) {
          throw new Error('provider setup failed');
        }
        return actual.createClaudeAgentToolDispatcher(...args);
      }
    ),
  };
});

vi.mock('../executors/claude_code/claude_permission_prompt_coordinator.js', () => ({
  createClaudePermissionPromptCoordinator: mocks.createClaudePermissionPromptCoordinator,
}));

vi.mock('../executors/codex_cli/persistent_codex_session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/codex_cli/persistent_codex_session.js')>()),
  startPersistentCodexAgent: mocks.startPersistentCodexAgent,
}));

const { CollaborativeAgentSession } = await import('../commands/agent/collaborative_session.js');

function createProviderHandle(
  executor: 'claude-code' | 'codex-cli',
  lifecycleEvents: string[] = []
): AgentLaunchHandle & {
  readonly emitTurnComplete: () => void;
  readonly emitExit: (classification: AgentProviderExitClassification) => void;
} {
  let observer: AgentProviderLifecycleObserver | undefined;
  const lifecycle = {
    requestGracefulShutdown: vi.fn(async () => {
      observer?.exit('graceful');
      return 'accepted' as const;
    }),
    requestCloseAfterCurrentTurn: vi.fn(async () => 'accepted' as const),
    requestForcedShutdown: vi.fn(async () => {
      observer?.exit('forced');
      return 'accepted' as const;
    }),
    subscribe: vi.fn((nextObserver: AgentProviderLifecycleObserver) => {
      observer = nextObserver;
      return () => {
        if (observer === nextObserver) observer = undefined;
      };
    }),
  };
  const input = {
    ready: Promise.resolve(),
    isReady: true,
    activity: 'idle' as const,
    deliver: vi.fn(() => 'started-idle-turn' as const),
    onAvailabilityChange: vi.fn(() => () => {}),
    release: vi.fn(async () => {}),
  };
  const handle: AgentLaunchHandle = {
    executor,
    processLabel: `${executor} label` as AgentLaunchHandle['processLabel'],
    input,
    ready: Promise.resolve(),
    completion: new Promise(() => {}),
    lifecycle,
    release: vi.fn(async () => {
      lifecycleEvents.push(`${executor}-release`);
      await input.release?.();
    }),
  };
  return {
    ...handle,
    emitTurnComplete: (): void => observer?.turnComplete(),
    emitExit: (classification: AgentProviderExitClassification): void =>
      observer?.exit(classification),
  };
}

function preparedExecution(request: SubagentPreparationRequest): PreparedSubagentExecution {
  return {
    agentType: request.agentType,
    executor: request.executor as 'claude-code' | 'codex-cli',
    model: undefined,
    plan: { id: 421, tasks: [] },
    planId: 421,
    planPath: '/repo/.tim/plans/421.plan.md',
    gitRoot: '/repo',
    useJj: true,
    prompt: `prepared ${request.agentType}`,
    config: { paths: { tasks: 'tasks' } },
    timEnvironment: { context: { planId: 421 } },
  } as PreparedSubagentExecution;
}

function createCoordinator(
  disposeOrder: string[],
  disposeError?: Error
): ClaudePermissionPromptCoordinator {
  return {
    enqueue: vi.fn(),
    cancelRequester: vi.fn(),
    dispose: vi.fn(async () => {
      disposeOrder.push('coordinator');
      if (disposeError !== undefined) throw disposeError;
    }),
  };
}

describe('CollaborativeAgentSession root activation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('installs role-scoped root tools and launches mixed persistent providers through the manager', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    mocks.prepareSubagentExecution.mockImplementation(async (request) =>
      preparedExecution(request)
    );
    mocks.runClaudeSubprocess.mockImplementation(async () =>
      createProviderHandle('claude-code', disposeOrder)
    );
    mocks.startPersistentCodexAgent.mockImplementation(async () =>
      createProviderHandle('codex-cli', disposeOrder)
    );

    const session = await CollaborativeAgentSession.create({
      planId: 421,
      repositoryRoot: '/repo',
      orchestratorExecutor: 'claude-code',
      noninteractive: false,
    });

    try {
      expect(session.claudeAgentToolContext.allowedTools).toEqual(
        new Set(['StartAgent', 'ListAgents', 'SendAgentMessage', 'StopAgent'])
      );
      expect(
        session.codexDynamicToolProvider.definitions.map((definition) => definition.name)
      ).toEqual(['StartAgent', 'ListAgents', 'SendAgentMessage', 'StopAgent']);
      expect(session.manager.listAgents().agents).toHaveLength(1);

      const caller = { id: session.manager.orchestratorIdentity.id, role: 'orchestrator' as const };
      await session.manager.startAgent(caller, {
        name: 'claude-worker',
        type: 'implementer',
        executor: 'claude-code',
        initialMessage: 'Implement the assigned scope.',
      });
      await session.manager.startAgent(caller, {
        name: 'codex-review',
        type: 'reviewer',
        executor: 'codex-cli',
        initialMessage: 'Inspect the evolving change without editing.',
      });

      expect(mocks.runClaudeSubprocess).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'persistent-agent',
          processLabel: 'Claude agent (claude-worker)',
          lifecycleObserver: expect.any(Object),
          claudeCodeOptions: expect.objectContaining({
            permissionPromptCoordinator: coordinator,
            agentToolContext: expect.objectContaining({
              caller: expect.objectContaining({ name: 'claude-worker', role: 'subagent' }),
              allowedTools: new Set(['ListAgents', 'SendAgentMessage', 'FinishAgent']),
            }),
          }),
          noninteractive: false,
          terminalInput: false,
        })
      );
      expect(mocks.startPersistentCodexAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'persistent-agent',
          processLabel: 'Codex thread (codex-review)',
          dynamicToolProvider: expect.objectContaining({
            context: expect.objectContaining({
              caller: expect.objectContaining({ name: 'codex-review', role: 'subagent' }),
            }),
            definitions: expect.arrayContaining([
              expect.objectContaining({ name: 'ListAgents' }),
              expect.objectContaining({ name: 'SendAgentMessage' }),
              expect.objectContaining({ name: 'FinishAgent' }),
            ]),
          }),
        })
      );
      expect(mocks.prepareSubagentExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'reviewer',
          executor: 'codex-cli',
          promptContext: { mode: 'persistent-agent' },
        })
      );
      const codexPreparationCall = mocks.prepareSubagentExecution.mock.calls.find(
        ([request]) => request.executor === 'codex-cli'
      );
      expect(codexPreparationCall?.[0]?.model).toBeUndefined();
    } finally {
      await session.close();
    }

    disposeOrder.push('after-close');
    expect(disposeOrder).toEqual([
      'claude-code-release',
      'codex-cli-release',
      'coordinator',
      'after-close',
    ]);
    expect(session.manager.isClosed).toBe(true);
  });

  test('closes only once and preserves cleanup errors after manager shutdown', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder, new Error('coordinator close failed'));
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    const session = await CollaborativeAgentSession.create({
      planId: 421,
      repositoryRoot: '/repo',
      orchestratorExecutor: 'claude-code',
    });

    const firstClose = session.close();
    expect(session.close()).toBe(firstClose);
    await expect(firstClose).rejects.toThrow('coordinator close failed');
    expect(session.manager.isClosed).toBe(true);
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    expect(disposeOrder).toEqual(['coordinator']);
  });

  test('closes the manager when provider setup fails during session creation', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    mocks.throwDuringSessionCreate = true;

    try {
      await expect(
        CollaborativeAgentSession.create({
          planId: 421,
          repositoryRoot: '/repo',
          orchestratorExecutor: 'claude-code',
          noninteractive: false,
        })
      ).rejects.toThrow('provider setup failed');
    } finally {
      mocks.throwDuringSessionCreate = false;
    }

    expect(disposeOrder).toEqual(['coordinator']);
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
  });

  test('disposes the coordinator when manager setup fails before a manager is assigned', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);

    await expect(
      CollaborativeAgentSession.create({
        planId: 421,
        repositoryRoot: '/repo',
        orchestratorExecutor: 'unsupported-executor' as never,
        noninteractive: false,
      })
    ).rejects.toThrow('Unsupported orchestrator executor');

    expect(disposeOrder).toEqual(['coordinator']);
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
  });

  test('routes root and subagent tool operations through one mixed-executor manager', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    const claudeHandle = createProviderHandle('claude-code', disposeOrder);
    const codexHandle = createProviderHandle('codex-cli', disposeOrder);
    mocks.prepareSubagentExecution.mockImplementation(async (request) =>
      preparedExecution(request)
    );
    mocks.runClaudeSubprocess.mockResolvedValueOnce(claudeHandle);
    mocks.startPersistentCodexAgent.mockResolvedValueOnce(codexHandle);

    const session = await CollaborativeAgentSession.create({
      planId: 421,
      repositoryRoot: '/repo',
      orchestratorExecutor: 'claude-code',
      noninteractive: false,
    });

    try {
      const rootInput = createProviderHandle('claude-code');
      session.orchestratorInputAdapter.bind(rootInput.input);
      const rootCaller = {
        id: session.manager.orchestratorIdentity.id,
        role: 'orchestrator' as const,
      };
      const claudeStart = await session.claudeAgentToolContext.dispatcher.startAgent(rootCaller, {
        name: 'claude-impl',
        type: 'implementer',
        executor: 'claude-code',
        initialMessage: 'Implement the assigned files.',
      });

      const codexStartResponse = await session.codexDynamicToolProvider.handler({
        threadId: 'root-thread',
        turnId: 'root-turn',
        callId: 'start-codex',
        tool: 'StartAgent',
        arguments: {
          name: 'codex-tests',
          type: 'tester',
          executor: 'codex-cli',
          initialMessage: 'Test the assigned files.',
        },
      });
      expect(codexStartResponse.success).toBe(true);

      const listedResponse = await session.codexDynamicToolProvider.handler({
        threadId: 'root-thread',
        turnId: 'root-turn',
        callId: 'list-agents',
        tool: 'ListAgents',
        arguments: {},
      });
      expect(listedResponse.success).toBe(true);
      expect(listedResponse.contentItems[0]?.text).toContain('claude-impl');
      expect(listedResponse.contentItems[0]?.text).toContain('codex-tests');

      const sentResponse = await session.codexDynamicToolProvider.handler({
        threadId: 'root-thread',
        turnId: 'root-turn',
        callId: 'send-message',
        tool: 'SendAgentMessage',
        arguments: {
          name: 'claude-impl',
          message: 'The tester is ready for the handoff.',
        },
      });
      expect(sentResponse).toMatchObject({ success: true });
      expect(claudeHandle.input.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'The tester is ready for the handoff.',
          source: expect.objectContaining({ name: 'orchestrator' }),
        })
      );

      const subagentToolContext =
        mocks.runClaudeSubprocess.mock.calls[0]?.[0]?.claudeCodeOptions?.agentToolContext;
      expect(subagentToolContext).toBeDefined();
      await expect(
        subagentToolContext.dispatcher.sendAgentMessage(
          { id: claudeStart.id, role: 'subagent' },
          { name: 'orchestrator', message: 'The implementation handoff is ready.' }
        )
      ).resolves.toMatchObject({ delivery: 'started-idle-turn' });
      expect(rootInput.input.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'The implementation handoff is ready.',
          source: expect.objectContaining({ name: 'claude-impl' }),
        })
      );
      session.manager.setAgentLifecycleState(claudeStart.id, 'running-active');
      await expect(
        subagentToolContext.dispatcher.finishAgent(
          { id: claudeStart.id, role: 'subagent' },
          { message: 'Implementation handoff is complete.' }
        )
      ).resolves.toEqual({ state: 'finishing' });

      const stoppedResponse = await session.claudeAgentToolContext.dispatcher.stopAgent(
        rootCaller,
        { name: 'codex-tests', force: true }
      );
      expect(stoppedResponse).toMatchObject({ name: 'codex-tests', mode: 'forced' });
      await session.manager.waitForAgentTerminal(
        session.manager.getIdentityByName('codex-tests')?.id ?? ''
      );
      expect(session.manager.listAgents().agents).toEqual([
        expect.objectContaining({ name: 'orchestrator' }),
        expect.objectContaining({ name: 'claude-impl', state: 'finishing' }),
      ]);
      claudeHandle.emitTurnComplete();
      claudeHandle.emitExit('natural');
      await session.manager.waitForAgentTerminal(claudeStart.id);
      expect(rootInput.input.deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Agent claude-impl completed'),
          source: expect.objectContaining({ name: 'claude-impl' }),
        })
      );
    } finally {
      await session.close();
    }
  });

  test('rolls back the mailbox and reservation when a persistent provider fails to launch', async () => {
    const disposeOrder: string[] = [];
    const coordinator = createCoordinator(disposeOrder);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    const launchError = new Error('persistent Claude launch failed');
    mocks.prepareSubagentExecution.mockImplementation(async (request) =>
      preparedExecution(request)
    );
    mocks.runClaudeSubprocess.mockRejectedValueOnce(launchError);

    const session = await CollaborativeAgentSession.create({
      planId: 421,
      repositoryRoot: '/repo',
      orchestratorExecutor: 'codex-cli',
      noninteractive: false,
    });

    try {
      const rootCaller = {
        id: session.manager.orchestratorIdentity.id,
        role: 'orchestrator' as const,
      };
      await expect(
        session.manager.startAgent(rootCaller, {
          name: 'failed-claude',
          type: 'implementer',
          executor: 'claude-code',
          initialMessage: 'This provider must fail before becoming visible.',
        })
      ).rejects.toThrow('persistent Claude launch failed');

      expect(session.manager.subagentCount).toBe(0);
      expect(session.manager.listAgents().agents).toEqual([
        expect.objectContaining({ name: 'orchestrator' }),
      ]);
      expect(await session.manager.sessionRuntime.runtime.listRegistrations()).toEqual([
        expect.objectContaining({ name: 'orchestrator' }),
      ]);
      expect(mocks.runClaudeSubprocess).toHaveBeenCalledTimes(1);
    } finally {
      await session.close();
    }

    expect(disposeOrder).toEqual(['coordinator']);
  });

  test('uses the same provider-neutral root semantics for a Codex orchestrator', async () => {
    const coordinator = createCoordinator([]);
    mocks.createClaudePermissionPromptCoordinator.mockReturnValue(coordinator);
    mocks.prepareSubagentExecution.mockImplementation(async (request) =>
      preparedExecution(request)
    );
    mocks.startPersistentCodexAgent.mockImplementation(async () =>
      createProviderHandle('codex-cli')
    );

    const session = await CollaborativeAgentSession.create({
      planId: 421,
      repositoryRoot: '/repo',
      orchestratorExecutor: 'codex-cli',
      noninteractive: false,
    });

    try {
      const rootToolResult = await session.codexDynamicToolProvider.handler({
        threadId: 'root-thread',
        turnId: 'root-turn',
        callId: 'call-1',
        tool: 'ListAgents',
        arguments: {},
      });
      expect(rootToolResult.success).toBe(true);
      expect(rootToolResult.contentItems[0]?.text).toContain('orchestrator');
    } finally {
      await session.close();
    }
  });
});
