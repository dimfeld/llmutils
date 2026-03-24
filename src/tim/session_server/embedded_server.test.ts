import { afterEach, describe, expect, test } from 'bun:test';

import type { HeadlessMessage, HeadlessServerMessage } from '../../logging/headless_protocol.js';
import { startEmbeddedServer, type EmbeddedServerHandle } from './embedded_server.js';

async function waitFor(condition: () => boolean, timeoutMs: number = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function parseJsonMessage<T>(value: string | Buffer | ArrayBuffer | ArrayBufferView): T {
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Buffer
        ? value.toString('utf8')
        : ArrayBuffer.isView(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8')
          : Buffer.from(value).toString('utf8');

  return JSON.parse(text) as T;
}

function parseClientMessage(
  value: string | Buffer | ArrayBuffer | ArrayBufferView
): HeadlessMessage {
  return parseJsonMessage<HeadlessMessage>(value);
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

function waitForMessage(ws: WebSocket): Promise<HeadlessMessage> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(parseClientMessage(event.data)), {
      once: true,
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket error while waiting')), {
      once: true,
    });
  });
}

function waitForRawMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      'message',
      (event) => {
        const data = event.data;
        const text =
          typeof data === 'string'
            ? data
            : data instanceof Buffer
              ? data.toString('utf8')
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
                : Buffer.from(data).toString('utf8');
        resolve(text);
      },
      {
        once: true,
      }
    );
    ws.addEventListener('error', () => reject(new Error('WebSocket error while waiting')), {
      once: true,
    });
  });
}

async function getAvailablePort(): Promise<number> {
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open() {},
      close() {},
      drain() {},
      data() {},
      error() {},
      end() {},
      timeout() {},
      connectError() {},
    },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

const serversToStop: EmbeddedServerHandle[] = [];

afterEach(() => {
  for (const server of serversToStop.splice(0)) {
    server.stop();
  }
});

