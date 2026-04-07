import { afterAll, afterEach, beforeAll, describe, expect, vi, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLoggerAdapter, runWithLogger, type LoggerAdapter } from '../logging/adapter.js';
import { HeadlessAdapter } from '../logging/headless_adapter.js';
import type { HeadlessMessage } from '../logging/headless_protocol.js';
import * as logging from '../logging.js';
import type { StructuredMessage } from '../logging/structured_messages.js';
import { listSessionInfoFiles } from './session_server/runtime_dir.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';

// Mock the workspace_identifier module
vi.mock('./assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

const getRepositoryIdentitySpy = vi.fn(async () => ({
  repositoryId: 'owner/repo',
  remoteUrl: 'https://github.com/owner/repo.git',
  gitRoot: '/tmp/repo',
}));

let resolveHeadlessUrl: typeof import('./headless.js').resolveHeadlessUrl;
let buildHeadlessSessionInfo: typeof import('./headless.js').buildHeadlessSessionInfo;
let runWithHeadlessAdapterIfEnabled: typeof import('./headless.js').runWithHeadlessAdapterIfEnabled;
let createHeadlessAdapterForCommand: typeof import('./headless.js').createHeadlessAdapterForCommand;
let updateHeadlessSessionInfo: typeof import('./headless.js').updateHeadlessSessionInfo;
let resetHeadlessWarningStateForTests: typeof import('./headless.js').resetHeadlessWarningStateForTests;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempCacheDir: string | undefined;

beforeAll(async () => {
  // Set up the mock
  vi.mocked(getRepositoryIdentity).mockImplementation(getRepositoryIdentitySpy);

  ({
    resolveHeadlessUrl,
    buildHeadlessSessionInfo,
    runWithHeadlessAdapterIfEnabled,
    createHeadlessAdapterForCommand,
    updateHeadlessSessionInfo,
    resetHeadlessWarningStateForTests,
  } = await import('./headless.js'));
});

afterEach(async () => {
  getRepositoryIdentitySpy.mockClear();
  delete process.env.TIM_HEADLESS_URL;
  delete process.env.TIM_NO_SERVER;
  delete process.env.TIM_SERVER_PORT;
  delete process.env.TIM_SERVER_HOSTNAME;
  delete process.env.TIM_WS_BEARER_TOKEN;
  delete process.env.WEZTERM_PANE;
  if (originalXdgCacheHome === undefined) {
    delete process.env.XDG_CACHE_HOME;
  } else {
    process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  }
  if (tempCacheDir) {
    await rm(tempCacheDir, { recursive: true, force: true });
    tempCacheDir = undefined;
  }
  resetHeadlessWarningStateForTests();
});

afterAll(() => {
  vi.clearAllMocks();
});

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

async function reserveAvailablePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response('ok');
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

function waitForMessage(ws: WebSocket): Promise<HeadlessMessage> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('message', (event) => resolve(JSON.parse(event.data as string)), {
      once: true,
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket error while waiting')), {
      once: true,
    });
  });
}

