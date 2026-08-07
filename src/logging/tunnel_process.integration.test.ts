import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import path from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { SessionProcessRegistry, toProcessId, type ProcessId } from '../common/session_process.ts';
import { createTunnelAdapter, type TunnelAdapter } from './tunnel_client.ts';
import {
  createTunnelServer,
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
