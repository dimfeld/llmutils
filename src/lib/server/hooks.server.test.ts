import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('hooks.server init', () => {
  const sessionShutdownKey = Symbol.for('tim.web.sessionShutdown');

  beforeEach(async () => {
    vi.resetModules();
    const sessionContext = await import('./session_context.js');
    (sessionContext.setSessionManager as unknown as (manager: null) => void)(null);
    (sessionContext.setWebSocketServerHandle as unknown as (server: null) => void)(null);
    sessionContext.setSessionDiscoveryClient(null);
    sessionContext.setWebhookPoller(null);
    sessionContext.setSyncService(null);
    sessionContext.setSessionInitPromise(null);
    const globalState = globalThis as typeof globalThis & {
      [sessionShutdownKey]?: { cleanup: (() => void) | null };
    };
    globalState[sessionShutdownKey]?.cleanup?.();
    delete globalState[sessionShutdownKey];
  });

  afterEach(async () => {
    const sessionContext = await import('./session_context.js');
    (sessionContext.setSessionManager as unknown as (manager: null) => void)(null);
    (sessionContext.setWebSocketServerHandle as unknown as (server: null) => void)(null);
    sessionContext.setSessionDiscoveryClient(null);
    sessionContext.setWebhookPoller(null);
    sessionContext.setSyncService(null);
    sessionContext.setSessionInitPromise(null);
    const globalState = globalThis as typeof globalThis & {
      [sessionShutdownKey]?: { cleanup: (() => void) | null };
    };
    globalState[sessionShutdownKey]?.cleanup?.();
    delete globalState[sessionShutdownKey];
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock('$lib/server/init.js');
    vi.doUnmock('$lib/server/session_discovery.js');
    vi.doUnmock('$lib/server/sync_service.js');
    vi.doUnmock('$lib/server/webhook_poller.js');
    vi.doUnmock('$lib/server/ws_server.js');
  });

  test('init creates the session manager and starts the websocket server once', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await hooks.init();
    await hooks.init();

    expect(getServerContext).toHaveBeenCalledTimes(2);
    expect(startWebSocketServer).toHaveBeenCalledTimes(1);
    expect(startWebSocketServer).toHaveBeenCalledWith(expect.anything(), config);
    expect(sessionContext.getSessionManager()).toEqual(expect.anything());
    expect(sessionContext.getWebSocketServerHandle()).toBe(serverHandle);
    expect(sessionContext.getSessionInitPromise()).toEqual(expect.any(Promise));
  });

  test('init clears the init promise when startup fails', async () => {
    const failure = new Error('boom');
    const getServerContext = vi.fn().mockRejectedValue(failure);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return actual;
    });

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await expect(hooks.init()).rejects.toThrow('boom');
    expect(sessionContext.getSessionInitPromise()).toBeNull();
  });

  test('init registers process shutdown handlers that stop the websocket server', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const stop = vi.fn();
    const serverHandle = { port: 8123, stop };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const onSpy = vi.spyOn(process, 'on');
    const offSpy = vi.spyOn(process, 'off');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    const sigintHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGINT')?.[1];

    expect(sigtermHandler).toEqual(expect.any(Function));
    expect(sigintHandler).toEqual(expect.any(Function));

    (sigtermHandler as () => void)();
    (sigintHandler as () => void)();

    expect(stop).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledTimes(2);
    expect(exitSpy).toHaveBeenCalledWith(0);

    vi.resetModules();
    const sessionContext = await import('./session_context.js');
    (sessionContext.setSessionManager as unknown as (manager: null) => void)(null);
    (sessionContext.setWebSocketServerHandle as unknown as (server: null) => void)(null);
    sessionContext.setSyncService(null);
    sessionContext.setSessionInitPromise(null);

    const hooksReloaded = await import('../../hooks.server.js');
    await hooksReloaded.init();

    expect(offSpy).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
    expect(offSpy).toHaveBeenCalledWith('SIGINT', sigintHandler);
  });

  test('init failure only tears down resources created during that attempt', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const reusedServerHandle = { port: 8123, stop: vi.fn() };
    const reusedManager = { reused: true };
    const failingDiscoveryClient = {
      start: vi.fn().mockRejectedValue(new Error('discovery boom')),
      stop: vi.fn(),
    };

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    class FailingSessionDiscoveryClient {
      constructor() {
        return failingDiscoveryClient;
      }
    }

    vi.doMock('$lib/server/session_discovery.js', () => ({
      SessionDiscoveryClient: FailingSessionDiscoveryClient,
    }));

    const sessionContext = await import('./session_context.js');
    (sessionContext.setSessionManager as unknown as (manager: object) => void)(reusedManager);
    sessionContext.setWebSocketServerHandle(reusedServerHandle as any);
    sessionContext.setSessionDiscoveryClient(null);

    const hooks = await import('../../hooks.server.js');

    await expect(hooks.init()).rejects.toThrow('discovery boom');

    expect(failingDiscoveryClient.stop).toHaveBeenCalledTimes(1);
    expect(reusedServerHandle.stop).not.toHaveBeenCalled();
    expect(sessionContext.getSessionManager()).toBe(reusedManager);
    expect(sessionContext.getWebSocketServerHandle()).toBe(reusedServerHandle);
    expect(sessionContext.getSessionDiscoveryClient()).toBeNull();
    expect(sessionContext.getSessionInitPromise()).toBeNull();
  });

  test('init stores the webhook poller when webhook polling is enabled', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const pollerHandle = { stop: vi.fn() };
    const startWebhookPoller = vi.fn().mockReturnValue(pollerHandle);
    const isWebhookPollingEnabled = vi.fn().mockReturnValue(true);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    vi.doMock('$lib/server/webhook_poller.js', () => ({
      isWebhookPollingEnabled,
      startWebhookPoller,
    }));

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await hooks.init();

    expect(startWebhookPoller).toHaveBeenCalledTimes(1);
    expect(startWebhookPoller).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        onPrUpdated: expect.any(Function),
      })
    );
    expect(sessionContext.getWebhookPoller()).toBe(pollerHandle);
  });

  test('process shutdown stops the webhook poller', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const pollerHandle = { stop: vi.fn() };
    const startWebhookPoller = vi.fn().mockReturnValue(pollerHandle);
    const isWebhookPollingEnabled = vi.fn().mockReturnValue(true);
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    vi.doMock('$lib/server/webhook_poller.js', () => ({
      isWebhookPollingEnabled,
      startWebhookPoller,
    }));

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    expect(sigtermHandler).toEqual(expect.any(Function));

    (sigtermHandler as () => void)();

    expect(pollerHandle.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('init failure stops a webhook poller created during that attempt', async () => {
    const config = { headless: { url: 'ws://localhost:8123/tim-agent' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const pollerHandle = { stop: vi.fn() };
    const startWebhookPoller = vi.fn().mockReturnValue(pollerHandle);
    const isWebhookPollingEnabled = vi.fn().mockReturnValue(true);
    const failingDiscoveryClient = {
      start: vi.fn().mockRejectedValue(new Error('discovery boom')),
      stop: vi.fn(),
    };

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    class FailingSessionDiscoveryClient {
      constructor() {
        return failingDiscoveryClient;
      }
    }

    vi.doMock('$lib/server/session_discovery.js', () => ({
      SessionDiscoveryClient: FailingSessionDiscoveryClient,
    }));
    vi.doMock('$lib/server/webhook_poller.js', () => ({
      isWebhookPollingEnabled,
      startWebhookPoller,
    }));

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await expect(hooks.init()).rejects.toThrow('discovery boom');

    expect(pollerHandle.stop).toHaveBeenCalledTimes(1);
    expect(sessionContext.getWebhookPoller()).toBeNull();
  });

  test('init stops a stale webhook poller on HMR re-init when polling is disabled', async () => {
    const stalePoller = { stop: vi.fn() };
    const isWebhookPollingEnabled = vi.fn().mockReturnValue(false);
    const startWebhookPoller = vi.fn();
    const getServerContext = vi.fn().mockResolvedValue({ config: {}, db: { fake: true } });

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/webhook_poller.js', () => ({
      isWebhookPollingEnabled,
      startWebhookPoller,
    }));

    const sessionContext = await import('./session_context.js');
    // Simulate a previously successful init — initPromise is set and resolved.
    const fakeManager = {} as any;
    sessionContext.setSessionInitPromise(Promise.resolve(fakeManager));
    sessionContext.setWebhookPoller(stalePoller);

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    expect(stalePoller.stop).toHaveBeenCalledTimes(1);
    expect(startWebhookPoller).not.toHaveBeenCalled();
    expect(sessionContext.getWebhookPoller()).toBeNull();
  });

  test('HMR re-init starts sync service when config becomes enabled after initial disabled init', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const syncServiceHandle = {
      role: 'main' as const,
      port: 8124,
      hostname: '127.0.0.1',
      stop: vi.fn(),
    };
    const startSyncService = vi.fn().mockResolvedValue(syncServiceHandle);
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);
    const onSpy = vi.spyOn(process, 'on');

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const sessionContext = await import('./session_context.js');
    const fakeManager = {} as any;
    sessionContext.setSessionInitPromise(Promise.resolve(fakeManager));
    sessionContext.setSyncService(null);

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    expect(startSyncService).toHaveBeenCalledWith(db, config);
    expect(sessionContext.getSyncService()).toBe(syncServiceHandle);

    const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    expect(sigtermHandler).toEqual(expect.any(Function));
  });

  test('init stores the sync service when sync is enabled', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const syncServiceHandle = { stop: vi.fn() };
    const startSyncService = vi.fn().mockResolvedValue(syncServiceHandle);
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await hooks.init();

    expect(startSyncService).toHaveBeenCalledWith(db, config);
    expect(sessionContext.getSyncService()).toBe(syncServiceHandle);
  });

  test('process shutdown stops the sync service', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const syncServiceHandle = { stop: vi.fn() };
    const startSyncService = vi.fn().mockResolvedValue(syncServiceHandle);
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);
    const onSpy = vi.spyOn(process, 'on');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    const sigtermHandler = onSpy.mock.calls.find(([signal]) => signal === 'SIGTERM')?.[1];
    expect(sigtermHandler).toEqual(expect.any(Function));

    (sigtermHandler as () => void)();

    expect(syncServiceHandle.stop).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('init failure stops a sync service created during that attempt', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } };
    const db = { fake: true };
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const syncServiceHandle = { stop: vi.fn() };
    const startSyncService = vi.fn().mockResolvedValue(syncServiceHandle);
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);
    const failingDiscoveryClient = {
      start: vi.fn().mockRejectedValue(new Error('discovery boom')),
      stop: vi.fn(),
    };

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    class FailingSessionDiscoveryClient {
      constructor() {
        return failingDiscoveryClient;
      }
    }
    vi.doMock('$lib/server/session_discovery.js', () => ({
      SessionDiscoveryClient: FailingSessionDiscoveryClient,
    }));
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await expect(hooks.init()).rejects.toThrow('discovery boom');

    expect(syncServiceHandle.stop).toHaveBeenCalledTimes(1);
    expect(sessionContext.getSyncService()).toBeNull();
  });

  test('init failure during sync service startup tears down created resources', async () => {
    const config = { sync: { role: 'main', nodeId: 'main-node' } };
    const db = { fake: true };
    const failure = new Error('sync boom');
    const getServerContext = vi.fn().mockResolvedValue({ config, db });
    const serverHandle = { port: 8123, stop: vi.fn() };
    const startWebSocketServer = vi.fn().mockReturnValue(serverHandle);
    const pollerHandle = { stop: vi.fn() };
    const startWebhookPoller = vi.fn().mockReturnValue(pollerHandle);
    const startSyncService = vi.fn().mockRejectedValue(failure);
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/ws_server.js', async () => {
      const actual = await vi.importActual<typeof import('./ws_server.js')>('./ws_server.js');
      return {
        ...actual,
        startWebSocketServer,
      };
    });
    vi.doMock('$lib/server/webhook_poller.js', () => ({
      isWebhookPollingEnabled: vi.fn().mockReturnValue(true),
      startWebhookPoller,
    }));
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const hooks = await import('../../hooks.server.js');
    const sessionContext = await import('./session_context.js');

    await expect(hooks.init()).rejects.toThrow('sync boom');

    expect(serverHandle.stop).toHaveBeenCalledTimes(1);
    expect(pollerHandle.stop).toHaveBeenCalledTimes(1);
    expect(sessionContext.getWebSocketServerHandle()).toBeNull();
    expect(sessionContext.getSessionDiscoveryClient()).toBeNull();
    expect(sessionContext.getWebhookPoller()).toBeNull();
    expect(sessionContext.getSyncService()).toBeNull();
    expect(sessionContext.getSessionInitPromise()).toBeNull();
  });

  test('init stops a stale sync service on HMR re-init when sync is disabled', async () => {
    const staleSyncService = { stop: vi.fn() };
    const config = { sync: { disabled: true } };
    const getServerContext = vi.fn().mockResolvedValue({ config, db: { fake: true } });
    const isSyncServiceEnabled = vi.fn().mockReturnValue(false);
    const startSyncService = vi.fn();

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService: isSyncServiceEnabled,
      startSyncService,
    }));

    const sessionContext = await import('./session_context.js');
    const fakeManager = {} as any;
    sessionContext.setSessionInitPromise(Promise.resolve(fakeManager));
    sessionContext.setSyncService(staleSyncService);

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    expect(staleSyncService.stop).toHaveBeenCalledTimes(1);
    expect(startSyncService).not.toHaveBeenCalled();
    expect(sessionContext.getSyncService()).toBeNull();
  });

  test('init stops a stale persistent sync service on HMR re-init when sync.offline becomes true', async () => {
    const staleSyncService = { stop: vi.fn() };
    const config = {
      sync: {
        role: 'persistent',
        nodeId: 'persistent-node',
        mainUrl: 'ws://localhost:9999/sync/ws',
        nodeToken: 'token',
        offline: true,
      },
    };
    const getServerContext = vi.fn().mockResolvedValue({ config, db: { fake: true } });
    // The "enabled" check still reports true (offline does NOT change `enabled`),
    // but `shouldRunSyncService` returns false because the persistent runner
    // must not run while offline.
    const isSyncServiceEnabled = vi.fn().mockReturnValue(true);
    const shouldRunSyncService = vi.fn().mockReturnValue(false);
    const startSyncService = vi.fn();

    vi.doMock('$lib/server/init.js', () => ({ getServerContext }));
    vi.doMock('$lib/server/sync_service.js', () => ({
      isSyncServiceEnabled,
      shouldRunSyncService,
      startSyncService,
    }));

    const sessionContext = await import('./session_context.js');
    const fakeManager = {} as any;
    sessionContext.setSessionInitPromise(Promise.resolve(fakeManager));
    sessionContext.setSyncService(staleSyncService);

    const hooks = await import('../../hooks.server.js');

    await hooks.init();

    expect(staleSyncService.stop).toHaveBeenCalledTimes(1);
    expect(startSyncService).not.toHaveBeenCalled();
    expect(sessionContext.getSyncService()).toBeNull();
  });
});
