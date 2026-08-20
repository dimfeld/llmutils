import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  AgentLaunchHandle,
  AgentLaunchRequest,
  AgentProviderLifecycleObserver,
} from './agent_manager_types.js';
import type { PreparedSubagentExecution } from '../subagents/types.js';
import type { SubagentPreparationRequest } from '../subagents/types.js';
import type { ClaudePermissionPromptCoordinator } from '../executors/claude_code/claude_mcp_protocol.js';

const mocks = vi.hoisted(() => ({
  prepareSubagentExecution: vi.fn(),
  runClaudeSubprocess: vi.fn(),
  startPersistentCodexAgent: vi.fn(),
}));

vi.mock('../subagents/service.js', () => ({
  prepareSubagentExecution: mocks.prepareSubagentExecution,
}));

vi.mock('../executors/claude_code/run_claude_subprocess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/claude_code/run_claude_subprocess.js')>()),
  runClaudeSubprocess: mocks.runClaudeSubprocess,
}));

vi.mock('../executors/codex_cli/persistent_codex_session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../executors/codex_cli/persistent_codex_session.js')>()),
  startPersistentCodexAgent: mocks.startPersistentCodexAgent,
}));

const { CollaborativeAgentSession } = await import('./collaborative_session.js');

function createProviderHandle(
  executor: 'claude-code' | 'codex-cli',
  lifecycleEvents: string[] = []
): AgentLaunchHandle {
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
  return {
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

function createCoordinator(disposeOrder: string[]): ClaudePermissionPromptCoordinator {
  return {
    enqueue: vi.fn(),
    cancelRequester: vi.fn(),
    dispose: vi.fn(async () => {
      disposeOrder.push('coordinator');
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
      permissionPromptCoordinator: coordinator,
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
            }),
          }),
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
          }),
        })
      );
      expect(mocks.prepareSubagentExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'reviewer',
          promptContext: { mode: 'persistent-agent' },
        })
      );
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

  test('uses the same provider-neutral root semantics for a Codex orchestrator', async () => {
    const coordinator = createCoordinator([]);
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
      permissionPromptCoordinator: coordinator,
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