describe('session_server/embedded_server', () => {
  test('starts on a random port when port 0 is requested', () => {
    const randomPortServer = startEmbeddedServer({ port: 0 });
    serversToStop.push(randomPortServer);
    expect(randomPortServer.port).toBeGreaterThan(0);
  });

  test('starts on a specific requested port', async () => {
    const requestedPort = await getAvailablePort();
    const requestedServer = startEmbeddedServer({ port: requestedPort });
    serversToStop.push(requestedServer);
    expect(requestedServer.port).toBe(requestedPort);
  });

  test('throws when the requested port is unavailable', () => {
    const first = startEmbeddedServer({ port: 0 });
    serversToStop.push(first);

    expect(() => startEmbeddedServer({ port: first.port })).toThrow();
  });

  test('rejects unauthorized requests and accepts bearer tokens from headers or query params', async () => {
    const server = startEmbeddedServer({ port: 0, bearerToken: 'secret-token' });
    serversToStop.push(server);

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/tim-agent`);
    expect(unauthorized.status).toBe(401);

    const unauthorizedHeader = await fetch(`http://127.0.0.1:${server.port}/tim-agent`, {
      headers: {
        authorization: 'Bearer wrong-token',
      },
    });
    expect(unauthorizedHeader.status).toBe(401);

    const authorizedViaHeader = await fetch(`http://127.0.0.1:${server.port}/tim-agent`, {
      headers: {
        authorization: 'Bearer secret-token',
      },
    });
    expect(authorizedViaHeader.status).toBe(400);

    const ws = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent?token=secret-token`);
    ws.close();
  });

  test('allows unauthenticated websocket connections when no bearer token is configured', async () => {
    const server = startEmbeddedServer({ port: 0 });
    serversToStop.push(server);

    const ws = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    expect(server.connectedClients.size).toBe(1);
    ws.close();
    await waitFor(() => server.connectedClients.size === 0);
  });

  test('tracks clients, routes parsed messages, and notifies on disconnect', async () => {
    const connects: string[] = [];
    const disconnects: string[] = [];
    const messages: Array<{ connectionId: string; message: HeadlessServerMessage }> = [];
    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => connects.push(connectionId),
      onMessage: (connectionId, message) => messages.push({ connectionId, message }),
      onDisconnect: (connectionId) => disconnects.push(connectionId),
    });
    serversToStop.push(server);

    const ws = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    await waitFor(() => connects.length === 1);

    expect(server.connectedClients.size).toBe(1);

    ws.send(JSON.stringify({ type: 'user_input', content: 'hello' }));
    ws.send(JSON.stringify({ type: 'prompt_response', requestId: 'req-1', value: 'ok' }));
    ws.send(JSON.stringify({ type: 'end_session' }));
    ws.send(JSON.stringify({ type: 'invalid_type' }));
    ws.send(JSON.stringify({ type: 'user_input', content: 123 }));

    await waitFor(() => messages.length === 3);
    expect(messages).toEqual([
      {
        connectionId: connects[0]!,
        message: { type: 'user_input', content: 'hello' },
      },
      {
        connectionId: connects[0]!,
        message: { type: 'prompt_response', requestId: 'req-1', value: 'ok' },
      },
      {
        connectionId: connects[0]!,
        message: { type: 'end_session' },
      },
    ]);

    ws.close();
    await waitFor(() => disconnects.length === 1);

    expect(disconnects).toEqual([connects[0]]);
    expect(server.connectedClients.size).toBe(0);
  });

  test('broadcasts to all clients and sends targeted messages', async () => {
    const server = startEmbeddedServer({ port: 0 });
    serversToStop.push(server);

    const ws1 = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    const ws2 = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    await waitFor(() => server.connectedClients.size === 2);

    const broadcast1 = waitForMessage(ws1);
    const broadcast2 = waitForMessage(ws2);
    server.broadcast({ type: 'replay_start' });

    expect(await broadcast1).toEqual({ type: 'replay_start' });
    expect(await broadcast2).toEqual({ type: 'replay_start' });

    const [firstConnectionId] = [...server.connectedClients.keys()];
    expect(firstConnectionId).toEqual(expect.any(String));

    const targeted = waitForMessage(ws1);
    expect(
      server.sendTo(firstConnectionId!, {
        type: 'session_info',
        command: 'agent',
        workspacePath: '/tmp/workspace',
      })
    ).toBe(true);
    expect(await targeted).toEqual({
      type: 'session_info',
      command: 'agent',
      workspacePath: '/tmp/workspace',
    });
    expect(server.sendTo('missing', { type: 'replay_end' })).toBe(false);

    ws1.close();
    ws2.close();
  });

  test('supports broadcasting and sending raw payloads without re-serializing', async () => {
    const server = startEmbeddedServer({ port: 0 });
    serversToStop.push(server);

    const ws1 = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    const ws2 = await openWebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    await waitFor(() => server.connectedClients.size === 2);

    const rawBroadcastPayload = '{"type":"replay_start"}';
    const rawBroadcast1 = waitForRawMessage(ws1);
    const rawBroadcast2 = waitForRawMessage(ws2);
    server.broadcastRaw(rawBroadcastPayload);

    expect(await rawBroadcast1).toBe(rawBroadcastPayload);
    expect(await rawBroadcast2).toBe(rawBroadcastPayload);

    const [firstConnectionId] = [...server.connectedClients.keys()];
    const rawTargetPayload = '{"type":"replay_end"}';
    const rawTarget = waitForRawMessage(ws1);
    expect(server.sendToRaw(firstConnectionId!, rawTargetPayload)).toBe(true);
    expect(await rawTarget).toBe(rawTargetPayload);
    expect(server.sendToRaw('missing', rawTargetPayload)).toBe(false);

    ws1.close();
    ws2.close();
  });

  test('returns 404 and 405 for unsupported paths and methods', async () => {
    const server = startEmbeddedServer({ port: 0 });
    serversToStop.push(server);

    const notFound = await fetch(`http://127.0.0.1:${server.port}/wrong-path`);
    expect(notFound.status).toBe(404);

    const methodNotAllowed = await fetch(`http://127.0.0.1:${server.port}/tim-agent`, {
      method: 'POST',
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get('allow')).toBe('GET');
  });
});
