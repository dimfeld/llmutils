import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { HeadlessServerMessage } from '../../logging/headless_protocol.js';
import {
  startEmbeddedServer,
  type EmbeddedServerHandle,
} from '../../tim/session_server/embedded_server.js';
import {
  getTimSessionDir,
  readSessionInfoFile,
  removeSessionInfoFile,
  unregisterSessionInfoFileCleanup,
  writeSessionInfoFile,
  type SessionInfoFile,
} from '$tim/session_server/runtime_dir.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';

import { SessionManager } from './session_manager.js';
import { SessionDiscoveryClient } from './session_discovery.js';

interface SessionManagerStub {
  handleWebSocketConnect: ReturnType<typeof vi.fn>;
  handleWebSocketMessage: ReturnType<typeof vi.fn>;
  handleWebSocketDisconnect: ReturnType<typeof vi.fn>;
  dismissSession: ReturnType<typeof vi.fn>;
  getSessionSnapshot: ReturnType<typeof vi.fn>;
}

async function waitFor(condition: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

function createManagerStub(): SessionManagerStub {
  return {
    handleWebSocketConnect: vi.fn(),
    handleWebSocketMessage: vi.fn(),
    handleWebSocketDisconnect: vi.fn(),
    dismissSession: vi.fn(),
    getSessionSnapshot: vi.fn(() => ({ sessions: [] })),
  };
}

function createInfo(port: number, overrides: Partial<SessionInfoFile> = {}): SessionInfoFile {
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    pid: overrides.pid ?? process.pid,
    port,
    hostname: overrides.hostname,
    command: overrides.command ?? 'agent',
    workspacePath: overrides.workspacePath ?? '/tmp/workspace',
    planId: overrides.planId ?? 223,
    planUuid: overrides.planUuid ?? 'plan-uuid-223',
    planTitle: overrides.planTitle ?? 'tim web gui connects to websocket server of tim processes',
    gitRemote: overrides.gitRemote ?? 'git@github.com:tim/test.git',
    startedAt: overrides.startedAt ?? '2026-03-23T00:00:00.000Z',
    token: overrides.token,
  };
}

