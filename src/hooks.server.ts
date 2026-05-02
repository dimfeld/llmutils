import process from 'node:process';

import type { Handle, ServerInit } from '@sveltejs/kit';

import { getServerContext } from '$lib/server/init.js';
import { emitPrUpdatesForIngestResult } from '$lib/server/pr_event_utils.js';
import {
  getSessionDiscoveryClient,
  getSessionInitPromise,
  getSessionManager,
  getSyncService,
  getWebSocketServerHandle,
  getWebhookPoller,
  setSessionDiscoveryClient,
  setSessionInitPromise,
  setSessionManager,
  setSyncService,
  setWebSocketServerHandle,
  setWebhookPoller,
} from '$lib/server/session_context.js';
import { SessionDiscoveryClient } from '$lib/server/session_discovery.js';
import { SessionManager } from '$lib/server/session_manager.js';
import { shouldRunSyncService, startSyncService } from '$lib/server/sync_service.js';
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

function registerCurrentShutdownHandlers(): void {
  // The closure intentionally reads service handles from session_context lazily
  // at signal time, so HMR-started services replace the value in the slot rather
  // than capturing a stale handle. Do not refactor to capture handles by value.
  registerShutdownHandlers(() => {
    getSyncService()?.stop();
    getWebhookPoller()?.stop();
    getSessionDiscoveryClient()?.stop();
    getWebSocketServerHandle()?.stop();
  });
}

export const init: ServerInit = async () => {
  const existingPromise = getSessionInitPromise();
  if (existingPromise) {
    await existingPromise;
    const { config, db } = await getServerContext();
    // Handle poller state changes during HMR re-init.
    const existingPoller = getWebhookPoller();
    if (existingPoller && !isWebhookPollingEnabled()) {
      existingPoller.stop();
      setWebhookPoller(null);
    }
    const existingSyncService = getSyncService();
    if (existingSyncService) {
      if (!shouldRunSyncService(config)) {
        existingSyncService.stop();
        setSyncService(null);
      }
    } else if (shouldRunSyncService(config)) {
      const syncService = await startSyncService(db, config);
      if (syncService) {
        setSyncService(syncService);
        registerCurrentShutdownHandlers();
      }
    }
    return;
  }

  const existingServer = getWebSocketServerHandle();
  const existingDiscoveryClient = getSessionDiscoveryClient();
  const existingWebhookPoller = getWebhookPoller();
  const existingSyncService = getSyncService();
  if (existingServer && existingDiscoveryClient && existingSyncService) {
    return;
  }
  if (existingServer && existingDiscoveryClient && !existingSyncService) {
    const { config } = await getServerContext();
    if (!shouldRunSyncService(config)) {
      return;
    }
  }

  const createdResources = {
    manager: false,
    server: false,
    discoveryClient: false,
    webhookPoller: false,
    syncService: false,
  };

  const initPromise = (async () => {
    const { config, db } = await getServerContext();
    const sessionManager = existingServer ? getSessionManager() : new SessionManager(db);
    const serverHandle = existingServer ?? startWebSocketServer(sessionManager, config);
    const discoveryClient = existingDiscoveryClient ?? new SessionDiscoveryClient(sessionManager);
    const webhookPoller =
      existingWebhookPoller ??
      startWebhookPoller(db, {
        onPrUpdated: (result) => {
          try {
            emitPrUpdatesForIngestResult(db, result, sessionManager);
          } catch (err) {
            console.warn('[webhook_poller] Failed to emit PR update event', err);
          }
        },
      });
    let syncService = existingSyncService;

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
    if (!existingSyncService) {
      syncService = await startSyncService(db, config);
    }
    if (!existingSyncService && syncService) {
      createdResources.syncService = true;
      setSyncService(syncService);
    }

    await discoveryClient.start();

    registerCurrentShutdownHandlers();

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
    if (createdResources.syncService) {
      const syncService = getSyncService();
      if (syncService) {
        syncService.stop();
        setSyncService(null);
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
