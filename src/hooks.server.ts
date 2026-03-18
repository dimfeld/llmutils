import process from 'node:process';

import type { Handle, ServerInit } from '@sveltejs/kit';

import { getServerContext } from '$lib/server/init.js';
import {
  getSessionInitPromise,
  getSessionManager,
  getWebSocketServerHandle,
  setSessionInitPromise,
  setSessionManager,
  setWebSocketServerHandle,
} from '$lib/server/session_context.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { startWebSocketServer } from '$lib/server/ws_server.js';

interface SessionShutdownState {
  cleanup: (() => void) | null;
}

const sessionShutdownKey = Symbol.for('tim.web.sessionShutdown');

function getSessionShutdownState(): SessionShutdownState {
  const globalState = globalThis as typeof globalThis & {
    [sessionShutdownKey]?: SessionShutdownState;
  };

  globalState[sessionShutdownKey] ??= {
    cleanup: null,
  };

  return globalState[sessionShutdownKey];
}

function registerShutdownHandlers(stop: () => void): void {
  const state = getSessionShutdownState();
  state.cleanup?.();

  const shutdown = () => {
    stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  state.cleanup = () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  };
}

export const init: ServerInit = async () => {
  const existingPromise = getSessionInitPromise();
  if (existingPromise) {
    await existingPromise;
    return;
  }

  const initPromise = (async () => {
    const existingServer = getWebSocketServerHandle();
    if (existingServer) {
      return getSessionManager();
    }

    const { config, db } = await getServerContext();
    const sessionManager = new SessionManager(db);
    const serverHandle = startWebSocketServer(sessionManager, config);

    setSessionManager(sessionManager);
    setWebSocketServerHandle(serverHandle);
    registerShutdownHandlers(serverHandle.stop);

    return sessionManager;
  })().catch((error) => {
    setSessionInitPromise(null);
    throw error;
  });

  setSessionInitPromise(initPromise);
  await initPromise;
};

export const handle: Handle = async ({ event, resolve }) => resolve(event);
