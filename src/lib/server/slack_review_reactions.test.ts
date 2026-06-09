import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { SubmittedPrReview } from '$common/github/webhook_ingest.js';
import type { SlackReactionSenderArgs } from '$common/slack/slack_client.js';
import { getDefaultConfig, type TimConfig } from '$tim/configSchema.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPrStatus } from '$tim/db/pr_status.js';
import {
  REVIEW_REQUEST_MESSAGE_RETENTION_MS,
  upsertSlackReviewRequestMessage,
} from '$tim/db/slack_review_request_message.js';
import { upsertUserMapping } from '$tim/db/slack_user_map.js';
import { processSlackReviewReactions, REVIEW_STATE_REACTIONS } from './slack_review_reactions.js';

function buildConfig(): TimConfig {
  return {
    ...getDefaultConfig(),
    slack: {
      workspaces: {
        work: { token: 'xoxb-test-token', reviewNotifier: { enabled: true } },
      },
    },
  };
}

function makeFakeReactionSender(overrideOk?: boolean): {
  sender: (args: SlackReactionSenderArgs) => Promise<{ ok: boolean; error?: string }>;
  sent: SlackReactionSenderArgs[];
} {
  const sent: SlackReactionSenderArgs[] = [];
  const sender = async (args: SlackReactionSenderArgs) => {
    sent.push(args);
    return overrideOk === false
      ? { ok: false, error: 'message_not_found' }
      : { ok: true, channel: args.channel, ts: args.ts };
  };
  return { sender, sent };
}

function buildReview(overrides: Partial<SubmittedPrReview> = {}): SubmittedPrReview {
  return {
    owner: 'octocat',
    repo: 'hello-world',
    prNumber: 1,
    prUrl: 'https://github.com/octocat/hello-world/pull/1',
    author: 'reviewer-1',
    authorType: 'User',
    state: 'APPROVED',
    submittedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('lib/server/slack_review_reactions', () => {
  let tempDir: string;
  let db: Database;
  let prStatusId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-review-reactions-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));

    const pr = upsertPrStatus(db, {
      prUrl: 'https://github.com/octocat/hello-world/pull/1',
      owner: 'octocat',
      repo: 'hello-world',
      prNumber: 1,
      author: 'author-login',
      title: 'Test PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    prStatusId = pr.status.id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function trackMessage(): void {
    upsertSlackReviewRequestMessage(db, {
      prStatusId,
      workspace: 'work',
      slackChannel: 'C123',
      slackTs: '1710000000.000100',
    });
  }

  test('adds the matching emoji per review state to the tracked message', async () => {
    trackMessage();

    for (const [state, emoji] of Object.entries(REVIEW_STATE_REACTIONS)) {
      const { sender, sent } = makeFakeReactionSender();
      await processSlackReviewReactions(db, [buildReview({ state })], {
        config: buildConfig(),
        sender,
      });

      expect(sent).toEqual([
        {
          token: 'xoxb-test-token',
          channel: 'C123',
          ts: '1710000000.000100',
          name: emoji,
        },
      ]);
    }
  });

  test('uses the expected emoji names', () => {
    expect(REVIEW_STATE_REACTIONS).toEqual({
      APPROVED: 'white_check_mark',
      COMMENTED: 'speech_balloon',
      CHANGES_REQUESTED: 'arrows_counterclockwise',
    });
  });

  test('skips reviews from bot authors', async () => {
    trackMessage();

    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(
      db,
      [
        buildReview({ author: 'dependabot', authorType: 'Bot' }),
        buildReview({ author: 'github-actions[bot]', authorType: null }),
      ],
      { config: buildConfig(), sender }
    );

    expect(sent).toHaveLength(0);
  });

  test('falls back to the user mapping when the author account type is unknown', async () => {
    trackMessage();
    upsertUserMapping(db, {
      workspace: 'work',
      githubLogin: 'mapped-reviewer',
      slackUserId: 'U123',
    });

    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(
      db,
      [
        buildReview({ author: 'mapped-reviewer', authorType: null }),
        buildReview({ author: 'unmapped-reviewer', authorType: null, state: 'COMMENTED' }),
      ],
      { config: buildConfig(), sender }
    );

    expect(sent).toEqual([expect.objectContaining({ name: 'white_check_mark' })]);
  });

  test('does nothing when the PR has no tracked message', async () => {
    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(db, [buildReview()], { config: buildConfig(), sender });

    expect(sent).toHaveLength(0);
  });

  test('does nothing for unknown PRs', async () => {
    trackMessage();

    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(
      db,
      [buildReview({ prNumber: 99, prUrl: 'https://github.com/octocat/hello-world/pull/99' })],
      { config: buildConfig(), sender }
    );

    expect(sent).toHaveLength(0);
  });

  test('ignores review states without a configured reaction', async () => {
    trackMessage();

    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(db, [buildReview({ state: 'DISMISSED' })], {
      config: buildConfig(),
      sender,
    });

    expect(sent).toHaveLength(0);
  });

  test('skips tracked messages older than the retention window', async () => {
    trackMessage();
    const nowMs = Date.now();
    db.prepare('UPDATE slack_review_request_message SET posted_at = ?').run(
      new Date(nowMs - REVIEW_REQUEST_MESSAGE_RETENTION_MS - 60_000).toISOString()
    );

    const { sender, sent } = makeFakeReactionSender();
    await processSlackReviewReactions(db, [buildReview()], {
      config: buildConfig(),
      sender,
      nowMs,
    });

    expect(sent).toHaveLength(0);
  });

  test('a Slack failure for one review does not block the others', async () => {
    trackMessage();

    const sent: SlackReactionSenderArgs[] = [];
    const sender = async (args: SlackReactionSenderArgs) => {
      sent.push(args);
      return sent.length === 1
        ? { ok: false, error: 'message_not_found' }
        : { ok: true, channel: args.channel, ts: args.ts };
    };

    await processSlackReviewReactions(
      db,
      [
        buildReview({ author: 'reviewer-1', state: 'APPROVED' }),
        buildReview({ author: 'reviewer-2', state: 'COMMENTED' }),
      ],
      { config: buildConfig(), sender }
    );

    expect(sent).toHaveLength(2);
    expect(sent[1].name).toBe('speech_balloon');
  });

  test('a misconfigured workspace does not throw or block other reviews', async () => {
    trackMessage();

    // Config without the tracked workspace: addSlackReaction throws on token resolution.
    const config: TimConfig = { ...getDefaultConfig() };
    const { sender, sent } = makeFakeReactionSender();

    await expect(
      processSlackReviewReactions(db, [buildReview()], { config, sender })
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});
