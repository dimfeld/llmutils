import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import type { SlackPostSenderArgs } from '$common/slack/slack_client.js';
import { SLACK_PROJECT_SETTING_KEY } from '$common/slack/slack_project_setting.js';
import { getDefaultConfig, type TimConfig } from '$tim/configSchema.js';
import { openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';
import { upsertPrReviewRequestByReviewer, upsertPrStatus } from '$tim/db/pr_status.js';

import {
  runAllDailyDigests,
  runDailyDigestForWorkspace,
  shouldStartDailyDigest,
  startDailyDigestScheduler,
} from './daily_digest.js';

type UpsertPrStatusResult = ReturnType<typeof upsertPrStatus>;

interface FakeSender {
  sender: (args: SlackPostSenderArgs) => Promise<{ ok: boolean; error?: string }>;
  sent: SlackPostSenderArgs[];
}

function makeFakeSender(): FakeSender {
  const sent: SlackPostSenderArgs[] = [];
  return {
    sent,
    sender: async (args: SlackPostSenderArgs): Promise<{ ok: boolean }> => {
      sent.push(args);
      return { ok: true };
    },
  };
}

function buildConfig(
  workspaces: NonNullable<TimConfig['slack']>['workspaces'] = {
    work: {
      token: 'xoxb-work-token',
      dailyDigest: { staleAfterHours: 24 },
    },
  }
): TimConfig {
  return {
    ...getDefaultConfig(),
    slack: { workspaces },
  };
}

function payloadText(args: SlackPostSenderArgs): string {
  return JSON.stringify(args.payload.blocks);
}

describe('lib/server/daily_digest', () => {
  let db: Database;
  let originalInfo: typeof console.info;
  let originalWebhookPollInterval: string | undefined;
  let originalWebhookServerUrl: string | undefined;
  let originalWebhookInternalApiToken: string | undefined;

  beforeEach(() => {
    db = openDatabase(':memory:');
    originalInfo = console.info;
    console.info = (): void => {};
    originalWebhookPollInterval = process.env.TIM_WEBHOOK_POLL_INTERVAL;
    originalWebhookServerUrl = process.env.TIM_WEBHOOK_SERVER_URL;
    originalWebhookInternalApiToken = process.env.WEBHOOK_INTERNAL_API_TOKEN;
    delete process.env.TIM_WEBHOOK_POLL_INTERVAL;
    delete process.env.TIM_WEBHOOK_SERVER_URL;
    delete process.env.WEBHOOK_INTERNAL_API_TOKEN;
  });

  afterEach(() => {
    console.info = originalInfo;
    restoreEnv('TIM_WEBHOOK_POLL_INTERVAL', originalWebhookPollInterval);
    restoreEnv('TIM_WEBHOOK_SERVER_URL', originalWebhookServerUrl);
    restoreEnv('WEBHOOK_INTERNAL_API_TOKEN', originalWebhookInternalApiToken);
    db.close(false);
  });

  function setupProject(
    owner: string,
    repo: string,
    options: {
      enabled?: boolean;
      dailyDigest?: boolean;
      workspace?: string;
      channel?: string;
      omitChannel?: boolean;
    } = {}
  ): number {
    const project = getOrCreateProject(db, constructGitHubRepositoryId(owner, repo));
    setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
      enabled: options.enabled ?? true,
      dailyDigest: options.dailyDigest ?? true,
      workspace: options.workspace ?? 'work',
      ...(options.omitChannel === true ? {} : { channel: options.channel ?? '#reviews' }),
    });
    return project.id;
  }

  function setupInvalidRepositoryProject(options: {
    workspace?: string;
    channel?: string;
    dailyDigest?: boolean;
  }): void {
    const project = getOrCreateProject(db, 'not-a-github-repository-id');
    setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
      enabled: true,
      dailyDigest: options.dailyDigest ?? true,
      workspace: options.workspace ?? 'work',
      channel: options.channel ?? '#invalid',
    });
  }

  function insertPr(
    owner: string,
    repo: string,
    prNumber: number,
    options: {
      title?: string;
      author?: string;
      state?: string;
      draft?: boolean;
      reviewDecision?: string | null;
      readyAt?: string | null;
    } = {}
  ): UpsertPrStatusResult {
    return upsertPrStatus(db, {
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      owner,
      repo,
      prNumber,
      author: options.author ?? `author-${prNumber}`,
      title: options.title ?? `PR ${prNumber}`,
      state: options.state ?? 'open',
      draft: options.draft ?? false,
      reviewDecision: options.reviewDecision ?? null,
      readyAt: options.readyAt,
      lastFetchedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  function requestReview(prStatusId: number, reviewer: string, requestedAt: string): void {
    upsertPrReviewRequestByReviewer(db, prStatusId, {
      reviewer,
      action: 'requested',
      eventAt: requestedAt,
    });
  }

  function enableWebhookPollingEnv(): void {
    process.env.TIM_WEBHOOK_POLL_INTERVAL = '30';
    process.env.TIM_WEBHOOK_SERVER_URL = 'https://webhooks.example.com';
    process.env.WEBHOOK_INTERNAL_API_TOKEN = 'test-token';
  }

  test('posts one digest for a qualifying project to its configured channel', async () => {
    setupProject('octocat', 'hello-world', { channel: '#team-a' });
    insertPr('octocat', 'hello-world', 1, {
      title: 'Approved PR',
      author: 'alice',
      reviewDecision: 'APPROVED',
    });
    const stalePr = insertPr('octocat', 'hello-world', 2, {
      title: 'Needs review',
      author: 'bob',
    });
    requestReview(stalePr.status.id, 'carol', REQUESTED_25_HOURS_AGO);

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe('xoxb-work-token');
    expect(sent[0].payload.channel).toBe('#team-a');
    expect(payloadText(sent[0])).toContain('Approved PR');
    expect(payloadText(sent[0])).toContain('Needs review');
    expect(payloadText(sent[0])).toContain('`carol` (25 hours)');
    expect(payloadText(sent[0])).not.toContain('<@');
  });

  test('posts other PRs ready for review for more than three days', async () => {
    setupProject('octocat', 'other-ready', { channel: '#team-ready' });
    insertPr('octocat', 'other-ready', 3, {
      title: 'Old ready PR',
      author: 'dana',
      readyAt: '2025-12-29T09:00:00.000Z',
    });

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.channel).toBe('#team-ready');
    expect(payloadText(sent[0])).toContain('Other PRs ready for review for > 3 days');
    expect(payloadText(sent[0])).toContain('Old ready PR');
    expect(payloadText(sent[0])).toContain('no previous review');
  });

  test('does not post for projects without digest eligibility', async () => {
    setupProject('octocat', 'digest-disabled', { dailyDigest: false, channel: '#disabled' });
    setupProject('octocat', 'slack-disabled', { enabled: false, channel: '#slack-disabled' });
    setupProject('octocat', 'other-workspace', { workspace: 'other', channel: '#other' });
    setupProject('octocat', 'missing-channel', { omitChannel: true });

    for (const repo of [
      'digest-disabled',
      'slack-disabled',
      'other-workspace',
      'missing-channel',
    ]) {
      insertPr('octocat', repo, 1, { reviewDecision: 'APPROVED' });
    }

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(0);
  });

  test('does not post when the computed digest is empty', async () => {
    setupProject('octocat', 'empty', { channel: '#empty' });
    const freshPr = insertPr('octocat', 'empty', 1);
    requestReview(freshPr.status.id, 'fresh-reviewer', REQUESTED_EXACTLY_24_HOURS_AGO);

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(0);
  });

  test('posts once per qualifying project on the same workspace', async () => {
    setupProject('octocat', 'repo-a', { channel: '#a' });
    setupProject('octocat', 'repo-b', { channel: '#b' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });
    insertPr('octocat', 'repo-b', 1, { title: 'Repo B approved', reviewDecision: 'APPROVED' });

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(2);
    expect(sent.map((call) => call.payload.channel).sort()).toEqual(['#a', '#b']);
    expect(payloadText(sent.find((call) => call.payload.channel === '#a')!)).toContain(
      'Repo A approved'
    );
    expect(payloadText(sent.find((call) => call.payload.channel === '#b')!)).toContain(
      'Repo B approved'
    );
  });

  test('includes Linear milestones once per Slack channel when enabled', async () => {
    const originalLinearApiKey = process.env.TEST_LINEAR_API_KEY;
    process.env.TEST_LINEAR_API_KEY = 'test-linear-key';
    setupProject('octocat', 'repo-a', { channel: '#shared' });
    setupProject('octocat', 'repo-b', { channel: '#shared' });
    setupProject('octocat', 'repo-c', { channel: '#other' });
    insertPr('octocat', 'repo-b', 1, { title: 'Repo B approved', reviewDecision: 'APPROVED' });

    try {
      const { sender, sent } = makeFakeSender();
      await runDailyDigestForWorkspace(
        db,
        buildConfig({
          work: {
            token: 'xoxb-work-token',
            dailyDigest: {
              timezone: 'UTC',
              staleAfterHours: 24,
              linearMilestones: { enabled: true, apiKeyEnv: 'TEST_LINEAR_API_KEY' },
            },
          },
        }),
        'work',
        {
          sender,
          nowMs: NOW_MS,
          linearMilestonesFetcher: async ({ timezone, apiKey }) => {
            expect(timezone).toBe('UTC');
            expect(apiKey).toBe('test-linear-key');
            return [
              {
                milestoneName: 'Beta',
                targetDate: '2026-01-02',
                projectName: 'Launch',
                milestoneOwner: 'Dana',
              },
            ];
          },
        }
      );

      expect(sent.map((call) => call.payload.channel).sort()).toEqual(['#other', '#shared']);
      const sharedPayloads = sent.filter((call) => call.payload.channel === '#shared');
      expect(sharedPayloads).toHaveLength(1);
      expect(payloadText(sharedPayloads[0])).toContain('Linear milestones due or overdue');
      expect(payloadText(sharedPayloads[0])).toContain('Beta');
      expect(payloadText(sent.find((call) => call.payload.channel === '#other')!)).toContain(
        'Linear milestones due or overdue'
      );
    } finally {
      restoreEnv('TEST_LINEAR_API_KEY', originalLinearApiKey);
    }
  });

  test('logs a misconfigured workspace only once with a shared logged set and does not throw', async () => {
    setupProject('octocat', 'hello-world', { channel: '#reviews' });
    insertPr('octocat', 'hello-world', 1, { reviewDecision: 'APPROVED' });
    delete process.env.TIM_DAILY_DIGEST_UNSET_TOKEN;

    const config = buildConfig({
      work: { token: '${TIM_DAILY_DIGEST_UNSET_TOKEN}' },
    });
    const logged = new Set<string>();
    const errorMessages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errorMessages.push(String(args[0]));
    };

    try {
      const { sender, sent } = makeFakeSender();
      await runDailyDigestForWorkspace(db, config, 'work', {
        sender,
        nowMs: NOW_MS,
        loggedMisconfiguredWorkspaces: logged,
      });
      await runDailyDigestForWorkspace(db, config, 'work', {
        sender,
        nowMs: NOW_MS,
        loggedMisconfiguredWorkspaces: logged,
      });
      expect(sent).toHaveLength(0);
    } finally {
      console.error = originalError;
    }

    expect(errorMessages.filter((message) => message.includes('work'))).toHaveLength(1);
    expect(logged.has('work')).toBe(true);
  });

  test('skips unparseable repository ids while other projects still post', async () => {
    setupInvalidRepositoryProject({ channel: '#invalid' });
    setupProject('octocat', 'valid', { channel: '#valid' });
    insertPr('octocat', 'valid', 1, { reviewDecision: 'APPROVED' });

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.channel).toBe('#valid');
  });

  test('continues processing other projects when one project throws during digest shaping', async () => {
    setupProject('octocat', 'broken', { channel: '#broken' });
    const brokenPr = insertPr('octocat', 'broken', 1);
    requestReview(brokenPr.status.id, 'reviewer-broken', REQUESTED_25_HOURS_AGO);
    db.prepare(
      `
        UPDATE pr_review_request
        SET requested_at = ?
        WHERE pr_status_id = ?
          AND reviewer = ?
      `
    ).run('!', brokenPr.status.id, 'reviewer-broken');

    setupProject('octocat', 'valid', { channel: '#valid' });
    insertPr('octocat', 'valid', 1, { title: 'Still posts', reviewDecision: 'APPROVED' });

    const errorMessages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errorMessages.push(String(args[0]));
    };

    try {
      const { sender, sent } = makeFakeSender();
      await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });
      expect(sent).toHaveLength(1);
      expect(sent[0].payload.channel).toBe('#valid');
      expect(payloadText(sent[0])).toContain('Still posts');
    } finally {
      console.error = originalError;
    }

    expect(errorMessages.some((message) => message.includes('broken'))).toBe(true);
  });

  test('runAllDailyDigests iterates all configured workspaces with one shared nowMs', async () => {
    setupProject('octocat', 'work-repo', { workspace: 'work', channel: '#work' });
    setupProject('octocat', 'other-repo', { workspace: 'other', channel: '#other' });
    const workPr = insertPr('octocat', 'work-repo', 1);
    const otherPr = insertPr('octocat', 'other-repo', 1);
    requestReview(workPr.status.id, 'work-reviewer', REQUESTED_25_HOURS_AGO);
    requestReview(otherPr.status.id, 'other-reviewer', REQUESTED_25_HOURS_AGO);

    const { sender, sent } = makeFakeSender();
    await runAllDailyDigests(
      db,
      buildConfig({
        work: { token: 'xoxb-work-token', dailyDigest: { staleAfterHours: 24 } },
        other: { token: 'xoxb-other-token', dailyDigest: { staleAfterHours: 24 } },
      }),
      { sender, nowMs: NOW_MS }
    );

    expect(sent).toHaveLength(2);
    expect(sent.map((call) => call.token).sort()).toEqual(['xoxb-other-token', 'xoxb-work-token']);
    expect(payloadText(sent.find((call) => call.payload.channel === '#work')!)).toContain(
      '`work-reviewer` (25 hours)'
    );
    expect(payloadText(sent.find((call) => call.payload.channel === '#other')!)).toContain(
      '`other-reviewer` (25 hours)'
    );
  });

  test('uses injected nowMs and excludes exactly-at-threshold requests while including just-past-threshold requests', async () => {
    setupProject('octocat', 'thresholds', { channel: '#thresholds' });
    const exactlyAtThreshold = insertPr('octocat', 'thresholds', 1);
    const justPastThreshold = insertPr('octocat', 'thresholds', 2);
    requestReview(exactlyAtThreshold.status.id, 'exactly-fresh', REQUESTED_EXACTLY_24_HOURS_AGO);
    requestReview(justPastThreshold.status.id, 'just-stale', REQUESTED_24_HOURS_AND_1_MS_AGO);

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(1);
    const blocks = payloadText(sent[0]);
    expect(blocks).not.toContain('exactly-fresh');
    expect(blocks).toContain('just-stale');
  });

  describe('shouldStartDailyDigest', () => {
    test('returns false when webhook polling is disabled even with an eligible project', () => {
      setupProject('octocat', 'eligible', { channel: '#reviews' });

      expect(shouldStartDailyDigest(db, buildConfig())).toBe(false);
    });

    test('returns false when no slack workspace is configured', () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'eligible', { channel: '#reviews' });

      expect(shouldStartDailyDigest(db, getDefaultConfig())).toBe(false);
    });

    test('returns false when configured workspaces have no matching digest-enabled project', () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'digest-disabled', {
        dailyDigest: false,
        channel: '#digest-disabled',
      });
      setupProject('octocat', 'slack-disabled', { enabled: false, channel: '#slack-disabled' });
      setupProject('octocat', 'missing-channel', { omitChannel: true });
      setupProject('octocat', 'other-workspace', { workspace: 'other', channel: '#other' });

      expect(shouldStartDailyDigest(db, buildConfig())).toBe(false);
    });

    test('returns true when webhook polling is enabled and an eligible digest project exists', () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'eligible', { channel: '#reviews' });

      expect(shouldStartDailyDigest(db, buildConfig())).toBe(true);
    });
  });

  describe('startDailyDigestScheduler', () => {
    test('returns null when shouldStartDailyDigest is false', () => {
      setupProject('octocat', 'eligible', { channel: '#reviews' });

      expect(startDailyDigestScheduler(db, buildConfig())).toBeNull();
    });

    test('returns a handle whose runNow posts for eligible projects and whose stop is idempotent', async () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'scheduled', { channel: '#scheduled' });
      insertPr('octocat', 'scheduled', 1, {
        title: 'Scheduled approved PR',
        reviewDecision: 'APPROVED',
      });

      const { sender, sent } = makeFakeSender();
      const handle = startDailyDigestScheduler(db, buildConfig(), {
        sender,
        nowMs: () => NOW_MS,
      });

      try {
        expect(handle).not.toBeNull();
        await handle!.runNow();

        expect(sent).toHaveLength(1);
        expect(sent[0].payload.channel).toBe('#scheduled');
        expect(payloadText(sent[0])).toContain('Scheduled approved PR');
      } finally {
        handle?.stop();
        expect(() => handle?.stop()).not.toThrow();
      }
    });

    test('runNow posts nothing after stop()', async () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'stopped-repo', { channel: '#scheduled' });
      insertPr('octocat', 'stopped-repo', 1, {
        title: 'Approved PR after stop',
        reviewDecision: 'APPROVED',
      });

      const { sender, sent } = makeFakeSender();
      const handle = startDailyDigestScheduler(db, buildConfig(), {
        sender,
        nowMs: () => NOW_MS,
      });

      expect(handle).not.toBeNull();
      handle!.stop();
      await handle!.runNow();

      expect(sent).toHaveLength(0);
    });

    test('runNow only processes scheduler-eligible workspaces', async () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'scheduled', { workspace: 'work', channel: '#scheduled' });
      insertPr('octocat', 'scheduled', 1, {
        title: 'Eligible scheduled PR',
        reviewDecision: 'APPROVED',
      });
      delete process.env.TIM_DAILY_DIGEST_NONELIGIBLE_TOKEN;

      const errorMessages: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errorMessages.push(String(args[0]));
      };

      const { sender, sent } = makeFakeSender();
      const handle = startDailyDigestScheduler(
        db,
        buildConfig({
          work: {
            token: 'xoxb-work-token',
            dailyDigest: { time: '00:00', timezone: 'UTC', staleAfterHours: 24 },
          },
          noneligible: {
            token: '${TIM_DAILY_DIGEST_NONELIGIBLE_TOKEN}',
            dailyDigest: { time: '00:00', timezone: 'UTC', staleAfterHours: 24 },
          },
        }),
        {
          sender,
          nowMs: () => NOW_MS,
        }
      );

      try {
        expect(handle).not.toBeNull();
        await handle!.runNow();

        expect(sent).toHaveLength(1);
        expect(sent[0].payload.channel).toBe('#scheduled');
      } finally {
        handle?.stop();
        console.error = originalError;
      }

      expect(errorMessages).toHaveLength(0);
    });

    test('scheduled timeout fires, posts, and re-arms the next workspace timer', async () => {
      vi.useFakeTimers();
      enableWebhookPollingEnv();
      setupProject('octocat', 'timer-repo', { channel: '#timer' });
      insertPr('octocat', 'timer-repo', 1, {
        title: 'Timer fired approved PR',
        reviewDecision: 'APPROVED',
      });

      const { sender, sent } = makeFakeSender();
      const handle = startDailyDigestScheduler(
        db,
        buildConfig({
          work: {
            token: 'xoxb-work-token',
            dailyDigest: { time: '12:01', timezone: 'UTC', staleAfterHours: 24 },
          },
        }),
        {
          sender,
          nowMs: () => Date.parse('2026-01-02T12:00:00.000Z'),
        }
      );

      try {
        expect(handle).not.toBeNull();
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(sent).toHaveLength(1);
        expect(sent[0].payload.channel).toBe('#timer');
        expect(payloadText(sent[0])).toContain('Timer fired approved PR');
        expect(vi.getTimerCount()).toBe(1);
      } finally {
        handle?.stop();
        vi.useRealTimers();
      }
    });
  });
});

const NOW_MS = Date.parse('2026-01-02T12:00:00.000Z');
const REQUESTED_EXACTLY_24_HOURS_AGO = '2026-01-01T12:00:00.000Z';
const REQUESTED_24_HOURS_AND_1_MS_AGO = '2026-01-01T11:59:59.999Z';
const REQUESTED_25_HOURS_AGO = '2026-01-01T11:00:00.000Z';

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
