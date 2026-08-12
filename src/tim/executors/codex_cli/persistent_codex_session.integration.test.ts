import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentIdentity,
  AgentProviderLifecycleObserver,
} from '../../agent_messaging/agent_manager_types.js';
import { formatAgentProcessLabel } from '../../agent_messaging/agent_process_labels.js';
import {
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from '../../../common/session_process_control.js';
import {
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
} from '../../../common/session_process.js';
import { TIM_CODEX_APP_SERVER_SOCKET } from './app_server_connection.js';
import {
  createCodexAgentToolProvider,
  type CodexAgentToolDispatcher,
} from './codex_agent_tools.js';
import { CODEX_PERSISTENT_AGENT_MODE } from './persistent_agent_contract.js';
import { startPersistentCodexAgent } from './persistent_codex_session.js';

interface MockCodexFixture {
  readonly rootDir: string;
  readonly mode: 'normal' | 'dynamic-tool' | 'reject-thread-start' | 'crash-after-start';
  readonly serverPath: string;
  readonly codexPath: string;
  readonly spawnLogPath: string;
  readonly requestLogPath: string;
  readonly responseLogPath: string;
}

async function createMockCodexFixture(
  mode: 'normal' | 'dynamic-tool' | 'reject-thread-start' | 'crash-after-start'
): Promise<MockCodexFixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persistent-codex-fixture-'));
  const serverPath = path.join(rootDir, 'mock-app-server.ts');
  const codexPath = path.join(rootDir, 'codex');
  const spawnLogPath = path.join(rootDir, 'spawn.log');
  const requestLogPath = path.join(rootDir, 'requests.jsonl');
  const responseLogPath = path.join(rootDir, 'responses.jsonl');

  await Promise.all([
    fs.writeFile(spawnLogPath, ''),
    fs.writeFile(requestLogPath, ''),
    fs.writeFile(responseLogPath, ''),
    fs.writeFile(
      serverPath,
      `#!/usr/bin/env bun
import * as fs from 'node:fs';

const mode = process.env.PERSISTENT_CODEX_MOCK_MODE || '';
const requestLogPath = process.env.PERSISTENT_CODEX_REQUEST_LOG;
const responseLogPath = process.env.PERSISTENT_CODEX_RESPONSE_LOG;
const threadId = 'thread-' + process.pid;
const turnId = 'turn-' + process.pid;

function append(filePath, value) {
  if (filePath) fs.appendFileSync(filePath, JSON.stringify(value) + '\\n');
}

function send(websocket, value) {
  websocket.send(JSON.stringify(value));
}

const listenIndex = process.argv.indexOf('--listen');
const listenValue = listenIndex >= 0 ? process.argv[listenIndex + 1] : undefined;
const socketPath = listenValue && listenValue.startsWith('unix://')
  ? listenValue.slice('unix://'.length)
  : undefined;
if (!socketPath) throw new Error('missing private app-server socket');

const server = Bun.serve({
  unix: socketPath,
  fetch(request, serverHandle) {
    if (serverHandle.upgrade(request)) return;
    return new Response('Expected websocket upgrade', { status: 426 });
  },
  websocket: {
    message(websocket, rawMessage) {
      const message = JSON.parse(String(rawMessage));
      if (message.method) {
        append(requestLogPath, { pid: process.pid, ...message });
        if (message.method === 'initialize') {
          send(websocket, { jsonrpc: '2.0', id: message.id, result: { capabilities: {} } });
        } else if (message.method === 'thread/start') {
          if (mode === 'reject-thread-start') {
            send(websocket, {
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32602, message: 'dynamicTools is not supported' },
            });
            return;
          }
          send(websocket, { jsonrpc: '2.0', id: message.id, result: { threadId } });
          if (mode === 'dynamic-tool') {
            setTimeout(() => send(websocket, {
              jsonrpc: '2.0',
              id: 700,
              method: 'item/tool/call',
              params: {
                threadId,
                turnId,
                callId: 'call-1',
                tool: 'ListTimAgents',
                arguments: {},
              },
            }), 0);
          }
        } else if (message.method === 'turn/start') {
          send(websocket, { jsonrpc: '2.0', id: message.id, result: { turnId } });
          if (mode === 'crash-after-start') {
            setTimeout(() => process.exit(23), 0);
          }
        } else if (message.method === 'turn/interrupt') {
          send(websocket, { jsonrpc: '2.0', id: message.id, result: {} });
        } else {
          send(websocket, { jsonrpc: '2.0', id: message.id, result: {} });
        }
      } else if (message.id !== undefined) {
        append(responseLogPath, { pid: process.pid, ...message });
      }
    },
  },
});
void server;
`
    ),
    fs.writeFile(
      codexPath,
      `#!/bin/sh
printf 'pid=%s\\nargs:' "$$" >> "$PERSISTENT_CODEX_SPAWN_LOG"
for arg in "$@"; do printf '\\t%s' "$arg" >> "$PERSISTENT_CODEX_SPAWN_LOG"; done
  printf '\\nTIM_CODEX_APP_SERVER_SOCKET=%s\\n' "$TIM_CODEX_APP_SERVER_SOCKET" >> "$PERSISTENT_CODEX_SPAWN_LOG"
  printf 'TIM_OUTPUT_SOCKET=%s\\n' "$TIM_OUTPUT_SOCKET" >> "$PERSISTENT_CODEX_SPAWN_LOG"
exec bun "$PERSISTENT_CODEX_SERVER_PATH" "$@"
`
    ),
  ]);
  await fs.chmod(serverPath, 0o755);
  await fs.chmod(codexPath, 0o755);
  return { rootDir, mode, serverPath, codexPath, spawnLogPath, requestLogPath, responseLogPath };
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForCondition(
  condition: () => Promise<boolean>,
  label: string,
  timeoutMs: number = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createOwner(): {
  owner: SessionProcessOwner;
  registry: SessionProcessRegistry;
  rootId: string;
} {
  const registry = new SessionProcessRegistry({ sessionId: `persistent-codex-${Date.now()}` });
  const rootId = 'root-process';
  const rootProcessId = toProcessId(rootId);
  if (!rootProcessId) throw new Error('Invalid test root process ID');
  if (
    registry.register({
      processId: rootProcessId,
      kind: 'tim',
      label: 'test tim',
      state: 'running',
    }) === undefined
  ) {
    throw new Error('Could not register test root process');
  }
  return {
    owner: new SessionProcessOwner({
      sessionId: registry.sessionId!,
      ownerProcessId: rootProcessId,
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    }),
    registry,
    rootId,
  };
}

function createIdentity(name: string): AgentIdentity {
  return {
    id: `agent-${name}` as AgentIdentity['id'],
    name: name as AgentIdentity['name'],
    role: 'subagent',
    type: 'implementer',
    executor: 'codex-cli',
  };
}

function createProvider(identity: AgentIdentity) {
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
      messageId: 'message-1',
      delivery: 'queued' as const,
    }),
    stopAgent: async () => ({
      name: 'other-agent',
      mode: 'graceful-requested' as const,
      state: 'stopping' as const,
    }),
    finishAgent: async () => ({ state: 'finishing' as const }),
  };
  return createCodexAgentToolProvider({ caller: identity, dispatcher });
}

