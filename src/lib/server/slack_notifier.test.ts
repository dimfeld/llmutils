import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import type { SlackPostSenderArgs } from '$common/slack/slack_client.js';
import { SLACK_PROJECT_SETTING_KEY } from '$common/slack/slack_project_setting.js';
import { getDefaultConfig, type TimConfig } from '$tim/configSchema.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';
import { upsertPrStatus, upsertPrReviewRequestByReviewer } from '$tim/db/pr_status.js';
import {
  getPendingReviewRequestNotifications,
  markReviewRequestsNotified,
} from '$tim/db/pr_review_request_notifications.js';
import {
  getSlackReviewRequestMessage,
  REVIEW_REQUEST_MESSAGE_RETENTION_MS,
  upsertSlackReviewRequestMessage,
} from '$tim/db/slack_review_request_message.js';
import { upsertUserMapping } from '$tim/db/slack_user_map.js';
import {
  runSlackNotifierOnce,
  shouldRunSlackNotifier,
  shouldStartSlackNotifier,
  startSlackNotifier,
} from './slack_notifier.js';

/** Fake Slack sender that records calls and returns ok:true by default. */
function makeFakeSender(
  overrideOk?: boolean,
  coordinates?: { channel?: string; ts?: string }
): {
  sender: (
    args: SlackPostSenderArgs
  ) => Promise<{ ok: boolean; error?: string; channel?: string; ts?: string }>;
  sent: SlackPostSenderArgs[];
} {
  const sent: SlackPostSenderArgs[] = [];
  const sender = async (args: SlackPostSenderArgs) => {
    sent.push(args);
    return { ok: overrideOk ?? true, ...coordinates };
  };
  return { sender, sent };
}

/** Build a TimConfig with one slack workspace using a literal token. */
function buildConfig(workspaceName = 'work', token = 'xoxb-test-token'): TimConfig {
  return {
    ...getDefaultConfig(),
    slack: {
      workspaces: {
        [workspaceName]: { token, reviewNotifier: { enabled: true } },
      },
    },
  };
}

