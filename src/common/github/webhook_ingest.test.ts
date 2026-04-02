import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { upsertPlan } from '../../tim/db/plan.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import {
  getWebhookCursor,
  insertWebhookLogEntry,
  updateWebhookCursor,
  pruneOldWebhookLogs,
} from '../../tim/db/webhook_log.js';
import { getPrStatusByUrl } from '../../tim/db/pr_status.js';

const mocks = vi.hoisted(() => ({
  fetchWebhookEvents: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(),
  fetchAndUpdatePrMergeableStatus: vi.fn<(...args: unknown[]) => Promise<void>>(),
}));

vi.mock('./webhook_client.ts', () => ({
  fetchWebhookEvents: mocks.fetchWebhookEvents,
  getWebhookServerUrl: () => process.env.TIM_WEBHOOK_SERVER_URL ?? null,
  getWebhookInternalApiToken: () => process.env.WEBHOOK_INTERNAL_API_TOKEN ?? null,
}));

vi.mock('./pr_status_service.ts', () => ({
  fetchAndUpdatePrMergeableStatus: mocks.fetchAndUpdatePrMergeableStatus,
}));

import { ingestWebhookEvents } from './webhook_ingest.js';

describe('common/github/webhook_ingest', () => {
  let tempDir: string;
  let db: Database;
  let originalWebhookUrl: string | undefined;
  let originalWebhookToken: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-webhook-ingest-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));

    const projectId = getOrCreateProject(db, 'github.com__example__repo').id;
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      branch: 'feature/webhook',
      filename: '1.plan.md',
    });

    originalWebhookUrl = process.env.TIM_WEBHOOK_SERVER_URL;
    originalWebhookToken = process.env.WEBHOOK_INTERNAL_API_TOKEN;
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';
    process.env.WEBHOOK_INTERNAL_API_TOKEN = 'shared-token';
  });

  afterEach(async () => {
    mocks.fetchWebhookEvents.mockReset();
    mocks.fetchAndUpdatePrMergeableStatus.mockReset();
    if (originalWebhookUrl === undefined) {
      delete process.env.TIM_WEBHOOK_SERVER_URL;
    } else {
      process.env.TIM_WEBHOOK_SERVER_URL = originalWebhookUrl;
    }
    if (originalWebhookToken === undefined) {
      delete process.env.WEBHOOK_INTERNAL_API_TOKEN;
    } else {
      process.env.WEBHOOK_INTERNAL_API_TOKEN = originalWebhookToken;
    }
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('ingestWebhookEvents stores webhook logs, updates matching PRs, and advances the cursor', async () => {
    mocks.fetchWebhookEvents.mockResolvedValueOnce([
      {
        id: 11,
        deliveryId: 'delivery-1',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:00:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 51,
            title: 'Webhook PR',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-51', ref: 'feature/webhook' },
            base: { ref: 'main' },
            labels: [{ name: 'backend', color: '00ff00' }],
            requested_reviewers: [{ login: 'bob' }],
          },
        }),
      },
      {
        id: 12,
        deliveryId: 'delivery-2',
        eventType: 'pull_request_review',
        action: 'submitted',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:01:00.000Z',
        payloadJson: JSON.stringify({
          repository: { full_name: 'example/repo' },
          pull_request: { number: 51 },
          review: {
            state: 'approved',
            submitted_at: '2026-03-30T10:01:00.000Z',
            user: { login: 'reviewer-1' },
          },
        }),
      },
      {
        id: 13,
        deliveryId: 'delivery-3',
        eventType: 'check_run',
        action: 'completed',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:02:00.000Z',
        payloadJson: JSON.stringify({
          repository: { full_name: 'example/repo' },
          check_run: {
            name: 'unit tests',
            status: 'completed',
            conclusion: 'success',
            details_url: 'https://example.com/checks/51',
            started_at: '2026-03-30T10:01:00.000Z',
            completed_at: '2026-03-30T10:02:00.000Z',
            pull_requests: [{ number: 51 }],
          },
        }),
      },
      {
        id: 14,
        deliveryId: 'delivery-4',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'other/repo',
        receivedAt: '2026-03-30T10:03:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'other/repo' },
          pull_request: {
            number: 99,
            title: 'Unknown repo',
            state: 'open',
            draft: false,
          },
        }),
      },
    ]);
    mocks.fetchAndUpdatePrMergeableStatus.mockResolvedValue(undefined);

    const result = await ingestWebhookEvents(db);

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/51');
    expect(result.eventsIngested).toBe(4);
    expect(result.errors).toEqual([]);
    expect(result.prsUpdated).toEqual(['https://github.com/example/repo/pull/51']);
    expect(mocks.fetchWebhookEvents).toHaveBeenCalledWith(
      'https://webhooks.example.com',
      'shared-token',
      {
        afterId: 0,
        limit: 500,
      }
    );
    // Both the pull_request (opened) and pull_request_review (approved) events target
    // example/repo#51, but deduplication means only one API call is made
    expect(mocks.fetchAndUpdatePrMergeableStatus).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAndUpdatePrMergeableStatus).toHaveBeenCalledWith(db, 'example', 'repo', 51);
    expect(getWebhookCursor(db)).toBe(14);
    expect(
      db.prepare('SELECT COUNT(*) as count FROM webhook_log').get() as { count: number }
    ).toEqual({ count: 4 });
    expect(detail?.status.author).toBe('alice');
    expect(detail?.status.requested_reviewers).toBe('["bob"]');
    expect(detail?.reviews.map((review) => review.state)).toEqual(['APPROVED']);
    expect(detail?.checks.map((check) => check.name)).toEqual(['unit tests']);
    expect(detail?.status.check_rollup_state).toBe('success');
    expect(getPrStatusByUrl(db, 'https://github.com/other/repo/pull/99')).toBeNull();
  });

  test('ingestWebhookEvents returns early when webhook config is missing', async () => {
    delete process.env.TIM_WEBHOOK_SERVER_URL;

    mocks.fetchWebhookEvents.mockRejectedValue(new Error('should not be called'));

    await expect(ingestWebhookEvents(db)).resolves.toEqual({
      eventsIngested: 0,
      prsUpdated: [],
      errors: [],
    });
    expect(mocks.fetchWebhookEvents).not.toHaveBeenCalled();
  });

  test('ingestWebhookEvents records handler and follow-up refresh errors while still advancing the cursor and pruning logs', async () => {
    mocks.fetchWebhookEvents.mockResolvedValueOnce([
      {
        id: 21,
        deliveryId: 'delivery-bad-json',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:00:00.000Z',
        payloadJson: '{not valid json',
      },
      {
        id: 22,
        deliveryId: 'delivery-refresh-fails',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:01:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 52,
            title: 'Refresh fails later',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-52', ref: 'feature/webhook' },
            base: { ref: 'main' },
          },
        }),
      },
    ]);
    mocks.fetchAndUpdatePrMergeableStatus.mockRejectedValue(new Error('targeted refresh failed'));

    const result = await ingestWebhookEvents(db);

    expect(result.eventsIngested).toBe(2);
    expect(result.prsUpdated).toEqual(['https://github.com/example/repo/pull/52']);
    expect(result.errors).toEqual([
      expect.stringContaining('webhook event 21:'),
      'webhook follow-up refresh failed: example/repo#52: mergeable/review_decision refresh failed',
    ]);
    expect(getWebhookCursor(db)).toBe(22);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/52')?.status.title).toBe(
      'Refresh fails later'
    );
  });

  test('ingestWebhookEvents ignores duplicate delivery ids but still advances the cursor and returns the affected PR once', async () => {
    mocks.fetchWebhookEvents.mockResolvedValueOnce([
      {
        id: 31,
        deliveryId: 'duplicate-delivery',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:00:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 53,
            title: 'Duplicate delivery',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-53', ref: 'feature/webhook' },
            base: { ref: 'main' },
          },
        }),
      },
      {
        id: 32,
        deliveryId: 'duplicate-delivery',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:00:01.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 53,
            title: 'Duplicate delivery second copy',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-53b', ref: 'feature/webhook' },
            base: { ref: 'main' },
          },
        }),
      },
    ]);
    mocks.fetchAndUpdatePrMergeableStatus.mockResolvedValue(undefined);

    const result = await ingestWebhookEvents(db);

    expect(result.eventsIngested).toBe(1); // Second event skipped as duplicate
    expect(result.errors).toEqual([]);
    expect(result.prsUpdated).toEqual(['https://github.com/example/repo/pull/53']);
    expect(getWebhookCursor(db)).toBe(32);
    expect(
      db
        .prepare('SELECT COUNT(*) as count FROM webhook_log WHERE delivery_id = ?')
        .get('duplicate-delivery')
    ).toEqual({ count: 1 });
    // Verify the PR title is from the first event (second was skipped due to dedup)
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/53')?.status.title).toBe(
      'Duplicate delivery'
    );
    // Verify API call was only made once (not twice)
    expect(mocks.fetchAndUpdatePrMergeableStatus).toHaveBeenCalledTimes(1);
  });

  test('ingestWebhookEvents skips pruning when every fetched event is a duplicate', async () => {
    const events = [
      {
        id: 41,
        deliveryId: 'already-seen-delivery',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:05:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 54,
            title: 'First copy',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-54', ref: 'feature/webhook' },
            base: { ref: 'main' },
          },
        }),
      },
      {
        id: 42,
        deliveryId: 'already-seen-delivery',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:05:01.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 54,
            title: 'Second copy',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-54b', ref: 'feature/webhook' },
            base: { ref: 'main' },
          },
        }),
      },
    ];

    // First call returns events, second call (after cursor advance) returns empty
    mocks.fetchWebhookEvents.mockResolvedValueOnce(events).mockResolvedValueOnce(events);
    mocks.fetchAndUpdatePrMergeableStatus.mockResolvedValue(undefined);

    const pruneOldWebhookLogsSpy = vi.spyOn(
      await import('../../tim/db/webhook_log.js'),
      'pruneOldWebhookLogs'
    );

    expect(await ingestWebhookEvents(db)).toEqual({
      eventsIngested: 1,
      prsUpdated: ['https://github.com/example/repo/pull/54'],
      errors: [],
    });

    // Second run: same events but all are duplicates now (already in webhook_log)
    mocks.fetchWebhookEvents.mockResolvedValueOnce(events);
    expect(await ingestWebhookEvents(db)).toEqual({
      eventsIngested: 0,
      prsUpdated: [],
      errors: [],
    });
    // pruneOldWebhookLogs was called once (first run had events), not on second run
    expect(pruneOldWebhookLogsSpy).toHaveBeenCalledTimes(1);
    expect(mocks.fetchAndUpdatePrMergeableStatus).toHaveBeenCalledTimes(1);
  });

  test('ingestWebhookEvents loops until all events are consumed', async () => {
    // First batch: exactly 500 events (triggers another fetch)
    const batch1 = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      deliveryId: `delivery-batch1-${i}`,
      eventType: 'check_run' as const,
      action: 'completed',
      repositoryFullName: 'example/repo',
      receivedAt: '2026-03-30T10:00:00.000Z',
      payloadJson: JSON.stringify({
        repository: { full_name: 'example/repo' },
        check_run: {
          name: `check-${i}`,
          status: 'completed',
          conclusion: 'success',
          pull_requests: [],
        },
      }),
    }));

    // Second batch: 2 events (< 500, so loop ends)
    const batch2 = [
      {
        id: 501,
        deliveryId: 'delivery-batch2-0',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:01:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 60,
            title: 'Batch 2 PR',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'alice' },
            head: { sha: 'sha-60', ref: 'feature/batch2' },
            base: { ref: 'main' },
          },
        }),
      },
      {
        id: 502,
        deliveryId: 'delivery-batch2-1',
        eventType: 'pull_request',
        action: 'opened',
        repositoryFullName: 'example/repo',
        receivedAt: '2026-03-30T10:02:00.000Z',
        payloadJson: JSON.stringify({
          action: 'opened',
          repository: { full_name: 'example/repo' },
          pull_request: {
            number: 61,
            title: 'Batch 2 PR 2',
            state: 'open',
            draft: false,
            merged_at: null,
            user: { login: 'bob' },
            head: { sha: 'sha-61', ref: 'feature/batch2b' },
            base: { ref: 'main' },
          },
        }),
      },
    ];

    mocks.fetchWebhookEvents.mockResolvedValueOnce(batch1).mockResolvedValueOnce(batch2);
    mocks.fetchAndUpdatePrMergeableStatus.mockResolvedValue(undefined);

    const result = await ingestWebhookEvents(db);

    expect(mocks.fetchWebhookEvents).toHaveBeenCalledTimes(2);
    // First call with initial cursor
    expect(mocks.fetchWebhookEvents).toHaveBeenNthCalledWith(
      1,
      'https://webhooks.example.com',
      'shared-token',
      { afterId: 0, limit: 500 }
    );
    // Second call with advanced cursor
    expect(mocks.fetchWebhookEvents).toHaveBeenNthCalledWith(
      2,
      'https://webhooks.example.com',
      'shared-token',
      { afterId: 500, limit: 500 }
    );
    expect(result.eventsIngested).toBe(502);
    expect(getWebhookCursor(db)).toBe(502);
    // Two PRs from batch2 that needed refresh (opened action), deduplicated
    expect(mocks.fetchAndUpdatePrMergeableStatus).toHaveBeenCalledTimes(2);
  });
});
