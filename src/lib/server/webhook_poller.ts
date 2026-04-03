import type { Database } from 'bun:sqlite';

import {
  formatWebhookIngestErrors,
  ingestWebhookEvents,
  type IngestResult,
} from '$common/github/webhook_ingest.js';
import { getWebhookInternalApiToken, getWebhookServerUrl } from '$common/github/webhook_client.js';

import type { WebhookPollerHandle } from './session_context.js';

const MIN_POLL_INTERVAL_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 86_400; // 24 hours — prevents 32-bit timer overflow
const INITIAL_POLL_DELAY_MS = 15_000;

interface StartWebhookPollerOptions {
  onPrUpdated?: (result: IngestResult) => void;
}

export function getWebhookPollIntervalMs(): number | null {
  const rawInterval = process.env.TIM_WEBHOOK_POLL_INTERVAL;
  if (!rawInterval) {
    return null;
  }

  if (!/^\d+$/.test(rawInterval)) {
    return null;
  }
  const parsedInterval = Number.parseInt(rawInterval, 10);
  if (parsedInterval <= 0) {
    return null;
  }

  const clampedInterval = Math.min(
    Math.max(parsedInterval, MIN_POLL_INTERVAL_SECONDS),
    MAX_POLL_INTERVAL_SECONDS
  );
  return clampedInterval * 1000;
}

export function isWebhookPollingEnabled(): boolean {
  return (
    Boolean(getWebhookPollIntervalMs()) &&
    Boolean(getWebhookServerUrl()) &&
    Boolean(getWebhookInternalApiToken())
  );
}

export function startWebhookPoller(
  db: Database,
  options: StartWebhookPollerOptions = {}
): WebhookPollerHandle | null {
  const pollIntervalMs = getWebhookPollIntervalMs();
  if (!pollIntervalMs || !getWebhookServerUrl() || !getWebhookInternalApiToken()) {
    return null;
  }

  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let initialDelayTimer: ReturnType<typeof setTimeout> | null = null;
  let inProgress = false;
  let stopped = false;

  const runIngest = async (): Promise<void> => {
    if (inProgress || stopped) {
      return;
    }

    inProgress = true;
    try {
      const result = await ingestWebhookEvents(db);
      const formattedErrors = formatWebhookIngestErrors(result.errors);
      if (formattedErrors) {
        console.warn(`[webhook_poller] ${formattedErrors}`);
      }
      if (result.prsUpdated.length > 0) {
        options.onPrUpdated?.(result);
      }
    } catch (error) {
      console.error('[webhook_poller] Polling failed', error);
    } finally {
      inProgress = false;
    }
  };

  initialDelayTimer = setTimeout(() => {
    initialDelayTimer = null;
    void runIngest();
    intervalTimer = setInterval(() => {
      void runIngest();
    }, pollIntervalMs);
    intervalTimer.unref?.();
  }, INITIAL_POLL_DELAY_MS);

  initialDelayTimer.unref?.();

  console.info(
    `[webhook_poller] Started polling every ${pollIntervalMs / 1000}s after ${INITIAL_POLL_DELAY_MS / 1000}s initial delay`
  );

  return {
    stop: (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (initialDelayTimer) {
        clearTimeout(initialDelayTimer);
        initialDelayTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }

      console.info('[webhook_poller] Stopped polling');
    },
  };
}