describe('resolveHeadlessUrl', () => {
  test('uses TIM_HEADLESS_URL before config and default', () => {
    process.env.TIM_HEADLESS_URL = 'ws://env.example/socket';
    const value = resolveHeadlessUrl({
      headless: {
        url: 'ws://config.example/socket',
      },
    } as any);
    expect(value).toBe('ws://env.example/socket');
  });

  test('uses config url when env is unset', () => {
    const value = resolveHeadlessUrl({
      headless: {
        url: 'ws://config.example/socket',
      },
    } as any);
    expect(value).toBe('ws://config.example/socket');
  });

  test('uses default URL when env and config are unset', () => {
    const value = resolveHeadlessUrl({} as any);
    expect(value).toBe('ws://localhost:8123/tim-agent');
  });

  test('warns once and falls back when configured URL is not ws:// or wss://', () => {
    const warnSpy = vi.spyOn(logging, 'warn');
    try {
      process.env.TIM_HEADLESS_URL = 'http://example.com/socket';
      expect(resolveHeadlessUrl({} as any)).toBe('ws://localhost:8123/tim-agent');
      expect(resolveHeadlessUrl({} as any)).toBe('ws://localhost:8123/tim-agent');
      const headlessWarns = warnSpy.mock.calls.filter(
        (args) => typeof args[0] === 'string' && args[0].includes('Invalid headless URL')
      );
      expect(headlessWarns).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('buildHeadlessSessionInfo', () => {
  test('includes workspace and remote metadata when available', async () => {
    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 166,
      title: 'headless mode',
    });

    expect(info).toEqual({
      command: 'agent',
      interactive: false,
      planId: 166,
      planTitle: 'headless mode',
      workspacePath: '/tmp/repo',
      gitRemote: 'github.com/owner/repo',
      terminalPaneId: undefined,
      terminalType: undefined,
    });
  });

  test('strips credentials from remote URL before sending', async () => {
    getRepositoryIdentitySpy.mockImplementationOnce(async () => ({
      repositoryId: 'owner/repo',
      remoteUrl: 'https://user:token@github.com/owner/repo.git',
      gitRoot: '/tmp/repo',
    }));

    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 1,
      title: 'cred test',
    });

    expect(info.gitRemote).toBe('github.com/owner/repo');
    expect(info.gitRemote).not.toContain('token');
    expect(info.gitRemote).not.toContain('user');
    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });

  test('silently handles repository lookup failures', async () => {
    getRepositoryIdentitySpy.mockImplementationOnce(async () => {
      throw new Error('no repo');
    });

    const info = await buildHeadlessSessionInfo('review', false, {
      id: 42,
      title: 'review plan',
    });

    expect(info).toEqual({
      command: 'review',
      interactive: false,
      planId: 42,
      planTitle: 'review plan',
      workspacePath: undefined,
      gitRemote: undefined,
      terminalPaneId: undefined,
      terminalType: undefined,
    });
  });

  test('supports finish as a session command', async () => {
    const info = await buildHeadlessSessionInfo('finish', false, {
      id: 43,
      title: 'finalize plan',
    });

    expect(info.command).toBe('finish');
    expect(info.planId).toBe(43);
    expect(info.planTitle).toBe('finalize plan');
  });

  test('includes terminal metadata when WEZTERM_PANE is set', async () => {
    process.env.WEZTERM_PANE = '12';

    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 99,
      title: 'pane test',
    });

    expect(info.terminalPaneId).toBe('12');
    expect(info.terminalType).toBe('wezterm');
  });

  test('omits terminal metadata when WEZTERM_PANE is unset', async () => {
    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 99,
      title: 'pane test',
    });

    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });

  test('omits terminal metadata when WEZTERM_PANE is empty string', async () => {
    process.env.WEZTERM_PANE = '';

    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 99,
      title: 'empty pane test',
    });

    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });

  test('omits terminal metadata when WEZTERM_PANE is whitespace only', async () => {
    process.env.WEZTERM_PANE = '  ';

    const info = await buildHeadlessSessionInfo('agent', false, {
      id: 99,
      title: 'whitespace pane test',
    });

    expect(info.terminalPaneId).toBeUndefined();
    expect(info.terminalType).toBeUndefined();
  });

  test('trims whitespace from WEZTERM_PANE value', async () => {
    process.env.WEZTERM_PANE = '  42  ';

    const info = await buildHeadlessSessionInfo('agent', true, {
      id: 99,
      title: 'trim test',
    });

    expect(info.interactive).toBe(true);
    expect(info.terminalPaneId).toBe('42');
    expect(info.terminalType).toBe('wezterm');
  });
});

