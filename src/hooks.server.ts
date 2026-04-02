import process from 'node:process';

import type { Handle, ServerInit } from '@sveltejs/kit';

import { getServerContext } from '$lib/server/init.js';
import {
  getSessionDiscoveryClient,
  getSessionInitPromise,
  getSessionManager,
  getWebSocketServerHandle,
  getWebhookPoller,
  setSessionDiscoveryClient,
  setSessionInitPromise,
  setSessionManager,
  setWebSocketServerHandle,
  setWebhookPoller,
} from '$lib/server/session_context.js';
import { SessionDiscoveryClient } from '$lib/server/session_discovery.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { isWebhookPollingEnabled, startWebhookPoller } from '$lib/server/webhook_poller.js';
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
    // Handle poller state changes during HMR re-init.
    const existingPoller = getWebhookPoller();
    if (existingPoller && !isWebhookPollingEnabled()) {
      existingPoller.stop();
      setWebhookPoller(null);
    }
    return;
  }

  const existingServer = getWebSocketServerHandle();
  const existingDiscoveryClient = getSessionDiscoveryClient();
  const existingWebhookPoller = getWebhookPoller();
  if (existingServer && existingDiscoveryClient) {
    return;
  }

  const createdResources = {
    manager: false,
    server: false,
    discoveryClient: false,
    webhookPoller: false,
  };

  const initPromise = (async () => {
    const { config, db } = await getServerContext();
    const sessionManager = existingServer ? getSessionManager() : new SessionManager(db);
    const serverHandle = existingServer ?? startWebSocketServer(sessionManager, config);
    const discoveryClient = existingDiscoveryClient ?? new SessionDiscoveryClient(sessionManager);
    const webhookPoller = existingWebhookPoller ?? startWebhookPoller(db);

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
    if (!existingWebhookPoller && webhookPoller) {
      createdResources.webhookPoller = true;
      setWebhookPoller(webhookPoller);
    }

    await discoveryClient.start();

    registerShutdownHandlers(() => {
      webhookPoller?.stop();
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
    if (createdResources.webhookPoller) {
      const webhookPoller = getWebhookPoller();
      if (webhookPoller) {
        webhookPoller.stop();
        setWebhookPoller(null);
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