function createCallbacks() {
  return {
    outputActivity: vi.fn(),
    completedAssistantMessage: vi.fn(),
    turnComplete: vi.fn(),
    exit: vi.fn(),
  };
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
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

async function withFixtureEnvironment<T>(
  fixture: MockCodexFixture,
  callback: () => Promise<T>
): Promise<T> {
  const originalPath = process.env.PATH;
  const originalSocket = process.env[TIM_CODEX_APP_SERVER_SOCKET];
  const originalMode = process.env.CODEX_USE_APP_SERVER;
  const originalMockMode = process.env.PERSISTENT_CODEX_MOCK_MODE;
  const originalServerPath = process.env.PERSISTENT_CODEX_SERVER_PATH;
  const originalSpawnLog = process.env.PERSISTENT_CODEX_SPAWN_LOG;
  const originalRequestLog = process.env.PERSISTENT_CODEX_REQUEST_LOG;
  const originalResponseLog = process.env.PERSISTENT_CODEX_RESPONSE_LOG;

  process.env.PATH = `${fixture.rootDir}:${originalPath ?? ''}`;
  process.env[TIM_CODEX_APP_SERVER_SOCKET] = path.join(fixture.rootDir, 'inherited.sock');
  delete process.env.CODEX_USE_APP_SERVER;
  process.env.PERSISTENT_CODEX_MOCK_MODE = fixture.mode;
  process.env.PERSISTENT_CODEX_SERVER_PATH = fixture.serverPath;
  process.env.PERSISTENT_CODEX_SPAWN_LOG = fixture.spawnLogPath;
  process.env.PERSISTENT_CODEX_REQUEST_LOG = fixture.requestLogPath;
  process.env.PERSISTENT_CODEX_RESPONSE_LOG = fixture.responseLogPath;

  try {
    return await callback();
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSocket === undefined) delete process.env[TIM_CODEX_APP_SERVER_SOCKET];
    else process.env[TIM_CODEX_APP_SERVER_SOCKET] = originalSocket;
    if (originalMode === undefined) delete process.env.CODEX_USE_APP_SERVER;
    else process.env.CODEX_USE_APP_SERVER = originalMode;
    if (originalMockMode === undefined) delete process.env.PERSISTENT_CODEX_MOCK_MODE;
    else process.env.PERSISTENT_CODEX_MOCK_MODE = originalMockMode;
    if (originalServerPath === undefined) delete process.env.PERSISTENT_CODEX_SERVER_PATH;
    else process.env.PERSISTENT_CODEX_SERVER_PATH = originalServerPath;
    if (originalSpawnLog === undefined) delete process.env.PERSISTENT_CODEX_SPAWN_LOG;
    else process.env.PERSISTENT_CODEX_SPAWN_LOG = originalSpawnLog;
    if (originalRequestLog === undefined) delete process.env.PERSISTENT_CODEX_REQUEST_LOG;
    else process.env.PERSISTENT_CODEX_REQUEST_LOG = originalRequestLog;
    if (originalResponseLog === undefined) delete process.env.PERSISTENT_CODEX_RESPONSE_LOG;
    else process.env.PERSISTENT_CODEX_RESPONSE_LOG = originalResponseLog;
  }
}

