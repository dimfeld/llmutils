import type { Database } from 'bun:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import type {
  SlackPinSenderArgs,
  SlackPostSenderArgs,
  SlackUpdateSenderArgs,
} from '$common/slack/slack_client.js';
import { SLACK_PROJECT_SETTING_KEY } from '$common/slack/slack_project_setting.js';
import { getDefaultConfig, type TimConfig } from '$tim/configSchema.js';
import { openDatabase } from '$tim/db/database.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { setProjectSetting } from '$tim/db/project_settings.js';
import { upsertPrReviewRequestByReviewer, upsertPrStatus } from '$tim/db/pr_status.js';
import { recordWorkspace } from '$tim/db/workspace.js';

import {
  runAllDailyDigests,
  runDailyDigestForWorkspace,
  shouldStartDailyDigest,
  startDailyDigestScheduler,
  updateDailyDigestMessagesForPrUrls,
} from './daily_digest.js';

type UpsertPrStatusResult = ReturnType<typeof upsertPrStatus>;

interface FakeSender {
  sender: (args: SlackPostSenderArgs) => Promise<{ ok: boolean; error?: string }>;
  sent: SlackPostSenderArgs[];
}

interface FakeUpdateSender {
  sender: (args: SlackUpdateSenderArgs) => Promise<{ ok: boolean; error?: string }>;
  updated: SlackUpdateSenderArgs[];
}

