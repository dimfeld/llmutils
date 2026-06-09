import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { upsertPrStatus } from './pr_status.js';
import {
  getSlackReviewRequestMessage,
  pruneSlackReviewRequestMessagesBefore,
  upsertSlackReviewRequestMessage,
} from './slack_review_request_message.js';

describe('tim db/slack_review_request_message', () => {
  let tempDir: string;
  let db: Database;
  let prStatusId: number;
  let pr2StatusId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-review-message-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));

    const pr1 = upsertPrStatus(db, {
      prUrl: 'https://github.com/octocat/hello-world/pull/1',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 1,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
    });
    prStatusId = pr1.status.id;

    const pr2 = upsertPrStatus(db, {
      prUrl: 'https://github.com/octocat/hello-world/pull/2',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 2,
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
    });
    pr2StatusId = pr2.status.id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('migration creates the review-request message table keyed by pr_status_id', () => {
    const columns = db.prepare("PRAGMA table_info('slack_review_request_message')").all() as Array<{
      name: string;
      pk: number;
    }>;
    expect(columns.map((column) => column.name)).toEqual([
      'pr_status_id',
      'workspace',
      'slack_channel',
      'slack_ts',
      'posted_at',
      'created_at',
      'updated_at',
    ]);
    expect(columns.filter((column) => column.pk > 0).map((column) => column.name)).toEqual([
      'pr_status_id',
    ]);
  });

  test('tracks only the latest message per PR', () => {
    upsertSlackReviewRequestMessage(db, {
      prStatusId,
      workspace: 'work',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });

    const first = getSlackReviewRequestMessage(db, prStatusId);
    expect(first?.workspace).toBe('work');
    expect(first?.slack_channel).toBe('C123');
    expect(first?.slack_ts).toBe('1710000000.000100');

    upsertSlackReviewRequestMessage(db, {
      prStatusId,
      workspace: 'work',
      slackChannel: 'C456',
      slackTs: '1710000001.000200',
    });

    const second = getSlackReviewRequestMessage(db, prStatusId);
    expect(second?.slack_channel).toBe('C456');
    expect(second?.slack_ts).toBe('1710000001.000200');
    expect(second?.created_at).toBe(first?.created_at);

    const count = db
      .prepare('SELECT COUNT(*) AS count FROM slack_review_request_message')
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  test('returns undefined for a PR without a tracked message', () => {
    expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
  });

  test('prunes messages posted before the cutoff', () => {
    upsertSlackReviewRequestMessage(db, {
      prStatusId,
      workspace: 'work',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });
    upsertSlackReviewRequestMessage(db, {
      prStatusId: pr2StatusId,
      workspace: 'work',
      slackChannel: 'C123',
      slackTs: '1710000005.000500',
    });

    db.prepare('UPDATE slack_review_request_message SET posted_at = ? WHERE pr_status_id = ?').run(
      '2026-01-01T00:00:00.000Z',
      prStatusId
    );

    const pruned = pruneSlackReviewRequestMessagesBefore(db, '2026-01-15T00:00:00.000Z');
    expect(pruned).toBe(1);
    expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
    expect(getSlackReviewRequestMessage(db, pr2StatusId)).toBeDefined();
  });

  test('deleting the PR row cascades to the tracked message', () => {
    upsertSlackReviewRequestMessage(db, {
      prStatusId,
      workspace: 'work',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });

    db.prepare('DELETE FROM pr_status WHERE id = ?').run(prStatusId);
    expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
  });
});
