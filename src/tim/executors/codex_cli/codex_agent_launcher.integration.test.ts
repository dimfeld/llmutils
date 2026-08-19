import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimConfig } from '../../configSchema.js';
import {
  createAgentManager,
  type AgentManager,
  type AgentPreparation,
  type PreparedAgentExecution,
} from '../../agent_messaging/index.js';
import type { SessionProcessOwner } from '../../../common/session_process_control.js';
import { createCodexAgentLauncher } from './codex_agent_launcher.js';

const mocked = vi.hoisted(() => {
  const connection = {
    isAlive: true,
    pid: 4242,
    processControlId: 'codex-process-manager-test',
    setGracefulEndHandler: vi.fn(),
    updateMetadata: vi.fn(),
    turnStart: vi.fn(async ({ threadId }: { readonly threadId: string }) => ({
      turnId: `turn-${mocked.connection.turnStart.mock.calls.length}`,
      threadId,
    })),
    turnSteer: vi.fn(async () => ({ turnId: 'turn-1' })),
    turnInterrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    connection,
    notify: undefined as ((method: string, params: unknown) => void) | undefined,
    create: vi.fn(async (options: { readonly onNotification?: typeof mocked.notify }) => {
      mocked.notify = options.onNotification;
      return mocked.connection;
    }),
    startInitialThread: vi.fn(async () => ({ threadId: 'thread-manager-test' })),
  };
});

vi.mock('./app_server_connection.js', () => ({
  CodexAppServerConnection: { create: mocked.create },
}));
vi.mock('./app_server_runner.js', () => ({
  createAppServerRequestHandler: vi.fn(() => vi.fn(async () => ({ success: true }))),
  startInitialThread: mocked.startInitialThread,
}));
vi.mock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => true) }));
vi.mock('./app_server_approval.js', () => ({
  createApprovalHandler: vi.fn(() => vi.fn(async () => ({ decision: 'accept' }))),
}));
vi.mock('../../../logging', () => ({ debugLog: vi.fn(), sendStructured: vi.fn() }));

let manager: AgentManager | undefined;

afterEach(async () => {
  await manager?.close().catch(() => undefined);
  manager = undefined;
  mocked.notify = undefined;
  mocked.create.mockClear();
  mocked.startInitialThread.mockClear();
  for (const method of [
    mocked.connection.setGracefulEndHandler,
    mocked.connection.updateMetadata,
    mocked.connection.turnStart,
    mocked.connection.turnSteer,
    mocked.connection.turnInterrupt,
    mocked.connection.close,
  ]) {
    method.mockClear();
  }
});

function createOwner(): Pick<SessionProcessOwner, 'prepareLogicalExecutor'> {
  return {
    prepareLogicalExecutor: vi.fn(() => ({
      processId: 'codex-thread-process-manager-test',
      setGracefulEndHandler: vi.fn(),
      markStarted: vi.fn(),
      markExited: vi.fn(),
    })),
  };
}

function createPreparation(): AgentPreparation {
  return {
    prepare: async ({ identity, initialMessage }): Promise<PreparedAgentExecution> => ({
      agentType: identity.type,
      executor: identity.executor,
      model: 'gpt-5.6-sol:high',
      plan: {} as PreparedAgentExecution['plan'],
      planId: 420,
      planPath: '/repo/.tim/plans/420.plan.md',
      gitRoot: '/repo',
      useJj: true,
      prompt: `Prepared ${initialMessage}`,
      config: {} as TimConfig,
      timEnvironment: { context: { planId: 420 } },
    }),
  };
}

function notify(method: string, params: unknown): void {
  mocked.notify?.(method, params);
}

async function waitFor(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(condition()).toBe(true));
}

