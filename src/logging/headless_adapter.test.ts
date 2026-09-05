import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { HeadlessAdapter } from './headless_adapter.ts';
import { runWithAgentName } from './adapter.ts';
import type { HeadlessMessage, HeadlessServerMessage } from './headless_protocol.ts';
import { createRecordingAdapter } from './test_helpers.ts';
import { readSessionInfoFile } from '../tim/session_server/runtime_dir.ts';
import {
  TIM_OWNER_PROCESS_ID,
  TIM_PARENT_PROCESS_ID,
  TIM_PROCESS_ID,
  TIM_SESSION_ID,
  type ProcessId,
} from '../common/session_process.ts';

function parseMessage(
  message: string | Buffer | ArrayBuffer | ArrayBufferView
): HeadlessMessage | null {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Buffer
        ? message.toString('utf8')
        : ArrayBuffer.isView(message)
          ? Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString('utf8')
          : Buffer.from(message).toString('utf8');

  try {
    return JSON.parse(text) as HeadlessMessage;
  } catch {
    return null;
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error(`WebSocket error for ${url}`)), {
      once: true,
    });
  });

  return ws;
}

function createTestHeadlessAdapter(
  sessionInfo: ConstructorParameters<typeof HeadlessAdapter>[0],
  wrappedAdapter: ConstructorParameters<typeof HeadlessAdapter>[1],
  options?: ConstructorParameters<typeof HeadlessAdapter>[2]
): HeadlessAdapter {
  return new HeadlessAdapter(sessionInfo, wrappedAdapter, {
    serverPort: 0,
    serverHostname: '127.0.0.1',
    ...options,
  });
}

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempCacheDir = '';

beforeEach(async () => {
  tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-adapter-test-'));
  process.env.XDG_CACHE_HOME = tempCacheDir;
});

afterEach(async () => {
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (tempCacheDir) {
    await rm(tempCacheDir, { recursive: true, force: true });
    tempCacheDir = '';
  }
});

