import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  getLatestSlackDailyDigestMessageBeforeDate,
  getSlackDailyDigestMessage,
  upsertSlackDailyDigestMessage,
} from './slack_daily_digest_message.js';

describe('tim db/slack_daily_digest_message', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-digest-message-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('migration creates the daily digest message table', () => {
    const columns = db.prepare("PRAGMA table_info('slack_daily_digest_message')").all() as Array<{
      name: string;
      pk: number;
    }>;
    const names = columns.map((column) => column.name);
    expect(names).toEqual([
      'workspace',
      'channel',
      'repo_full_name',
      'digest_date',
      'slack_channel',
      'slack_ts',
      'created_at',
      'updated_at',
    ]);
    expect(
      columns
        .filter((column) => column.pk > 0)
        .map((column) => column.name)
        .sort()
    ).toEqual(['channel', 'digest_date', 'repo_full_name', 'workspace']);
  });

  test('upserts and retrieves the stored Slack message coordinates', () => {
    upsertSlackDailyDigestMessage(db, {
      workspace: 'work',
      channel: '#reviews',
      repoFullName: 'octocat/hello-world',
      digestDate: '2026-01-02',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });

    const first = getSlackDailyDigestMessage(
      db,
      'work',
      '#reviews',
      'octocat/hello-world',
      '2026-01-02'
    );
    expect(first?.slack_channel).toBe('C123');
    expect(first?.slack_ts).toBe('1710000000.000100');

    upsertSlackDailyDigestMessage(db, {
      workspace: 'work',
      channel: '#reviews',
      repoFullName: 'octocat/hello-world',
      digestDate: '2026-01-02',
      slackChannel: 'C456',
      slackTs: '1710000001.000200',
    });

    const second = getSlackDailyDigestMessage(
      db,
      'work',
      '#reviews',
      'octocat/hello-world',
      '2026-01-02'
    );
    expect(second?.created_at).toBe(first?.created_at);
    expect(second?.slack_channel).toBe('C456');
    expect(second?.slack_ts).toBe('1710000001.000200');
  });

  test('retrieves the latest stored Slack message before a digest date', () => {
    upsertSlackDailyDigestMessage(db, {
      workspace: 'work',
      channel: '#reviews',
      repoFullName: 'octocat/hello-world',
      digestDate: '2026-01-01',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });
    upsertSlackDailyDigestMessage(db, {
      workspace: 'work',
      channel: '#reviews',
      repoFullName: 'octocat/hello-world',
      digestDate: '2026-01-03',
      slackChannel: 'C123',
      slackTs: '1710000002.000300',
    });
    upsertSlackDailyDigestMessage(db, {
      workspace: 'work',
      channel: '#reviews',
      repoFullName: 'octocat/hello-world',
      digestDate: '2026-01-02',
      slackChannel: 'C123',
      slackTs: '1710000001.000200',
    });

    const row = getLatestSlackDailyDigestMessageBeforeDate(
      db,
      'work',
      '#reviews',
      'octocat/hello-world',
      '2026-01-03'
    );

    expect(row?.digest_date).toBe('2026-01-02');
    expect(row?.slack_ts).toBe('1710000001.000200');
  });
});
