import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ingestWebhookEvents: vi.fn<(...args: unknown[]) => Promise<{ errors: string[] }>>(),
  formatWebhookIngestErrors: vi.fn<(errors: string[]) => string | null>(),
  getWebhookServerUrl: vi.fn<() => string | null>(),
}));

vi.mock('$common/github/webhook_ingest.js', () => ({
  ingestWebhookEvents: mocks.ingestWebhookEvents,
  formatWebhookIngestErrors: mocks.formatWebhookIngestErrors,
}));

vi.mock('$common/github/webhook_client.js', () => ({
  getWebhookServerUrl: mocks.getWebhookServerUrl,
}));

import {
  getWebhookPollIntervalMs,
  isWebhookPollingEnabled,
  startWebhookPoller,
} from './webhook_poller.js';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

describe('lib/server/webhook_poller', () => {
  const originalPollInterval = process.env.TIM_WEBHOOK_POLL_INTERVAL;
  const originalServerUrl = process.env.TIM_WEBHOOK_SERVER_URL;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    delete process.env.TIM_WEBHOOK_POLL_INTERVAL;
    delete process.env.TIM_WEBHOOK_SERVER_URL;

    mocks.ingestWebhookEvents.mockResolvedValue({ errors: [] });
    mocks.formatWebhookIngestErrors.mockReturnValue(null);
    mocks.getWebhookServerUrl.mockImplementation(() => process.env.TIM_WEBHOOK_SERVER_URL ?? null);
  });

  afterEach(() => {
    vi.useRealTimers();

    if (originalPollInterval === undefined) {
      delete process.env.TIM_WEBHOOK_POLL_INTERVAL;
    } else {
      process.env.TIM_WEBHOOK_POLL_INTERVAL = originalPollInterval;
    }

    if (originalServerUrl === undefined) {
      delete process.env.TIM_WEBHOOK_SERVER_URL;
    } else {
      process.env.TIM_WEBHOOK_SERVER_URL = originalServerUrl;
    }
  });

  describe('getWebhookPollIntervalMs', () => {
    test('returns null when the env var is missing, invalid, or non-positive', () => {
      expect(getWebhookPollIntervalMs()).toBeNull();

      process.env.TIM_WEBHOOK_POLL_INTERVAL = 'abc';
      expect(getWebhookPollIntervalMs()).toBeNull();

      process.env.TIM_WEBHOOK_POLL_INTERVAL = '0';
      expect(getWebhookPollIntervalMs()).toBeNull();

      process.env.TIM_WEBHOOK_POLL_INTERVAL = '-3';
      expect(getWebhookPollIntervalMs()).toBeNull();
    });

    test('clamps values below five seconds and preserves larger intervals', () => {
      process.env.TIM_WEBHOOK_POLL_INTERVAL = '1';
      expect(getWebhookPollIntervalMs()).toBe(5_000);

      process.env.TIM_WEBHOOK_POLL_INTERVAL = '30';
      expect(getWebhookPollIntervalMs()).toBe(30_000);
    });
  });

  test('isWebhookPollingEnabled requires both the poll interval and webhook server URL', () => {
    expect(isWebhookPollingEnabled()).toBe(false);

    process.env.TIM_WEBHOOK_POLL_INTERVAL = '30';
    expect(isWebhookPollingEnabled()).toBe(false);

    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';
    expect(isWebhookPollingEnabled()).toBe(true);
  });

  test('startWebhookPoller returns null without TIM_WEBHOOK_POLL_INTERVAL', () => {
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    expect(startWebhookPoller(null as Database)).toBeNull();
    expect(mocks.ingestWebhookEvents).not.toHaveBeenCalled();
  });

  test('startWebhookPoller returns null without TIM_WEBHOOK_SERVER_URL', () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '30';

    expect(startWebhookPoller(null as Database)).toBeNull();
    expect(mocks.ingestWebhookEvents).not.toHaveBeenCalled();
  });

  test('polling starts after the initial delay and continues on the configured interval', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '30';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handle = startWebhookPoller(null as Database);

    expect(handle).not.toBeNull();
    expect(infoSpy).toHaveBeenCalledWith(
      '[webhook_poller] Started polling every 30s after 15s initial delay'
    );

    await vi.advanceTimersByTimeAsync(14_999);
    expect(mocks.ingestWebhookEvents).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(2);

    handle?.stop();
    expect(infoSpy).toHaveBeenCalledWith('[webhook_poller] Stopped polling');
  });

  test('minimum interval clamping applies to scheduled polling', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '1';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const handle = startWebhookPoller(null as Database);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(2);

    handle?.stop();
  });

  test('concurrency guard skips overlapping poll cycles', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '5';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const firstRun = createDeferred<{ errors: string[] }>();
    mocks.ingestWebhookEvents
      .mockReturnValueOnce(firstRun.promise)
      .mockResolvedValue({ errors: [] });

    const handle = startWebhookPoller(null as Database);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    firstRun.resolve({ errors: [] });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(2);

    handle?.stop();
  });

  test('ingestion errors are logged and do not stop future polls', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '5';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.ingestWebhookEvents.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({
      errors: [],
    });

    const handle = startWebhookPoller(null as Database);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[webhook_poller] Polling failed', expect.any(Error));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(2);

    handle?.stop();
  });

  test('formatted ingestion errors are logged as warnings', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '5';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.ingestWebhookEvents.mockResolvedValue({ errors: ['bad event'] });
    mocks.formatWebhookIngestErrors.mockReturnValue('bad event');

    const handle = startWebhookPoller(null as Database);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(mocks.formatWebhookIngestErrors).toHaveBeenCalledWith(['bad event']);
    expect(warnSpy).toHaveBeenCalledWith('[webhook_poller] bad event');

    handle?.stop();
  });

  test('stop clears the initial timeout and the polling interval', async () => {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '5';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';

    const handleBeforeStart = startWebhookPoller(null as Database);
    handleBeforeStart?.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.ingestWebhookEvents).not.toHaveBeenCalled();

    const handleAfterStart = startWebhookPoller(null as Database);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);

    handleAfterStart?.stop();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.ingestWebhookEvents).toHaveBeenCalledTimes(1);
  });
});