describe('HeadlessAdapter', () => {
  it('registers the root tim process for executor ownership and restores its environment', async () => {
    const before = {
      [TIM_SESSION_ID]: process.env[TIM_SESSION_ID],
      [TIM_PROCESS_ID]: process.env[TIM_PROCESS_ID],
      [TIM_PARENT_PROCESS_ID]: process.env[TIM_PARENT_PROCESS_ID],
      [TIM_OWNER_PROCESS_ID]: process.env[TIM_OWNER_PROCESS_ID],
    };
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    const registry = adapter.getProcessRegistry();
    expect(registry?.getSnapshot()).toHaveLength(1);
    expect(registry?.getSnapshot()[0]).toMatchObject({
      kind: 'tim',
      label: 'tim agent',
      pid: process.pid,
      state: 'running',
    });
    expect(process.env[TIM_SESSION_ID]).toEqual(expect.any(String));
    expect(process.env[TIM_PROCESS_ID]).toEqual(expect.any(String));
    expect(process.env[TIM_PARENT_PROCESS_ID]).toBeUndefined();
    expect(process.env[TIM_OWNER_PROCESS_ID]).toBeUndefined();

    await adapter.destroy();
    expect(process.env[TIM_SESSION_ID]).toBe(before[TIM_SESSION_ID]);
    expect(process.env[TIM_PROCESS_ID]).toBe(before[TIM_PROCESS_ID]);
    expect(process.env[TIM_PARENT_PROCESS_ID]).toBe(before[TIM_PARENT_PROCESS_ID]);
    expect(process.env[TIM_OWNER_PROCESS_ID]).toBe(before[TIM_OWNER_PROCESS_ID]);
  });

  it('buffers output in replay history and forwards local output', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    adapter.log('hello');
    adapter.writeStdout('world\n');
    adapter.warn('warning');

    expect(calls.map((call) => call.method)).toEqual(['log', 'writeStdout', 'warn']);
    const internals = adapter as any;
    expect(internals.history).toHaveLength(3);
    expect(internals.historyOutputBytes).toBeGreaterThan(0);

    await adapter.destroy();
  });

  it('uses the scoped agent name for forwarded output', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    runWithAgentName('worker-a', () => {
      adapter.log('worker log');
      adapter.sendStructured({
        type: 'workflow_progress',
        timestamp: '2026-08-28T01:02:03.000Z',
        phase: 'context',
        message: 'worker progress',
      });
    });

    const history = (adapter as any).history as Array<{ payload: string }>;
    const envelopes = history.map((entry) => JSON.parse(entry.payload));
    expect(envelopes.map((envelope) => envelope.message.agentName)).toEqual([
      'worker-a',
      'worker-a',
    ]);

    await adapter.destroy();
  });

  it('tags raw output with its origin in the tunnel message', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    adapter.writeStdout('lifecycle stdout\n', { origin: 'lifecycle' });
    adapter.writeStderr('lifecycle stderr\n', { origin: 'lifecycle' });
    adapter.writeStdout('plain stdout\n');

    const history = (adapter as any).history as Array<{ payload: string }>;
    const envelopes = history.map((entry) => JSON.parse(entry.payload));

    expect(envelopes[0].message).toMatchObject({
      type: 'stdout',
      data: 'lifecycle stdout\n',
      origin: 'lifecycle',
    });
    expect(envelopes[1].message).toMatchObject({
      type: 'stderr',
      data: 'lifecycle stderr\n',
      origin: 'lifecycle',
    });
    expect(envelopes[2].message.origin).toBeUndefined();

    await adapter.destroy();
  });

  it('drops non-serializable structured messages without throwing', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(() =>
      adapter.sendStructured({
        type: 'llm_tool_use',
        timestamp: '2026-02-08T00:00:00.000Z',
        toolName: 'Write',
        input: circular,
      })
    ).not.toThrow();

    expect((adapter as any).history).toHaveLength(0);
    expect(calls.at(-1)).toEqual({
      method: 'error',
      args: ['Failed to serialize headless tunnel message:', expect.any(Error)],
    });

    await adapter.destroy();
  });

  it('replays history to embedded-server clients with session info and replay markers', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'agent',
        interactive: false,
        planId: 166,
        planTitle: 'headless mode',
        workspacePath: '/tmp/workspace',
        gitRemote: 'git@example.com:repo.git',
      },
      wrapped
    );

    adapter.log('before-connect-1');
    adapter.log('before-connect-2');
    adapter.sendPlanContent('# latest plan');

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    expect(messages[0]).toMatchObject({
      type: 'session_info',
      command: 'agent',
      planId: 166,
      planTitle: 'headless mode',
      workspacePath: '/tmp/workspace',
      gitRemote: 'git@example.com:repo.git',
      sessionId: expect.any(String),
    });
    expect(messages[1]).toMatchObject({
      type: 'process_tree_snapshot',
      processes: [expect.objectContaining({ kind: 'tim', label: 'tim agent' })],
    });
    expect(messages[2]).toEqual({ type: 'plan_content', content: '# latest plan', tasks: [] });
    expect(messages[3]).toEqual({ type: 'replay_start' });
    expect(messages[4]).toMatchObject({ type: 'output', seq: 1 });
    expect(messages[5]).toMatchObject({ type: 'output', seq: 2 });
    expect(messages[6]).toEqual({ type: 'replay_end' });

    ws.close();
    await adapter.destroy();
  });

  it('replays a deterministic process tree and broadcasts complete live snapshots', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const registry = adapter.getProcessRegistry();
    expect(registry).toBeDefined();

    const root = registry!.getSnapshot()[0]!;
    const firstExecutorId = 'executor-1' as ProcessId;
    const nestedTimId = 'nested-tim-1' as ProcessId;
    const nestedExecutorId = 'nested-executor-1' as ProcessId;
    registry!.register({
      processId: firstExecutorId,
      parentProcessId: root.processId,
      ownerProcessId: root.processId,
      kind: 'executor',
      label: 'first executor',
      startedAt: '2026-03-17T10:00:02.000Z',
      state: 'running',
    });
    registry!.register({
      processId: nestedTimId,
      parentProcessId: firstExecutorId,
      ownerProcessId: firstExecutorId,
      kind: 'tim',
      label: 'nested tim',
      startedAt: '2026-03-17T10:00:03.000Z',
      state: 'running',
    });
    registry!.register({
      processId: nestedExecutorId,
      parentProcessId: nestedTimId,
      ownerProcessId: nestedTimId,
      kind: 'executor',
      label: 'nested executor',
      startedAt: '2026-03-17T10:00:04.000Z',
      state: 'running',
    });

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    const initialSnapshot = messages.find((message) => message.type === 'process_tree_snapshot');
    expect(initialSnapshot?.type).toBe('process_tree_snapshot');
    expect(initialSnapshot?.processes.map((process) => process.processId)).toEqual([
      root.processId,
      firstExecutorId,
      nestedTimId,
      nestedExecutorId,
    ]);

    messages.length = 0;
    const secondExecutorId = 'executor-2' as ProcessId;
    registry!.register({
      processId: secondExecutorId,
      parentProcessId: root.processId,
      ownerProcessId: root.processId,
      kind: 'executor',
      label: 'second executor',
      startedAt: '2026-03-17T10:00:01.000Z',
      state: 'running',
    });
    await waitFor(() => messages.some((message) => message.type === 'process_tree_update'));

    const update = messages.find((message) => message.type === 'process_tree_update');
    expect(update?.type).toBe('process_tree_update');
    expect(update?.processes.map((process) => process.processId)).toEqual([
      root.processId,
      secondExecutorId,
      firstExecutorId,
      nestedTimId,
      nestedExecutorId,
    ]);

    const ws2 = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const reconnectMessages: HeadlessMessage[] = [];
    ws2.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        reconnectMessages.push(parsed);
      }
    });
    await waitFor(() => reconnectMessages.some((message) => message.type === 'replay_end'));
    const reconnectSnapshot = reconnectMessages.find(
      (message) => message.type === 'process_tree_snapshot'
    );
    expect(reconnectSnapshot?.type).toBe('process_tree_snapshot');
    expect(reconnectSnapshot?.processes.map((process) => process.processId)).toEqual([
      root.processId,
      secondExecutorId,
      firstExecutorId,
      nestedTimId,
      nestedExecutorId,
    ]);

    ws.close();
    ws2.close();
    await adapter.destroy();
  });

  it('routes targeted termination to the owning channel and fans out force shutdown', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const registry = adapter.getProcessRegistry();
    expect(registry).toBeDefined();
    const root = registry!.getSnapshot()[0]!;
    const ownerExecutorId = 'owner-executor' as ProcessId;
    const nestedTimId = 'nested-tim' as ProcessId;
    const executorId = 'nested-executor' as ProcessId;
    const staleExecutorId = 'stale-executor' as ProcessId;

    expect(
      registry!.register({
        processId: ownerExecutorId,
        parentProcessId: root.processId,
        ownerProcessId: root.processId,
        kind: 'executor',
        label: 'orchestrator',
        startedAt: '2026-03-17T10:00:01.000Z',
        state: 'running',
      })
    ).toBeDefined();

    const routedRequests: Array<{ executorId: ProcessId; requestId?: string }> = [];
    expect(
      registry!.registerOwnerChannelSender('nested-channel', (targetExecutorId, requestId) => {
        routedRequests.push({ executorId: targetExecutorId, requestId });
        return true;
      })
    ).toBe(true);
    expect(
      registry!.register(
        {
          processId: nestedTimId,
          parentProcessId: ownerExecutorId,
          ownerProcessId: ownerExecutorId,
          kind: 'tim',
          label: 'subagent tim',
          startedAt: '2026-03-17T10:00:02.000Z',
          state: 'running',
        },
        { ownerChannelId: 'nested-channel' }
      )
    ).toBeDefined();
    expect(
      registry!.register({
        processId: executorId,
        parentProcessId: nestedTimId,
        ownerProcessId: nestedTimId,
        kind: 'executor',
        label: 'subagent executor',
        startedAt: '2026-03-17T10:00:03.000Z',
        state: 'running',
      })
    ).toBeDefined();
    expect(
      registry!.register({
        processId: staleExecutorId,
        parentProcessId: nestedTimId,
        ownerProcessId: nestedTimId,
        kind: 'executor',
        label: 'stale executor',
        startedAt: '2026-03-17T10:00:04.000Z',
        state: 'running',
      })
    ).toBeDefined();
    registry!.exit(staleExecutorId);

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    ws.send(
      JSON.stringify({
        type: 'terminate_executor',
        requestId: 'remote-request',
        executorId,
      })
    );
    await waitFor(() =>
      routedRequests.some(
        (request) => request.executorId === executorId && request.requestId === 'remote-request'
      )
    );
    expect(routedRequests).toEqual([{ executorId, requestId: 'remote-request' }]);

    registry!.emitTerminationResult({
      executorId,
      requestId: 'remote-request',
      result: 'terminated',
    });
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === 'executor_termination_result' && message.requestId === 'remote-request'
      )
    );
    expect(
      messages.find(
        (message) =>
          message.type === 'executor_termination_result' && message.requestId === 'remote-request'
      )
    ).toMatchObject({ executorId, result: 'terminated' });

    ws.send(
      JSON.stringify({
        type: 'terminate_executor',
        requestId: 'signal-failure-request',
        executorId,
      })
    );
    await waitFor(() =>
      routedRequests.some(
        (request) =>
          request.executorId === executorId && request.requestId === 'signal-failure-request'
      )
    );
    registry!.emitTerminationResult({
      executorId,
      requestId: 'signal-failure-request',
      result: 'signal_failed',
      error: 'permission denied',
    });
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === 'executor_termination_result' &&
          message.requestId === 'signal-failure-request'
      )
    );
    expect(
      messages.find(
        (message) =>
          message.type === 'executor_termination_result' &&
          message.requestId === 'signal-failure-request'
      )
    ).toEqual({
      type: 'executor_termination_result',
      requestId: 'signal-failure-request',
      executorId,
      result: 'signal_failed',
      error: 'permission denied',
    });

    ws.send(
      JSON.stringify({
        type: 'terminate_executor',
        requestId: 'missing-request',
        executorId: 'missing-executor',
      })
    );
    ws.send(
      JSON.stringify({
        type: 'terminate_executor',
        requestId: 'tim-request',
        executorId: root.processId,
      })
    );
    ws.send(
      JSON.stringify({
        type: 'terminate_executor',
        requestId: 'stale-request',
        executorId: staleExecutorId,
      })
    );
    await waitFor(
      () => messages.filter((message) => message.type === 'executor_termination_result').length >= 4
    );
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'executor_termination_result',
          requestId: 'missing-request',
          result: 'unknown_executor',
        }),
        expect.objectContaining({
          type: 'executor_termination_result',
          requestId: 'tim-request',
          result: 'not_executor',
        }),
        expect.objectContaining({
          type: 'executor_termination_result',
          requestId: 'stale-request',
          result: 'stale_target',
        }),
      ])
    );

    const endSession = vi.fn();
    adapter.setEndSessionHandler(endSession);
    const requestCountBeforeForce = routedRequests.length;
    ws.send(JSON.stringify({ type: 'force_end_session' }));
    await waitFor(() => routedRequests.length > requestCountBeforeForce);
    expect(routedRequests).toContainEqual({ executorId, requestId: undefined });

    const requestCountBeforeEnd = routedRequests.length;
    ws.send(JSON.stringify({ type: 'end_session' }));
    await waitFor(() => endSession.mock.calls.length === 1);
    expect(routedRequests).toHaveLength(requestCountBeforeEnd);

    ws.close();
    await adapter.destroy();
  });

  it('fans out force end and root teardown to every connected nested owner', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const registry = adapter.getProcessRegistry();
    expect(registry).toBeDefined();
    const root = registry!.getSnapshot()[0]!;
    const routedRequests: Array<{ channelId: string; executorId: ProcessId }> = [];

    const branches = [
      {
        channelId: 'nested-channel-a',
        ownerExecutorId: 'owner-executor-a' as ProcessId,
        timId: 'nested-tim-a' as ProcessId,
        executorId: 'nested-executor-a' as ProcessId,
        startedAt: '2026-03-17T10:00:01.000Z',
      },
      {
        channelId: 'nested-channel-b',
        ownerExecutorId: 'owner-executor-b' as ProcessId,
        timId: 'nested-tim-b' as ProcessId,
        executorId: 'nested-executor-b' as ProcessId,
        startedAt: '2026-03-17T10:00:02.000Z',
      },
    ];

    for (const branch of branches) {
      expect(
        registry!.register({
          processId: branch.ownerExecutorId,
          parentProcessId: root.processId,
          ownerProcessId: root.processId,
          kind: 'executor',
          label: branch.ownerExecutorId,
          startedAt: branch.startedAt,
          state: 'running',
        })
      ).toBeDefined();
      expect(
        registry!.registerOwnerChannelSender(branch.channelId, (executorId) => {
          routedRequests.push({ channelId: branch.channelId, executorId });
          return true;
        })
      ).toBe(true);
      expect(
        registry!.register(
          {
            processId: branch.timId,
            parentProcessId: branch.ownerExecutorId,
            ownerProcessId: branch.ownerExecutorId,
            kind: 'tim',
            label: branch.timId,
            startedAt: branch.startedAt,
            state: 'running',
          },
          { ownerChannelId: branch.channelId }
        )
      ).toBeDefined();
      expect(
        registry!.register({
          processId: branch.executorId,
          parentProcessId: branch.timId,
          ownerProcessId: branch.timId,
          kind: 'executor',
          label: branch.executorId,
          startedAt: branch.startedAt,
          state: 'running',
        })
      ).toBeDefined();
    }

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    const endSession = vi.fn();
    adapter.setEndSessionHandler(endSession);
    ws.send(JSON.stringify({ type: 'force_end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => routedRequests.length === branches.length);
    expect(routedRequests).toEqual([
      { channelId: 'nested-channel-a', executorId: 'nested-executor-a' },
      { channelId: 'nested-channel-b', executorId: 'nested-executor-b' },
    ]);

    const requestCountBeforeGracefulEnd = routedRequests.length;
    ws.send(JSON.stringify({ type: 'end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => endSession.mock.calls.length === 1);
    expect(routedRequests).toHaveLength(requestCountBeforeGracefulEnd);

    await adapter.destroy();
    expect(routedRequests).toEqual([
      { channelId: 'nested-channel-a', executorId: 'nested-executor-a' },
      { channelId: 'nested-channel-b', executorId: 'nested-executor-b' },
      { channelId: 'nested-channel-a', executorId: 'nested-executor-a' },
      { channelId: 'nested-channel-b', executorId: 'nested-executor-b' },
    ]);

    const registryInternals = registry as unknown as {
      listeners: Set<unknown>;
      terminationResultListeners: Set<unknown>;
    };
    expect(registryInternals.listeners.size).toBe(0);
    expect(registryInternals.terminationResultListeners.size).toBe(0);
  });

  it('sends PTY session info and buffered output without structured replay markers', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'shell',
        pty: true,
        cols: 100,
        rows: 30,
        workspacePath: '/tmp/workspace',
      },
      wrapped,
      {
        maxPtyBufferBytes: 32,
      }
    );

    adapter.log('structured-before-connect');
    adapter.broadcastPtyOutput(Buffer.from('before-1\n'));
    adapter.broadcastPtyOutput(Buffer.from('before-2\n'));

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.filter((message) => message.type === 'pty_output').length === 2);
    adapter.broadcastPtyOutput(Buffer.from('live\n'));
    await waitFor(() => messages.filter((message) => message.type === 'pty_output').length === 3);

    expect(messages[0]).toMatchObject({
      type: 'session_info',
      command: 'shell',
      pty: true,
      cols: 100,
      rows: 30,
      workspacePath: '/tmp/workspace',
      sessionId: expect.any(String),
    });
    expect(messages.some((message) => message.type === 'replay_start')).toBe(false);
    expect(messages.some((message) => message.type === 'replay_end')).toBe(false);
    expect(messages.some((message) => message.type === 'output')).toBe(false);
    expect(
      messages
        .filter((message) => message.type === 'pty_output')
        .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
    ).toEqual(['before-1\n', 'before-2\n', 'live\n']);

    ws.close();
    await adapter.destroy();
  });

  it('replays bounded PTY backlog to later embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'shell', pty: true }, wrapped, {
      maxPtyBufferBytes: 10,
    });

    adapter.broadcastPtyOutput(Buffer.from('12345'));
    adapter.broadcastPtyOutput(Buffer.from('abcdef'));

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'pty_output'));

    expect(
      messages
        .filter((message) => message.type === 'pty_output')
        .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
        .join('')
    ).toBe('2345abcdef');

    adapter.broadcastPtyOutput(Buffer.from('0123456789ABCDE'));
    const ws2 = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const secondMessages: HeadlessMessage[] = [];
    ws2.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        secondMessages.push(parsed);
      }
    });

    await waitFor(() => secondMessages.some((message) => message.type === 'pty_output'));

    expect(
      secondMessages
        .filter((message) => message.type === 'pty_output')
        .map((message) => Buffer.from(message.data, 'base64').toString('utf8'))
    ).toEqual(['56789ABCDE']);

    ws.close();
    ws2.close();
    await adapter.destroy();
  });

  it('broadcasts live output and updated session info to embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'agent',
        interactive: false,
        workspacePath: '/tmp/original',
        gitRemote: 'example.com/original',
      },
      wrapped
    );

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));
    messages.length = 0;

    adapter.log('live-message');
    adapter.updateSessionInfo({
      workspacePath: '/tmp/updated',
      gitRemote: 'example.com/updated',
    });

    await waitFor(
      () =>
        messages.some((message) => message.type === 'output') &&
        messages.some(
          (message) => message.type === 'session_info' && message.workspacePath === '/tmp/updated'
        )
    );

    expect(messages.find((message) => message.type === 'output')).toMatchObject({
      type: 'output',
      seq: 1,
      message: { type: 'log', args: ['live-message'] },
    });
    expect(messages.find((message) => message.type === 'session_info')).toMatchObject({
      type: 'session_info',
      workspacePath: '/tmp/updated',
      gitRemote: 'example.com/updated',
      sessionId: expect.any(String),
    });

    ws.close();
    await adapter.destroy();
  });

  it('broadcasts live plan content updates to embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });
    await waitFor(() => messages.some((message) => message.type === 'replay_end'));
    messages.length = 0;

    adapter.sendPlanContent('## updated plan');

    await waitFor(() => messages.some((message) => message.type === 'plan_content'));

    expect(messages).toContainEqual({
      type: 'plan_content',
      content: '## updated plan',
      tasks: [],
    });

    ws.close();
    await adapter.destroy();
  });

  it('replays only the latest plan content to newly connected clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);

    adapter.sendPlanContent('# first version');
    adapter.sendPlanContent('# second version');

    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
    const messages: HeadlessMessage[] = [];
    ws.addEventListener('message', (event) => {
      const parsed = parseMessage(event.data as string);
      if (parsed) {
        messages.push(parsed);
      }
    });

    await waitFor(() => messages.some((message) => message.type === 'replay_end'));

    expect(messages.filter((message) => message.type === 'plan_content')).toEqual([
      {
        type: 'plan_content',
        content: '# second version',
        tasks: [],
      },
    ]);

    ws.close();
    await adapter.destroy();
  });

  it('writes session metadata including planUuid and sessionId to the session file', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter(
      {
        command: 'review',
        planId: 42,
        planUuid: 'plan-uuid-42',
        planTitle: 'review plan',
        linkedPlanId: 43,
        linkedPlanUuid: 'linked-plan-uuid-43',
        linkedPlanTitle: 'linked plan',
        linkedPrUrl: 'https://github.com/owner/repo/pull/42',
        linkedPrNumber: 42,
        linkedPrTitle: 'review target',
      },
      wrapped
    );

    const info = readSessionInfoFile(process.pid);
    expect(info).toMatchObject({
      pid: process.pid,
      command: 'review',
      hostname: '127.0.0.1',
      planId: 42,
      planUuid: 'plan-uuid-42',
      planTitle: 'review plan',
      linkedPlanId: 43,
      linkedPlanUuid: 'linked-plan-uuid-43',
      linkedPlanTitle: 'linked plan',
      linkedPrUrl: 'https://github.com/owner/repo/pull/42',
      linkedPrNumber: 42,
      linkedPrTitle: 'review target',
      sessionId: expect.any(String),
    });

    await adapter.destroy();
  });

  it.each(['end_session', 'force_end_session'] as const)(
    'keeps %s when no executor handler is installed',
    async (type: 'end_session' | 'force_end_session'): Promise<void> => {
      const { adapter: wrapped } = createRecordingAdapter();
      const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
      const port = (adapter as any).sessionServer.port as number;
      const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);
      try {
        expect(adapter.hasSessionEndRequest).toBe(false);
        ws.send(JSON.stringify({ type } satisfies HeadlessServerMessage));
        await waitFor(() => adapter.hasSessionEndRequest);
        adapter.setEndSessionHandler(undefined);
        adapter.setForceEndSessionHandler(undefined);
        expect(adapter.hasSessionEndRequest).toBe(true);
      } finally {
        ws.close();
        await adapter.destroy();
      }
    }
  );

  it('handles prompt, user input, and end-session messages from embedded-server clients', async () => {
    const { adapter: wrapped, calls } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    await waitFor(() => readSessionInfoFile(process.pid) != null);

    let receivedInput: string | undefined;
    let endSessionCount = 0;
    let forceEndSessionCount = 0;
    adapter.setUserInputHandler((content) => {
      receivedInput = content;
    });
    adapter.setEndSessionHandler(() => {
      endSessionCount += 1;
    });
    adapter.setForceEndSessionHandler(() => {
      forceEndSessionCount += 1;
    });

    const prompt = adapter.waitForPromptResponse('req-1');
    ws.send(
      JSON.stringify({
        type: 'prompt_response',
        requestId: 'req-1',
        value: 'accepted',
      } satisfies HeadlessServerMessage)
    );
    await expect(prompt.promise).resolves.toBe('accepted');

    ws.send(
      JSON.stringify({ type: 'user_input', content: 'typed input' } satisfies HeadlessServerMessage)
    );
    await waitFor(() => receivedInput === 'typed input');

    ws.send(JSON.stringify({ type: 'end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => endSessionCount === 1);
    ws.send(JSON.stringify({ type: 'force_end_session' } satisfies HeadlessServerMessage));
    await waitFor(() => forceEndSessionCount === 1);

    expect(calls).toContainEqual({
      method: 'sendStructured',
      args: [
        {
          type: 'user_terminal_input',
          content: 'typed input',
          source: 'gui',
          timestamp: expect.any(String),
        },
      ],
    });

    ws.close();
    await adapter.destroy();
  });

  it('routes PTY input and resize messages from embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'shell', pty: true }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    let receivedInput: string | undefined;
    let receivedResize: { cols: number; rows: number } | undefined;
    adapter.setPtyInputHandler((bytes) => {
      receivedInput = Buffer.from(bytes).toString('utf8');
    });
    adapter.setPtyResizeHandler((cols, rows) => {
      receivedResize = { cols, rows };
    });

    ws.send(
      JSON.stringify({
        type: 'pty_input',
        data: Buffer.from('echo hello\r').toString('base64'),
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => receivedInput === 'echo hello\r');

    ws.send(
      JSON.stringify({ type: 'pty_resize', cols: 132, rows: 43 } satisfies HeadlessServerMessage)
    );
    await waitFor(() => receivedResize?.cols === 132 && receivedResize.rows === 43);

    expect(receivedResize).toEqual({ cols: 132, rows: 43 });

    ws.close();
    await adapter.destroy();
  });

  it('tracks notification subscriber updates from embedded-server clients', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    expect(adapter.hasNotificationSubscribers()).toBe(false);

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: true,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => adapter.hasNotificationSubscribers());

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: false,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => !adapter.hasNotificationSubscribers());

    ws.close();
    await adapter.destroy();
  });

  it('resets notification subscribers when all clients disconnect', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped);
    const port = (adapter as any).sessionServer.port as number;
    const ws = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    ws.send(
      JSON.stringify({
        type: 'notification_subscribers_changed',
        hasSubscribers: true,
      } satisfies HeadlessServerMessage)
    );
    await waitFor(() => adapter.hasNotificationSubscribers());

    // Disconnect without sending hasSubscribers: false
    ws.close();
    await waitFor(() => !adapter.hasNotificationSubscribers());

    await adapter.destroy();
  });

  it('honors maxBufferBytes by trimming replay history', async () => {
    const { adapter: wrapped } = createRecordingAdapter();
    const adapter = createTestHeadlessAdapter({ command: 'agent' }, wrapped, {
      maxBufferBytes: 250,
    });

    for (let index = 0; index < 20; index += 1) {
      adapter.log(`line-${index}`);
    }

    const internals = adapter as any;
    expect(internals.historyOutputBytes).toBeLessThanOrEqual(250);
    expect(internals.history.length).toBeLessThan(20);

    await adapter.destroy();
  });
});