describe('lib/server/session_discovery', () => {
  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  let tempDir: string;
  let discovery: SessionDiscoveryClient | null = null;
  let db: Database | null = null;
  const serversToStop: EmbeddedServerHandle[] = [];
  const cleanupPids = new Set<number>();

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'tim-session-discovery-test-'));
    process.env.XDG_CACHE_HOME = tempDir;
  });

  afterEach(async () => {
    discovery?.stop();
    discovery = null;

    for (const server of serversToStop.splice(0)) {
      server.stop();
    }

    for (const pid of cleanupPids) {
      unregisterSessionInfoFileCleanup(pid);
      removeSessionInfoFile(pid);
    }
    cleanupPids.clear();

    db?.close(false);
    db = null;

    if (originalXdgCacheHome === undefined) {
      delete process.env.XDG_CACHE_HOME;
    } else {
      process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  test('discovers existing sessions, forwards replay messages, and sends messages back to the agent', async () => {
    const manager = createManagerStub();
    const receivedServerMessages: HeadlessServerMessage[] = [];

    let server!: EmbeddedServerHandle;
    server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'session-1',
          command: 'agent',
          planId: 223,
          planUuid: 'plan-uuid-223',
          planTitle: 'tim web gui connects to websocket server of tim processes',
          workspacePath: '/tmp/workspace',
          gitRemote: 'git@github.com:tim/test.git',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, {
          type: 'output',
          seq: 1,
          message: { type: 'log', args: ['hello from agent'] },
        });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
      onMessage: (_connectionId, message) => {
        receivedServerMessages.push(message);
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port);
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
    await waitFor(() => manager.handleWebSocketMessage.mock.calls.length === 4);

    expect(server.connectedClients.size).toBe(1);
    expect(manager.dismissSession).toHaveBeenCalledWith('session-1');
    expect(manager.handleWebSocketConnect).toHaveBeenCalledWith('session-1', expect.any(Function));
    expect(
      manager.handleWebSocketMessage.mock.calls.map(([connectionId, message]) => [
        connectionId,
        message.type,
      ])
    ).toEqual([
      ['session-1', 'session_info'],
      ['session-1', 'replay_start'],
      ['session-1', 'output'],
      ['session-1', 'replay_end'],
    ]);

    const sender = manager.handleWebSocketConnect.mock.calls[0]?.[1] as
      | ((message: HeadlessServerMessage) => void)
      | undefined;
    sender?.({ type: 'user_input', content: 'hello from gui' });

    await waitFor(() => receivedServerMessages.length === 1);
    expect(receivedServerMessages).toEqual([{ type: 'user_input', content: 'hello from gui' }]);
  });

  test('connects to the advertised hostname from the session info file', async () => {
    const manager = createManagerStub();

    const server = startEmbeddedServer({
      hostname: '127.0.0.1',
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'hostname-session',
          command: 'agent',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      pid: process.pid,
      sessionId: 'hostname-session',
      hostname: 'localhost',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
    expect(manager.handleWebSocketConnect).toHaveBeenCalledWith(
      'hostname-session',
      expect.any(Function)
    );
    expect(server.connectedClients.size).toBe(1);
  });

  test('accepts the full IPv4 loopback range from the session info file', async () => {
    const manager = createManagerStub();
    const originalWebSocket = globalThis.WebSocket;
    const urls: string[] = [];

    class MockWebSocket {
      static readonly OPEN = 1;
      readonly readyState = MockWebSocket.OPEN;
      private readonly listeners = new Map<string, Array<(event?: any) => void>>();

      constructor(url: string) {
        urls.push(url);
        queueMicrotask(() => this.emit('open'));
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              type: 'session_info',
              sessionId: 'loopback-session',
              command: 'agent',
            }),
          })
        );
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ type: 'replay_start' }),
          })
        );
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ type: 'replay_end' }),
          })
        );
      }

      addEventListener(type: string, listener: (event?: any) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      close(): void {
        this.emit('close');
      }

      send(): void {}

      private emit(type: string, event?: any): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const info = createInfo(9123, {
      sessionId: 'loopback-session',
      hostname: '127.0.0.2',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    try {
      discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
        logger: { log() {}, warn() {}, error() {} },
        watchDebounceMs: 10,
        reconcileIntervalMs: 50,
      });
      await discovery.start();

      await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
      expect(urls).toEqual(['ws://127.0.0.2:9123/tim-agent']);
    } finally {
      vi.stubGlobal('WebSocket', originalWebSocket);
    }
  });

  test('rejects non-loopback hostnames from session info files', async () => {
    const manager = createManagerStub();
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const info = createInfo(9123, {
      sessionId: 'remote-host-session',
      hostname: '192.168.1.44',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger,
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
    });
    await discovery.start();

    await waitFor(() => logger.warn.mock.calls.length > 0);
    expect(logger.warn).toHaveBeenCalledWith(
      `[session_discovery] Skipping pid ${info.pid} because hostname 192.168.1.44 is not loopback-only`
    );
    expect(manager.handleWebSocketConnect).not.toHaveBeenCalled();
  });

  test('normalizes IPv6 wildcard bind hostnames to IPv6 loopback for connections', async () => {
    const manager = createManagerStub();
    const originalWebSocket = globalThis.WebSocket;
    const urls: string[] = [];

    class MockWebSocket {
      static readonly OPEN = 1;
      readonly readyState = MockWebSocket.OPEN;
      private readonly listeners = new Map<string, Array<(event?: any) => void>>();

      constructor(url: string) {
        urls.push(url);
        queueMicrotask(() => this.emit('open'));
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({
              type: 'session_info',
              sessionId: 'ipv6-session',
              command: 'agent',
            }),
          })
        );
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ type: 'replay_start' }),
          })
        );
        queueMicrotask(() =>
          this.emit('message', {
            data: JSON.stringify({ type: 'replay_end' }),
          })
        );
      }

      addEventListener(type: string, listener: (event?: any) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      close(): void {
        this.emit('close');
      }

      send(): void {}

      private emit(type: string, event?: any): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const info = createInfo(9123, {
      sessionId: 'ipv6-session',
      hostname: '::',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    try {
      discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
        logger: { log() {}, warn() {}, error() {} },
        watchDebounceMs: 10,
        reconcileIntervalMs: 50,
      });
      await discovery.start();

      await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
      expect(urls).toEqual(['ws://[::1]:9123/tim-agent']);
    } finally {
      vi.stubGlobal('WebSocket', originalWebSocket);
    }
  });

  test('removes stale session files for dead processes', async () => {
    const manager = createManagerStub();
    const staleInfo = createInfo(9123, {
      pid: 999_999_999,
      sessionId: 'dead-session',
    });
    cleanupPids.add(staleInfo.pid);
    writeSessionInfoFile(staleInfo);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
    });
    await discovery.start();

    await waitFor(() => !fs.existsSync(path.join(getTimSessionDir(), `${staleInfo.pid}.json`)));
    expect(manager.handleWebSocketConnect).not.toHaveBeenCalled();
  });

  test('discovers new session files via the directory watcher and disconnects when the file is removed', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);

    discovery = new SessionDiscoveryClient(manager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'watch-session',
          command: 'agent',
          workspacePath: '/tmp/watch-workspace',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'watch-session',
      workspacePath: '/tmp/watch-workspace',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    await waitFor(() => manager.getSessionSnapshot().sessions.length === 1);
    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.status === 'active');
    expect(server.connectedClients.size).toBe(1);

    removeSessionInfoFile(info.pid);
    cleanupPids.delete(info.pid);
    await discovery.forceReconcile();

    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.status === 'offline');
    expect(manager.getSessionSnapshot().sessions).toEqual([
      expect.objectContaining({
        connectionId: 'watch-session',
        status: 'offline',
      }),
    ]);
    await waitFor(() => server.connectedClients.size === 0);
  });

  test('integrates discovery, replay, prompt responses, live output, file removal, and stop cleanup with a real SessionManager', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);
    const receivedServerMessages: HeadlessServerMessage[] = [];

    let server!: EmbeddedServerHandle;
    server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'integration-session',
          command: 'agent',
          interactive: true,
          planId: 223,
          planUuid: 'plan-uuid-223',
          planTitle: 'tim web gui connects to websocket server of tim processes',
          workspacePath: '/tmp/integration-workspace',
          gitRemote: 'git@github.com:tim/test.git',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, {
          type: 'output',
          seq: 1,
          message: { type: 'log', args: ['replayed log'] },
        });
        server.sendTo(connectionId, {
          type: 'output',
          seq: 2,
          message: {
            type: 'structured',
            message: {
              type: 'prompt_request',
              timestamp: '2026-03-23T00:00:01.000Z',
              requestId: 'req-integration',
              promptType: 'confirm',
              promptConfig: { message: 'Continue integration flow?' },
            },
          },
        });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
      onMessage: (_connectionId, message) => {
        receivedServerMessages.push(message);
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'integration-session',
      workspacePath: '/tmp/integration-workspace',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => {
      const session = manager.getSessionSnapshot().sessions[0];
      return (
        manager.getSessionSnapshot().sessions.length === 1 &&
        session?.status === 'active' &&
        session.isReplaying === false &&
        session.activePrompt?.requestId === 'req-integration' &&
        session.messages.length === 2
      );
    });

    const replayedSession = manager.getSessionSnapshot().sessions[0];
    expect(replayedSession).toMatchObject({
      connectionId: 'integration-session',
      status: 'active',
      sessionInfo: expect.objectContaining({
        sessionId: 'integration-session',
        command: 'agent',
        interactive: true,
        planId: 223,
        planUuid: 'plan-uuid-223',
        workspacePath: '/tmp/integration-workspace',
      }),
      activePrompt: expect.objectContaining({
        requestId: 'req-integration',
        promptType: 'confirm',
      }),
    });
    expect(replayedSession?.messages).toEqual([
      expect.objectContaining({
        seq: 1,
        rawType: 'log',
        category: 'log',
        body: { type: 'text', text: 'replayed log' },
      }),
      expect.objectContaining({
        seq: 2,
        rawType: 'prompt_request',
        category: 'structured',
        bodyType: 'structured',
        body: {
          type: 'structured',
          message: expect.objectContaining({
            type: 'prompt_request',
            requestId: 'req-integration',
            promptType: 'confirm',
            promptConfig: {
              message: 'Continue integration flow?',
            },
          }),
        },
      }),
    ]);

    server.broadcast({
      type: 'output',
      seq: 3,
      message: { type: 'stdout', data: 'live output\n' },
    });

    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.messages.length === 3);
    expect(manager.getSessionSnapshot().sessions[0]?.messages.at(-1)).toMatchObject({
      seq: 3,
      rawType: 'stdout',
      category: 'log',
      bodyType: 'monospaced',
      body: { type: 'monospaced', text: 'live output\n' },
    });

    expect(manager.sendPromptResponse('integration-session', 'req-integration', true)).toBe('sent');
    await waitFor(() =>
      receivedServerMessages.some((message) => message.type === 'prompt_response')
    );
    expect(receivedServerMessages).toContainEqual({
      type: 'prompt_response',
      requestId: 'req-integration',
      value: true,
    });

    removeSessionInfoFile(info.pid);
    cleanupPids.delete(info.pid);
    await discovery.forceReconcile();

    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.status === 'offline');
    await waitFor(() => server.connectedClients.size === 0);

    writeSessionInfoFile(info);
    cleanupPids.add(info.pid);
    await discovery.forceReconcile();

    await waitFor(() => {
      const sessions = manager.getSessionSnapshot().sessions;
      return sessions.length === 1 && sessions[0]?.status === 'active';
    });
    await waitFor(() => server.connectedClients.size === 1);

    discovery.stop();
    discovery = null;

    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.status === 'offline');
    await waitFor(() => server.connectedClients.size === 0);
  });

  test('skips token-protected sessions with a warning', async () => {
    const manager = createManagerStub();
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const info = createInfo(9123, {
      token: true,
      sessionId: 'token-session',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger,
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
    });
    await discovery.start();

    await waitFor(() => logger.warn.mock.calls.length > 0);
    expect(manager.handleWebSocketConnect).not.toHaveBeenCalled();
    expect(readSessionInfoFile(info.pid)).toMatchObject({ token: true });
  });

  test('retries until the embedded server becomes available', async () => {
    const manager = createManagerStub();
    const port = await getAvailablePort();
    const info = createInfo(port, {
      sessionId: 'retry-session',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryMaxAttempts: 20,
    });
    await discovery.start();

    await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 0, 50);

    let server!: EmbeddedServerHandle;
    server = startEmbeddedServer({
      port,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'retry-session',
          command: 'agent',
          workspacePath: '/tmp/workspace',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
    expect(manager.handleWebSocketConnect).toHaveBeenCalledWith(
      'retry-session',
      expect.any(Function)
    );
  });

  test('registers first-time sessions immediately so they remain visible during replay', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'visible-during-replay',
          command: 'agent',
          workspacePath: '/tmp/replay-visible',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        setTimeout(() => {
          server.sendTo(connectionId, { type: 'replay_end' });
        }, 100);
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'visible-during-replay',
      workspacePath: '/tmp/replay-visible',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => {
      const session = manager.getSessionSnapshot().sessions[0];
      return (
        manager.getSessionSnapshot().sessions.length === 1 &&
        session?.status === 'active' &&
        session.isReplaying === true
      );
    });

    expect(manager.getSessionSnapshot().sessions[0]).toMatchObject({
      connectionId: 'visible-during-replay',
      status: 'active',
      isReplaying: true,
      sessionInfo: expect.objectContaining({
        sessionId: 'visible-during-replay',
        workspacePath: '/tmp/replay-visible',
      }),
    });

    await waitFor(() => manager.getSessionSnapshot().sessions[0]?.isReplaying === false);
  });

  test('does not register a first-time session that never sends session_info', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, {
          type: 'output',
          seq: 1,
          message: { type: 'log', args: ['missing session info'] },
        });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'missing-session-info',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger,
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryMaxAttempts: 1,
    });
    await discovery.start();

    await waitFor(() => logger.warn.mock.calls.length > 0);
    await waitFor(() => server.connectedClients.size === 0);

    expect(logger.warn).toHaveBeenCalledWith(
      `[session_discovery] Closing pid ${info.pid} because replay_end arrived before a valid session_info`
    );
    expect(manager.getSessionSnapshot().sessions).toEqual([]);
  });

  test('closes mismatched session info without replacing the existing offline session', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    manager.handleWebSocketConnect('expected-session', () => {});
    manager.handleWebSocketMessage('expected-session', {
      type: 'session_info',
      sessionId: 'expected-session',
      command: 'agent',
      workspacePath: '/tmp/original-session',
    });
    manager.handleWebSocketDisconnect('expected-session');

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'wrong-session',
          command: 'agent',
          workspacePath: '/tmp/wrong-session',
        });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'expected-session',
      workspacePath: '/tmp/original-session',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger,
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryMaxAttempts: 1,
    });
    await discovery.start();

    await waitFor(() => logger.warn.mock.calls.length > 0);
    await waitFor(() => server.connectedClients.size === 0);

    expect(logger.warn).toHaveBeenCalledWith(
      `[session_discovery] Closing pid ${info.pid} because session_info sessionId wrong-session did not match expected expected-session`
    );
    expect(manager.getSessionSnapshot().sessions).toEqual([
      expect.objectContaining({
        connectionId: 'expected-session',
        status: 'offline',
        sessionInfo: expect.objectContaining({
          sessionId: 'expected-session',
          workspacePath: '/tmp/original-session',
        }),
      }),
    ]);
  });

  test('closes the websocket if replay buffering exceeds the pending message cap', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const originalWebSocket = globalThis.WebSocket;
    let closeCalls = 0;

    class MockWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.OPEN;
      private closed = false;
      private readonly listeners = new Map<string, Array<(event?: any) => void>>();

      constructor(_url: string) {
        queueMicrotask(() => {
          this.emit('open');
          this.emitMessage({
            type: 'session_info',
            sessionId: 'buffer-cap-session',
            command: 'agent',
          });
          this.emitMessage({ type: 'replay_start' });

          for (let index = 0; index < 10_005 && !this.closed; index += 1) {
            this.emitMessage({
              type: 'output',
              seq: index + 1,
              message: { type: 'log', args: [`line ${index + 1}`] },
            });
          }
        });
      }

      addEventListener(type: string, listener: (event?: any) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
      }

      close(): void {
        if (this.closed) {
          return;
        }

        this.closed = true;
        this.readyState = MockWebSocket.CLOSED;
        closeCalls += 1;
        this.emit('close');
      }

      send(): void {}

      private emitMessage(message: Record<string, unknown>): void {
        this.emit('message', { data: JSON.stringify(message) });
      }

      private emit(type: string, event?: any): void {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }
    }

    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);

    const info = createInfo(9123, {
      sessionId: 'buffer-cap-session',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    manager.handleWebSocketConnect('buffer-cap-session', () => {});
    manager.handleWebSocketDisconnect('buffer-cap-session');

    try {
      discovery = new SessionDiscoveryClient(manager, {
        logger,
        watchDebounceMs: 10,
        reconcileIntervalMs: 50,
        retryMaxAttempts: 0,
      });
      await discovery.start();

      await waitFor(() => closeCalls === 1);
      expect(logger.warn).toHaveBeenCalledWith(
        `[session_discovery] Closing pid ${info.pid} after buffering more than 10000 replay messages without replay_end`
      );
      expect(manager.getSessionSnapshot().sessions).toEqual([
        expect.objectContaining({
          connectionId: 'buffer-cap-session',
          status: 'offline',
        }),
      ]);
    } finally {
      vi.stubGlobal('WebSocket', originalWebSocket);
    }
  });

  test('stop closes tracked websocket clients and prevents future discovery', async () => {
    const manager = createManagerStub();
    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'stop-session',
          command: 'agent',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'stop-session',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager as unknown as SessionManager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 500,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => manager.handleWebSocketConnect.mock.calls.length === 1);
    await waitFor(() => server.connectedClients.size === 1);

    discovery.stop();
    discovery = null;

    await waitFor(() => server.connectedClients.size === 0);

    removeSessionInfoFile(info.pid);
    cleanupPids.delete(info.pid);

    const replacementServer = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        replacementServer.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'stop-session-2',
          command: 'agent',
        });
        replacementServer.sendTo(connectionId, { type: 'replay_start' });
        replacementServer.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(replacementServer);

    writeSessionInfoFile(
      createInfo(replacementServer.port, {
        sessionId: 'stop-session-2',
      })
    );
    cleanupPids.add(process.pid);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.handleWebSocketConnect).toHaveBeenCalledTimes(1);
    expect(replacementServer.connectedClients.size).toBe(0);
  });

  test('dismisses an old offline session before reconnecting the same session id after hmr', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);

    manager.handleWebSocketConnect('hmr-session', () => {});
    manager.handleWebSocketDisconnect('hmr-session');
    expect(manager.getSessionSnapshot().sessions).toHaveLength(1);
    expect(manager.getSessionSnapshot().sessions[0]?.status).toBe('offline');

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'hmr-session',
          command: 'agent',
          workspacePath: '/tmp/hmr',
        });
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'hmr-session',
      workspacePath: '/tmp/hmr',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });
    await discovery.start();

    await waitFor(() => {
      const sessions = manager.getSessionSnapshot().sessions;
      return sessions.length === 1 && sessions[0]?.status === 'active';
    });

    expect(manager.getSessionSnapshot().sessions).toEqual([
      expect.objectContaining({
        connectionId: 'hmr-session',
        status: 'active',
        sessionInfo: expect.objectContaining({
          command: 'agent',
          workspacePath: '/tmp/hmr',
        }),
      }),
    ]);
  });

  test('keeps the previous offline session until a replacement connection replays session data', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);

    manager.handleWebSocketConnect('hmr-session', () => {});
    manager.handleWebSocketMessage('hmr-session', {
      type: 'session_info',
      sessionId: 'hmr-session',
      command: 'agent',
      workspacePath: '/tmp/original-hmr',
    });
    manager.handleWebSocketMessage('hmr-session', {
      type: 'output',
      seq: 1,
      message: { type: 'log', args: ['existing history'] },
    });
    manager.handleWebSocketDisconnect('hmr-session');

    const baselineSession = manager.getSessionSnapshot().sessions[0];
    expect(baselineSession).toMatchObject({
      connectionId: 'hmr-session',
      status: 'offline',
      messages: [
        expect.objectContaining({
          seq: 1,
          body: { type: 'text', text: 'existing history' },
        }),
      ],
    });

    const flakyServer = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        flakyServer.sendTo(connectionId, {
          type: 'session_info',
          sessionId: 'hmr-session',
          command: 'agent',
          workspacePath: '/tmp/replacement-hmr',
        });
        flakyServer.sendTo(connectionId, { type: 'replay_start' });
        flakyServer.sendTo(connectionId, {
          type: 'output',
          seq: 2,
          message: { type: 'log', args: ['replacement history that should not win'] },
        });
        queueMicrotask(() => flakyServer.stop());
      },
    });
    serversToStop.push(flakyServer);

    const info = createInfo(flakyServer.port, {
      sessionId: 'hmr-session',
      workspacePath: '/tmp/replacement-hmr',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger: { log() {}, warn() {}, error() {} },
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryMaxAttempts: 1,
    });
    await discovery.start();

    await waitFor(() => manager.getSessionSnapshot().sessions.length === 1);

    expect(manager.getSessionSnapshot().sessions).toEqual([
      expect.objectContaining({
        connectionId: 'hmr-session',
        status: 'offline',
        sessionInfo: expect.objectContaining({
          sessionId: 'hmr-session',
          workspacePath: '/tmp/original-hmr',
        }),
        messages: [
          expect.objectContaining({
            seq: 1,
            body: { type: 'text', text: 'existing history' },
          }),
        ],
      }),
    ]);
  });

  test('does not replace an offline session when reconnect replay_end arrives before session_info', async () => {
    db = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const manager = new SessionManager(db);
    const logger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    manager.handleWebSocketConnect('reconnect-session', () => {});
    manager.handleWebSocketMessage('reconnect-session', {
      type: 'session_info',
      sessionId: 'reconnect-session',
      command: 'agent',
      workspacePath: '/tmp/original-reconnect',
    });
    manager.handleWebSocketMessage('reconnect-session', {
      type: 'output',
      seq: 1,
      message: { type: 'log', args: ['original reconnect history'] },
    });
    manager.handleWebSocketDisconnect('reconnect-session');

    const server = startEmbeddedServer({
      port: 0,
      onConnect: (connectionId) => {
        server.sendTo(connectionId, { type: 'replay_start' });
        server.sendTo(connectionId, {
          type: 'output',
          seq: 2,
          message: { type: 'log', args: ['replacement history that should not replace'] },
        });
        server.sendTo(connectionId, { type: 'replay_end' });
      },
    });
    serversToStop.push(server);

    const info = createInfo(server.port, {
      sessionId: 'reconnect-session',
      workspacePath: '/tmp/replacement-reconnect',
    });
    cleanupPids.add(info.pid);
    writeSessionInfoFile(info);

    discovery = new SessionDiscoveryClient(manager, {
      logger,
      watchDebounceMs: 10,
      reconcileIntervalMs: 50,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      retryMaxAttempts: 1,
    });
    await discovery.start();

    await waitFor(() => logger.warn.mock.calls.length > 0);
    await waitFor(() => server.connectedClients.size === 0);

    expect(logger.warn).toHaveBeenCalledWith(
      `[session_discovery] Closing pid ${info.pid} because replay_end arrived before a valid session_info`
    );
    expect(manager.getSessionSnapshot().sessions).toEqual([
      expect.objectContaining({
        connectionId: 'reconnect-session',
        status: 'offline',
        sessionInfo: expect.objectContaining({
          sessionId: 'reconnect-session',
          workspacePath: '/tmp/original-reconnect',
        }),
        messages: [
          expect.objectContaining({
            seq: 1,
            body: { type: 'text', text: 'original reconnect history' },
          }),
        ],
      }),
    ]);
  });
});
