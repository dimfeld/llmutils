import process from 'node:process';

import type { Handle, ServerInit } from '@sveltejs/kit';

import { getServerContext } from '$lib/server/init.js';
import {
  getSessionDiscoveryClient,
  getSessionInitPromise,
  getSessionManager,
  getWebSocketServerHandle,
  setSessionDiscoveryClient,
  setSessionInitPromise,
  setSessionManager,
  setWebSocketServerHandle,
} from '$lib/server/session_context.js';
import { SessionDiscoveryClient } from '$lib/server/session_discovery.js';
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

  const existingServer = getWebSocketServerHandle();
  const existingDiscoveryClient = getSessionDiscoveryClient();
  if (existingServer && existingDiscoveryClient) {
    return;
  }

  const createdResources = {
    manager: false,
    server: false,
    discoveryClient: false,
  };

  const initPromise = (async () => {
    const { config, db } = await getServerContext();
    const sessionManager = existingServer ? getSessionManager() : new SessionManager(db);
    const serverHandle = existingServer ?? startWebSocketServer(sessionManager, config);
    const discoveryClient = existingDiscoveryClient ?? new SessionDiscoveryClient(sessionManager);

    // Store references before await so they are tracked for cleanup on failure.
    if (!existingServer) {
      createdResources.manager = true;
      createdResources.server = true;
      setSessionManager(sessionManager);
      setWebSocketServerHandle(serverHandle);
    }
    if (!existingDiscoveryClient) {
      createdResources.discoveryClient = true;
      setSessionDiscoveryClient(discoveryClient);
    }

    await discoveryClient.start();

    registerShutdownHandlers(() => {
      discoveryClient.stop();
      serverHandle.stop();
    });

    return sessionManager;
  })().catch((error) => {
    // Clean up only resources created during this failed init attempt.
    if (createdResources.discoveryClient) {
      const discoveryClient = getSessionDiscoveryClient();
      if (discoveryClient) {
        discoveryClient.stop();
        setSessionDiscoveryClient(null);
      }
    }
    if (createdResources.server) {
      const serverHandle = getWebSocketServerHandle();
      if (serverHandle) {
        serverHandle.stop();
        setWebSocketServerHandle(null);
      }
    }
    if (createdResources.manager) {
      setSessionManager(null);
    }
    setSessionInitPromise(null);
    throw error;
  });

  setSessionInitPromise(initPromise);
  await initPromise;
};

export const handle: Handle = async ({ event, resolve }) => resolve(event);
