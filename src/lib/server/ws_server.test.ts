import { afterEach, describe, expect, test, vi } from 'vitest';

import type { SessionManager } from './session_manager.js';
import {
  resolveHeadlessServerConfig,
  resolveHeadlessServerPort,
  startWebSocketServer,
} from './ws_server.js';

function createSessionManagerStub(): SessionManager {
  return {
    handleHttpNotification: vi.fn(),
    handleWebSocketConnect: vi.fn(),
    handleWebSocketMessage: vi.fn(),
    handleWebSocketDisconnect: vi.fn(),
  } as unknown as SessionManager;
}

const serversToStop: Array<{ stop: () => void }> = [];

describe('lib/server/ws_server', () => {
  afterEach(() => {
    delete process.env.TIM_WS_PORT;
    delete process.env.TIM_HEADLESS_URL;

    for (const server of serversToStop.splice(0)) {
      server.stop();
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

    expect(logSpy).toHaveBeenCalledWith('[ws_server] Received WebSocket message', {
      connectionId: expect.any(String),
      message: {
        type: 'session_info',
        command: `${'x'.repeat(200)}...(40 more chars)`,
        extra: {
          nested: `${'x'.repeat(200)}...(40 more chars)`,
        },
      },
    });

    ws.close();
    logSpy.mockRestore();
  });
});
