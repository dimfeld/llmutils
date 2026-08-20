import { describe, expect, test, vi } from 'vitest';
import type { AgentLaunchRequest } from '../../agent_messaging/agent_manager_types.js';
import type { ClaudePermissionPromptCoordinator } from './claude_mcp_protocol.js';

const mocks = vi.hoisted(() => ({
  runClaudeSubprocess: vi.fn(),
}));

vi.mock('./run_claude_subprocess.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./run_claude_subprocess.js')>()),
  runClaudeSubprocess: mocks.runClaudeSubprocess,
}));

const { createClaudeAgentLauncher } = await import('./claude_agent_launcher.js');

function createRequest(): AgentLaunchRequest {
  return {
    identity: {
      id: 'agent-id' as AgentLaunchRequest['identity']['id'],
      name: 'api-impl' as AgentLaunchRequest['identity']['name'],
      role: 'subagent',
      type: 'implementer',
      executor: 'claude-code',
    },
    initialMessage: 'Implement the assigned scope.',
    preparedExecution: {
      agentType: 'implementer',
      executor: 'claude-code',
      model: 'claude-test',
      plan: { id: 421, tasks: [] },
      planId: 421,
      planPath: '/repo/.tim/plans/421.plan.md',
      gitRoot: '/repo',
      useJj: true,
      prompt: 'prepared prompt',
      config: { executors: {} } as AgentLaunchRequest['preparedExecution']['config'],
      timEnvironment: {},
    },
    processLabel: 'Claude agent (api-impl)' as AgentLaunchRequest['processLabel'],
    lifecycleObserver: {
      outputActivity: vi.fn(),
      completedAssistantMessage: vi.fn(),
      turnComplete: vi.fn(),
      exit: vi.fn(),
    },
  };
}

function createCoordinator(): ClaudePermissionPromptCoordinator {
  return {
    enqueue: vi.fn(),
    cancelRequester: vi.fn(),
    dispose: vi.fn(async () => {}),
  };
}

describe('ClaudeAgentLauncher', () => {
  test('derives persistent agent tools and interactive permission capability from the root', async () => {
    mocks.runClaudeSubprocess.mockResolvedValue({});
    const coordinator = createCoordinator();
    const launcher = createClaudeAgentLauncher({
      dispatcher: {} as never,
      permissionPromptCoordinator: coordinator,
      noninteractive: false,
    });

    await launcher.launch(createRequest());

    expect(mocks.runClaudeSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        noninteractive: false,
        terminalInput: false,
        claudeCodeOptions: expect.objectContaining({
          permissionPromptCoordinator: coordinator,
          agentToolContext: expect.objectContaining({
            allowedTools: new Set(['ListAgents', 'SendAgentMessage', 'FinishAgent']),
          }),
        }),
      })
    );
  });

  test('passes noninteractive root sessions through to persistent agents', async () => {
    mocks.runClaudeSubprocess.mockResolvedValue({});
    const coordinator = createCoordinator();
    const launcher = createClaudeAgentLauncher({
      dispatcher: {} as never,
      permissionPromptCoordinator: coordinator,
      noninteractive: true,
    });

    await launcher.launch(createRequest());

    expect(mocks.runClaudeSubprocess).toHaveBeenCalledWith(
      expect.objectContaining({
        noninteractive: true,
        terminalInput: false,
      })
    );
  });
});