describe('runWithHeadlessAdapterIfEnabled', () => {
  const wrappedAdapter: LoggerAdapter = {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (_message: StructuredMessage) => {},
  };

  test('installs a headless adapter when enabled', async () => {
    const destroySpy = vi.spyOn(HeadlessAdapter.prototype, 'destroy');
    try {
      const activeAdapter = await runWithLogger(wrappedAdapter, () =>
        runWithHeadlessAdapterIfEnabled({
          enabled: true,
          command: 'agent',
          interactive: false,
          plan: { id: 166, title: 'headless mode' },
          callback: async () => getLoggerAdapter(),
        })
      );

      expect(activeAdapter).toBeInstanceOf(HeadlessAdapter);
      expect((activeAdapter as any).wrappedAdapter).toBe(wrappedAdapter);
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  test('uses the existing logger adapter when disabled', async () => {
    const activeAdapter = await runWithLogger(wrappedAdapter, () =>
      runWithHeadlessAdapterIfEnabled({
        enabled: false,
        command: 'review',
        interactive: false,
        callback: async () => getLoggerAdapter(),
      })
    );

    expect(activeAdapter).toBe(wrappedAdapter);
  });

  test('destroys the headless adapter when callback throws', async () => {
    const destroySpy = vi.spyOn(HeadlessAdapter.prototype, 'destroy');
    try {
      await expect(
        runWithHeadlessAdapterIfEnabled({
          enabled: true,
          command: 'review',
          interactive: false,
          callback: async () => {
            throw new Error('boom');
          },
        })
      ).rejects.toThrow('boom');
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });
});

describe('createHeadlessAdapterForCommand', () => {
  const wrappedAdapter: LoggerAdapter = {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (_message: StructuredMessage) => {},
  };

  test('wraps the current logger adapter when one is present', async () => {
    const headlessAdapter = await runWithLogger(wrappedAdapter, () =>
      createHeadlessAdapterForCommand({
        command: 'review',
        interactive: false,
        plan: { id: 42, title: 'review plan' },
      })
    );

    expect(headlessAdapter).toBeInstanceOf(HeadlessAdapter);
    expect((headlessAdapter as any).wrappedAdapter).toBe(wrappedAdapter);
    await headlessAdapter.destroy();
  });

  test('starts an embedded server by default and writes session metadata', async () => {
    tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-test-'));
    process.env.XDG_CACHE_HOME = tempCacheDir;

    const headlessAdapter = await createHeadlessAdapterForCommand({
      command: 'review',
      interactive: false,
      plan: { id: 42, title: 'review plan' },
    });

    try {
      expect((headlessAdapter as any).sessionServer.port).toBeGreaterThan(0);
      expect(listSessionInfoFiles()).toEqual([
        expect.objectContaining({
          pid: process.pid,
          command: 'review',
          planId: 42,
          planTitle: 'review plan',
        }),
      ]);
    } finally {
      await headlessAdapter.destroy();
    }
  });

  test('honors TIM_SERVER_PORT, TIM_SERVER_HOSTNAME, TIM_WS_BEARER_TOKEN, and TIM_NO_SERVER', async () => {
    tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-test-'));
    process.env.XDG_CACHE_HOME = tempCacheDir;

    process.env.TIM_SERVER_PORT = '0';
    process.env.TIM_SERVER_HOSTNAME = '127.0.0.1';
    process.env.TIM_WS_BEARER_TOKEN = 'secret-token';

    const headlessAdapter = await createHeadlessAdapterForCommand({
      command: 'agent',
      interactive: true,
    });

    try {
      const sessionInfo = listSessionInfoFiles()[0];
      expect(sessionInfo).toMatchObject({
        pid: process.pid,
        command: 'agent',
        token: true,
      });
      expect((headlessAdapter as any).sessionServer.port).toBe(sessionInfo?.port);
    } finally {
      await headlessAdapter.destroy();
    }

    process.env.TIM_NO_SERVER = '1';
    const noServerAdapter = await createHeadlessAdapterForCommand({
      command: 'chat',
      interactive: true,
    });

    try {
      expect((noServerAdapter as any).sessionServer).toBeUndefined();
      expect(listSessionInfoFiles()).toEqual([]);
    } finally {
      await noServerAdapter.destroy();
    }
  });

  test('uses a requested TIM_SERVER_PORT and enforces bearer auth on the embedded server', async () => {
    tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-test-'));
    process.env.XDG_CACHE_HOME = tempCacheDir;
    process.env.TIM_SERVER_HOSTNAME = '127.0.0.1';
    process.env.TIM_WS_BEARER_TOKEN = 'secret-token';

    let requestedPort = 0;
    let headlessAdapter: HeadlessAdapter | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      requestedPort = await reserveAvailablePort();
      process.env.TIM_SERVER_PORT = String(requestedPort);
      try {
        headlessAdapter = await createHeadlessAdapterForCommand({
          command: 'agent',
          interactive: false,
        });
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.includes('EADDRINUSE')) {
          throw error;
        }
      }
    }

    if (!headlessAdapter) {
      throw lastError instanceof Error ? lastError : new Error('Failed to acquire a test port');
    }

    try {
      expect((headlessAdapter as any).sessionServer.port).toBe(requestedPort);
      expect(listSessionInfoFiles()).toEqual([
        expect.objectContaining({
          port: requestedPort,
          token: true,
        }),
      ]);

      const unauthorized = await fetch(`http://127.0.0.1:${requestedPort}/tim-agent`);
      expect(unauthorized.status).toBe(401);

      const authorized = await openWebSocket(
        `ws://127.0.0.1:${requestedPort}/tim-agent?token=secret-token`
      );
      expect(await waitForMessage(authorized)).toMatchObject({ type: 'session_info' });
      authorized.close();
    } finally {
      await headlessAdapter.destroy();
    }
  });

  test('throws on invalid TIM_SERVER_PORT values', async () => {
    for (const badPort of ['abc', '123abc', '-1', '65536', '3.14', '']) {
      if (badPort === '') continue; // empty string falls back to port 0
      process.env.TIM_SERVER_PORT = badPort;
      await expect(
        createHeadlessAdapterForCommand({
          command: 'agent',
          interactive: false,
        })
      ).rejects.toThrow(/Invalid TIM_SERVER_PORT/);
      delete process.env.TIM_SERVER_PORT;
    }
  });

  test('respects TIM_SERVER_HOSTNAME and stops the embedded server on destroy', async () => {
    tempCacheDir = await mkdtemp(path.join(os.tmpdir(), 'tim-headless-test-'));
    process.env.XDG_CACHE_HOME = tempCacheDir;
    process.env.TIM_SERVER_PORT = '0';
    process.env.TIM_SERVER_HOSTNAME = '127.0.0.1';

    const headlessAdapter = await createHeadlessAdapterForCommand({
      command: 'generate',
      interactive: false,
    });

    const port = (headlessAdapter as any).sessionServer.port as number;
    const sessionClient = await openWebSocket(`ws://127.0.0.1:${port}/tim-agent`);

    try {
      expect(await waitForMessage(sessionClient)).toMatchObject({
        type: 'session_info',
        command: 'generate',
      });
    } finally {
      sessionClient.close();
      await headlessAdapter.destroy();
    }

    await waitFor(() => listSessionInfoFiles().length === 0);

    await expect(fetch(`http://127.0.0.1:${port}/tim-agent`)).rejects.toThrow();
  });
});

describe('updateHeadlessSessionInfo', () => {
  const wrappedAdapter: LoggerAdapter = {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (_message: StructuredMessage) => {},
  };

  test('calls updateSessionInfo when a headless adapter is the active logger', async () => {
    const updateSpy = vi.spyOn(HeadlessAdapter.prototype, 'updateSessionInfo');

    try {
      await runWithLogger(wrappedAdapter, async () => {
        const headlessAdapter = await createHeadlessAdapterForCommand({
          command: 'agent',
          interactive: false,
          plan: { id: 42, title: 'session update test' },
        });

        try {
          await runWithLogger(headlessAdapter, async () => {
            updateHeadlessSessionInfo({ workspacePath: '/tmp/workspaces/ws-1' });
          });
        } finally {
          await headlessAdapter.destroy();
        }
      });

      expect(updateSpy).toHaveBeenCalledWith({ workspacePath: '/tmp/workspaces/ws-1' });
    } finally {
      updateSpy.mockRestore();
    }
  });

  test('no-ops when the active logger is not a headless adapter', async () => {
    const updateSpy = vi.spyOn(HeadlessAdapter.prototype, 'updateSessionInfo');

    try {
      await runWithLogger(wrappedAdapter, async () => {
        updateHeadlessSessionInfo({ workspacePath: '/tmp/workspaces/ws-2' });
      });

      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });
});
