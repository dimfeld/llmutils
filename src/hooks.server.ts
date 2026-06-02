import process from 'node:process';

import type { Handle, ServerInit } from '@sveltejs/kit';

import {
  shouldStartDailyDigest,
  startDailyDigestScheduler,
  updateDailyDigestMessagesForPrUrls,
} from '$lib/server/daily_digest.js';
import { getServerContext } from '$lib/server/init.js';
import { emitPrUpdatesForIngestResult } from '$lib/server/pr_event_utils.js';
import {
  getDailyDigestScheduler,
  getSessionDiscoveryClient,
  getSessionInitPromise,
  getSessionManager,
  getSlackNotifier,
  getSyncService,
  getWebSocketServerHandle,
  getWebhookPoller,
  setSessionDiscoveryClient,
  setDailyDigestScheduler,
  setSessionInitPromise,
  setSessionManager,
  setSlackNotifier,
  setSyncService,
  setWebSocketServerHandle,
  setWebhookPoller,
} from '$lib/server/session_context.js';
import { shouldStartSlackNotifier, startSlackNotifier } from '$lib/server/slack_notifier.js';
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
    getDailyDigestScheduler()?.stop();
    getSlackNotifier()?.stop();
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
    const existingSlackNotifier = getSlackNotifier();
    if (existingSlackNotifier) {
      if (!shouldStartSlackNotifier(config)) {
        existingSlackNotifier.stop();
        setSlackNotifier(null);
      }
    } else if (shouldStartSlackNotifier(config)) {
      const slackNotifier = startSlackNotifier(db, config);
      if (slackNotifier) {
        setSlackNotifier(slackNotifier);
        registerCurrentShutdownHandlers();
      }
    }
    const existingDailyDigestScheduler = getDailyDigestScheduler();
    if (existingDailyDigestScheduler) {
      if (!shouldStartDailyDigest(db, config)) {
        existingDailyDigestScheduler.stop();
        setDailyDigestScheduler(null);
      }
    } else if (shouldStartDailyDigest(db, config)) {
      const dailyDigestScheduler = startDailyDigestScheduler(db, config);
      if (dailyDigestScheduler) {
        setDailyDigestScheduler(dailyDigestScheduler);
        registerCurrentShutdownHandlers();
      }
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
  const existingSlackNotifier = getSlackNotifier();
  const existingDailyDigestScheduler = getDailyDigestScheduler();
  const existingSyncService = getSyncService();
  if (existingServer && existingDiscoveryClient) {
    const { config, db } = await getServerContext();
    const shouldRunSync = shouldRunSyncService(config);
    const shouldRunSlack = shouldStartSlackNotifier(config);
    const shouldRunDigest = shouldStartDailyDigest(db, config);
    const syncReady = Boolean(existingSyncService) || !shouldRunSync;
    const slackReady = Boolean(existingSlackNotifier) || !shouldRunSlack;
    const digestReady = Boolean(existingDailyDigestScheduler) || !shouldRunDigest;
    if (syncReady && slackReady && digestReady) {
      return;
    }

    if (syncReady && !existingSlackNotifier && shouldRunSlack) {
      const slackNotifier = startSlackNotifier(db, config);
      if (slackNotifier) {
        setSlackNotifier(slackNotifier);
        registerCurrentShutdownHandlers();
      }
      return;
    }

    if (syncReady && slackReady && !existingDailyDigestScheduler && shouldRunDigest) {
      const dailyDigestScheduler = startDailyDigestScheduler(db, config);
      if (dailyDigestScheduler) {
        setDailyDigestScheduler(dailyDigestScheduler);
        registerCurrentShutdownHandlers();
      }
      return;
    }

    if (!existingSyncService && !shouldRunSync) {
      return;
    }
  }

  const createdResources = {
    manager: false,
    server: false,
    discoveryClient: false,
    webhookPoller: false,
    slackNotifier: false,
    dailyDigestScheduler: false,
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
          void getSlackNotifier()
            ?.kick()
            .catch((err) =>
              console.warn('[slack_notifier] Failed to kick notifier after PR ingest', err)
            );
          if (result.prsUpdated.length > 0) {
            void updateDailyDigestMessagesForPrUrls(db, config, result.prsUpdated).catch((err) =>
              console.warn('[daily_digest] Failed to update digest messages after PR ingest', err)
            );
          }
        },
      });
    const slackNotifier =
      existingSlackNotifier ??
      (shouldStartSlackNotifier(config) ? startSlackNotifier(db, config) : null);
    const dailyDigestScheduler =
      existingDailyDigestScheduler ??
      (shouldStartDailyDigest(db, config) ? startDailyDigestScheduler(db, config) : null);
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
    if (!existingSlackNotifier && slackNotifier) {
      createdResources.slackNotifier = true;
      setSlackNotifier(slackNotifier);
    }
    if (!existingDailyDigestScheduler && dailyDigestScheduler) {
      createdResources.dailyDigestScheduler = true;
      setDailyDigestScheduler(dailyDigestScheduler);
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
    if (createdResources.slackNotifier) {
      const slackNotifier = getSlackNotifier();
      if (slackNotifier) {
        slackNotifier.stop();
        setSlackNotifier(null);
      }
    }
    if (createdResources.dailyDigestScheduler) {
      const dailyDigestScheduler = getDailyDigestScheduler();
      if (dailyDigestScheduler) {
        dailyDigestScheduler.stop();
        setDailyDigestScheduler(null);
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
