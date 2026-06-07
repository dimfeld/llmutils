import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

import type { HeadlessServerMessage } from '../../logging/headless_protocol.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { SessionManager } from './session_manager.js';
import type { SessionManager as SessionManagerType } from './session_manager.js';
import {
  resolveHeadlessServerConfig,
  resolveHeadlessServerPort,
  startWebSocketServer,
} from './ws_server.js';

function createSessionManagerStub(): SessionManagerType {
  return {
    handleHttpNotification: vi.fn(),
    handleWebSocketConnect: vi.fn(),
    handleWebSocketMessage: vi.fn(),
    handleWebSocketDisconnect: vi.fn(),
  } as unknown as SessionManagerType;
}

const serversToStop: Array<{ stop: () => void }> = [];
const socketsToClose: WebSocket[] = [];
const dbsToClose: Database[] = [];

let tempDir: string;

interface RealPtyServerFixture {
  connectionId: string;
  manager: SessionManager;
  server: { port: number; stop: () => void };
  agentMessages: HeadlessServerMessage[];
}

const WebSocketWithHeaders = WebSocket as unknown as new (
  url: string,
  init: { headers: Record<string, string> }
) => WebSocket;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-ws-server-test-'));
});

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function createTestDatabase(): Database {
  const db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
  dbsToClose.push(db);
  return db;
}

function createRealPtyServerFixture(
  connectionId = `conn-${crypto.randomUUID()}`
): RealPtyServerFixture {
  process.env.TIM_WS_PORT = '0';

  const manager = new SessionManager(createTestDatabase());
  const agentMessages: HeadlessServerMessage[] = [];
  manager.handleWebSocketConnect(connectionId, (message: HeadlessServerMessage): void => {
    agentMessages.push(message);
  });
  manager.handleWebSocketMessage(connectionId, {
    type: 'session_info',
    command: 'shell',
    interactive: true,
    pty: true,
    workspacePath: '/tmp/tim-pty-ws-test',
  });

  const server = startWebSocketServer(manager, {});
  serversToStop.push(server);

  return { connectionId, manager, server, agentMessages };
}

async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for websocket open')),
      1000
    );
    ws.addEventListener('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('websocket error before open'));
    });
  });
}

async function waitForMessage(ws: WebSocket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for websocket message')),
      1000
    );
    ws.addEventListener(
      'message',
      (event: MessageEvent<string>) => {
        clearTimeout(timeout);
        resolve(String(event.data));
      },
      { once: true }
    );
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timeout);
        reject(new Error('websocket error while waiting for message'));
      },
      { once: true }
    );
  });
}

async function expectNoMessage(ws: WebSocket, timeoutMs = 50): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, timeoutMs);
    ws.addEventListener(
      'message',
      (event: MessageEvent<string>) => {
        clearTimeout(timeout);
        reject(new Error(`unexpected websocket message: ${String(event.data)}`));
      },
      { once: true }
    );
  });
}

