import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TimConfig } from '../../configSchema.js';
import {
  createAgentManager,
  type AgentManager,
  type AgentPreparation,
  type PreparedAgentExecution,
} from '../../agent_messaging/index.js';
import {
  FakeAgentInputAdapter,
  FakeAgentManagerScheduler,
} from '../../agent_messaging/fake_provider.js';
import { STOP_AGENT_INACTIVITY_TIMEOUT_MS } from '../../agent_messaging/contracts.js';
import type { SessionProcessOwner } from '../../../common/session_process_control.js';
import { createCodexAgentLauncher } from './codex_agent_launcher.js';

interface TestConnection {
  isAlive: boolean;
  readonly threadId: string;
  readonly processControlId: string;
  readonly setGracefulEndHandler: ReturnType<typeof vi.fn>;
  readonly updateMetadata: ReturnType<typeof vi.fn>;
  readonly threadStart: ReturnType<typeof vi.fn>;
  readonly turnStart: ReturnType<typeof vi.fn>;
  readonly turnSteer: ReturnType<typeof vi.fn>;
  readonly turnInterrupt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  onNotification?: (method: string, params: unknown) => void;
  onServerRequest?: (method: string, id: number, params: unknown) => Promise<unknown>;
  onExit?: (event: { readonly exitCode: number | null; readonly signal?: NodeJS.Signals }) => void;
}

interface TestLogicalLifecycle {
  readonly markExited: ReturnType<typeof vi.fn>;
}

interface DynamicToolProviderLike {
  readonly handler: (params: unknown) => Promise<unknown>;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

type AppServerRequestHandler = (method: string, id: number, params: unknown) => Promise<unknown>;

const mocked = vi.hoisted(() => ({
  pendingConnections: [] as TestConnection[],
  connections: [] as TestConnection[],
  create: vi.fn(
    async (options: {
      readonly onNotification?: (method: string, params: unknown) => void;
      readonly onServerRequest?: AppServerRequestHandler;
      readonly onExit?: (event: {
        readonly exitCode: number | null;
        readonly signal?: NodeJS.Signals;
      }) => void;
    }): Promise<TestConnection> => {
      const connection = mocked.pendingConnections.shift();
      if (connection === undefined) throw new Error('No scripted Codex connection was queued');
      connection.onNotification = options.onNotification;
      connection.onServerRequest = options.onServerRequest;
      connection.onExit = options.onExit;
      mocked.connections.push(connection);
      return connection;
    }
  ),
  createRequestHandler: vi.fn(
    (
      dynamicToolProvider: DynamicToolProviderLike | undefined,
      approvalHandler: AppServerRequestHandler
    ): AppServerRequestHandler => {
      return async (method, id, params): Promise<unknown> => {
        if (method === 'item/tool/call') {
          if (dynamicToolProvider === undefined) {
            throw new Error('Dynamic tools were not installed');
          }
          return await dynamicToolProvider.handler(params);
        }
        return await approvalHandler(method, id, params);
      };
    }
  ),
  startInitialThread: vi.fn(async (connection: TestConnection, params: unknown) => {
    return await connection.threadStart(params);
  }),
}));

vi.mock('./app_server_connection.js', () => ({
  CodexAppServerConnection: { create: mocked.create },
}));
vi.mock('./app_server_runner.js', () => ({
  createAppServerRequestHandler: mocked.createRequestHandler,
  startInitialThread: mocked.startInitialThread,
}));
vi.mock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => true) }));
vi.mock('./app_server_approval.js', () => ({
  createApprovalHandler: vi.fn(() => vi.fn(async () => ({ decision: 'accept' }))),
}));
vi.mock('../../../logging', () => ({ debugLog: vi.fn(), sendStructured: vi.fn() }));

let activeManagers: AgentManager[] = [];

afterEach(async () => {
  await Promise.all(activeManagers.map((manager) => manager.close().catch(() => undefined)));
  activeManagers = [];
  mocked.pendingConnections.length = 0;
  mocked.connections.length = 0;
  mocked.create.mockClear();
  mocked.createRequestHandler.mockClear();
  mocked.startInitialThread.mockClear();
});

function createConnection(threadId: string, processControlId: string): TestConnection {
  let turnNumber = 0;
  let currentTurnId = `${threadId}-turn-0`;
  let connection!: TestConnection;

  connection = {
    isAlive: true,
    threadId,
    processControlId,
    setGracefulEndHandler: vi.fn(),
    updateMetadata: vi.fn(),
    threadStart: vi.fn(async () => ({ threadId })),
    turnStart: vi.fn(async () => {
      currentTurnId = `${threadId}-turn-${++turnNumber}`;
      return { turnId: currentTurnId };
    }),
    turnSteer: vi.fn(async () => ({ turnId: currentTurnId })),
    turnInterrupt: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      connection.isAlive = false;
    }),
  };
  return connection;
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

