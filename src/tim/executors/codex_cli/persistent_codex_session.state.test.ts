import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TimConfig } from '../../configSchema.js';
import type {
  AgentIdentity,
  AgentInputMessage,
} from '../../agent_messaging/agent_manager_types.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import type { CodexAgentToolDispatcher } from './codex_agent_tools.js';
import type { CodexPersistentAgentLifecycleCallbacks } from './persistent_agent_contract.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface TestConnection {
  isAlive: boolean;
  readonly pid: number;
  readonly processControlId: string;
  readonly setGracefulEndHandler: ReturnType<typeof vi.fn>;
  readonly updateMetadata: ReturnType<typeof vi.fn>;
  readonly turnStart: ReturnType<typeof vi.fn>;
  readonly turnSteer: ReturnType<typeof vi.fn>;
  readonly turnInterrupt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value: T): void => resolvePromise?.(value),
    reject: (error: unknown): void => rejectPromise?.(error),
  };
}

function createIdentity(): AgentIdentity {
  return {
    id: 'agent-state-test' as AgentIdentity['id'],
    name: 'state-test-agent' as AgentIdentity['name'],
    role: 'subagent',
    type: 'implementer',
    executor: 'codex-cli',
  };
}

function createCallbacks(): CodexPersistentAgentLifecycleCallbacks {
  return {
    outputActivity: vi.fn(),
    completedAssistantMessage: vi.fn(),
    turnComplete: vi.fn(),
    exit: vi.fn(),
  };
}

interface Harness {
  readonly handle: Awaited<
    ReturnType<(typeof import('./persistent_codex_session.js'))['startPersistentCodexAgent']>
  >;
  readonly callbacks: CodexPersistentAgentLifecycleCallbacks;
  readonly connection: TestConnection;
  readonly initialTurn: Deferred<{ turnId: string }>;
  readonly tunnelServerReady: Deferred<{ close: ReturnType<typeof vi.fn> }>;
  readonly tunnelServerClose: ReturnType<typeof vi.fn>;
  readonly tunnelCreate: ReturnType<typeof vi.fn>;
  readonly notify: (method: string, params: unknown) => void;
}

