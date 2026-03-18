import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('hooks.server init', () => {
  const sessionShutdownKey = Symbol.for('tim.web.sessionShutdown');

  beforeEach(async () => {
    vi.resetModules();
    const sessionContext = await import('./session_context.js');
    (sessionContext.setSessionManager as unknown as (manager: null) => void)(null);
    (sessionContext.setWebSocketServerHandle as unknown as (server: null) => void)(null);
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
    sessionContext.setSessionInitPromise(null);
    const globalState = globalThis as typeof globalThis & {
      [sessionShutdownKey]?: { cleanup: (() => void) | null };
    };
    globalState[sessionShutdownKey]?.cleanup?.();
    delete globalState[sessionShutdownKey];
    vi.resetModules();
    vi.clearAllMocks();
    vi.doUnmock('$lib/server/init.js');
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

    expect(getServerContext).toHaveBeenCalledTimes(1);
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
    sessionContext.setSessionInitPromise(null);

    const hooksReloaded = await import('../../hooks.server.js');
    await hooksReloaded.init();

    expect(offSpy).toHaveBeenCalledWith('SIGTERM', sigtermHandler);
    expect(offSpy).toHaveBeenCalledWith('SIGINT', sigintHandler);
  });
});