function createOwner(
  logicalLifecycles: TestLogicalLifecycle[]
): Pick<SessionProcessOwner, 'prepareLogicalExecutor'> {
  return {
    prepareLogicalExecutor: vi.fn(() => {
      const lifecycle = {
        processId: `codex-thread-process-${logicalLifecycles.length + 1}`,
        setGracefulEndHandler: vi.fn(),
        markStarted: vi.fn(),
        markExited: vi.fn(),
      };
      logicalLifecycles.push(lifecycle);
      return lifecycle;
    }),
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

async function createHarness(options: {
  readonly connections: readonly TestConnection[];
  readonly scheduler?: FakeAgentManagerScheduler;
}): Promise<{
  readonly manager: AgentManager;
  readonly root: { readonly id: string; readonly role: 'orchestrator' };
  readonly rootInput: FakeAgentInputAdapter;
  readonly logicalLifecycles: readonly TestLogicalLifecycle[];
}> {
  mocked.pendingConnections.push(...options.connections);
  const rootInput = new FakeAgentInputAdapter();
  rootInput.markReady();
  const logicalLifecycles: TestLogicalLifecycle[] = [];
  let manager: AgentManager | undefined;
  const dispatcher = {
    startAgent: (caller: Parameters<AgentManager['startAgent']>[0], request: unknown) =>
      manager!.startAgent(caller, request),
    listAgents: () => manager!.listAgents(),
    sendAgentMessage: (caller: Parameters<AgentManager['sendAgentMessage']>[0], request: unknown) =>
      manager!.sendAgentMessage(caller, request),
    stopAgent: (caller: Parameters<AgentManager['stopAgent']>[0], request: unknown) =>
      manager!.stopAgent(caller, request),
    finishAgent: (caller: Parameters<AgentManager['finishAgent']>[0], request: unknown) =>
      manager!.finishAgent(caller, request),
  };
  const launcher = createCodexAgentLauncher({
    dispatcher,
    sessionProcessOwner: createOwner(logicalLifecycles),
  });
  let nextId = 0;
  manager = await createAgentManager({
    orchestratorExecutor: 'codex-cli',
    agentPreparer: createPreparation(),
    agentLauncher: launcher,
    agentIdGenerator: () => `agent-codex-lifecycle-${++nextId}`,
    orchestratorInputAdapter: rootInput,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  });
  activeManagers.push(manager);
  return {
    manager,
    root: { id: manager.orchestratorIdentity.id, role: 'orchestrator' },
    rootInput,
    logicalLifecycles,
  };
}

async function startAgent(
  manager: AgentManager,
  root: { readonly id: string; readonly role: 'orchestrator' },
  name: string
): Promise<{ readonly id: string; readonly name: string }> {
  return await manager.startAgent(root, {
    name,
    type: 'implementer',
    executor: 'codex-cli',
    initialMessage: `Implement ${name}.`,
  });
}

function notify(connection: TestConnection, method: string, params: unknown): void {
  connection.onNotification?.(method, params);
}

function completeTurn(connection: TestConnection, turnId: string, message?: string): void {
  if (message !== undefined) {
    notify(connection, 'item/completed', {
      threadId: connection.threadId,
      turnId,
      item: { type: 'agentMessage', text: message },
    });
  }
  notify(connection, 'turn/completed', {
    threadId: connection.threadId,
    turn: { id: turnId, status: 'completed' },
  });
}

describe('Codex AgentManager lifecycle integration', () => {
  it('queues input during provider startup and drains it after readiness', async () => {
    const connection = createConnection('thread-starting', 'process-starting');
    const initialTurn = createDeferred<{ readonly turnId: string }>();
    connection.turnStart.mockImplementationOnce(() => initialTurn.promise);
    const { manager, root } = await createHarness({ connections: [connection] });

    const start = manager.startAgent(root, {
      name: 'starting-worker',
      type: 'implementer',
      executor: 'codex-cli',
      initialMessage: 'Start the assignment.',
    });
    await vi.waitFor(() => expect(connection.turnStart).toHaveBeenCalledTimes(1));

    const acknowledgement = await manager.sessionRuntime.sendMessage(
      { id: manager.orchestratorIdentity.id, name: manager.orchestratorIdentity.name },
      { id: manager.getIdentityByName('starting-worker')?.id, name: 'starting-worker' },
      { requestId: 'startup-message-1', content: 'Check the migration before coding.' }
    );
    expect(acknowledgement).toMatchObject({ success: true, delivery: 'queued' });
    expect(connection.turnSteer).not.toHaveBeenCalled();

    const secondAcknowledgement = await manager.sessionRuntime.sendMessage(
      { id: manager.orchestratorIdentity.id, name: manager.orchestratorIdentity.name },
      { id: manager.getIdentityByName('starting-worker')?.id, name: 'starting-worker' },
      { requestId: 'startup-message-2', content: 'Then update the focused tests.' }
    );
    expect(secondAcknowledgement).toMatchObject({ success: true, delivery: 'queued' });

    initialTurn.resolve({ turnId: 'thread-starting-turn-1' });
    const started = await start;
    await vi.waitFor(() => expect(connection.turnSteer).toHaveBeenCalledTimes(2));
    expect(connection.turnSteer.mock.calls.map(([request]) => request.input[0].text)).toEqual([
      'Check the migration before coding.',
      'Then update the focused tests.',
    ]);
    expect(connection.turnSteer).toHaveBeenNthCalledWith(1, {
      threadId: connection.threadId,
      input: [{ type: 'text', text: 'Check the migration before coding.' }],
      expectedTurnId: 'thread-starting-turn-1',
    });
    expect(connection.turnSteer).toHaveBeenNthCalledWith(2, {
      threadId: connection.threadId,
      input: [{ type: 'text', text: 'Then update the focused tests.' }],
      expectedTurnId: 'thread-starting-turn-1',
    });
    expect(manager.getAgentSnapshot(started.id)).toMatchObject({
      state: 'running-active',
      inputActivity: 'active',
    });
    await expect(
      manager.stopAgent(root, { name: 'starting-worker', force: true })
    ).resolves.toMatchObject({
      mode: 'forced',
      state: 'stopping',
    });
    await manager.waitForAgentTerminal(started.id);
  });

  it('queues an active steer rejection and retries the same message through the mailbox', async () => {
    const connection = createConnection('thread-steer-retry', 'process-steer-retry');
    connection.turnSteer.mockRejectedValueOnce(new Error('turn completion raced the steer'));
    const { manager, root } = await createHarness({ connections: [connection] });
    const started = await startAgent(manager, root, 'steer-retry-worker');

    await expect(
      manager.sendAgentMessage(root, {
        name: 'steer-retry-worker',
        message: 'Retry this exact message after the turn settles.',
      })
    ).resolves.toMatchObject({ delivery: 'queued' });

    await vi.waitFor(() => expect(connection.turnSteer).toHaveBeenCalledTimes(2));
    expect(connection.turnSteer.mock.calls.map(([request]) => request.input[0].text)).toEqual([
      'Retry this exact message after the turn settles.',
      'Retry this exact message after the turn settles.',
    ]);
    expect(connection.turnSteer).toHaveBeenLastCalledWith({
      threadId: connection.threadId,
      input: [{ type: 'text', text: 'Retry this exact message after the turn settles.' }],
      expectedTurnId: 'thread-steer-retry-turn-1',
    });

    await expect(
      manager.stopAgent(root, { name: 'steer-retry-worker', force: true })
    ).resolves.toMatchObject({ mode: 'forced' });
    await manager.waitForAgentTerminal(started.id);
  });

  it('finishes through the real dynamic tool and closes after the completed turn', async () => {
    const connection = createConnection('thread-finish', 'process-finish');
    const { manager, root, rootInput } = await createHarness({ connections: [connection] });
    const started = await startAgent(manager, root, 'finish-worker');

    const toolResult = await connection.onServerRequest?.('item/tool/call', 1, {
      threadId: connection.threadId,
      turnId: 'thread-finish-turn-1',
      callId: 'finish-call',
      tool: 'FinishAgent',
      arguments: { message: 'Finished the implementation.' },
    });

    expect(toolResult).toMatchObject({ success: true });
    expect(connection.close).not.toHaveBeenCalled();
    expect(manager.getAgentSnapshot(started.id)).toMatchObject({ state: 'finishing' });

    completeTurn(connection, 'thread-finish-turn-1', 'Finished the implementation.');
    await manager.waitForAgentTerminal(started.id);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('Finished the implementation.');
    expect(manager.getAgentSnapshot(started.id)).toBeUndefined();
  });

  it('uses active graceful steering once and resets the manager timer on provider output', async () => {
    const scheduler = new FakeAgentManagerScheduler();
    const connection = createConnection('thread-graceful-active', 'process-graceful-active');
    const { manager, root, rootInput } = await createHarness({
      connections: [connection],
      scheduler,
    });
    const started = await startAgent(manager, root, 'graceful-worker');

    await expect(
      manager.stopAgent(root, {
        name: 'graceful-worker',
        message: 'Report the final status.',
      })
    ).resolves.toMatchObject({ mode: 'graceful-requested', state: 'stopping' });
    expect(connection.turnSteer).toHaveBeenCalledTimes(1);
    expect(connection.turnSteer).toHaveBeenCalledWith({
      threadId: connection.threadId,
      input: [
        {
          type: 'text',
          text: 'The orchestrator has requested a graceful shutdown. Complete your current work, then provide your final status update or result before ending your session.\n\nAdditional shutdown context:\n---\nReport the final status.\n---',
        },
      ],
      expectedTurnId: 'thread-graceful-active-turn-1',
    });

    await vi.waitFor(() => expect(scheduler.pendingTimerCount).toBe(1));
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS / 2);
    notify(connection, 'item/agentMessage/delta', {
      threadId: connection.threadId,
      turnId: 'thread-graceful-active-turn-1',
      delta: 'Still working on the final status.',
    });
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS / 2 + 1);
    await Promise.resolve();
    expect(connection.turnInterrupt).not.toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();

    completeTurn(connection, 'thread-graceful-active-turn-1', 'Final status delivered.');
    await manager.waitForAgentTerminal(started.id);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(connection.turnInterrupt).not.toHaveBeenCalled();
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('Final status delivered.');
  });

  it('force-escalates a graceful request whose steer RPC never answers', async () => {
    const scheduler = new FakeAgentManagerScheduler();
    const connection = createConnection('thread-graceful-wedged', 'process-graceful-wedged');
    const neverAnswered = createDeferred<{ readonly turnId: string }>();
    connection.turnSteer.mockImplementationOnce(() => neverAnswered.promise);
    const { manager, root } = await createHarness({
      connections: [connection],
      scheduler,
    });
    const started = await startAgent(manager, root, 'graceful-wedged-worker');

    await expect(
      manager.stopAgent(root, {
        name: 'graceful-wedged-worker',
        message: 'Report the final status.',
      })
    ).resolves.toMatchObject({ mode: 'graceful-requested', state: 'stopping' });
    await vi.waitFor(() => expect(connection.turnSteer).toHaveBeenCalledTimes(1));
    expect(scheduler.pendingTimerCount).toBe(1);

    const teardown = manager.close();
    scheduler.advanceBy(STOP_AGENT_INACTIVITY_TIMEOUT_MS);
    await teardown;

    expect(connection.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
    await manager.waitForAgentTerminal(started.id);
  });

  it('force-stops once, upgrades a finishing agent, and rejects later input', async () => {
    const connection = createConnection('thread-force', 'process-force');
    const { manager, root, rootInput } = await createHarness({ connections: [connection] });
    const started = await startAgent(manager, root, 'force-worker');

    const toolResult = await connection.onServerRequest?.('item/tool/call', 2, {
      threadId: connection.threadId,
      turnId: 'thread-force-turn-1',
      callId: 'finish-call',
      tool: 'FinishAgent',
      arguments: {},
    });
    expect(toolResult).toMatchObject({ success: true });

    const firstForce = manager.stopAgent(root, { name: 'force-worker', force: true });
    const secondForce = manager.stopAgent(root, { name: 'force-worker', force: true });
    await expect(Promise.all([firstForce, secondForce])).resolves.toEqual([
      { name: 'force-worker', mode: 'forced', state: 'stopping' },
      { name: 'force-worker', mode: 'forced', state: 'stopping' },
    ]);
    await manager.waitForAgentTerminal(started.id);

    expect(connection.turnInterrupt).toHaveBeenCalledTimes(1);
    expect(connection.turnInterrupt).toHaveBeenCalledWith({
      threadId: connection.threadId,
      turnId: 'thread-force-turn-1',
    });
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('stale or out of context');
    await expect(
      manager.sendAgentMessage(root, { name: 'force-worker', message: 'Too late.' })
    ).rejects.toMatchObject({ code: 'unknown_target' });
  });

  it('preserves forced terminal context when close cleanup fails', async () => {
    const connection = createConnection('thread-close-error', 'process-close-error');
    const closeError = new Error('connection close failed');
    connection.close.mockImplementationOnce(async () => {
      connection.isAlive = false;
      throw closeError;
    });
    const { manager, root, rootInput, logicalLifecycles } = await createHarness({
      connections: [connection],
    });
    const started = await startAgent(manager, root, 'close-error-worker');
    completeTurn(connection, 'thread-close-error-turn-1', 'Last completed result.');

    await expect(
      manager.stopAgent(root, { name: 'close-error-worker', force: true })
    ).resolves.toMatchObject({
      mode: 'forced',
      state: 'stopping',
    });
    await manager.waitForAgentTerminal(started.id);

    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(logicalLifecycles[0]?.markExited).toHaveBeenCalledTimes(1);
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('Last completed result.');
    expect(rootInput.receivedMessages[0]?.content).toContain('stale or out of context');
    expect(manager.getAgentSnapshot(started.id)).toBeUndefined();
  });

  it('classifies an unexpected provider exit once and ignores late callbacks', async () => {
    const connection = createConnection('thread-crash', 'process-crash');
    const { manager, root, rootInput, logicalLifecycles } = await createHarness({
      connections: [connection],
    });
    const started = await startAgent(manager, root, 'crash-worker');

    connection.onExit?.({ exitCode: 17 });
    connection.onExit?.({ exitCode: 18 });
    notify(connection, 'item/completed', {
      threadId: connection.threadId,
      turnId: 'thread-crash-turn-1',
      item: { type: 'agentMessage', text: 'late partial result' },
    });
    notify(connection, 'turn/completed', {
      threadId: connection.threadId,
      turn: { id: 'thread-crash-turn-1', status: 'completed' },
    });

    await manager.waitForAgentTerminal(started.id);
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(logicalLifecycles[0]?.markExited).toHaveBeenCalledTimes(1);
    expect(rootInput.receivedMessages).toHaveLength(1);
    expect(rootInput.receivedMessages[0]?.content).toContain('failed');
    expect(rootInput.receivedMessages[0]?.content).not.toContain('late partial result');
    expect(manager.getAgentSnapshot(started.id)).toBeUndefined();
  });

  it('tears down two active agents in parallel without crossing callback identity', async () => {
    const first = createConnection('thread-first', 'process-first');
    const second = createConnection('thread-second', 'process-second');
    const { manager, root } = await createHarness({ connections: [first, second] });
    const firstStarted = await startAgent(manager, root, 'first-worker');
    const secondStarted = await startAgent(manager, root, 'second-worker');

    const teardown = manager.close();
    await vi.waitFor(() => {
      expect(first.turnSteer).toHaveBeenCalledTimes(1);
      expect(second.turnSteer).toHaveBeenCalledTimes(1);
    });
    expect(first.turnSteer).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-first', expectedTurnId: 'thread-first-turn-1' })
    );
    expect(second.turnSteer).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-second', expectedTurnId: 'thread-second-turn-1' })
    );

    completeTurn(first, 'thread-first-turn-1', 'First final status.');
    completeTurn(second, 'thread-second-turn-1', 'Second final status.');
    await teardown;

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(manager.getAgentSnapshot(firstStarted.id)).toBeUndefined();
    expect(manager.getAgentSnapshot(secondStarted.id)).toBeUndefined();
  });

  it('keeps one agent alive when the other completes and stops in reverse order', async () => {
    const first = createConnection('thread-reverse-first', 'process-reverse-first');
    const second = createConnection('thread-reverse-second', 'process-reverse-second');
    const { manager, root } = await createHarness({ connections: [first, second] });
    const firstStarted = await startAgent(manager, root, 'reverse-first');
    const secondStarted = await startAgent(manager, root, 'reverse-second');

    completeTurn(first, 'thread-reverse-first-turn-1', 'First completed normally.');
    await vi.waitFor(() =>
      expect(manager.getAgentSnapshot(firstStarted.id)?.state).toBe('running-idle')
    );
    await expect(
      manager.stopAgent(root, { name: 'reverse-second', force: true })
    ).resolves.toMatchObject({ mode: 'forced' });
    await manager.waitForAgentTerminal(secondStarted.id);

    expect(manager.getAgentSnapshot(firstStarted.id)).toMatchObject({
      identity: { name: 'reverse-first' },
      state: 'running-idle',
      providerThreadId: 'thread-reverse-first',
    });
    expect(second.isAlive).toBe(false);
    expect(first.isAlive).toBe(true);
    expect(first.close).not.toHaveBeenCalled();

    await expect(
      manager.stopAgent(root, { name: 'reverse-first', force: true })
    ).resolves.toMatchObject({ mode: 'forced' });
    await manager.waitForAgentTerminal(firstStarted.id);
    expect(first.close).toHaveBeenCalledTimes(1);
  });
});
