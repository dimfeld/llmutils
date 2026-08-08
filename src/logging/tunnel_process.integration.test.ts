import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import {
  SessionProcessRegistry,
  SessionProcessRegistryLifecycleSink,
  toProcessId,
  type ProcessId,
} from '../common/session_process.ts';
import {
  runWithSessionProcessOwner,
  SessionProcessOwner,
} from '../common/session_process_control.ts';
import { createTunnelAdapter, type TunnelAdapter } from './tunnel_client.ts';
import {
  createTunnelServer,
  createExecutorTunnelServer,
  type TunnelClientChannel,
  type TunnelServer,
  type TunnelServerOptions,
} from './tunnel_server.ts';
import type { TunnelProcessMessage } from './tunnel_protocol.ts';

const TEMP_BASE = '/tmp/claude';

function processId(value: string): ProcessId {
  const result = toProcessId(value);
  if (!result) {
    throw new Error(`Invalid test process ID: ${value}`);
  }
  return result;
}

async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for tunnel process state');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function connectRaw(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect(socketPath, () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('tunnel process plumbing', () => {
  let testDir = '';
  let server: TunnelServer | null = null;
  const adapters: TunnelAdapter[] = [];

  beforeEach(async () => {
    await mkdir(TEMP_BASE, { recursive: true });
    testDir = await mkdtemp(path.join(TEMP_BASE, 'tp-'));
  });

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.destroy();
    }
    server?.close();
    server = null;
    await rm(testDir, { recursive: true, force: true });
  });

  async function createFixture(
    extraOptions: Omit<TunnelServerOptions, 'processRegistry'> = {}
  ): Promise<{
    registry: SessionProcessRegistry;
    root: ProcessId;
    rootExecutor: ProcessId;
    socketPath: string;
  }> {
    const registry = new SessionProcessRegistry({ sessionId: 'session-1' });
    const root = processId('root');
    const rootExecutor = processId('root-executor');
    registry.register({ processId: root, kind: 'tim', label: 'root tim' });
    registry.register({
      processId: rootExecutor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'root executor',
    });
    const socketPath = path.join(testDir, 'output.sock');
    server = await createTunnelServer(socketPath, { processRegistry: registry, ...extraOptions });
    return { registry, root, rootExecutor, socketPath };
  }

  it('injects the current owner registry into executor tunnel servers', async () => {
    const registry = new SessionProcessRegistry({ sessionId: 'session-factory' });
    const root = processId('factory-root');
    const rootExecutor = processId('factory-root-executor');
    registry.register({ processId: root, kind: 'tim', label: 'factory root' });
    registry.register({
      processId: rootExecutor,
      parentProcessId: root,
      ownerProcessId: root,
      kind: 'executor',
      label: 'factory root executor',
    });
    const owner = new SessionProcessOwner({
      sessionId: 'session-factory',
      ownerProcessId: root,
      lifecycleSink: new SessionProcessRegistryLifecycleSink(registry),
    });
    const socketPath = path.join(testDir, 'factory-output.sock');

    server = await runWithSessionProcessOwner(owner, () => createExecutorTunnelServer(socketPath));
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const nestedTim = processId('factory-nested-tim');
    client.registerProcess({
      processId: nestedTim,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'factory nested tim',
    });

    await waitFor(() => registry.has(nestedTim));
    expect(registry.getOwnerChannel(nestedTim)).toBeDefined();
  });

  it('accepts validated lifecycle messages and keeps malformed messages out of the registry', async () => {
    const received: TunnelProcessMessage[] = [];
    const { registry, rootExecutor, socketPath } = await createFixture({
      onProcessMessage: (message) => received.push(message),
    });

    const socket = await connectRaw(socketPath);
    socket.write(
      `${JSON.stringify({
        type: 'process_register',
        processId: 'bad process id',
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'invalid',
      })}\n`
    );
    socket.write(`${JSON.stringify({ type: 'process_update', processId: 'only-id' })}\n`);
    socket.write(
      `${JSON.stringify({
        type: 'process_register',
        processId: 'tim-raw',
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'raw nested tim',
      })}\n`
    );

    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      type: 'process_register',
      processId: processId('tim-raw'),
    });
    expect(registry.has(processId('tim-raw'))).toBe(true);
    socket.end();
  });

  it('rejects malformed lifecycle fields while accepting a valid nested registration', async () => {
    const received: TunnelProcessMessage[] = [];
    const { registry, rootExecutor, socketPath } = await createFixture({
      onProcessMessage: (message) => received.push(message),
    });

    const socket = await connectRaw(socketPath);
    const invalidMessages: Record<string, unknown>[] = [
      {
        type: 'process_register',
        processId: 'tim-invalid-kind',
        parentProcessId: rootExecutor,
        kind: 'worker',
        label: 'invalid kind',
      },
      {
        type: 'process_register',
        processId: 'tim-invalid-label',
        parentProcessId: rootExecutor,
        kind: 'tim',
        label: '   ',
      },
      {
        type: 'process_register',
        processId: 'tim-invalid-pid',
        parentProcessId: rootExecutor,
        kind: 'tim',
        label: 'invalid pid',
        pid: 0,
      },
      {
        type: 'process_register',
        processId: 'tim-invalid-parent',
        parentProcessId: 'not a process id',
        kind: 'tim',
        label: 'invalid parent',
      },
      {
        type: 'process_update',
        processId: 'root-executor',
      },
      {
        type: 'process_update',
        processId: 'root-executor',
        state: 'unknown',
      },
      {
        type: 'process_exit',
        processId: 'root-executor',
        exitCode: 1.5,
      },
      {
        type: 'process_exit',
        processId: 'root-executor',
        signal: 'x'.repeat(129),
      },
      {
        type: 'process_remove',
        processId: 'root-executor',
        subtree: 'yes',
      },
    ];
    for (const message of invalidMessages) {
      socket.write(`${JSON.stringify(message)}\n`);
    }
    socket.write(
      `${JSON.stringify({
        type: 'process_register',
        processId: 'tim-valid',
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'valid nested tim',
      })}\n`
    );

    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({
      type: 'process_register',
      processId: processId('tim-valid'),
    });
    expect(registry.getSnapshot().map((node) => node.processId)).toEqual([
      processId('root'),
      rootExecutor,
      processId('tim-valid'),
    ]);
    socket.end();
  });

  it('accepts multi-kilobyte provider command metadata through the tunnel', async () => {
    const { registry, rootExecutor, socketPath } = await createFixture();
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('long-command-tim');
    const executor = processId('long-command-executor');
    const command = `codex exec --json ${'prompt-token '.repeat(500)}`;

    expect(command.length).toBeGreaterThan(2048);
    expect(
      client.registerProcess({
        processId: tim,
        parentProcessId: rootExecutor,
        ownerProcessId: rootExecutor,
        kind: 'tim',
        label: 'long-command tim',
      })
    ).toBe(true);
    expect(
      client.registerProcess({
        processId: executor,
        parentProcessId: tim,
        ownerProcessId: tim,
        kind: 'executor',
        label: 'Codex CLI prompt',
        command,
        state: 'starting',
      })
    ).toBe(true);

    await waitFor(() => registry.get(executor)?.command === command);
    expect(client.updateProcess(executor, { command, state: 'running' })).toBe(true);
    await waitFor(() => registry.get(executor)?.state === 'running');
    expect(registry.get(executor)).toMatchObject({ command, state: 'running' });
  });

  it('builds nested and parallel branches from real tunnel lifecycle messages', async () => {
    const { registry, rootExecutor, socketPath } = await createFixture();
    const clientA = await createTunnelAdapter(socketPath);
    const clientB = await createTunnelAdapter(socketPath);
    adapters.push(clientA, clientB);

    const timA = processId('tim-a');
    const executorA = processId('executor-a');
    const nestedTimA = processId('nested-tim-a');
    const nestedExecutorA = processId('nested-executor-a');
    const timB = processId('tim-b');
    const executorB = processId('executor-b');

    expect(
      clientA.registerProcess({
        processId: timA,
        parentProcessId: rootExecutor,
        kind: 'tim',
        label: 'tim A',
      })
    ).toBe(true);
    expect(
      clientA.registerProcess({
        processId: executorA,
        parentProcessId: timA,
        kind: 'executor',
        label: 'executor A',
      })
    ).toBe(true);
    expect(
      clientA.registerProcess({
        processId: nestedTimA,
        parentProcessId: executorA,
        kind: 'tim',
        label: 'nested tim A',
      })
    ).toBe(true);
    expect(
      clientA.registerProcess({
        processId: nestedExecutorA,
        parentProcessId: nestedTimA,
        kind: 'executor',
        label: 'nested executor A',
      })
    ).toBe(true);
    expect(
      clientB.registerProcess({
        processId: timB,
        parentProcessId: rootExecutor,
        kind: 'tim',
        label: 'tim B',
      })
    ).toBe(true);
    expect(
      clientB.registerProcess({
        processId: executorB,
        parentProcessId: timB,
        kind: 'executor',
        label: 'executor B',
      })
    ).toBe(true);

    await waitFor(() => registry.size === 8);
    expect(registry.getSnapshot().map((node) => node.processId)).toEqual([
      processId('root'),
      rootExecutor,
      timA,
      executorA,
      nestedTimA,
      nestedExecutorA,
      timB,
      executorB,
    ]);
    expect(registry.get(nestedTimA)).toMatchObject({
      parentProcessId: executorA,
      ownerProcessId: executorA,
    });
    expect(registry.get(nestedExecutorA)).toMatchObject({
      parentProcessId: nestedTimA,
      ownerProcessId: nestedTimA,
    });
  });

  it('gives each client a stable channel and routes termination only to the matching owner', async () => {
    const channels: TunnelClientChannel[] = [];
    const { registry, rootExecutor, socketPath } = await createFixture({
      onClientConnect: (channel) => channels.push(channel),
    });

    const clientA = await createTunnelAdapter(socketPath);
    const clientB = await createTunnelAdapter(socketPath);
    adapters.push(clientA, clientB);
    const timA = processId('tim-a');
    const executorA = processId('executor-a');
    const timB = processId('tim-b');
    const executorB = processId('executor-b');
    const terminatedA: string[] = [];
    const terminatedB: string[] = [];
    clientA.setExecutorControlHandler((message) => terminatedA.push(message.executorId));
    clientB.setExecutorControlHandler((message) => terminatedB.push(message.executorId));

    expect(
      clientA.registerProcess({
        processId: timA,
        parentProcessId: rootExecutor,
        kind: 'tim',
        label: 'tim A',
      })
    ).toBe(true);
    expect(
      clientA.registerProcess({
        processId: executorA,
        parentProcessId: timA,
        kind: 'executor',
        label: 'executor A',
      })
    ).toBe(true);
    clientB.registerProcess({
      processId: timB,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'tim B',
    });
    clientB.registerProcess({
      processId: executorB,
      parentProcessId: timB,
      ownerProcessId: timB,
      kind: 'executor',
      label: 'executor B',
    });

    await waitFor(() => registry.has(executorA) && registry.has(executorB));
    expect(channels).toHaveLength(2);
    expect(channels[0]?.id).not.toBe(channels[1]?.id);
    expect(server?.clients.get(channels[0]!.id)).toBe(channels[0]);

    expect(server?.sendExecutorTermination(executorA, 'request-a')).toEqual({
      ok: true,
      clientId: channels[0]!.id,
    });
    await waitFor(() => terminatedA.length === 1);
    expect(terminatedA).toEqual([executorA]);
    expect(terminatedB).toEqual([]);

    expect(server?.sendExecutorControl(executorB, 'request-b')).toEqual({
      ok: true,
      clientId: channels[1]!.id,
    });
    await waitFor(() => terminatedB.length === 1);
    expect(terminatedB).toEqual([executorB]);
  });

  it('returns an owner termination result through the tunnel and rejects stale control results', async () => {
    const terminationResults: Array<{
      executorId: ProcessId;
      requestId: string;
      result: string;
      error?: string;
    }> = [];
    const { registry, rootExecutor, socketPath } = await createFixture();
    registry.subscribeTerminationResults((event) => terminationResults.push(event));

    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-result');
    const executor = processId('executor-result');
    client.setExecutorControlHandler(() => 'terminated');
    client.registerProcess({
      processId: tim,
      parentProcessId: rootExecutor,
      kind: 'tim',
      label: 'result tim',
    });
    client.registerProcess({
      processId: executor,
      parentProcessId: tim,
      kind: 'executor',
      label: 'result executor',
    });
    await waitFor(() => registry.has(executor));

    expect(server?.sendExecutorTermination(executor, 'request-result')).toMatchObject({ ok: true });
    await waitFor(() => terminationResults.length === 1);
    expect(terminationResults).toEqual([
      {
        executorId: executor,
        requestId: 'request-result',
        result: 'terminated',
        error: undefined,
      },
    ]);

    // A result from a client that does not own the tracked executor cannot
    // enter the root registry.
    const rawSocket = await connectRaw(socketPath);
    rawSocket.write(
      `${JSON.stringify({
        type: 'terminate_executor_result',
        executorId: executor,
        requestId: 'request-forged',
        result: 'terminated',
      })}\n`
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(terminationResults).toHaveLength(1);
    rawSocket.end();
  });

  it('rejects lifecycle messages from a different client and preserves the owner branch', async () => {
    const accepted: Array<{ processId: ProcessId; clientId: string }> = [];
    const { registry, rootExecutor, socketPath } = await createFixture({
      onProcessMessage: (message, client) => {
        accepted.push({ processId: message.processId, clientId: client.id });
      },
    });
    const clientA = await createTunnelAdapter(socketPath);
    const clientB = await createTunnelAdapter(socketPath);
    adapters.push(clientA, clientB);

    const timA = processId('tim-owned-a');
    const executorA = processId('executor-owned-a');
    const executorB = processId('executor-forbidden-b');
    clientA.registerProcess({
      processId: timA,
      parentProcessId: rootExecutor,
      kind: 'tim',
      label: 'tim A',
    });
    clientA.registerProcess({
      processId: executorA,
      parentProcessId: timA,
      kind: 'executor',
      label: 'executor A',
    });
    await waitFor(() => registry.has(executorA));
    const acceptedBeforeAttack = accepted.length;

    clientB.updateProcess(executorA, { label: 'hijacked' });
    clientB.exitProcess(executorA, { exitCode: 99 });
    clientB.removeProcess(timA);
    clientB.registerProcess({
      processId: executorB,
      parentProcessId: timA,
      ownerProcessId: timA,
      kind: 'executor',
      label: 'executor B',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(accepted).toHaveLength(acceptedBeforeAttack);
    expect(registry.get(timA)).toMatchObject({ state: 'running', label: 'tim A' });
    expect(registry.get(executorA)).toMatchObject({ state: 'running', label: 'executor A' });
    expect(registry.has(executorB)).toBe(false);
  });

  it('accepts duplicate and late lifecycle messages without recreating or changing a node', async () => {
    const received: TunnelProcessMessage[] = [];
    const { registry, rootExecutor, socketPath } = await createFixture({
      onProcessMessage: (message) => received.push(message),
    });
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-idempotent');
    const executor = processId('executor-idempotent');

    const timRegistration = {
      processId: tim,
      parentProcessId: rootExecutor,
      kind: 'tim' as const,
      label: 'idempotent tim',
    };
    const executorRegistration = {
      processId: executor,
      parentProcessId: tim,
      kind: 'executor' as const,
      label: 'idempotent executor',
    };
    client.registerProcess(timRegistration);
    client.registerProcess(timRegistration);
    client.registerProcess(executorRegistration);
    client.registerProcess(executorRegistration);
    await waitFor(() => registry.has(executor));
    await waitFor(() => received.length >= 4);

    client.updateProcess(executor, { pid: 42, command: 'agent --run' });
    client.updateProcess(executor, { pid: 42, command: 'agent --run' });
    await waitFor(() => registry.get(executor)?.pid === 42);
    await waitFor(() => received.length >= 6);
    client.exitProcess(executor, { exitCode: 0 });
    client.exitProcess(executor, { exitCode: 1 });
    await waitFor(() => registry.get(executor)?.state === 'exited');
    await waitFor(() => received.length >= 8);
    client.updateProcess(executor, { label: 'late label', state: 'running' });
    await waitFor(() => received.length >= 9);
    expect(registry.get(executor)).toMatchObject({
      label: 'idempotent executor',
      parentProcessId: tim,
      ownerProcessId: tim,
      state: 'exited',
    });
    expect(registry.getOwnerChannel(tim)).toBeDefined();
    client.registerProcess(executorRegistration);
    await waitFor(() => received.length >= 10);
    client.removeProcess(executor);
    client.removeProcess(executor);
    await waitFor(() => !registry.has(executor));
    await waitFor(() => received.length >= 12);

    expect(registry.get(tim)).toMatchObject({ label: 'idempotent tim', state: 'running' });
    expect(registry.has(executor)).toBe(false);
    expect(received.map((message) => message.type)).toEqual([
      'process_register',
      'process_register',
      'process_register',
      'process_register',
      'process_update',
      'process_update',
      'process_exit',
      'process_exit',
      'process_update',
      'process_register',
      'process_remove',
      'process_remove',
    ]);
  });

  it('cleans a client owner subtree when its tunnel disconnects', async () => {
    const { registry, rootExecutor, socketPath } = await createFixture();
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-disconnected');
    const executor = processId('executor-disconnected');
    client.registerProcess({
      processId: tim,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'nested tim',
    });
    client.registerProcess({
      processId: executor,
      parentProcessId: tim,
      ownerProcessId: tim,
      kind: 'executor',
      label: 'nested executor',
    });
    await waitFor(() => registry.has(executor));

    await client.destroy();
    await waitFor(() => !registry.has(tim) && !registry.has(executor));
    expect(server?.clients.size).toBe(0);
    expect(registry.has(rootExecutor)).toBe(true);
  });

  it('reports a channel send failure without rerouting the request', async () => {
    const { registry, rootExecutor, socketPath } = await createFixture();
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-send-failure');
    const executor = processId('executor-send-failure');
    client.registerProcess({
      processId: tim,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'nested tim',
    });
    client.registerProcess({
      processId: executor,
      parentProcessId: tim,
      ownerProcessId: tim,
      kind: 'executor',
      label: 'nested executor',
    });
    await waitFor(() => registry.has(executor));

    const channel = [...server!.clients.values()][0]!;
    const originalSend = channel.send;
    channel.send = () => false;
    expect(server!.sendExecutorTermination(executor)).toEqual({
      ok: false,
      reason: 'send_failed',
    });
    channel.send = originalSend;
  });

  it('reports unknown, non-executor, and disconnected owner targets', async () => {
    const { registry, root, rootExecutor, socketPath } = await createFixture();
    expect(server!.sendExecutorTermination(processId('missing'))).toEqual({
      ok: false,
      reason: 'unknown_executor',
    });
    expect(server!.sendExecutorTermination(root)).toEqual({
      ok: false,
      reason: 'not_executor',
    });
    expect(server!.sendExecutorTermination(rootExecutor)).toEqual({
      ok: false,
      reason: 'owner_not_connected',
    });

    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-disconnect-owner');
    const executor = processId('executor-disconnect-owner');
    client.registerProcess({
      processId: tim,
      parentProcessId: rootExecutor,
      kind: 'tim',
      label: 'tim owner',
    });
    client.registerProcess({
      processId: executor,
      parentProcessId: tim,
      kind: 'executor',
      label: 'executor',
    });
    await waitFor(() => registry.has(executor));
    await client.destroy();
    await waitFor(() => !registry.has(tim));
    expect(server!.sendExecutorTermination(executor)).toEqual({
      ok: false,
      reason: 'unknown_executor',
    });
  });

  it('rejects a termination request after the executor has exited', async () => {
    const { registry, rootExecutor, socketPath } = await createFixture();
    const client = await createTunnelAdapter(socketPath);
    adapters.push(client);
    const tim = processId('tim-stale');
    const executor = processId('executor-stale');
    client.registerProcess({
      processId: tim,
      parentProcessId: rootExecutor,
      ownerProcessId: rootExecutor,
      kind: 'tim',
      label: 'nested tim',
    });
    client.registerProcess({
      processId: executor,
      parentProcessId: tim,
      ownerProcessId: tim,
      kind: 'executor',
      label: 'nested executor',
    });
    await waitFor(() => registry.has(executor));

    client.exitProcess(executor, { exitCode: 0 });
    await waitFor(() => registry.get(executor)?.state === 'exited');
    expect(server!.sendExecutorTermination(executor)).toEqual({
      ok: false,
      reason: 'stale_executor',
    });
  });
});
