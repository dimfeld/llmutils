import type { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { IngestResult } from '$common/github/webhook_ingest.js';

const mocks = vi.hoisted(() => ({
  ingestWebhookEvents: vi.fn(),
  processInboxSignals: vi.fn(),
}));

vi.mock('$common/github/webhook_ingest.js', () => ({
  ingestWebhookEvents: mocks.ingestWebhookEvents,
}));

vi.mock('./inbox_producer.js', () => ({
  processInboxSignals: mocks.processInboxSignals,
}));

import { ingestWebhookEventsWithInbox } from './webhook_ingest_orchestrator.js';

function makeResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    eventsIngested: 1,
    prsUpdated: [],
    prsReadyForReview: [],
    reviewsSubmitted: [],
    inboxSignals: [],
    errors: [],
    ...overrides,
  };
}

function makeInboxSignal(): IngestResult['inboxSignals'][number] {
  return {
    kind: 'pr_comment',
    repo: 'example/repo',
    prNumber: 17,
    prUrl: 'https://github.com/example/repo/pull/17',
    actor: 'commenter',
    eventAt: '2026-06-01T10:00:00.000Z',
  };
}

describe('ingestWebhookEventsWithInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ingestWebhookEvents.mockResolvedValue(makeResult());
    mocks.processInboxSignals.mockResolvedValue([]);
  });

  test('returns the complete ingest result and processes inbox signals with a supplied manager', async () => {
    const result = makeResult({ inboxSignals: [makeInboxSignal()] });
    const sessionManager = {
      hasInboxUpdateListeners: vi.fn(() => true),
      emitInboxUpdate: vi.fn(),
    };
    mocks.ingestWebhookEvents.mockResolvedValue(result);

    await expect(ingestWebhookEventsWithInbox(null as Database, { sessionManager })).resolves.toBe(
      result
    );

    expect(mocks.ingestWebhookEvents).toHaveBeenCalledWith(null);
    expect(mocks.processInboxSignals).toHaveBeenCalledWith(null, result.inboxSignals, {
      sessionManager,
    });
  });

  test('resolves the session manager inside the best-effort boundary', async () => {
    const result = makeResult({ inboxSignals: [makeInboxSignal()] });
    const sessionManager = {
      hasInboxUpdateListeners: vi.fn(() => true),
      emitInboxUpdate: vi.fn(),
    };
    const getSessionManager = vi.fn(() => sessionManager);
    mocks.ingestWebhookEvents.mockResolvedValue(result);

    await ingestWebhookEventsWithInbox(null as Database, { getSessionManager });

    expect(getSessionManager).toHaveBeenCalledTimes(1);
    expect(mocks.processInboxSignals).toHaveBeenCalledWith(null, result.inboxSignals, {
      sessionManager,
    });
  });

  test('returns successfully when session-manager lookup fails', async () => {
    const result = makeResult({ inboxSignals: [makeInboxSignal()] });
    const error = new Error('session manager unavailable');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.ingestWebhookEvents.mockResolvedValue(result);

    await expect(
      ingestWebhookEventsWithInbox(null as Database, {
        getSessionManager: () => {
          throw error;
        },
      })
    ).resolves.toBe(result);

    expect(mocks.processInboxSignals).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[webhook_ingest] Inbox post-processing failed', error);
    warnSpy.mockRestore();
  });

  test('returns successfully when inbox processing fails', async () => {
    const result = makeResult({ inboxSignals: [makeInboxSignal()] });
    const error = new Error('inbox database unavailable');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.ingestWebhookEvents.mockResolvedValue(result);
    mocks.processInboxSignals.mockRejectedValue(error);

    await expect(ingestWebhookEventsWithInbox(null as Database)).resolves.toBe(result);

    expect(warnSpy).toHaveBeenCalledWith('[webhook_ingest] Inbox post-processing failed', error);
    warnSpy.mockRestore();
  });

  test('does not resolve a session manager or process inbox when there are no signals', async () => {
    const getSessionManager = vi.fn();

    await ingestWebhookEventsWithInbox(null as Database, { getSessionManager });

    expect(getSessionManager).not.toHaveBeenCalled();
    expect(mocks.processInboxSignals).not.toHaveBeenCalled();
  });
});