describe('Codex AgentManager launch integration', () => {
  it('keeps readiness, active steering, idle turns, graceful stop, and cleanup on manager contracts', async () => {
    let nextManager: AgentManager | undefined;
    const dispatcher = {
      startAgent: (caller: Parameters<AgentManager['startAgent']>[0], request: unknown) =>
        nextManager!.startAgent(caller, request),
      listAgents: () => nextManager!.listAgents(),
      sendAgentMessage: (
        caller: Parameters<AgentManager['sendAgentMessage']>[0],
        request: unknown
      ) => nextManager!.sendAgentMessage(caller, request),
      stopAgent: (caller: Parameters<AgentManager['stopAgent']>[0], request: unknown) =>
        nextManager!.stopAgent(caller, request),
      finishAgent: (caller: Parameters<AgentManager['finishAgent']>[0], request: unknown) =>
        nextManager!.finishAgent(caller, request),
    };
    const launcher = createCodexAgentLauncher({
      dispatcher,
      sessionProcessOwner: createOwner(),
    });
    let nextId = 0;
    nextManager = await createAgentManager({
      orchestratorExecutor: 'codex-cli',
      agentPreparer: createPreparation(),
      agentLauncher: launcher,
      agentIdGenerator: () => `agent-codex-manager-test-${++nextId}`,
    });
    manager = nextManager;

    const root = { id: manager.orchestratorIdentity.id, role: 'orchestrator' as const };
    const started = await manager.startAgent(root, {
      name: 'codex-worker',
      type: 'implementer',
      executor: 'codex-cli',
      initialMessage: 'Implement the change.',
    });
    expect(started.state).toBe('running-active');
    expect(manager.getAgentSnapshot(started.id)).toMatchObject({
      processControlId: 'codex-process-manager-test',
      providerThreadId: 'thread-manager-test',
    });

    await expect(
      manager.sendAgentMessage(root, { name: 'codex-worker', message: 'Check migrations first.' })
    ).resolves.toMatchObject({ delivery: 'steered' });
    expect(mocked.connection.turnSteer).toHaveBeenCalledWith({
      threadId: 'thread-manager-test',
      input: [{ type: 'text', text: 'Check migrations first.' }],
      expectedTurnId: 'turn-1',
    });

    notify('item/completed', {
      threadId: 'thread-manager-test',
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: 'Initial work is complete.' },
    });
    notify('turn/completed', {
      threadId: 'thread-manager-test',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await waitFor(() => manager.getAgentSnapshot(started.id)?.state === 'running-idle');

    await expect(
      manager.sendAgentMessage(root, { name: 'codex-worker', message: 'Run the edge cases.' })
    ).resolves.toMatchObject({ delivery: 'started-idle-turn' });
    expect(mocked.connection.turnStart).toHaveBeenLastCalledWith({
      threadId: 'thread-manager-test',
      input: [{ type: 'text', text: 'Run the edge cases.' }],
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    notify('turn/completed', {
      threadId: 'thread-manager-test',
      turn: { id: 'turn-2', status: 'completed' },
    });
    await waitFor(() => manager.getAgentSnapshot(started.id)?.state === 'running-idle');

    await expect(
      manager.stopAgent(root, { name: 'codex-worker', message: 'Provide the final status.' })
    ).resolves.toMatchObject({ mode: 'graceful-requested', state: 'stopping' });
    await waitFor(() => mocked.connection.turnStart.mock.calls.length === 3);
    expect(mocked.connection.turnStart).toHaveBeenLastCalledWith({
      threadId: 'thread-manager-test',
      input: [
        {
          type: 'text',
          text: 'The orchestrator has requested a graceful shutdown. Complete your current work, then provide your final status update or result before ending your session.\n\nAdditional shutdown context:\n---\nProvide the final status.\n---',
        },
      ],
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    notify('item/completed', {
      threadId: 'thread-manager-test',
      turnId: 'turn-3',
      item: { type: 'agentMessage', text: 'Final status delivered.' },
    });
    notify('turn/completed', {
      threadId: 'thread-manager-test',
      turn: { id: 'turn-3', status: 'completed' },
    });
    await manager.waitForAgentTerminal(started.id);
    expect(manager.getAgentSnapshot(started.id)).toBeUndefined();
    expect(mocked.connection.close).toHaveBeenCalledTimes(1);
  });
});