/** Timestamp helpers to control debounce. */
function minsAgo(mins: number): string {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

function secsAgo(secs: number): string {
  return new Date(Date.now() - secs * 1000).toISOString();
}

/** Insert a pr_review_request with a custom requested_at directly via SQL. */
function insertReviewRequest(
  db: Database,
  prStatusId: number,
  reviewer: string,
  requestedAt: string
): number {
  const result = db
    .prepare(
      `INSERT INTO pr_review_request (pr_status_id, reviewer, requested_at, last_event_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(pr_status_id, reviewer) DO UPDATE SET
         requested_at = excluded.requested_at,
         last_event_at = excluded.last_event_at,
         request_version = pr_review_request.request_version + 1`
    )
    .run(prStatusId, reviewer, requestedAt, requestedAt);
  return Number(result.lastInsertRowid);
}

describe('lib/server/slack_notifier', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-notifier-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /** Set up a project and PR in the DB with Slack enabled. */
  function setupEnabledProject(
    owner = 'octocat',
    repo = 'hello-world',
    workspaceName = 'work',
    channel = '#reviews'
  ): { projectId: number; prStatusId: number } {
    const repositoryId = constructGitHubRepositoryId(owner, repo);
    const project = getOrCreateProject(db, repositoryId);
    setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
      enabled: true,
      workspace: workspaceName,
      channel,
    });

    const pr = upsertPrStatus(db, {
      prUrl: `https://github.com/${owner}/${repo}/pull/1`,
      owner,
      repo,
      prNumber: 1,
      author: 'author-login',
      title: 'Test PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
      additions: 42,
      deletions: 17,
      changedFiles: 3,
    });

    return { projectId: project.id, prStatusId: pr.status.id };
  }

  describe('shouldRunSlackNotifier', () => {
    test('returns false when no slack config', () => {
      const config = getDefaultConfig();
      expect(shouldRunSlackNotifier(config)).toBe(false);
    });

    test('returns false when slack.workspaces is empty', () => {
      const config: TimConfig = { ...getDefaultConfig(), slack: { workspaces: {} } };
      expect(shouldRunSlackNotifier(config)).toBe(false);
    });

    test('returns false when workspaces are configured without review notifier opt-in', () => {
      const config: TimConfig = {
        ...getDefaultConfig(),
        slack: { workspaces: { work: { token: 'xoxb-test-token' } } },
      };
      expect(shouldRunSlackNotifier(config)).toBe(false);
    });

    test('returns false when review notifier is explicitly disabled', () => {
      const config: TimConfig = {
        ...getDefaultConfig(),
        slack: {
          workspaces: {
            work: { token: 'xoxb-test-token', reviewNotifier: { enabled: false } },
          },
        },
      };
      expect(shouldRunSlackNotifier(config)).toBe(false);
    });

    test('returns true when at least one workspace opts in to review notifier', () => {
      expect(shouldRunSlackNotifier(buildConfig())).toBe(true);
    });
  });

  describe('startSlackNotifier', () => {
    test('returns null when no workspaces configured', () => {
      const handle = startSlackNotifier(db, getDefaultConfig());
      expect(handle).toBeNull();
    });

    test('returns null when workspaces do not opt in to review notifier', () => {
      const config: TimConfig = {
        ...getDefaultConfig(),
        slack: { workspaces: { work: { token: 'xoxb-test-token' } } },
      };
      const handle = startSlackNotifier(db, config);
      expect(handle).toBeNull();
    });

    test('returns a handle with stop() when workspaces configured', () => {
      const handle = startSlackNotifier(db, buildConfig(), { intervalMs: 999999 });
      try {
        expect(handle).not.toBeNull();
        expect(typeof handle!.stop).toBe('function');
        expect(typeof handle!.kick).toBe('function');
      } finally {
        handle?.stop();
      }
    });
  });

  describe('runSlackNotifierOnce', () => {
    test('batching: multiple reviewers on same PR coalesce into one message', async () => {
      const { prStatusId } = setupEnabledProject();
      const requestedAt = minsAgo(2);
      insertReviewRequest(db, prStatusId, 'reviewer-a', requestedAt);
      insertReviewRequest(db, prStatusId, 'reviewer-b', requestedAt);

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      const payload = sent[0].payload;
      expect(payload.channel).toBe('#reviews');
      const blockText = payload.blocks[0].text.text;
      expect(blockText).toContain('reviewer-a');
      expect(blockText).toContain('reviewer-b');
    });

    test('skips review requests for workspace without review notifier opt-in', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer-a', minsAgo(2));

      const config: TimConfig = {
        ...getDefaultConfig(),
        slack: { workspaces: { work: { token: 'xoxb-test-token' } } },
      };
      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, config, { sender, debounceMs: 0 });

      expect(sent).toHaveLength(0);
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);
    });

    test('passes cached PR change stats into the Slack message', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer-a', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      expect(sent[0].payload.blocks[0].text.text).toContain('*Changes:* 3 files (+42/-17)');
    });

    test('batching: both rows marked notified after single send', async () => {
      const { prStatusId } = setupEnabledProject();
      const requestedAt = minsAgo(2);
      insertReviewRequest(db, prStatusId, 'reviewer-a', requestedAt);
      insertReviewRequest(db, prStatusId, 'reviewer-b', requestedAt);

      const { sender } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      const pending = getPendingReviewRequestNotifications(db);
      expect(pending).toHaveLength(0);
    });

    test('debounce: does NOT send when still inside debounce window', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer-a', secsAgo(10));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 30_000 });

      expect(sent).toHaveLength(0);
      const pending = getPendingReviewRequestNotifications(db);
      expect(pending).toHaveLength(1);
    });

    test('cross-tick join: reviewer added within window joins next send after window expires', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer-a', secsAgo(15));

      const { sender: sender1, sent: sent1 } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender: sender1, debounceMs: 30_000 });
      expect(sent1).toHaveLength(0);

      insertReviewRequest(db, prStatusId, 'reviewer-b', secsAgo(5));

      const { sender: sender2, sent: sent2 } = makeFakeSender();
      const nowMs = Date.now() + 35_000;
      await runSlackNotifierOnce(db, buildConfig(), {
        sender: sender2,
        debounceMs: 30_000,
        nowMs,
      });

      expect(sent2).toHaveLength(1);
      const blockText = sent2[0].payload.blocks[0].text.text;
      expect(blockText).toContain('reviewer-a');
      expect(blockText).toContain('reviewer-b');
    });

    test('separate PRs get separate messages', async () => {
      const { prStatusId: pr1Id } = setupEnabledProject();

      const pr2 = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/2',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 2,
        author: 'author2',
        title: 'Second PR',
        state: 'open',
        draft: false,
        lastFetchedAt: new Date().toISOString(),
      });
      const pr2Id = pr2.status.id;

      const requestedAt = minsAgo(2);
      insertReviewRequest(db, pr1Id, 'reviewer-on-pr1', requestedAt);
      insertReviewRequest(db, pr2Id, 'reviewer-on-pr2', requestedAt);

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(2);
    });

    test('repo not enabled: no send, rows stay pending', async () => {
      const repositoryId = constructGitHubRepositoryId('octocat', 'disabled-repo');
      getOrCreateProject(db, repositoryId);
      const pr = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/disabled-repo/pull/1',
        owner: 'octocat',
        repo: 'disabled-repo',
        prNumber: 1,
        author: 'someone',
        title: 'PR in disabled repo',
        state: 'open',
        draft: false,
        lastFetchedAt: new Date().toISOString(),
      });
      insertReviewRequest(db, pr.status.id, 'reviewer', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(0);
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);
    });

    test('repo explicitly disabled: no send', async () => {
      const repositoryId = constructGitHubRepositoryId('octocat', 'hello-world');
      const project = getOrCreateProject(db, repositoryId);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: false,
        workspace: 'work',
        channel: '#reviews',
      });
      const pr = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/1',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 1,
        author: 'someone',
        title: 'PR',
        state: 'open',
        draft: false,
        lastFetchedAt: new Date().toISOString(),
      });
      insertReviewRequest(db, pr.status.id, 'reviewer', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(0);
    });

    test('mapped reviewer renders as <@SLACK_ID>, unmapped reviewer renders as github login', async () => {
      const { prStatusId } = setupEnabledProject();
      upsertUserMapping(db, {
        workspace: 'work',
        githubLogin: 'mapped-user',
        slackUserId: 'U12345',
      });

      const requestedAt = minsAgo(2);
      insertReviewRequest(db, prStatusId, 'mapped-user', requestedAt);
      insertReviewRequest(db, prStatusId, 'unmapped-user', requestedAt);

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      const blockText = sent[0].payload.blocks[0].text.text;
      expect(blockText).toContain('<@U12345>');
      expect(blockText).toContain('`unmapped-user`');
    });

    test('unmapped reviewer: message still sent', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'unmapped-reviewer', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      expect(sent[0].payload.blocks[0].text.text).toContain('`unmapped-reviewer`');
    });

    test('no double-notify across simulated restart: second run sends nothing', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer', minsAgo(2));

      const { sender: sender1, sent: sent1 } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender: sender1, debounceMs: 0 });
      expect(sent1).toHaveLength(1);

      // Simulate restart: second run over same DB state
      const { sender: sender2, sent: sent2 } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender: sender2, debounceMs: 0 });
      expect(sent2).toHaveLength(0);
    });

    test('marks old pending review requests as notified without sending when side-effect cutoff is set', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'old-reviewer', '2026-01-01T10:00:00.000Z');
      insertReviewRequest(db, prStatusId, 'new-reviewer', '2026-01-01T12:00:00.000Z');

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(
        db,
        {
          ...buildConfig(),
          githubWebhooks: { ignoreSideEffectsBefore: '2026-01-01T11:00:00.000Z' },
        },
        {
          sender,
          debounceMs: 0,
          nowMs: Date.parse('2026-01-01T12:01:00.000Z'),
        }
      );

      expect(sent).toHaveLength(1);
      expect(sent[0].payload.text).toContain('new-reviewer');
      expect(sent[0].payload.text).not.toContain('old-reviewer');
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);
    });

    test('failure path: notified_at stays null so row is eligible for retry', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer', minsAgo(2));

      const { sender } = makeFakeSender(false); // returns ok: false
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      const pending = getPendingReviewRequestNotifications(db);
      expect(pending).toHaveLength(1);
      expect(pending[0].reviewer).toBe('reviewer');
    });

    test('workspace undefined/misconfigured: no send, notified_at stays null', async () => {
      const { prStatusId } = setupEnabledProject('octocat', 'hello-world', 'work');
      insertReviewRequest(db, prStatusId, 'reviewer', minsAgo(2));

      // Config has no workspaces defined — resolveSlackWorkspaceToken will throw
      const emptyConfig: TimConfig = { ...getDefaultConfig() };
      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, emptyConfig, { sender, debounceMs: 0 });

      expect(sent).toHaveLength(0);
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);
    });

    test('workspace defined but token is empty: no send, notified_at stays null', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'reviewer', minsAgo(2));

      const configWithBadToken: TimConfig = {
        ...getDefaultConfig(),
        slack: { workspaces: { work: { token: '' } } },
      };
      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, configWithBadToken, { sender, debounceMs: 0 });

      expect(sent).toHaveLength(0);
      expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);
    });

    test('message payload includes PR title, author, url, and channel', async () => {
      const repositoryId = constructGitHubRepositoryId('acme', 'core');
      const project = getOrCreateProject(db, repositoryId);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        workspace: 'work',
        channel: '#engineering',
      });
      const pr = upsertPrStatus(db, {
        prUrl: 'https://github.com/acme/core/pull/42',
        owner: 'acme',
        repo: 'core',
        prNumber: 42,
        author: 'engineer-x',
        title: 'My feature branch',
        state: 'open',
        draft: false,
        lastFetchedAt: new Date().toISOString(),
      });
      insertReviewRequest(db, pr.status.id, 'reviewer-z', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      const payload = sent[0].payload;
      expect(payload.channel).toBe('#engineering');
      const text = payload.blocks[0].text.text;
      expect(text).toContain('My feature branch');
      expect(text).toContain('engineer-x');
      expect(text).toContain('https://linear.review/acme/core/pull/42');
    });

    test('no pending rows: nothing sent', async () => {
      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });
      expect(sent).toHaveLength(0);
    });

    test('re-request after removal and notification: notifier sends again', async () => {
      const { prStatusId } = setupEnabledProject();
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: minsAgo(5),
      });

      // First send: notifies alice
      const { sender: s1, sent: sent1 } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender: s1, debounceMs: 0 });
      expect(sent1).toHaveLength(1);
      expect(sent1[0].payload.blocks[0].text.text).toContain('alice');

      // Remove the review request
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'removed',
        eventAt: minsAgo(4),
      });

      // Re-request: this should clear notified_at and removed_at
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: minsAgo(1),
      });

      // Second send: should send again for alice
      const { sender: s2, sent: sent2 } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender: s2, debounceMs: 0 });
      expect(sent2).toHaveLength(1);
      expect(sent2[0].payload.blocks[0].text.text).toContain('alice');
    });

    test('mixed new and re-requested reviewers are annotated in the message', async () => {
      const { prStatusId } = setupEnabledProject();
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: '2026-01-01T10:00:00.000Z',
      });

      const { sender: firstSender, sent: firstSent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), {
        sender: firstSender,
        debounceMs: 0,
        nowMs: Date.parse('2026-01-01T10:01:00.000Z'),
      });
      expect(firstSent).toHaveLength(1);

      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'alice',
        action: 'requested',
        eventAt: '2026-01-01T10:02:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, prStatusId, {
        reviewer: 'bob',
        action: 'requested',
        eventAt: '2026-01-01T10:02:00.000Z',
      });

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), {
        sender,
        debounceMs: 0,
        nowMs: Date.parse('2026-01-01T10:03:00.000Z'),
      });

      expect(sent).toHaveLength(1);
      const blockText = sent[0].payload.blocks[0].text.text;
      expect(blockText).toContain('*Review Requested:*');
      expect(blockText).toContain('`alice` (re-request)');
      expect(blockText).toContain('`bob` (new)');
    });

    test('all-new reviewers are not annotated in the message', async () => {
      const { prStatusId } = setupEnabledProject();
      insertReviewRequest(db, prStatusId, 'alice', minsAgo(2));
      insertReviewRequest(db, prStatusId, 'bob', minsAgo(2));

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

      expect(sent).toHaveLength(1);
      const blockText = sent[0].payload.blocks[0].text.text;
      expect(blockText).toContain('*Review Requested:*');
      expect(blockText).toContain('`alice`, `bob`');
      expect(blockText).not.toContain('(new)');
    });

    test('all re-requested reviewers use the re-request title', async () => {
      const { prStatusId } = setupEnabledProject();
      for (const reviewer of ['alice', 'bob']) {
        upsertPrReviewRequestByReviewer(db, prStatusId, {
          reviewer,
          action: 'requested',
          eventAt: '2026-01-01T10:00:00.000Z',
        });
      }

      const { sender: firstSender, sent: firstSent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), {
        sender: firstSender,
        debounceMs: 0,
        nowMs: Date.parse('2026-01-01T10:01:00.000Z'),
      });
      expect(firstSent).toHaveLength(1);

      for (const reviewer of ['alice', 'bob']) {
        upsertPrReviewRequestByReviewer(db, prStatusId, {
          reviewer,
          action: 'requested',
          eventAt: '2026-01-01T10:02:00.000Z',
        });
      }

      const { sender, sent } = makeFakeSender();
      await runSlackNotifierOnce(db, buildConfig(), {
        sender,
        debounceMs: 0,
        nowMs: Date.parse('2026-01-01T10:03:00.000Z'),
      });

      expect(sent).toHaveLength(1);
      const blockText = sent[0].payload.blocks[0].text.text;
      expect(blockText).toContain('*Review Re-Requested:*');
      expect(blockText).toContain('`alice` (re-request)');
      expect(blockText).toContain('`bob` (re-request)');
    });

    test('misconfigured workspace is logged only once per workspace name', async () => {
      const { prStatusId } = setupEnabledProject('octocat', 'hello-world', 'work');
      insertReviewRequest(db, prStatusId, 'reviewer', minsAgo(2));

      // Also add a second PR so we can confirm the second call within the same workspace is suppressed
      const pr2 = upsertPrStatus(db, {
        prUrl: 'https://github.com/octocat/hello-world/pull/2',
        owner: 'octocat',
        repo: 'hello-world',
        prNumber: 2,
        author: 'author2',
        title: 'Another PR',
        state: 'open',
        draft: false,
        lastFetchedAt: new Date().toISOString(),
      });
      insertReviewRequest(db, pr2.status.id, 'reviewer2', minsAgo(2));

      const loggedSet = new Set<string>();
      const errorMessages: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errorMessages.push(String(args[0]));
      };
      try {
        // Config has no workspaces defined — triggers loud error
        const emptyConfig: TimConfig = { ...getDefaultConfig() };
        await runSlackNotifierOnce(db, emptyConfig, {
          sender: makeFakeSender().sender,
          debounceMs: 0,
          loggedMisconfiguredWorkspaces: loggedSet,
        });
        // Run again — same workspace should not log again
        await runSlackNotifierOnce(db, emptyConfig, {
          sender: makeFakeSender().sender,
          debounceMs: 0,
          loggedMisconfiguredWorkspaces: loggedSet,
        });
      } finally {
        console.error = originalError;
      }

      const workspaceErrors = errorMessages.filter((m) => m.includes('work'));
      // Should log exactly once, not twice (two PRs + two runs would be 4 without dedup)
      expect(workspaceErrors).toHaveLength(1);
      expect(loggedSet.has('work')).toBe(true);
    });
    describe('review-request message tracking', () => {
      test('successful post stores the latest message coordinates for the PR', async () => {
        const { prStatusId } = setupEnabledProject();
        insertReviewRequest(db, prStatusId, 'alice', minsAgo(2));

        const { sender } = makeFakeSender(true, { channel: 'C123', ts: '1710000000.000100' });
        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

        const tracked = getSlackReviewRequestMessage(db, prStatusId);
        expect(tracked?.workspace).toBe('work');
        expect(tracked?.slack_channel).toBe('C123');
        expect(tracked?.slack_ts).toBe('1710000000.000100');
      });

      test('a later post for the same PR replaces the tracked message', async () => {
        const { prStatusId } = setupEnabledProject();
        insertReviewRequest(db, prStatusId, 'alice', minsAgo(5));

        const { sender: firstSender } = makeFakeSender(true, {
          channel: 'C123',
          ts: '1710000000.000100',
        });
        await runSlackNotifierOnce(db, buildConfig(), { sender: firstSender, debounceMs: 0 });

        upsertPrReviewRequestByReviewer(db, prStatusId, {
          reviewer: 'alice',
          action: 'requested',
          eventAt: minsAgo(1),
        });

        const { sender: secondSender } = makeFakeSender(true, {
          channel: 'C123',
          ts: '1710000099.000900',
        });
        await runSlackNotifierOnce(db, buildConfig(), { sender: secondSender, debounceMs: 0 });

        const tracked = getSlackReviewRequestMessage(db, prStatusId);
        expect(tracked?.slack_ts).toBe('1710000099.000900');
        const count = db
          .prepare('SELECT COUNT(*) AS count FROM slack_review_request_message')
          .get() as { count: number };
        expect(count.count).toBe(1);
      });

      test('post without channel/ts coordinates does not store a tracking row', async () => {
        const { prStatusId } = setupEnabledProject();
        insertReviewRequest(db, prStatusId, 'alice', minsAgo(2));

        const { sender, sent } = makeFakeSender();
        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

        expect(sent).toHaveLength(1);
        expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
      });

      test('failed post does not store a tracking row', async () => {
        const { prStatusId } = setupEnabledProject();
        insertReviewRequest(db, prStatusId, 'alice', minsAgo(2));

        const { sender } = makeFakeSender(false, { channel: 'C123', ts: '1710000000.000100' });
        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

        expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
      });

      test('messages older than two weeks are pruned on each run', async () => {
        const { prStatusId } = setupEnabledProject();
        upsertSlackReviewRequestMessage(db, {
          prStatusId,
          workspace: 'work',
          slackChannel: 'C123',
          slackTs: '1710000000.000100',
        });

        const nowMs = Date.now();
        const oldPostedAt = new Date(
          nowMs - REVIEW_REQUEST_MESSAGE_RETENTION_MS - 60_000
        ).toISOString();
        db.prepare('UPDATE slack_review_request_message SET posted_at = ?').run(oldPostedAt);

        const { sender } = makeFakeSender();
        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0, nowMs });

        expect(getSlackReviewRequestMessage(db, prStatusId)).toBeUndefined();
      });

      test('messages newer than two weeks survive the prune', async () => {
        const { prStatusId } = setupEnabledProject();
        upsertSlackReviewRequestMessage(db, {
          prStatusId,
          workspace: 'work',
          slackChannel: 'C123',
          slackTs: '1710000000.000100',
        });

        const { sender } = makeFakeSender();
        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 0 });

        expect(getSlackReviewRequestMessage(db, prStatusId)).toBeDefined();
      });
    });

    describe('send-in-flight race: remove + re-request during Slack await', () => {
      test('markReviewRequestsNotified with stale request_version is a no-op', () => {
        const { prStatusId } = setupEnabledProject();
        const T1 = '2026-01-01T10:00:00.000Z';
        insertReviewRequest(db, prStatusId, 'alice', T1);

        const pending = getPendingReviewRequestNotifications(db);
        const aliceRow = pending.find((r) => r.reviewer === 'alice')!;
        expect(aliceRow.last_event_at).toBe(T1);
        expect(aliceRow.request_version).toBe(0);

        // Bump request_version (simulates an accepted concurrent lifecycle transition)
        db.prepare(
          `UPDATE pr_review_request SET request_version = request_version + 1 WHERE id = ?`
        ).run(aliceRow.id);

        // Now try to mark with the OLD (stale) request_version — must be a no-op
        markReviewRequestsNotified(db, [
          { id: aliceRow.id, request_version: aliceRow.request_version },
        ]);
        const afterStale = getPendingReviewRequestNotifications(db);
        expect(afterStale).toHaveLength(1); // still pending

        // Marking with the CURRENT request_version should set notified_at
        markReviewRequestsNotified(db, [
          { id: aliceRow.id, request_version: aliceRow.request_version + 1 },
        ]);
        const afterCorrect = getPendingReviewRequestNotifications(db);
        expect(afterCorrect).toHaveLength(0); // now marked
      });

      test('completing original send does NOT mark row when re-requested during in-flight send', async () => {
        const { prStatusId } = setupEnabledProject();
        const T1 = '2026-01-01T10:00:00.000Z';
        const T2 = '2026-01-01T10:00:01.000Z';
        const T3 = '2026-01-01T10:00:02.000Z';
        insertReviewRequest(db, prStatusId, 'alice', T1);

        // nowMs is well past the 30s debounce window relative to T1
        const nowMs = new Date('2026-01-01T10:01:00.000Z').getTime();

        // Sender mutates the DB before resolving (simulates concurrent webhook ingest)
        const sender = async (_args: SlackPostSenderArgs) => {
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'removed',
            eventAt: T2,
          });
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'requested',
            eventAt: T3,
          });
          return { ok: true };
        };

        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 30_000, nowMs });

        // The completing send used request_version = 0, but the row version has advanced — mark must be a no-op
        const afterRace = getPendingReviewRequestNotifications(db);
        expect(afterRace).toHaveLength(1);
        expect(afterRace[0].reviewer).toBe('alice');
        // notified_at must still be null (confirmed by the row appearing in pending results)
      });

      test('second tick after re-request race sends again and marks notified', async () => {
        const { prStatusId } = setupEnabledProject();
        const T1 = '2026-01-01T10:00:00.000Z';
        const T2 = '2026-01-01T10:00:01.000Z';
        const T3 = '2026-01-01T10:00:02.000Z';
        insertReviewRequest(db, prStatusId, 'alice', T1);

        const nowMs1 = new Date('2026-01-01T10:01:00.000Z').getTime();
        let senderCallCount = 0;

        // First tick: sender mutates DB during in-flight send
        const sender1 = async (_args: SlackPostSenderArgs) => {
          senderCallCount++;
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'removed',
            eventAt: T2,
          });
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'requested',
            eventAt: T3,
          });
          return { ok: true };
        };
        await runSlackNotifierOnce(db, buildConfig(), {
          sender: sender1,
          debounceMs: 30_000,
          nowMs: nowMs1,
        });
        expect(senderCallCount).toBe(1); // did attempt to send

        // Row should still be pending after the race
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);

        // Second tick: no concurrent mutation, nowMs past debounce window relative to T3
        const nowMs2 = new Date('2026-01-01T10:02:00.000Z').getTime();
        const { sender: sender2, sent: sent2 } = makeFakeSender();
        await runSlackNotifierOnce(db, buildConfig(), {
          sender: sender2,
          debounceMs: 30_000,
          nowMs: nowMs2,
        });

        // Should send alice again and mark her notified
        expect(sent2).toHaveLength(1);
        expect(sent2[0].payload.blocks[0].text.text).toContain('alice');
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);
      });

      test('upsertPrReviewRequestByReviewer increments request_version on each same-timestamp transition', () => {
        const { prStatusId } = setupEnabledProject();
        const T = '2026-01-01T10:00:00.000Z';

        // Initial insert via the low-level helper used by other tests; request_version = 0
        insertReviewRequest(db, prStatusId, 'alice', T);

        const row0 = db
          .prepare(
            `SELECT request_version FROM pr_review_request WHERE pr_status_id = ? AND reviewer = 'alice'`
          )
          .get(prStatusId) as { request_version: number };
        expect(row0.request_version).toBe(0);

        // same-timestamp remove → version bumps to 1
        upsertPrReviewRequestByReviewer(db, prStatusId, {
          reviewer: 'alice',
          action: 'removed',
          eventAt: T,
        });
        const row1 = db
          .prepare(
            `SELECT request_version FROM pr_review_request WHERE pr_status_id = ? AND reviewer = 'alice'`
          )
          .get(prStatusId) as { request_version: number };
        expect(row1.request_version).toBe(1);

        // same-timestamp re-request → version bumps to 2
        upsertPrReviewRequestByReviewer(db, prStatusId, {
          reviewer: 'alice',
          action: 'requested',
          eventAt: T,
        });
        const row2 = db
          .prepare(
            `SELECT request_version FROM pr_review_request WHERE pr_status_id = ? AND reviewer = 'alice'`
          )
          .get(prStatusId) as { request_version: number };
        expect(row2.request_version).toBe(2);

        // stale mark (version 0) must be a no-op; row stays pending
        markReviewRequestsNotified(db, [
          {
            id: getPendingReviewRequestNotifications(db).find((r) => r.reviewer === 'alice')!.id,
            request_version: 0,
          },
        ]);
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);

        // correct mark (version 2) must mark notified
        const aliceRow = getPendingReviewRequestNotifications(db).find(
          (r) => r.reviewer === 'alice'
        )!;
        markReviewRequestsNotified(db, [{ id: aliceRow.id, request_version: 2 }]);
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);
      });

      test('same-timestamp remove + re-request during in-flight send: row stays pending', async () => {
        const { prStatusId } = setupEnabledProject();
        const T = '2026-01-01T10:00:00.000Z';

        // Insert alice at T; request_version = 0
        insertReviewRequest(db, prStatusId, 'alice', T);
        const initialPending = getPendingReviewRequestNotifications(db);
        const aliceInitial = initialPending.find((r) => r.reviewer === 'alice')!;
        expect(aliceInitial.request_version).toBe(0);

        const nowMs = new Date('2026-01-01T10:01:00.000Z').getTime();

        // Sender mutates the DB with SAME timestamp T before resolving
        const sender = async (_args: SlackPostSenderArgs) => {
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'removed',
            eventAt: T,
          });
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'requested',
            eventAt: T,
          });
          return { ok: true as const };
        };

        await runSlackNotifierOnce(db, buildConfig(), { sender, debounceMs: 30_000, nowMs });

        // The mark used request_version = 0 but row is now at version 2 → no-op
        const afterRace = getPendingReviewRequestNotifications(db);
        expect(afterRace).toHaveLength(1);
        expect(afterRace[0].reviewer).toBe('alice');
        // notified_at must be null (row is in pending results)
      });

      test('second tick after same-timestamp race sends alice and marks notified', async () => {
        const { prStatusId } = setupEnabledProject();
        const T = '2026-01-01T10:00:00.000Z';

        insertReviewRequest(db, prStatusId, 'alice', T);
        const nowMs1 = new Date('2026-01-01T10:01:00.000Z').getTime();
        let senderCallCount = 0;

        // First tick: concurrent same-timestamp mutation during send
        const sender1 = async (_args: SlackPostSenderArgs) => {
          senderCallCount++;
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'removed',
            eventAt: T,
          });
          upsertPrReviewRequestByReviewer(db, prStatusId, {
            reviewer: 'alice',
            action: 'requested',
            eventAt: T,
          });
          return { ok: true as const };
        };
        await runSlackNotifierOnce(db, buildConfig(), {
          sender: sender1,
          debounceMs: 30_000,
          nowMs: nowMs1,
        });
        expect(senderCallCount).toBe(1);

        // Row is still pending after the race
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(1);

        // Second tick: no concurrent mutation, nowMs past debounce relative to T
        const nowMs2 = new Date('2026-01-01T10:02:00.000Z').getTime();
        const { sender: sender2, sent: sent2 } = makeFakeSender();
        await runSlackNotifierOnce(db, buildConfig(), {
          sender: sender2,
          debounceMs: 30_000,
          nowMs: nowMs2,
        });

        expect(sent2).toHaveLength(1);
        expect(sent2[0].payload.blocks[0].text.text).toContain('alice');
        expect(getPendingReviewRequestNotifications(db)).toHaveLength(0);
      });
    });

    test('nowMs option controls debounce evaluation', async () => {
      const { prStatusId } = setupEnabledProject();
      const requestedAt = new Date('2026-01-01T10:00:00.000Z').getTime();
      insertReviewRequest(db, prStatusId, 'reviewer', new Date(requestedAt).toISOString());

      const { sender: sender1, sent: sent1 } = makeFakeSender();
      // 10s after request — inside 30s window
      await runSlackNotifierOnce(db, buildConfig(), {
        sender: sender1,
        debounceMs: 30_000,
        nowMs: requestedAt + 10_000,
      });
      expect(sent1).toHaveLength(0);

      const { sender: sender2, sent: sent2 } = makeFakeSender();
      // 31s after request — outside 30s window
      await runSlackNotifierOnce(db, buildConfig(), {
        sender: sender2,
        debounceMs: 30_000,
        nowMs: requestedAt + 31_000,
      });
      expect(sent2).toHaveLength(1);
    });
  }); // end runSlackNotifierOnce

  describe('shouldStartSlackNotifier', () => {
    const POLL_INTERVAL_KEY = 'TIM_WEBHOOK_POLL_INTERVAL';
    const SERVER_URL_KEY = 'TIM_WEBHOOK_SERVER_URL';
    const API_TOKEN_KEY = 'WEBHOOK_INTERNAL_API_TOKEN';

    let origPollInterval: string | undefined;
    let origServerUrl: string | undefined;
    let origApiToken: string | undefined;

    beforeEach(() => {
      origPollInterval = process.env[POLL_INTERVAL_KEY];
      origServerUrl = process.env[SERVER_URL_KEY];
      origApiToken = process.env[API_TOKEN_KEY];
    });

    afterEach(() => {
      if (origPollInterval === undefined) {
        delete process.env[POLL_INTERVAL_KEY];
      } else {
        process.env[POLL_INTERVAL_KEY] = origPollInterval;
      }
      if (origServerUrl === undefined) {
        delete process.env[SERVER_URL_KEY];
      } else {
        process.env[SERVER_URL_KEY] = origServerUrl;
      }
      if (origApiToken === undefined) {
        delete process.env[API_TOKEN_KEY];
      } else {
        process.env[API_TOKEN_KEY] = origApiToken;
      }
    });

    test('returns false when webhook polling env vars are not set (even with slack workspace)', () => {
      delete process.env[POLL_INTERVAL_KEY];
      delete process.env[SERVER_URL_KEY];
      delete process.env[API_TOKEN_KEY];
      expect(shouldStartSlackNotifier(buildConfig())).toBe(false);
    });

    test('returns true when all webhook polling env vars are set AND slack workspace configured', () => {
      process.env[POLL_INTERVAL_KEY] = '30';
      process.env[SERVER_URL_KEY] = 'http://localhost:8080';
      process.env[API_TOKEN_KEY] = 'test-token';
      expect(shouldStartSlackNotifier(buildConfig())).toBe(true);
    });

    test('returns false when webhook polling is enabled but no slack workspace configured', () => {
      process.env[POLL_INTERVAL_KEY] = '30';
      process.env[SERVER_URL_KEY] = 'http://localhost:8080';
      process.env[API_TOKEN_KEY] = 'test-token';
      expect(shouldStartSlackNotifier(getDefaultConfig())).toBe(false);
    });

    test('returns false when only some webhook polling env vars are set', () => {
      process.env[POLL_INTERVAL_KEY] = '30';
      process.env[SERVER_URL_KEY] = 'http://localhost:8080';
      delete process.env[API_TOKEN_KEY];
      expect(shouldStartSlackNotifier(buildConfig())).toBe(false);
    });
  });
});