async function waitForAgentMessage(
  messages: HeadlessServerMessage[],
  predicate: (message: HeadlessServerMessage) => boolean
): Promise<HeadlessServerMessage> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const found = messages.find(predicate);
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('timed out waiting for agent message');
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 100);
    ws.addEventListener(
      'close',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

async function openPtySocket(
  serverPort: number,
  connectionId: string,
  headers?: Record<string, string>
): Promise<WebSocket> {
  const url = `ws://127.0.0.1:${serverPort}/pty?connectionId=${encodeURIComponent(connectionId)}`;
  const ws = headers ? new WebSocketWithHeaders(url, { headers }) : new WebSocket(url);
  socketsToClose.push(ws);
  await waitForOpen(ws);
  return ws;
}

describe('lib/server/ws_server', () => {
  afterEach(async () => {
    delete process.env.TIM_WS_PORT;
    delete process.env.TIM_HEADLESS_URL;

    await Promise.all(socketsToClose.splice(0).map((socket) => closeWebSocket(socket)));

    for (const server of serversToStop.splice(0)) {
      server.stop();
    }

    for (const db of dbsToClose.splice(0)) {
      db.close(false);
    }
  });

  test('resolveHeadlessServerPort prefers TIM_WS_PORT over config and env headless url', () => {
    process.env.TIM_WS_PORT = '9001';
    process.env.TIM_HEADLESS_URL = 'ws://env.example:7000/tim-agent';

    const port = resolveHeadlessServerPort({
      headless: {
        url: 'ws://config.example:8124/tim-agent',
      },
    });

    expect(port).toBe(9001);
  });

  test('resolveHeadlessServerPort parses the port from TIM_HEADLESS_URL when TIM_WS_PORT is unset', () => {
    process.env.TIM_HEADLESS_URL = 'ws://env.example:9234/tim-agent';

    const port = resolveHeadlessServerPort({});

    expect(port).toBe(9234);
  });

  test('resolveHeadlessServerPort parses the port from config headless url', () => {
    const port = resolveHeadlessServerPort({
      headless: {
        url: 'wss://config.example:8456/tim-agent',
      },
    });

    expect(port).toBe(8456);
  });

  test('resolveHeadlessServerPort falls back to default when env or config ports are invalid', () => {
    process.env.TIM_WS_PORT = '70000';
    process.env.TIM_HEADLESS_URL = 'not-a-url';

    const port = resolveHeadlessServerPort({
      headless: {
        url: 'ws://config.example/tim-agent',
      },
    });

    expect(port).toBe(8123);
  });

  test('resolveHeadlessServerConfig uses root path when the configured URL has no explicit path', () => {
    const config = resolveHeadlessServerConfig({
      headless: {
        url: 'ws://config.example:8124',
      },
    });

    expect(config).toEqual({
      port: 8124,
      agentPath: '/',
    });
  });

  test('resolveHeadlessServerConfig parses a custom agent path from the configured URL', () => {
    const config = resolveHeadlessServerConfig({
      headless: {
        url: 'ws://localhost:9000/custom-path',
      },
    });

    expect(config).toEqual({
      port: 9000,
      agentPath: '/custom-path',
    });
  });

  test('resolveHeadlessServerConfig lets TIM_WS_PORT override the port without changing the path', () => {
    process.env.TIM_WS_PORT = '7777';

    const config = resolveHeadlessServerConfig({
      headless: {
        url: 'ws://localhost:9000/custom-path',
      },
    });

    expect(config).toEqual({
      port: 7777,
      agentPath: '/custom-path',
    });
  });

  test('POST /messages delegates valid payloads to the session manager and returns 202', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Build finished',
        workspacePath: '/tmp/ws-server',
        gitRemote: 'git@github.com:tim/ws-server.git',
        terminal: {
          type: 'wezterm',
          pane_id: 'pane-42',
        },
      }),
    });

    expect(response.status).toBe(202);
    expect(sessionManager.handleHttpNotification).toHaveBeenCalledWith({
      message: 'Build finished',
      workspacePath: '/tmp/ws-server',
      gitRemote: 'git@github.com:tim/ws-server.git',
      terminal: {
        type: 'wezterm',
        pane_id: 'pane-42',
      },
    });
  });

  test('POST /messages rejects bodies that are missing required fields', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Build finished',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Missing required fields: message, workspacePath\n');
    expect(sessionManager.handleHttpNotification).not.toHaveBeenCalled();
  });

  test('POST /messages handles invalid JSON gracefully', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"message":',
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid JSON\n');
    expect(sessionManager.handleHttpNotification).not.toHaveBeenCalled();
  });

  test('returns 404 for unknown routes', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/not-a-route`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not Found\n');
    expect(sessionManager.handleHttpNotification).not.toHaveBeenCalled();
  });

  test('/pty forwards pty_output to the browser socket without adding session messages', async () => {
    const { connectionId, manager, server } = createRealPtyServerFixture();
    const browserWs = await openPtySocket(server.port, connectionId);
    const messagePromise = waitForMessage(browserWs);

    manager.handleWebSocketMessage(connectionId, {
      type: 'pty_output',
      data: 'b3V0cHV0',
    });

    await expect(messagePromise).resolves.toBe('b3V0cHV0');
    const session = manager
      .getSessionSnapshot()
      .sessions.find((item) => item.connectionId === connectionId);
    expect(session?.messages).toHaveLength(0);
  });

  test('/pty forwards opaque base64 input frames to the agent sender', async () => {
    const { connectionId, server, agentMessages } = createRealPtyServerFixture();
    const browserWs = await openPtySocket(server.port, connectionId);
    agentMessages.length = 0;

    browserWs.send('a2V5c3Ryb2tl');

    await expect(
      waitForAgentMessage(
        agentMessages,
        (message) => message.type === 'pty_input' && message.data === 'a2V5c3Ryb2tl'
      )
    ).resolves.toEqual({
      type: 'pty_input',
      data: 'a2V5c3Ryb2tl',
    });
  });

  test('/pty forwards valid resize frames and drops invalid resize frames', async () => {
    const { connectionId, server, agentMessages } = createRealPtyServerFixture();
    const browserWs = await openPtySocket(server.port, connectionId);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    agentMessages.length = 0;

    browserWs.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));

    await expect(
      waitForAgentMessage(
        agentMessages,
        (message) => message.type === 'pty_resize' && message.cols === 120 && message.rows === 40
      )
    ).resolves.toEqual({
      type: 'pty_resize',
      cols: 120,
      rows: 40,
    });

    agentMessages.length = 0;
    browserWs.send(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }));
    browserWs.send(JSON.stringify({ type: 'resize', cols: -1, rows: 40 }));
    browserWs.send(JSON.stringify({ type: 'resize', cols: 80.5, rows: 24 }));
    browserWs.send(JSON.stringify({ type: 'resize', cols: 80, rows: '24' }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(agentMessages.filter((message) => message.type === 'pty_resize')).toHaveLength(0);
    warnSpy.mockRestore();
  });

  test('/pty broadcasts pty_output to multiple browser viewers for the same connection', async () => {
    const { connectionId, manager, server } = createRealPtyServerFixture();
    const browserWs1 = await openPtySocket(server.port, connectionId);
    const browserWs2 = await openPtySocket(server.port, connectionId);
    const message1Promise = waitForMessage(browserWs1);
    const message2Promise = waitForMessage(browserWs2);

    manager.handleWebSocketMessage(connectionId, {
      type: 'pty_output',
      data: 'YnJvYWRjYXN0',
    });

    await expect(message1Promise).resolves.toBe('YnJvYWRjYXN0');
    await expect(message2Promise).resolves.toBe('YnJvYWRjYXN0');
  });

  test('/pty unregisters browser subscribers when the socket closes', async () => {
    const { connectionId, manager, server } = createRealPtyServerFixture();
    const firstViewer = await openPtySocket(server.port, connectionId);
    await closeWebSocket(firstViewer);

    expect(() => {
      manager.handleWebSocketMessage(connectionId, {
        type: 'pty_output',
        data: 'YWZ0ZXItY2xvc2U=',
      });
    }).not.toThrow();

    const secondViewer = await openPtySocket(server.port, connectionId);
    await expect(waitForMessage(secondViewer)).resolves.toBe('YWZ0ZXItY2xvc2U=');

    const liveMessagePromise = waitForMessage(secondViewer);
    manager.handleWebSocketMessage(connectionId, {
      type: 'pty_output',
      data: 'bmV4dC12aWV3ZXI=',
    });

    await expect(liveMessagePromise).resolves.toBe('bmV4dC12aWV3ZXI=');
    await expectNoMessage(firstViewer);
  });

  test('/pty validates connectionId and Origin before upgrade', async () => {
    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const missingConnectionResponse = await fetch(`http://127.0.0.1:${server.port}/pty`);
    expect(missingConnectionResponse.status).toBe(400);
    expect(await missingConnectionResponse.text()).toBe('Missing connectionId\n');

    const foreignOriginResponse = await fetch(
      `http://127.0.0.1:${server.port}/pty?connectionId=conn-origin`,
      {
        headers: {
          Origin: 'https://evil.example.com',
        },
      }
    );
    expect(foreignOriginResponse.status).toBe(403);
    expect(await foreignOriginResponse.text()).toBe('Forbidden\n');
  });

  test('/pty accepts loopback origins on different ports', async () => {
    const { connectionId, server } = createRealPtyServerFixture();

    const browserWs = await openPtySocket(server.port, connectionId, {
      Origin: 'http://localhost:8124',
    });

    expect(browserWs.readyState).toBe(WebSocket.OPEN);
  });

  test('/pty treats non-resize text that is also valid JSON as opaque input', async () => {
    const { connectionId, server, agentMessages } = createRealPtyServerFixture();
    const browserWs = await openPtySocket(server.port, connectionId);
    agentMessages.length = 0;

    browserWs.send('1234');

    await expect(
      waitForAgentMessage(
        agentMessages,
        (message) => message.type === 'pty_input' && message.data === '1234'
      )
    ).resolves.toEqual({
      type: 'pty_input',
      data: '1234',
    });
  });

  test('websocket message handler swallows session manager exceptions', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    vi.mocked(sessionManager.handleWebSocketMessage).mockImplementation(() => {
      throw new Error('bad frame');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            type: 'replay_start',
          })
        );
        setTimeout(resolve, 20);
      });
      ws.addEventListener('error', () => reject(new Error('websocket error')));
    });

    expect(sessionManager.handleWebSocketMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'replay_start' })
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[ws_server] Error handling WebSocket message',
      expect.any(Error)
    );

    ws.close();
    warnSpy.mockRestore();
  });

  test('logs received websocket messages with long string values truncated', async () => {
    expect.hasAssertions();

    process.env.TIM_WS_PORT = '0';
    const sessionManager = createSessionManagerStub();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const server = startWebSocketServer(sessionManager, {});
    serversToStop.push(server);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/tim-agent`);
    const longString = 'x'.repeat(240);

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(
          JSON.stringify({
            type: 'session_info',
            command: longString,
            extra: {
              nested: longString,
            },
          })
        );
        setTimeout(resolve, 20);
      });
      ws.addEventListener('error', () => reject(new Error('websocket error')));
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [label, payload] = logSpy.mock.calls[0] ?? [];
    expect(label).toBe('[ws_server] Received WebSocket message');
    expect(payload).toEqual(expect.any(String));
    expect(payload).toContain("type: 'session_info'");
    expect(payload).toContain(`command: '${'x'.repeat(200)}...(40 more chars)'`);
    expect(payload).toContain(`nested: '${'x'.repeat(200)}...(40 more chars)'`);

    ws.close();
    logSpy.mockRestore();
  });
});