async function createHarness(
  options: {
    readonly resolveInitialTurn?: boolean;
    readonly earlyThreadId?: string;
    readonly tunnelActive?: boolean;
    readonly assertReady?: boolean;
    readonly waitForInitialTurn?: boolean;
  } = {}
): Promise<Harness> {
  vi.resetModules();

  const initialTurn = createDeferred<{ turnId: string }>();
  const tunnelServerReady = createDeferred<{ close: ReturnType<typeof vi.fn> }>();
  const tunnelServerClose = vi.fn();
  const tunnelCreate = vi.fn(async () => tunnelServerReady.promise);
  let notify: ((method: string, params: unknown) => void) | undefined;
  const connection: TestConnection = {
    isAlive: true,
    pid: 1234,
    processControlId: 'codex-process-state-test',
    setGracefulEndHandler: vi.fn(),
    updateMetadata: vi.fn(),
    turnStart: vi.fn(() => initialTurn.promise),
    turnSteer: vi.fn(async () => ({ turnId: 'turn-1' })),
    turnInterrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const logicalLifecycle = {
    processId: 'logical-process-state-test',
    setGracefulEndHandler: vi.fn(),
    markStarted: vi.fn(),
    markExited: vi.fn(),
  };
  const owner = {
    prepareLogicalExecutor: vi.fn(() => logicalLifecycle),
  };
  const connectionCreate = vi.fn(async (options: { onNotification?: typeof notify }) => {
    notify = options.onNotification;
    return connection;
  });

  vi.doMock('./app_server_connection.js', () => ({
    CodexAppServerConnection: { create: connectionCreate },
  }));
  vi.doMock('./app_server_runner.js', () => ({
    createAppServerRequestHandler: vi.fn(() => vi.fn(async () => ({ success: true }))),
    startInitialThread: vi.fn(async () => {
      if (options.earlyThreadId !== undefined) {
        notify?.('thread/started', { threadId: options.earlyThreadId });
      }
      return { threadId: 'thread-state-test' };
    }),
  }));
  vi.doMock('../../../common/session_process_control.js', () => ({
    getCurrentSessionProcessOwner: vi.fn(() => owner),
  }));
  vi.doMock('../../../logging', () => ({
    debugLog: vi.fn(),
    sendStructured: vi.fn(),
  }));
  vi.doMock('../../../logging/tunnel_client.js', () => ({
    isTunnelActive: vi.fn(() => options.tunnelActive !== false),
  }));
  vi.doMock('../../../logging/tunnel_server.js', () => ({
    createExecutorTunnelServer: tunnelCreate,
  }));
  vi.doMock('./app_server_approval.js', () => ({
    createApprovalHandler: vi.fn(() => vi.fn(async () => ({ decision: 'accept' }))),
  }));

  const { createCodexAgentToolProvider } = await import('./codex_agent_tools.js');
  const { CODEX_PERSISTENT_AGENT_MODE } = await import('./persistent_agent_contract.js');
  const { startPersistentCodexAgent } = await import('./persistent_codex_session.js');
  const identity = createIdentity();
  const callbacks = createCallbacks();
  const dispatcher: CodexAgentToolDispatcher = {
    startAgent: async () => ({
      name: 'other-agent',
      id: 'other-id',
      type: 'tester',
      executor: 'codex-cli',
      state: 'starting',
    }),
    listAgents: () => ({ agents: [] }),
    sendAgentMessage: async () => ({
      name: 'other-agent',
      messageId: 'message-id',
      delivery: 'queued',
    }),
    stopAgent: async () => ({
      name: 'other-agent',
      mode: 'graceful-requested',
      state: 'stopping',
    }),
    finishAgent: async () => ({ state: 'finishing' }),
  };
  const provider = createCodexAgentToolProvider({ caller: identity, dispatcher });
  const handle = await startPersistentCodexAgent({
    mode: CODEX_PERSISTENT_AGENT_MODE,
    identity,
    prompt: 'Initial assignment',
    cwd: '/repo',
    timConfig: {} as TimConfig,
    dynamicToolProvider: provider,
    processLabel: formatAgentProcessLabel('codex-cli', identity.name),
    lifecycleCallbacks: callbacks,
    sessionProcessOwner: owner,
  });

  if (options.waitForInitialTurn !== false) {
    await vi.waitFor(() => expect(connection.turnStart).toHaveBeenCalledTimes(1));
  }
  if (options.resolveInitialTurn !== false) {
    initialTurn.resolve({ turnId: 'turn-1' });
    if (options.assertReady !== false) {
      await expect(handle.ready).resolves.toBeUndefined();
    }
  }

  return {
    handle,
    callbacks,
    connection,
    initialTurn,
    tunnelServerReady,
    tunnelServerClose,
    tunnelCreate,
    notify: (method: string, params: unknown): void => {
      notify?.(method, params);
    },
  };
}

function inputMessage(content: string, messageId: string): AgentInputMessage {
  return {
    content,
    messageId,
    source: createIdentity(),
  };
}

function completeTurn(
  harness: Harness,
  turnId: string,
  message?: string,
  status: string = 'completed'
): void {
  if (message !== undefined) {
    harness.notify('item/completed', {
      threadId: 'thread-state-test',
      turnId,
      item: { type: 'agentMessage', text: message },
    });
  }
  harness.notify('turn/completed', {
    threadId: 'thread-state-test',
    turn: { id: turnId, status },
  });
}

describe('persistent Codex turn state machine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CODEX_USE_APP_SERVER;
  });

  it('steers an active turn only after Codex accepts the expected turn', async () => {
    const harness = await createHarness();

    await expect(
      harness.handle.input.deliver(inputMessage('Check the migration.', 'message-1'))
    ).resolves.toBe('steered');
    expect(harness.connection.turnSteer).toHaveBeenCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'Check the migration.' }],
      expectedTurnId: 'turn-1',
    });
  });

  it('keeps a rejected active steer temporarily unavailable and restores active readiness', async () => {
    const harness = await createHarness();
    const availability: string[] = [];
    const unsubscribe = harness.handle.input.onAvailabilityChange(() => {
      availability.push(harness.handle.input.activity);
    });
    harness.connection.turnSteer.mockRejectedValueOnce(new Error('turn already completed'));

    await expect(
      harness.handle.input.deliver(inputMessage('Retry after rejection', 'message-rejected'))
    ).resolves.toBe('temporarily-unavailable');
    expect(availability).toContain('temporarily-unavailable');
    expect(availability.at(-1)).toBe('active');

    await expect(
      harness.handle.input.deliver(inputMessage('Accepted follow-up', 'message-accepted'))
    ).resolves.toBe('steered');
    expect(harness.connection.turnSteer).toHaveBeenLastCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'Accepted follow-up' }],
      expectedTurnId: 'turn-1',
    });
    unsubscribe();
  });

  it('keeps later input temporarily unavailable while the initial turn start is pending', async () => {
    const harness = await createHarness({ resolveInitialTurn: false });

    expect(harness.handle.input.isReady).toBe(false);
    await expect(
      harness.handle.input.deliver(inputMessage('Arrived during startup', 'message-startup'))
    ).resolves.toBe('temporarily-unavailable');
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(1);

    harness.initialTurn.resolve({ turnId: 'turn-1' });
    await expect(harness.handle.ready).resolves.toBeUndefined();
  });

  it('returns temporary unavailability for concurrent idle sends while one start is pending', async () => {
    const harness = await createHarness();
    const availability: string[] = [];
    const unsubscribe = harness.handle.input.onAvailabilityChange(() => {
      availability.push(harness.handle.input.activity);
    });
    completeTurn(harness, 'turn-1', 'Initial result');
    const nextTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => nextTurn.promise);

    const first = harness.handle.input.deliver(inputMessage('First idle message', 'message-2'));
    await vi.waitFor(() => expect(harness.connection.turnStart).toHaveBeenCalledTimes(2));
    await expect(
      harness.handle.input.deliver(inputMessage('Second idle message', 'message-3'))
    ).resolves.toBe('temporarily-unavailable');

    nextTurn.resolve({ turnId: 'turn-2' });
    await expect(first).resolves.toBe('started-idle-turn');
    expect(harness.connection.turnStart).toHaveBeenLastCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'First idle message' }],
      model: undefined,
      effort: 'medium',
    });

    await expect(
      harness.handle.input.deliver(inputMessage('Retry the second message', 'message-3'))
    ).resolves.toBe('steered');
    expect(harness.connection.turnSteer).toHaveBeenCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'Retry the second message' }],
      expectedTurnId: 'turn-2',
    });
    expect(availability).toContain('temporarily-unavailable');
    expect(availability.at(-1)).toBe('active');
    unsubscribe();
  });

  it('reconciles turn/started before the turn/start response', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1');
    const nextTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => nextTurn.promise);

    const delivery = harness.handle.input.deliver(inputMessage('Continue work', 'message-2'));
    await vi.waitFor(() => expect(harness.connection.turnStart).toHaveBeenCalledTimes(2));
    harness.notify('turn/started', {
      threadId: 'thread-state-test',
      turn: { id: 'turn-2' },
    });
    nextTurn.resolve({ turnId: 'turn-2' });

    await expect(delivery).resolves.toBe('started-idle-turn');
    expect(harness.handle.providerState).toBe('running-active');
  });

  it('turns an idle turn-start failure into one provider failure without retrying', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1');
    harness.connection.turnStart.mockRejectedValueOnce(new Error('idle turn start failed'));

    await expect(
      harness.handle.input.deliver(inputMessage('Start failed', 'message-failed-start'))
    ).rejects.toThrow('idle turn start failed');
    await expect(harness.handle.completion).resolves.toMatchObject({ error: expect.any(Error) });
    expect(harness.connection.turnStart).toHaveBeenCalledTimes(2);
    expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('failed', expect.any(Error));
  });

  it('reconciles alternate turn ID fields from notifications', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1');
    const nextTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => nextTurn.promise);

    const delivery = harness.handle.input.deliver(inputMessage('Use alternate IDs', 'message-2'));
    await vi.waitFor(() => expect(harness.connection.turnStart).toHaveBeenCalledTimes(2));
    harness.notify('turn/started', {
      thread_id: 'thread-state-test',
      turn: { turn_id: 'turn-2' },
    });
    nextTurn.resolve({ turnId: 'turn-2' });
    await expect(delivery).resolves.toBe('started-idle-turn');

    harness.notify('turn/completed', {
      thread_id: 'thread-state-test',
      turn: { turn_id: 'turn-2', status: 'completed' },
    });
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge a steer rejected by a completion race', async () => {
    const harness = await createHarness();
    const steer = createDeferred<{ turnId: string }>();
    harness.connection.turnSteer.mockImplementationOnce(() => steer.promise);

    const delivery = harness.handle.input.deliver(inputMessage('Race this turn', 'message-2'));
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));
    completeTurn(harness, 'turn-1', 'Completed before steer response');
    steer.reject(new Error('turn is already complete'));

    await expect(delivery).resolves.toBe('temporarily-unavailable');
    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledWith(
      'Completed before steer response'
    );
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(1);
  });

  it('reports a conflicting completion turn ID as one provider failure', async () => {
    const harness = await createHarness();

    harness.notify('turn/completed', {
      threadId: 'thread-state-test',
      turn: { id: 'unexpected-turn', status: 'completed' },
    });

    await expect(harness.handle.completion).resolves.toMatchObject({ error: expect.any(Error) });
    expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('failed', expect.any(Error));
    expect(harness.callbacks.turnComplete).not.toHaveBeenCalled();
  });

  it('reports one result per completed turn and isolates empty and duplicate completions', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1', 'First result');
    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(1);

    const secondTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => secondTurn.promise);
    const secondDelivery = harness.handle.input.deliver(inputMessage('Second task', 'message-2'));
    secondTurn.resolve({ turnId: 'turn-2' });
    await expect(secondDelivery).resolves.toBe('started-idle-turn');
    completeTurn(harness, 'turn-2', 'Second result');
    completeTurn(harness, 'turn-2', 'Stale duplicate');
    harness.notify('thread/status/changed', {
      threadId: 'thread-state-test',
      status: { type: 'idle' },
    });

    expect(harness.callbacks.completedAssistantMessage).toHaveBeenLastCalledWith('Second result');
    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledTimes(2);
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(2);

    const thirdTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => thirdTurn.promise);
    const thirdDelivery = harness.handle.input.deliver(inputMessage('Empty task', 'message-3'));
    thirdTurn.resolve({ turnId: 'turn-3' });
    await expect(thirdDelivery).resolves.toBe('started-idle-turn');
    completeTurn(harness, 'turn-3');

    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledTimes(2);
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(3);
    expect(harness.handle.providerState).toBe('running-idle');
  });

  it('reports a completed result before turn completion and ignores a prior-turn item', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1', 'First result');

    const secondTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => secondTurn.promise);
    const secondDelivery = harness.handle.input.deliver(inputMessage('Second task', 'message-2'));
    secondTurn.resolve({ turnId: 'turn-2' });
    await expect(secondDelivery).resolves.toBe('started-idle-turn');

    harness.notify('item/completed', {
      threadId: 'thread-state-test',
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: 'Late first result' },
    });
    completeTurn(harness, 'turn-2');

    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledWith('First result');
    expect(harness.callbacks.completedAssistantMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.callbacks.turnComplete.mock.invocationCallOrder[1]
    );
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(2);
  });

  it('reports only owned provider activity and fails an unrecoverable turn', async () => {
    const harness = await createHarness();
    harness.notify('account/rateLimits/updated', { rateLimits: {} });
    harness.notify('item/started', {
      threadId: 'other-thread',
      item: { type: 'reasoning', text: 'Not this agent' },
    });
    expect(harness.callbacks.outputActivity).not.toHaveBeenCalled();

    harness.notify('item/started', {
      threadId: 'thread-state-test',
      item: { type: 'reasoning', text: 'Owned progress' },
    });
    expect(harness.callbacks.outputActivity).toHaveBeenCalledTimes(1);

    harness.notify('item/completed', {
      threadId: 'thread-state-test',
      item: {
        type: 'UserMessage',
        content: [{ type: 'text', text: 'Local input echo' }],
      },
    });
    expect(harness.callbacks.outputActivity).toHaveBeenCalledTimes(1);

    harness.notify('item/agentMessage/delta', {
      threadId: 'thread-state-test',
      delta: 'Provider output without a structured message',
    });
    expect(harness.callbacks.outputActivity).toHaveBeenCalledTimes(2);

    completeTurn(harness, 'turn-1', undefined, 'interrupted');
    await expect(harness.handle.completion).resolves.toMatchObject({
      error: expect.any(Error),
    });
    expect(harness.callbacks.turnComplete).not.toHaveBeenCalled();
    expect(harness.callbacks.exit).toHaveBeenCalledWith('failed', expect.any(Error));
    harness.notify('turn/completed', {
      threadId: 'thread-state-test',
      turn: { id: 'turn-1', status: 'interrupted' },
    });
    expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
  });

  it('records FinishAgent close intent and closes after assistant output and turn completion', async () => {
    const harness = await createHarness();

    await expect(harness.handle.lifecycle.requestCloseAfterCurrentTurn()).resolves.toBe('accepted');
    expect(harness.connection.close).not.toHaveBeenCalled();

    completeTurn(harness, 'turn-1', 'Final implementation status');
    await expect(harness.handle.completion).resolves.toMatchObject({
      finalMessage: 'Final implementation status',
    });
    expect(harness.callbacks.completedAssistantMessage).toHaveBeenCalledWith(
      'Final implementation status'
    );
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('graceful', undefined);
  });

  it('delivers an active graceful-stop instruction through turn/steer', async () => {
    const harness = await createHarness();

    await expect(
      harness.handle.lifecycle.requestGracefulShutdown('Summarize the changed files.')
    ).resolves.toBe('accepted');
    expect(harness.connection.turnSteer).toHaveBeenLastCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'Summarize the changed files.' }],
      expectedTurnId: 'turn-1',
    });
    expect(harness.connection.close).not.toHaveBeenCalled();

    completeTurn(harness, 'turn-1', 'Changed files: ...');
    await expect(harness.handle.completion).resolves.toMatchObject({
      finalMessage: 'Changed files: ...',
    });
    expect(harness.callbacks.exit).toHaveBeenCalledWith('graceful', undefined);
  });

  it('closes when graceful steering races the completed-turn notification', async () => {
    const harness = await createHarness();
    const steer = createDeferred<{ turnId: string }>();
    harness.connection.turnSteer.mockImplementationOnce(() => steer.promise);

    const request = harness.handle.lifecycle.requestGracefulShutdown('Finish this turn.');
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));
    completeTurn(harness, 'turn-1', 'Turn completed during shutdown request');
    steer.resolve({ turnId: 'turn-1' });

    await expect(request).resolves.toBe('already-exited');
    await expect(harness.handle.completion).resolves.toMatchObject({
      finalMessage: 'Turn completed during shutdown request',
    });
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  it('starts a final idle graceful-stop turn on the existing thread', async () => {
    const harness = await createHarness();
    completeTurn(harness, 'turn-1', 'Initial result');

    const finalTurn = createDeferred<{ turnId: string }>();
    harness.connection.turnStart.mockImplementationOnce(() => finalTurn.promise);
    const request = harness.handle.lifecycle.requestGracefulShutdown('Give the final status.');
    await vi.waitFor(() => expect(harness.connection.turnStart).toHaveBeenCalledTimes(2));
    expect(harness.connection.turnStart).toHaveBeenLastCalledWith({
      threadId: 'thread-state-test',
      input: [{ type: 'text', text: 'Give the final status.' }],
      model: undefined,
      effort: 'medium',
    });
    expect(harness.connection.close).not.toHaveBeenCalled();

    finalTurn.resolve({ turnId: 'turn-2' });
    await expect(request).resolves.toBe('accepted');
    completeTurn(harness, 'turn-2', 'Final status');
    await expect(harness.handle.completion).resolves.toMatchObject({
      finalMessage: 'Final status',
    });
    expect(harness.callbacks.turnComplete).toHaveBeenCalledTimes(2);
  });

  it('interrupts and closes once for duplicate forced-stop requests', async () => {
    const harness = await createHarness();

    const first = harness.handle.lifecycle.requestForcedShutdown();
    const second = harness.handle.lifecycle.requestForcedShutdown();
    await expect(first).resolves.toBe('accepted');
    await expect(second).resolves.toBe('accepted');
    expect(harness.connection.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnInterrupt).toHaveBeenCalledWith({
      threadId: 'thread-state-test',
      turnId: 'turn-1',
    });
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('forced', undefined);
  });

  it('upgrades an active graceful stop to force and rejects new input', async () => {
    const harness = await createHarness();
    const steer = createDeferred<{ turnId: string }>();
    harness.connection.turnSteer.mockImplementationOnce(() => steer.promise);

    const graceful = harness.handle.lifecycle.requestGracefulShutdown('Final status, please.');
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));
    await expect(
      harness.handle.input.deliver(inputMessage('Must not be accepted', 'message-after-stop'))
    ).resolves.toBe('temporarily-unavailable');

    const forced = harness.handle.lifecycle.requestForcedShutdown();
    await expect(forced).resolves.toBe('accepted');
    expect(harness.connection.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);

    steer.resolve({ turnId: 'turn-1' });
    await expect(graceful).resolves.toBe('already-exited');
    await expect(harness.handle.completion).resolves.toMatchObject({});
    expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('forced', undefined);
  });

  it('ignores a late turn/start response after production-style forced close', async () => {
    const harness = await createHarness({ resolveInitialTurn: false });
    harness.connection.close.mockImplementationOnce(async () => {
      harness.connection.isAlive = false;
    });

    const forced = harness.handle.lifecycle.requestForcedShutdown();
    await expect(forced).resolves.toBe('accepted');
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
    expect(harness.connection.turnInterrupt).not.toHaveBeenCalled();

    harness.initialTurn.resolve({ turnId: 'turn-late' });
    await Promise.resolve();
    expect(harness.connection.turnInterrupt).not.toHaveBeenCalled();
    await expect(harness.handle.completion).resolves.toMatchObject({});
  });

  it('wakes a graceful control waiting for startup when forced close begins', async () => {
    const harness = await createHarness({ resolveInitialTurn: false });
    const graceful = harness.handle.lifecycle.requestGracefulShutdown('Provide the final status.');

    await expect(harness.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    await expect(graceful).resolves.toBe('already-exited');
    await expect(harness.handle.completion).resolves.toMatchObject({});
  });

  it('preserves forced classification and diagnostics when connection close fails', async () => {
    const harness = await createHarness();
    harness.connection.close.mockRejectedValueOnce(new Error('close failed'));

    await expect(harness.handle.lifecycle.requestForcedShutdown()).resolves.toBe('accepted');
    await expect(harness.handle.completion).resolves.toMatchObject({
      error: expect.objectContaining({ message: 'close failed' }),
    });
    expect(harness.callbacks.exit).toHaveBeenCalledTimes(1);
    expect(harness.callbacks.exit).toHaveBeenCalledWith('forced', expect.any(Error));
    expect(harness.callbacks.exit.mock.calls[0]?.[1]).toMatchObject({
      message: 'close failed',
    });
  });

  it('keeps an early owned thread/started notification for startup observability', async () => {
    const harness = await createHarness({ earlyThreadId: 'thread-state-test' });

    expect(harness.handle.providerThreadId).toBe('thread-state-test');
    expect(harness.callbacks.outputActivity).toHaveBeenCalledTimes(1);
  });

  it('rejects an unrelated early thread/started notification', async () => {
    const harness = await createHarness({
      earlyThreadId: 'unrelated-thread',
      assertReady: false,
      waitForInitialTurn: false,
    });

    await expect(harness.handle.ready).rejects.toThrow(/conflicting thread IDs/i);
    await expect(harness.handle.completion).resolves.toMatchObject({
      error: expect.objectContaining({ message: expect.stringMatching(/conflicting thread IDs/i) }),
    });
    expect(harness.handle.providerThreadId).toBeUndefined();
  });

  it('closes a tunnel created after forced startup close and removes its temp directory', async () => {
    const harness = await createHarness({
      tunnelActive: false,
      waitForInitialTurn: false,
      assertReady: false,
    });
    await vi.waitFor(() => expect(harness.tunnelCreate).toHaveBeenCalledTimes(1));
    const socketPath = harness.tunnelCreate.mock.calls[0]?.[0] as string;
    const release = harness.handle.release?.();

    harness.tunnelServerReady.resolve({ close: harness.tunnelServerClose });
    await expect(release).resolves.toBeUndefined();
    await expect(harness.handle.completion).resolves.toMatchObject({});
    await vi.waitFor(() => expect(harness.tunnelServerClose).toHaveBeenCalledTimes(1));
    await expect(fs.stat(path.dirname(socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