interface FakePinSender {
  sender: (args: SlackPinSenderArgs) => Promise<{ ok: boolean; error?: string }>;
  calls: SlackPinSenderArgs[];
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

function makeFakeSenderWithCoordinates(): FakeSender {
  const sent: SlackPostSenderArgs[] = [];
  return {
    sent,
    sender: async (
      args: SlackPostSenderArgs
    ): Promise<{ ok: true; channel: string; ts: string }> => {
      sent.push(args);
      return { ok: true, channel: 'C123', ts: `1710000000.000${sent.length}` };
    },
  };
}

function makeFakeUpdateSender(): FakeUpdateSender {
  const updated: SlackUpdateSenderArgs[] = [];
  return {
    updated,
    sender: async (
      args: SlackUpdateSenderArgs
    ): Promise<{ ok: true; channel: string; ts: string }> => {
      updated.push(args);
      return { ok: true, channel: args.channel, ts: args.ts };
    },
  };
}

function makeFakePinSender(): FakePinSender {
  const calls: SlackPinSenderArgs[] = [];
  return {
    calls,
    sender: async (args: SlackPinSenderArgs): Promise<{ ok: true }> => {
      calls.push(args);
      return { ok: true };
    },
  };
}

function buildConfig(
  workspaces: NonNullable<TimConfig['slack']>['workspaces'] = {
    work: {
      token: 'xoxb-work-token',
      dailyDigest: { enabled: true, staleAfterHours: 24 },
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
  let tempDirs: string[];

  beforeEach(() => {
    db = openDatabase(':memory:');
    tempDirs = [];
    originalInfo = console.info;
    console.info = (): void => {};
    originalWebhookPollInterval = process.env.TIM_WEBHOOK_POLL_INTERVAL;
    originalWebhookServerUrl = process.env.TIM_WEBHOOK_SERVER_URL;
    originalWebhookInternalApiToken = process.env.WEBHOOK_INTERNAL_API_TOKEN;
    delete process.env.TIM_WEBHOOK_POLL_INTERVAL;
    delete process.env.TIM_WEBHOOK_SERVER_URL;
    delete process.env.WEBHOOK_INTERNAL_API_TOKEN;
  });

  afterEach(async () => {
    console.info = originalInfo;
    restoreEnv('TIM_WEBHOOK_POLL_INTERVAL', originalWebhookPollInterval);
    restoreEnv('TIM_WEBHOOK_SERVER_URL', originalWebhookServerUrl);
    restoreEnv('WEBHOOK_INTERNAL_API_TOKEN', originalWebhookInternalApiToken);
    db.close(false);
    await Promise.all(tempDirs.map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
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

  async function createWorkspaceWithDotEnv(projectId: number, contents: string): Promise<string> {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-digest-workspace-'));
    tempDirs.push(workspacePath);
    await fs.writeFile(path.join(workspacePath, '.env'), contents, 'utf8');
    recordWorkspace(db, {
      projectId,
      workspacePath,
      workspaceType: 'primary',
    });
    return workspacePath;
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
    insertPr('octocat', 'empty', 1);

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

  test('updates the same-day per-repo digest message instead of posting again', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      nowMs: NOW_MS,
    });

    const updateSender = makeFakeUpdateSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      updateSender: updateSender.sender,
      nowMs: NOW_MS,
    });

    expect(postSender.sent).toHaveLength(1);
    expect(updateSender.updated).toHaveLength(1);
    expect(updateSender.updated[0].channel).toBe('C123');
    expect(updateSender.updated[0].ts).toBe('1710000000.0001');
    expect(payloadText({ token: '', payload: updateSender.updated[0].payload })).toContain(
      'Repo A approved'
    );
  });

  test('pins a newly posted daily digest message', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    const pinSender = makeFakePinSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      pinSender: pinSender.sender,
      nowMs: NOW_MS,
    });

    expect(pinSender.calls).toEqual([
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0001' },
    ]);
  });

  test('pins the new daily digest and unpins the previous digest when posting a later date', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    const pinSender = makeFakePinSender();
    const unpinSender = makeFakePinSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      pinSender: pinSender.sender,
      unpinSender: unpinSender.sender,
      nowMs: NOW_MS,
    });
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      pinSender: pinSender.sender,
      unpinSender: unpinSender.sender,
      nowMs: NOW_MS + 24 * 60 * 60 * 1000,
    });

    expect(postSender.sent).toHaveLength(2);
    expect(pinSender.calls).toEqual([
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0001' },
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0002' },
    ]);
    expect(unpinSender.calls).toEqual([
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0001' },
    ]);
  });

  test('does not pin or unpin when updating the same-day digest message', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    const pinSender = makeFakePinSender();
    const unpinSender = makeFakePinSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      pinSender: pinSender.sender,
      unpinSender: unpinSender.sender,
      nowMs: NOW_MS,
    });

    const updateSender = makeFakeUpdateSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      updateSender: updateSender.sender,
      pinSender: pinSender.sender,
      unpinSender: unpinSender.sender,
      nowMs: NOW_MS,
    });

    expect(updateSender.updated).toHaveLength(1);
    expect(pinSender.calls).toHaveLength(1);
    expect(unpinSender.calls).toHaveLength(0);
  });

  test('pins updated same-day digest and unpins previous digest when requested', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      nowMs: NOW_MS - 24 * 60 * 60 * 1000,
    });
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      nowMs: NOW_MS,
    });

    const updateSender = makeFakeUpdateSender();
    const pinSender = makeFakePinSender();
    const unpinSender = makeFakePinSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      updateSender: updateSender.sender,
      pinSender: pinSender.sender,
      unpinSender: unpinSender.sender,
      nowMs: NOW_MS,
      updateExistingOnly: true,
      pinUpdatedExisting: true,
    });

    expect(updateSender.updated).toHaveLength(1);
    expect(pinSender.calls).toEqual([
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0002' },
    ]);
    expect(unpinSender.calls).toEqual([
      { token: 'xoxb-work-token', channel: 'C123', ts: '1710000000.0001' },
    ]);
  });

  test('update-only digest refresh clears a same-day message when the repo digest becomes empty', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', {
      sender: postSender.sender,
      nowMs: NOW_MS,
    });

    db.prepare("UPDATE pr_status SET state = 'merged' WHERE owner = ? AND repo = ?").run(
      'octocat',
      'repo-a'
    );

    const updateSender = makeFakeUpdateSender();
    await updateDailyDigestMessagesForPrUrls(
      db,
      buildConfig(),
      ['https://github.com/octocat/repo-a/pull/1'],
      {
        sender: postSender.sender,
        updateSender: updateSender.sender,
        nowMs: NOW_MS,
      }
    );

    expect(postSender.sent).toHaveLength(1);
    expect(updateSender.updated).toHaveLength(1);
    expect(updateSender.updated[0].payload.text).toContain('0 approved');
    expect(payloadText({ token: '', payload: updateSender.updated[0].payload })).not.toContain(
      'Repo A approved'
    );
  });

  test('update-only digest refresh does not post when no same-day message exists', async () => {
    setupProject('octocat', 'repo-a', { channel: '#reviews' });
    insertPr('octocat', 'repo-a', 1, { title: 'Repo A approved', reviewDecision: 'APPROVED' });

    const postSender = makeFakeSenderWithCoordinates();
    const updateSender = makeFakeUpdateSender();
    await updateDailyDigestMessagesForPrUrls(
      db,
      buildConfig(),
      ['https://github.com/octocat/repo-a/pull/1'],
      {
        sender: postSender.sender,
        updateSender: updateSender.sender,
        nowMs: NOW_MS,
      }
    );

    expect(postSender.sent).toHaveLength(0);
    expect(updateSender.updated).toHaveLength(0);
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
              enabled: true,
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

  test('loads Linear milestone API key from a digest project workspace .env', async () => {
    const originalLinearApiKey = process.env.TEST_LINEAR_API_KEY;
    delete process.env.TEST_LINEAR_API_KEY;
    const projectId = setupProject('octocat', 'repo-with-env', { channel: '#env' });
    await createWorkspaceWithDotEnv(projectId, 'TEST_LINEAR_API_KEY=workspace-linear-key\n');

    try {
      const { sender, sent } = makeFakeSender();
      await runDailyDigestForWorkspace(
        db,
        buildConfig({
          work: {
            token: 'xoxb-work-token',
            dailyDigest: {
              enabled: true,
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
          linearMilestonesFetcher: async ({ apiKey }) => {
            expect(apiKey).toBe('workspace-linear-key');
            return [
              {
                milestoneName: 'Workspace Env Beta',
                targetDate: '2026-01-02',
                projectName: 'Launch',
                milestoneOwner: 'Dana',
              },
            ];
          },
        }
      );

      expect(sent).toHaveLength(1);
      expect(payloadText(sent[0])).toContain('Workspace Env Beta');
    } finally {
      restoreEnv('TEST_LINEAR_API_KEY', originalLinearApiKey);
    }
  });

  test('logs a misconfigured workspace only once with a shared logged set and does not throw', async () => {
    setupProject('octocat', 'hello-world', { channel: '#reviews' });
    insertPr('octocat', 'hello-world', 1, { reviewDecision: 'APPROVED' });
    delete process.env.TIM_DAILY_DIGEST_UNSET_TOKEN;

    const config = buildConfig({
      work: {
        token: '${TIM_DAILY_DIGEST_UNSET_TOKEN}',
        dailyDigest: { enabled: true, staleAfterHours: 24 },
      },
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
        work: { token: 'xoxb-work-token', dailyDigest: { enabled: true, staleAfterHours: 24 } },
        other: { token: 'xoxb-other-token', dailyDigest: { enabled: true, staleAfterHours: 24 } },
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

  test('runAllDailyDigests skips workspaces without daily digest opt-in', async () => {
    setupProject('octocat', 'work-repo', { workspace: 'work', channel: '#work' });
    setupProject('octocat', 'other-repo', { workspace: 'other', channel: '#other' });
    insertPr('octocat', 'work-repo', 1, { title: 'Work approved', reviewDecision: 'APPROVED' });
    insertPr('octocat', 'other-repo', 1, { title: 'Other approved', reviewDecision: 'APPROVED' });

    const { sender, sent } = makeFakeSender();
    await runAllDailyDigests(
      db,
      buildConfig({
        work: { token: 'xoxb-work-token', dailyDigest: { enabled: true, staleAfterHours: 24 } },
        other: { token: 'xoxb-other-token', dailyDigest: { staleAfterHours: 24 } },
      }),
      { sender, nowMs: NOW_MS }
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].payload.channel).toBe('#work');
    expect(payloadText(sent[0])).toContain('Work approved');
  });

  test('runDailyDigestForWorkspace skips workspace without daily digest opt-in', async () => {
    setupProject('octocat', 'disabled-workspace', { channel: '#disabled' });
    insertPr('octocat', 'disabled-workspace', 1, {
      title: 'Should not post',
      reviewDecision: 'APPROVED',
    });

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(
      db,
      buildConfig({
        work: { token: 'xoxb-work-token', dailyDigest: { staleAfterHours: 24 } },
      }),
      'work',
      { sender, nowMs: NOW_MS }
    );

    expect(sent).toHaveLength(0);
  });

  test('uses injected nowMs and includes all pending review requests regardless of wait time', async () => {
    setupProject('octocat', 'thresholds', { channel: '#thresholds' });
    const exactlyAtThreshold = insertPr('octocat', 'thresholds', 1);
    const justPastThreshold = insertPr('octocat', 'thresholds', 2);
    requestReview(exactlyAtThreshold.status.id, 'exactly-fresh', REQUESTED_EXACTLY_24_HOURS_AGO);
    requestReview(justPastThreshold.status.id, 'just-stale', REQUESTED_24_HOURS_AND_1_MS_AGO);

    const { sender, sent } = makeFakeSender();
    await runDailyDigestForWorkspace(db, buildConfig(), 'work', { sender, nowMs: NOW_MS });

    expect(sent).toHaveLength(1);
    const blocks = payloadText(sent[0]);
    expect(blocks).toContain('exactly-fresh');
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

    test('returns false when matching workspace has not opted into daily digest', () => {
      enableWebhookPollingEnv();
      setupProject('octocat', 'eligible', { channel: '#reviews' });

      expect(
        shouldStartDailyDigest(
          db,
          buildConfig({
            work: { token: 'xoxb-work-token', dailyDigest: { staleAfterHours: 24 } },
          })
        )
      ).toBe(false);
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
            dailyDigest: { enabled: true, time: '00:00', timezone: 'UTC', staleAfterHours: 24 },
          },
          noneligible: {
            token: '${TIM_DAILY_DIGEST_NONELIGIBLE_TOKEN}',
            dailyDigest: { enabled: true, time: '00:00', timezone: 'UTC', staleAfterHours: 24 },
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
            dailyDigest: { enabled: true, time: '12:01', timezone: 'UTC', staleAfterHours: 24 },
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
