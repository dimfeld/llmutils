import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimConfig } from '../../configSchema.js';
import type {
  AgentLaunchHandle,
  AgentLaunchRequest,
  AgentProviderLifecycleObserver,
} from '../../agent_messaging/agent_manager_types.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import { createCodexAgentLauncher } from './codex_agent_launcher.js';

const mocked = vi.hoisted(() => ({
  startPersistentCodexAgent: vi.fn(),
}));

vi.mock('./persistent_codex_session.js', () => mocked);

function createRequest(observer: AgentProviderLifecycleObserver): AgentLaunchRequest {
  return {
    identity: {
      id: 'agent-stable-id' as AgentLaunchRequest['identity']['id'],
      name: 'api-implementer' as AgentLaunchRequest['identity']['name'],
      role: 'subagent',
      type: 'implementer',
      executor: 'codex-cli',
    },
    initialMessage: 'Initial assignment',
    processLabel: formatAgentProcessLabel('codex-cli', 'api-implementer'),
    lifecycleObserver: observer,
    preparedExecution: {
      agentType: 'implementer',
      executor: 'codex-cli',
      model: 'gpt-5.6-sol:high',
      plan: {} as AgentLaunchRequest['preparedExecution']['plan'],
      planId: 420,
      planPath: '/repo/.tim/plans/420.plan.md',
      gitRoot: '/repo',
      useJj: true,
      prompt: 'Prepared prompt with task context.',
      config: {} as TimConfig,
      timEnvironment: { context: { planId: 420 } },
    },
  };
}

describe('Codex AgentManager launch adapter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('binds stable identity, prepared execution, dynamic tools, and lifecycle observer', async () => {
    const handle = {} as AgentLaunchHandle;
    mocked.startPersistentCodexAgent.mockResolvedValueOnce(handle);
    const observer: AgentProviderLifecycleObserver = {
      outputActivity: vi.fn(),
      completedAssistantMessage: vi.fn(),
      turnComplete: vi.fn(),
      exit: vi.fn(),
    };
    const dispatcher = {
      startAgent: vi.fn(),
      listAgents: vi.fn(),
      sendAgentMessage: vi.fn(),
      stopAgent: vi.fn(),
      finishAgent: vi.fn(),
    };
    const launcher = createCodexAgentLauncher({
      dispatcher,
      messagingDirectory: '/tmp/tim-agent-session',
    });

    await expect(launcher.launch(createRequest(observer))).resolves.toBe(handle);
    expect(mocked.startPersistentCodexAgent).toHaveBeenCalledTimes(1);
    expect(mocked.startPersistentCodexAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'persistent-agent',
        identity: expect.objectContaining({
          id: 'agent-stable-id',
          name: 'api-implementer',
        }),
        prompt: 'Prepared prompt with task context.',
        cwd: '/repo',
        model: 'gpt-5.6-sol',
        reasoningLevel: 'high',
        timEnvironment: { context: { planId: 420 } },
        agentEnvironmentIdentity: {
          messagingDirectory: '/tmp/tim-agent-session',
          id: 'agent-stable-id',
          name: 'api-implementer',
          role: 'subagent',
          type: 'implementer',
        },
        processLabel: 'Codex thread (api-implementer)',
        lifecycleObserver: observer,
      })
    );

    const launchOptions = mocked.startPersistentCodexAgent.mock.calls[0]?.[0] as {
      readonly dynamicToolProvider: {
        readonly context: { readonly caller: { readonly id: string } };
        readonly definitions: readonly unknown[];
      };
    };
    expect(launchOptions.dynamicToolProvider.context.caller.id).toBe('agent-stable-id');
    expect(launchOptions.dynamicToolProvider.definitions).toHaveLength(3);
  });
});