describe('persistent Codex setup', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.TIM_OUTPUT_SOCKET;
  });

  it('uses a private named owner, registers a sibling thread, and keeps tools installed', async () => {
    vi.resetModules();

    const connectionOptions: { current?: Record<string, unknown> } = {};
    const initialTurn = createDeferred<{ turnId: string }>();
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
      turnStart: vi.fn(() => initialTurn.promise),
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
      lifecycleObserver: callbacks,
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
    await vi.waitFor(() => {
      expect(connection.turnStart).toHaveBeenCalledTimes(1);
    });
    expect(owner.prepareLogicalExecutor).toHaveBeenCalledWith({
      label: 'Codex thread (worker-a)',
      command: 'codex thread thread-1',
      threadId: 'thread-1',
    });
    expect(logicalLifecycle.markStarted).toHaveBeenCalledTimes(1);
    expect(handle.providerThreadId).toBe('thread-1');
    expect(handle.processControlId).toBe('codex-process-1');
    await expect(
      Promise.race([
        handle.ready.then(
          () => 'ready' as const,
          () => 'failed' as const
        ),
        Promise.resolve('launch-boundary' as const),
      ])
    ).resolves.toBe('launch-boundary');
    initialTurn.resolve({ turnId: 'turn-1' });
    await expect(handle.ready).resolves.toBeUndefined();
    expect(handle.processControlId).toBe('codex-process-1');
    expect(handle.providerThreadId).toBe('thread-1');

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
        tool: 'ListTimAgents',
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

  it('uses the production launcher and connection for private setup and idempotent End controls', async () => {
    const fixture = await createMockCodexFixture('dynamic-tool');
    const { owner, registry, rootId } = createOwner();
    const identity = createIdentity('worker-a');
    const callbacks = createCallbacks();

    try {
      await withFixtureEnvironment(fixture, async () => {
        const handle = await runWithSessionProcessOwner(owner, () =>
          startPersistentCodexAgent({
            mode: CODEX_PERSISTENT_AGENT_MODE,
            identity,
            prompt: 'Initial assignment',
            cwd: fixture.rootDir,
            timConfig: {},
            dynamicToolProvider: createProvider(identity),
            processLabel: formatAgentProcessLabel('codex-cli', identity.name),
            lifecycleObserver: callbacks,
            sessionProcessOwner: owner,
          })
        );

        await expect(handle.ready).resolves.toBeUndefined();
        await waitForCondition(
          async () =>
            (await readJsonLines(fixture.responseLogPath)).some((response) => {
              const result = response.result;
              return (
                response.id === 700 &&
                typeof result === 'object' &&
                result !== null &&
                (result as Record<string, unknown>).success === true
              );
            }),
          'persistent dynamic tool response'
        );

        const nodes = registry
          .getSnapshot()
          .filter((node) => node.kind === 'executor' && node.state === 'running');
        expect(nodes).toHaveLength(2);
        const appServerNode = nodes.find((node) => node.label === 'Codex app-server (worker-a)');
        const threadNode = nodes.find((node) => node.label === 'Codex thread (worker-a)');
        expect(appServerNode).toMatchObject({
          parentProcessId: expect.stringMatching(new RegExp(`^${rootId}$`)),
          control: 'both',
          pid: expect.any(Number),
        });
        expect(threadNode).toMatchObject({
          parentProcessId: expect.stringMatching(new RegExp(`^${rootId}$`)),
          control: 'end',
          threadId: handle.providerThreadId,
          command: `codex thread ${handle.providerThreadId}`,
        });
        expect(handle.processControlId).toBe(appServerNode?.processId);
        expect(handle.providerThreadId).toBe(threadNode?.threadId);

        const spawnLog = await fs.readFile(fixture.spawnLogPath, 'utf8');
        expect(spawnLog).toContain('args:\tapp-server\t--listen\tunix://');
        expect(spawnLog).not.toContain('inherited.sock');

        expect(owner.endExecutor(appServerNode!.processId)).toBe('ended');
        expect(owner.endExecutor(threadNode!.processId)).toBe('ended');
        expect(owner.endExecutor(threadNode!.processId)).toBe('ended');
        await expect(handle.completion).resolves.toEqual({});

        expect(callbacks.exit).toHaveBeenCalledTimes(1);
        expect(callbacks.exit).toHaveBeenCalledWith('graceful', undefined);
        expect(
          registry
            .getSnapshot()
            .filter((node) => node.label.includes('(worker-a)'))
            .every((node) => node.state === 'exited')
        ).toBe(true);
      });
    } finally {
      owner.dispose();
      await fs.rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it('cleans every partial resource when dynamic-tool compatibility fails', async () => {
    const fixture = await createMockCodexFixture('reject-thread-start');
    const { owner, registry } = createOwner();
    const identity = createIdentity('worker-a');
    const callbacks = createCallbacks();

    try {
      await withFixtureEnvironment(fixture, async () => {
        const handle = await runWithSessionProcessOwner(owner, () =>
          startPersistentCodexAgent({
            mode: CODEX_PERSISTENT_AGENT_MODE,
            identity,
            prompt: 'Initial assignment',
            cwd: fixture.rootDir,
            timConfig: {},
            dynamicToolProvider: createProvider(identity),
            processLabel: formatAgentProcessLabel('codex-cli', identity.name),
            lifecycleObserver: callbacks,
            sessionProcessOwner: owner,
          })
        );

        await expect(handle.ready).rejects.toMatchObject({
          name: 'CodexDynamicToolsCompatibilityError',
          message: expect.stringContaining('does not support experimental dynamic tools'),
        });
        await expect(handle.completion).resolves.toMatchObject({
          error: expect.objectContaining({
            name: 'CodexDynamicToolsCompatibilityError',
          }),
        });
        expect(callbacks.exit).toHaveBeenCalledTimes(1);
        expect(callbacks.exit).toHaveBeenCalledWith('failed', expect.any(Error));

        const executorNodes = registry.getSnapshot().filter((node) => node.kind === 'executor');
        expect(executorNodes).toHaveLength(1);
        expect(executorNodes[0]).toMatchObject({
          label: 'Codex app-server (worker-a)',
          state: 'exited',
        });
        expect(executorNodes.some((node) => node.label === 'Codex thread (worker-a)')).toBe(false);

        const spawnLog = await fs.readFile(fixture.spawnLogPath, 'utf8');
        const socketLine = spawnLog
          .split('\n')
          .find((line) => line.startsWith(`${TIM_CODEX_APP_SERVER_SOCKET}=`));
        expect(socketLine).toBeDefined();
        const privateSocketPath = socketLine!.slice(`${TIM_CODEX_APP_SERVER_SOCKET}=`.length);
        await expect(fs.stat(privateSocketPath)).rejects.toMatchObject({ code: 'ENOENT' });

        const tunnelLine = spawnLog
          .split('\n')
          .find((line) => line.startsWith('TIM_OUTPUT_SOCKET='));
        expect(tunnelLine).toBeDefined();
        const tunnelSocketPath = tunnelLine!.slice('TIM_OUTPUT_SOCKET='.length);
        expect(tunnelSocketPath).not.toBe('');
        await expect(fs.stat(path.dirname(tunnelSocketPath))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    } finally {
      owner.dispose();
      await fs.rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it('starts two isolated private agents despite an inherited socket', async () => {
    const fixture = await createMockCodexFixture('normal');
    const { owner, registry, rootId } = createOwner();
    const identities = [createIdentity('worker-a'), createIdentity('worker-b')];

    try {
      await withFixtureEnvironment(fixture, async () => {
        const handles = await runWithSessionProcessOwner(owner, () =>
          Promise.all(
            identities.map((identity) =>
              startPersistentCodexAgent({
                mode: CODEX_PERSISTENT_AGENT_MODE,
                identity,
                prompt: `Assignment for ${identity.name}`,
                cwd: fixture.rootDir,
                timConfig: {},
                dynamicToolProvider: createProvider(identity),
                processLabel: formatAgentProcessLabel('codex-cli', identity.name),
                lifecycleObserver: createCallbacks(),
                sessionProcessOwner: owner,
              })
            )
          )
        );

        await Promise.all(handles.map((handle) => handle.ready));

        const runningExecutors = registry
          .getSnapshot()
          .filter((node) => node.kind === 'executor' && node.state === 'running');
        expect(runningExecutors).toHaveLength(4);
        expect(runningExecutors.every((node) => node.parentProcessId === rootId)).toBe(true);

        const appServerNodes = identities.map((identity) => {
          const node = runningExecutors.find(
            (candidate) => candidate.label === `Codex app-server (${identity.name})`
          );
          expect(node).toBeDefined();
          return node!;
        });
        const threadNodes = identities.map((identity) => {
          const node = runningExecutors.find(
            (candidate) => candidate.label === `Codex thread (${identity.name})`
          );
          expect(node).toBeDefined();
          return node!;
        });
        expect(new Set(appServerNodes.map((node) => node.processId)).size).toBe(2);
        expect(new Set(appServerNodes.map((node) => node.pid)).size).toBe(2);
        expect(new Set(threadNodes.map((node) => node.threadId)).size).toBe(2);
        expect(handles.map((handle) => handle.providerThreadId)).toEqual(
          expect.arrayContaining(threadNodes.map((node) => node.threadId))
        );

        const socketLines = (await fs.readFile(fixture.spawnLogPath, 'utf8'))
          .split('\n')
          .filter((line) => line.startsWith(`${TIM_CODEX_APP_SERVER_SOCKET}=`));
        expect(socketLines).toHaveLength(2);
        expect(new Set(socketLines).size).toBe(2);
        expect(socketLines.every((line) => !line.includes('inherited.sock'))).toBe(true);

        await Promise.all(handles.map((handle) => handle.release?.()));
        await Promise.all(handles.map((handle) => handle.completion));
        expect(
          registry
            .getSnapshot()
            .filter((node) => node.kind === 'executor')
            .every((node) => node.state === 'exited')
        ).toBe(true);
        expect(
          registry
            .getSnapshot()
            .filter((node) => node.kind === 'executor' && node.label.startsWith('Codex thread'))
        ).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              label: 'Codex thread (worker-a)',
              state: 'exited',
              signal: 'SIGTERM',
            }),
            expect.objectContaining({
              label: 'Codex thread (worker-b)',
              state: 'exited',
              signal: 'SIGTERM',
            }),
          ])
        );
      });
    } finally {
      owner.dispose();
      await fs.rm(fixture.rootDir, { recursive: true, force: true });
    }
  });

  it('reports a scripted app-server crash once and cleans the private owner', async () => {
    const fixture = await createMockCodexFixture('crash-after-start');
    const { owner, registry } = createOwner();
    const identity = createIdentity('crash-worker');
    const callbacks = createCallbacks();

    try {
      await withFixtureEnvironment(fixture, async () => {
        const handle = await runWithSessionProcessOwner(owner, () =>
          startPersistentCodexAgent({
            mode: CODEX_PERSISTENT_AGENT_MODE,
            identity,
            prompt: 'Start and then crash.',
            cwd: fixture.rootDir,
            timConfig: {},
            dynamicToolProvider: createProvider(identity),
            processLabel: formatAgentProcessLabel('codex-cli', identity.name),
            lifecycleObserver: callbacks,
            sessionProcessOwner: owner,
          })
        );

        await expect(handle.ready).resolves.toBeUndefined();
        await expect(handle.completion).resolves.toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining('exited unexpectedly'),
          }),
        });
        expect(callbacks.exit).toHaveBeenCalledTimes(1);
        expect(callbacks.exit).toHaveBeenCalledWith('failed', expect.any(Error));
        expect(
          registry
            .getSnapshot()
            .filter((node) => node.label.includes('(crash-worker)'))
            .every((node) => node.state === 'exited')
        ).toBe(true);
      });
    } finally {
      owner.dispose();
      await fs.rm(fixture.rootDir, { recursive: true, force: true });
    }
  });
});
