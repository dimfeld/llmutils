import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { format as formatMessage } from 'node:util';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock('chalk', () => ({
  default: {
    green: (v: string) => v,
    yellow: (v: string) => v,
    red: (v: string) => v,
    bold: (v: string) => v,
    dim: (v: string) => v,
  },
}));

vi.mock('../../common/git.js', () => ({
  getGitRepository: vi.fn(),
  getGitRoot: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { getGitRepository } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { getProjectSetting, setProjectSetting } from '../db/project_settings.js';
import {
  upsertPrReviewByAuthor,
  upsertPrReviewRequestByReviewer,
  upsertPrStatus,
} from '../db/pr_status.js';
import { upsertSlackDailyDigestMessage } from '../db/slack_daily_digest_message.js';
import { getUserMapping, upsertUserMapping } from '../db/slack_user_map.js';
import {
  handleSlackDisableCommand,
  handleSlackDigestDisableCommand,
  handleSlackDigestEnableCommand,
  handleSlackDigestRunCommand,
  handleSlackDigestUpdateCommand,
  handleSlackEnableCommand,
  handleSlackListCommand,
  handleSlackMarkClosedNotifiedCommand,
  handleSlackMapCommand,
  handleSlackTestCommand,
  handleSlackUnmapCommand,
} from './slack.js';
import type {
  SlackPostResult,
  SlackPostSenderArgs,
  SlackPinSenderArgs,
  SlackUpdateSenderArgs,
} from '../../common/slack/slack_client.js';
import { setDebug } from '../../common/process_state.js';

const OWNER = 'testowner';
const REPO = 'testrepo';
const REPOSITORY_ID = constructGitHubRepositoryId(OWNER, REPO);
const WORKSPACE_NAME = 'work';
const SLACK_PROJECT_SETTING_KEY = 'slack';

const configWithWorkspace = {
  slack: {
    workspaces: {
      [WORKSPACE_NAME]: { token: 'xoxb-test-token', dailyDigest: { enabled: true } },
    },
  },
};

const fakeCommand = { parent: { opts: () => ({ config: undefined as string | undefined }) } };

describe('tim slack CLI handlers', () => {
  let tempRoot: string;
  let originalXdgConfigHome: string | undefined;
  let originalAppData: string | undefined;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-slack-cmd-test-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    originalAppData = process.env.APPDATA;

    // Redirect the tim DB to a temp dir so tests don't touch the real DB
    process.env.XDG_CONFIG_HOME = tempRoot;
    delete process.env.APPDATA;

    vi.clearAllMocks();

    vi.mocked(getGitRepository).mockResolvedValue(`${OWNER}/${REPO}`);
    vi.mocked(loadEffectiveConfig).mockResolvedValue(configWithWorkspace as any);

    // Seed a project row so resolveCurrentProject succeeds
    getOrCreateProject(getDatabase(), REPOSITORY_ID);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    setDebug(false);
    closeDatabaseForTesting();

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }

    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe('handleSlackEnableCommand', () => {
    test('happy path: writes slack project_setting with enabled=true, workspace, channel', async () => {
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#code-reviews' },
        fakeCommand
      );

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      const setting = getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY) as Record<
        string,
        unknown
      > | null;
      expect(setting).not.toBeNull();
      expect(setting!.enabled).toBe(true);
      expect(setting!.workspace).toBe(WORKSPACE_NAME);
      expect(setting!.channel).toBe('#code-reviews');
    });

    test('validation error: unknown workspace throws with "is not configured" message', async () => {
      await expect(
        handleSlackEnableCommand({ workspace: 'unknown-ws', channel: '#ch' }, fakeCommand)
      ).rejects.toThrow('is not configured');
    });

    test('validation error: missing workspace throws with "Missing required option" message', async () => {
      await expect(
        handleSlackEnableCommand({ workspace: '', channel: '#ch' }, fakeCommand)
      ).rejects.toThrow('Missing required option');
    });

    test('validation error: missing channel throws with "Missing required option" message', async () => {
      await expect(
        handleSlackEnableCommand({ workspace: WORKSPACE_NAME, channel: '' }, fakeCommand)
      ).rejects.toThrow('Missing required option');
    });
  });

  describe('handleSlackDisableCommand', () => {
    test('sets enabled=false while preserving prior workspace and channel', async () => {
      // First enable
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#reviews' },
        fakeCommand
      );

      // Then disable
      await handleSlackDisableCommand({}, fakeCommand);

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      const setting = getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY) as Record<
        string,
        unknown
      > | null;
      expect(setting).not.toBeNull();
      expect(setting!.enabled).toBe(false);
      expect(setting!.workspace).toBe(WORKSPACE_NAME);
      expect(setting!.channel).toBe('#reviews');
      expect(setting!.dailyDigest).toBe(false);
    });

    test('disables even when no prior setting exists (sets enabled=false)', async () => {
      await handleSlackDisableCommand({}, fakeCommand);

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      const setting = getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY) as Record<
        string,
        unknown
      > | null;
      expect(setting).not.toBeNull();
      expect(setting!.enabled).toBe(false);
    });
  });

  describe('handleSlackDigestEnableCommand', () => {
    test('sets dailyDigest=true when Slack is already enabled with workspace and channel', async () => {
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#reviews' },
        fakeCommand
      );

      await handleSlackDigestEnableCommand({}, fakeCommand);

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      const setting = getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY) as Record<
        string,
        unknown
      > | null;
      expect(setting).not.toBeNull();
      expect(setting!.enabled).toBe(true);
      expect(setting!.workspace).toBe(WORKSPACE_NAME);
      expect(setting!.channel).toBe('#reviews');
      expect(setting!.dailyDigest).toBe(true);
    });

    test('throws without writing when Slack is not already enabled', async () => {
      await expect(handleSlackDigestEnableCommand({}, fakeCommand)).rejects.toThrow(
        'Slack daily digest requires Slack notifications to be enabled first'
      );

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      expect(getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)).toBeNull();
    });

    test('throws when Slack setting is enabled but missing workspace or channel', async () => {
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);

      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        workspace: WORKSPACE_NAME,
      });
      await expect(handleSlackDigestEnableCommand({}, fakeCommand)).rejects.toThrow(
        'Slack daily digest requires Slack notifications to be enabled first'
      );

      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        channel: '#reviews',
      });
      await expect(handleSlackDigestEnableCommand({}, fakeCommand)).rejects.toThrow(
        'Slack daily digest requires Slack notifications to be enabled first'
      );
    });

    test('throws when the saved workspace is no longer configured', async () => {
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#reviews' },
        fakeCommand
      );
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ slack: { workspaces: {} } } as any);

      await expect(handleSlackDigestEnableCommand({}, fakeCommand)).rejects.toThrow(
        'is not configured'
      );
    });
  });

  describe('handleSlackDigestDisableCommand', () => {
    test('sets dailyDigest=false while preserving Slack workspace and channel', async () => {
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#reviews' },
        fakeCommand
      );
      await handleSlackDigestEnableCommand({}, fakeCommand);

      await handleSlackDigestDisableCommand({}, fakeCommand);

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      const setting = getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY) as Record<
        string,
        unknown
      > | null;
      expect(setting).not.toBeNull();
      expect(setting!.enabled).toBe(true);
      expect(setting!.workspace).toBe(WORKSPACE_NAME);
      expect(setting!.channel).toBe('#reviews');
      expect(setting!.dailyDigest).toBe(false);
    });
  });

  describe('handleSlackDigestRunCommand', () => {
    test('dry run prints computed digests without sending or resolving Slack tokens', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        slack: {
          workspaces: {
            [WORKSPACE_NAME]: {
              token: '${TIM_SLACK_DIGEST_TEST_UNSET_TOKEN}',
              dailyDigest: { enabled: true, staleAfterHours: 24 },
            },
          },
        },
      } as any);
      delete process.env.TIM_SLACK_DIGEST_TEST_UNSET_TOKEN;

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      const approved = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/1`,
        owner: OWNER,
        repo: REPO,
        prNumber: 1,
        author: 'alice',
        title: 'Approved digest PR',
        state: 'open',
        draft: false,
        reviewDecision: 'APPROVED',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });
      const stale = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/2`,
        owner: OWNER,
        repo: REPO,
        prNumber: 2,
        author: 'bob',
        title: 'Waiting digest PR',
        state: 'open',
        draft: false,
        reviewDecision: null,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(approved.status.id).toBeGreaterThan(0);
      upsertPrReviewByAuthor(db, approved.status.id, {
        author: 'reviewer-approved',
        state: 'APPROVED',
        submittedAt: '2026-01-01T00:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, stale.status.id, {
        reviewer: 'carol',
        action: 'requested',
        eventAt: '2026-01-01T00:00:00.000Z',
      });

      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      await handleSlackDigestRunCommand({ dryRun: true }, fakeCommand, fakeSender);

      expect(calls).toHaveLength(0);
      const { log } = await import('../../logging.js');
      const output = vi
        .mocked(log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(output).toContain('Slack daily PR digest dry run');
      expect(output).toContain(`${OWNER}/${REPO}`);
      expect(output).toContain('Approved digest PR');
      expect(output).toContain('Waiting digest PR');
      expect(output).toContain('carol');
      expect(output).toMatch(
        /  - #1 Approved digest PR \(author: alice; approved: \d+ days ago\)\n\n  Awaiting review:/
      );
    });

    test('debug dry run logs review request state used to build awaiting-review entries', async () => {
      setDebug(true);
      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        slack: {
          workspaces: {
            [WORKSPACE_NAME]: {
              token: '${TIM_SLACK_DIGEST_TEST_UNSET_TOKEN}',
              dailyDigest: { enabled: true },
            },
          },
        },
      } as any);
      delete process.env.TIM_SLACK_DIGEST_TEST_UNSET_TOKEN;

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      const waiting = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/3005`,
        owner: OWNER,
        repo: REPO,
        prNumber: 3005,
        author: 'alice',
        title: 'Debug digest PR',
        state: 'open',
        draft: false,
        reviewDecision: null,
        readyAt: '2026-01-01T00:00:00.000Z',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, waiting.status.id, {
        reviewer: 'carol',
        action: 'requested',
        eventAt: '2026-01-01T00:00:00.000Z',
      });
      upsertPrReviewByAuthor(db, waiting.status.id, {
        author: 'carol',
        state: 'COMMENTED',
        submittedAt: '2026-01-01T01:00:00.000Z',
      });

      await handleSlackDigestRunCommand({ dryRun: true }, fakeCommand);

      const { debugLog } = await import('../../logging.js');
      const debugOutput = vi
        .mocked(debugLog)
        .mock.calls.map((call) => formatMessage(...call))
        .join('\n');
      expect(debugOutput).toContain(`PR digest input for ${OWNER}/${REPO}`);
      expect(debugOutput).toContain(`Review request debug for ${OWNER}/${REPO}#3005`);
      expect(debugOutput).toContain('requestReviewer=carol');
      expect(debugOutput).toContain('requestState=active-request');
      expect(debugOutput).toContain(
        'requestedReviewerClearingReview=carol:COMMENTED@2026-01-01T01:00:00.000Z'
      );
      expect(debugOutput).toContain(
        'reviewerClearingReview=carol:COMMENTED@2026-01-01T01:00:00.000Z'
      );
      expect(debugOutput).toContain('latestPrReviews=[carol:COMMENTED@2026-01-01T01:00:00.000Z]');
    });

    test('dry run groups awaiting-review entries by configured labels', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        slack: {
          workspaces: {
            [WORKSPACE_NAME]: {
              token: '${TIM_SLACK_DIGEST_TEST_UNSET_TOKEN}',
              dailyDigest: {
                enabled: true,
                reviewGroups: [
                  { name: 'ASAP', label: 'review-p-0' },
                  { name: 'High Priority', label: 'review-p-1' },
                ],
                defaultGroupName: 'Regular Priority',
              },
            },
          },
        },
      } as any);
      delete process.env.TIM_SLACK_DIGEST_TEST_UNSET_TOKEN;

      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });

      const urgent = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/10`,
        owner: OWNER,
        repo: REPO,
        prNumber: 10,
        author: 'alice',
        title: 'Urgent digest PR',
        state: 'open',
        draft: false,
        reviewDecision: null,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        labels: [{ name: 'review-p-0' }],
      });
      const high = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/11`,
        owner: OWNER,
        repo: REPO,
        prNumber: 11,
        author: 'bob',
        title: 'High priority digest PR',
        state: 'open',
        draft: false,
        reviewDecision: null,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        labels: [{ name: 'review-p-1' }],
      });
      const regular = upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/12`,
        owner: OWNER,
        repo: REPO,
        prNumber: 12,
        author: 'chris',
        title: 'Regular digest PR',
        state: 'open',
        draft: false,
        reviewDecision: null,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        labels: [{ name: 'bug' }],
      });

      upsertPrReviewRequestByReviewer(db, urgent.status.id, {
        reviewer: 'reviewer-urgent',
        action: 'requested',
        eventAt: '2026-01-01T00:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, high.status.id, {
        reviewer: 'reviewer-high',
        action: 'requested',
        eventAt: '2026-01-01T00:00:00.000Z',
      });
      upsertPrReviewRequestByReviewer(db, regular.status.id, {
        reviewer: 'reviewer-regular',
        action: 'requested',
        eventAt: '2026-01-01T00:00:00.000Z',
      });

      await handleSlackDigestRunCommand({ dryRun: true }, fakeCommand);

      const { log } = await import('../../logging.js');
      const output = vi
        .mocked(log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(output).toContain('  Awaiting review — ASAP (review-p-0):');
      expect(output).toContain('  Awaiting review — High Priority (review-p-1):');
      expect(output).toContain('  Awaiting review — Regular Priority:');
      expect(output).not.toContain('  Awaiting review:\n');

      const asapIndex = output.indexOf('Awaiting review — ASAP');
      const highIndex = output.indexOf('Awaiting review — High Priority');
      const regularIndex = output.indexOf('Awaiting review — Regular Priority');
      expect(asapIndex).toBeGreaterThanOrEqual(0);
      expect(asapIndex).toBeLessThan(highIndex);
      expect(highIndex).toBeLessThan(regularIndex);
      expect(output.indexOf('Urgent digest PR')).toBeGreaterThan(asapIndex);
      expect(output.indexOf('High priority digest PR')).toBeGreaterThan(highIndex);
      expect(output.indexOf('Regular digest PR')).toBeGreaterThan(regularIndex);
    });

    test('non-dry run posts computed digests through the injected sender', async () => {
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/3`,
        owner: OWNER,
        repo: REPO,
        prNumber: 3,
        author: 'dana',
        title: 'Posted digest PR',
        state: 'open',
        draft: false,
        reviewDecision: 'APPROVED',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });

      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      await handleSlackDigestRunCommand({ dryRun: false }, fakeCommand, fakeSender);

      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('xoxb-test-token');
      expect(calls[0].payload.channel).toBe('#reviews');
      expect(JSON.stringify(calls[0].payload.blocks)).toContain('Posted digest PR');
      const { log } = await import('../../logging.js');
      expect(vi.mocked(log)).toHaveBeenCalledWith('Ran Slack daily PR digest.');
    });
  });

  describe('handleSlackDigestUpdateCommand', () => {
    test('dry run reports the latest stored message for the current repo', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      upsertSlackDailyDigestMessage(db, {
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
        repoFullName: `${OWNER}/${REPO}`,
        digestDate: '2026-01-01',
        slackChannel: 'C123',
        slackTs: '1710000000.000100',
      });
      upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/5`,
        owner: OWNER,
        repo: REPO,
        prNumber: 5,
        author: 'frank',
        title: 'Dry run digest PR',
        state: 'open',
        draft: false,
        reviewDecision: 'APPROVED',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });

      try {
        await handleSlackDigestUpdateCommand({ dryRun: true }, fakeCommand);
      } finally {
        vi.useRealTimers();
      }

      const { log } = await import('../../logging.js');
      const output = vi
        .mocked(log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(output).toContain('Slack daily PR digest update dry run');
      expect(output).toContain(`Repository: ${OWNER}/${REPO}`);
      expect(output).toContain(
        'Stored message: digestDate=2026-01-01, channel=C123, ts=1710000000.000100'
      );
      expect(output).toContain('Would update the latest stored digest message.');
      expect(output).toContain('Dry run digest PR');
      expect(output).toContain('Slack update payload:');
      expect(output).toContain(`Daily PR digest for ${OWNER}/${REPO}: 1 approved`);
      expect(output).toContain('"type": "section"');
    });

    test('dry run reports when no stored message exists', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });

      try {
        await handleSlackDigestUpdateCommand({ dryRun: true }, fakeCommand);
      } finally {
        vi.useRealTimers();
      }

      const { log } = await import('../../logging.js');
      const output = vi
        .mocked(log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(output).toContain('No stored digest message found');
    });

    test('treats dryRun on the command object as a dry run', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      upsertSlackDailyDigestMessage(db, {
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
        repoFullName: `${OWNER}/${REPO}`,
        digestDate: '2026-01-02',
        slackChannel: 'C123',
        slackTs: '1710000000.000100',
      });

      const updates: SlackUpdateSenderArgs[] = [];
      const fakeUpdateSender = async (args: SlackUpdateSenderArgs): Promise<SlackPostResult> => {
        updates.push(args);
        return { ok: true, channel: args.channel, ts: args.ts };
      };
      const dryRunCommand = {
        opts: () => ({ dryRun: true }),
        parent: { opts: () => ({ config: undefined as string | undefined }) },
      };

      try {
        await handleSlackDigestUpdateCommand({}, dryRunCommand, fakeUpdateSender);
      } finally {
        vi.useRealTimers();
      }

      expect(updates).toHaveLength(0);
      const { log } = await import('../../logging.js');
      const output = vi
        .mocked(log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(output).toContain('Slack daily PR digest update dry run');
      expect(output).toContain(
        'Stored message: digestDate=2026-01-02, channel=C123, ts=1710000000.000100'
      );
    });

    test('non-dry run updates the latest stored message', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      upsertSlackDailyDigestMessage(db, {
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
        repoFullName: `${OWNER}/${REPO}`,
        digestDate: '2026-01-01',
        slackChannel: 'C123',
        slackTs: '1710000000.000100',
      });
      upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/4`,
        owner: OWNER,
        repo: REPO,
        prNumber: 4,
        author: 'erin',
        title: 'Updated digest PR',
        state: 'open',
        draft: false,
        reviewDecision: 'APPROVED',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });

      const updates: SlackUpdateSenderArgs[] = [];
      const fakeUpdateSender = async (args: SlackUpdateSenderArgs): Promise<SlackPostResult> => {
        updates.push(args);
        return { ok: true, channel: args.channel, ts: args.ts };
      };

      try {
        await handleSlackDigestUpdateCommand({ dryRun: false }, fakeCommand, fakeUpdateSender);
      } finally {
        vi.useRealTimers();
      }

      expect(updates).toHaveLength(1);
      expect(updates[0].channel).toBe('C123');
      expect(updates[0].ts).toBe('1710000000.000100');
      expect(JSON.stringify(updates[0].payload.blocks)).toContain('Updated digest PR');
    });

    test('non-dry run with pin pins the latest stored message and unpins the previous digest', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-02T12:00:00.000Z'));
      const db = getDatabase();
      const project = getOrCreateProject(db, REPOSITORY_ID);
      setProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY, {
        enabled: true,
        dailyDigest: true,
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
      });
      upsertSlackDailyDigestMessage(db, {
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
        repoFullName: `${OWNER}/${REPO}`,
        digestDate: '2026-01-01',
        slackChannel: 'C123',
        slackTs: '1710000000.000099',
      });
      upsertSlackDailyDigestMessage(db, {
        workspace: WORKSPACE_NAME,
        channel: '#reviews',
        repoFullName: `${OWNER}/${REPO}`,
        digestDate: '2026-01-02',
        slackChannel: 'C123',
        slackTs: '1710000000.000100',
      });
      upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER}/${REPO}/pull/4`,
        owner: OWNER,
        repo: REPO,
        prNumber: 4,
        author: 'erin',
        title: 'Updated digest PR',
        state: 'open',
        draft: false,
        reviewDecision: 'APPROVED',
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
      });

      const updates: SlackUpdateSenderArgs[] = [];
      const pins: SlackPinSenderArgs[] = [];
      const unpins: SlackPinSenderArgs[] = [];
      const fakeUpdateSender = async (args: SlackUpdateSenderArgs): Promise<SlackPostResult> => {
        updates.push(args);
        return { ok: true, channel: args.channel, ts: args.ts };
      };
      const fakePinSender = async (args: SlackPinSenderArgs): Promise<SlackPostResult> => {
        pins.push(args);
        return { ok: true };
      };
      const fakeUnpinSender = async (args: SlackPinSenderArgs): Promise<SlackPostResult> => {
        unpins.push(args);
        return { ok: true };
      };

      try {
        await handleSlackDigestUpdateCommand(
          { dryRun: false, pin: true },
          fakeCommand,
          fakeUpdateSender,
          fakePinSender,
          fakeUnpinSender
        );
      } finally {
        vi.useRealTimers();
      }

      expect(updates).toHaveLength(1);
      expect(pins).toEqual([
        { token: 'xoxb-test-token', channel: 'C123', ts: '1710000000.000100' },
      ]);
      expect(unpins).toEqual([
        { token: 'xoxb-test-token', channel: 'C123', ts: '1710000000.000099' },
      ]);
    });
  });

  describe('handleSlackTestCommand', () => {
    test('happy path: sends a test message using the configured workspace token', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      await handleSlackTestCommand(
        { workspace: WORKSPACE_NAME, channel: '#code-reviews', message: 'hello from test' },
        fakeCommand,
        fakeSender
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].token).toBe('xoxb-test-token');
      expect(calls[0].payload.channel).toBe('#code-reviews');
      expect(calls[0].payload.blocks[0].text.text).toBe('hello from test');
    });

    test('uses a default message when --message is omitted', async () => {
      const calls: SlackPostSenderArgs[] = [];
      const fakeSender = async (args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        calls.push(args);
        return { ok: true };
      };

      await handleSlackTestCommand(
        { workspace: WORKSPACE_NAME, channel: '#code-reviews' },
        fakeCommand,
        fakeSender
      );

      expect(calls[0].payload.blocks[0].text.text).toContain('tim Slack test message');
    });

    test('throws when Slack returns a failure result', async () => {
      const fakeSender = async (_args: SlackPostSenderArgs): Promise<SlackPostResult> => {
        return { ok: false, error: 'channel_not_found' };
      };

      await expect(
        handleSlackTestCommand(
          { workspace: WORKSPACE_NAME, channel: '#missing', message: 'hello' },
          fakeCommand,
          fakeSender
        )
      ).rejects.toThrow('channel_not_found');
    });

    test('validation error: unknown workspace throws', async () => {
      await expect(
        handleSlackTestCommand({ workspace: 'no-such-ws', channel: '#ch' }, fakeCommand)
      ).rejects.toThrow('is not configured');
    });

    test('validation error: missing channel throws', async () => {
      await expect(
        handleSlackTestCommand({ workspace: WORKSPACE_NAME, channel: '' }, fakeCommand)
      ).rejects.toThrow('Missing required option');
    });
  });

  describe('handleSlackMarkClosedNotifiedCommand', () => {
    test('marks pending review-request notifications for closed PRs', async () => {
      const db = getDatabase();
      const prStatusId = db
        .prepare(
          `
            INSERT INTO pr_status (
              pr_url,
              owner,
              repo,
              pr_number,
              author,
              title,
              state,
              draft,
              last_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `
        )
        .get(
          'https://github.com/testowner/testrepo/pull/9',
          OWNER,
          REPO,
          9,
          'alice',
          'Closed PR',
          'closed',
          0,
          '2026-01-01T00:00:00.000Z'
        ) as { id: number };
      db.prepare(
        `
          INSERT INTO pr_review_request (
            pr_status_id,
            reviewer,
            requested_at,
            last_event_at
          ) VALUES (?, ?, ?, ?)
        `
      ).run(prStatusId.id, 'reviewer', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');

      await handleSlackMarkClosedNotifiedCommand({});

      const row = db
        .prepare('SELECT notified_at FROM pr_review_request WHERE reviewer = ?')
        .get('reviewer') as { notified_at: string | null };
      expect(row.notified_at).not.toBeNull();
    });

    test('dry run does not change pending closed PR notifications', async () => {
      const db = getDatabase();
      const prStatusId = db
        .prepare(
          `
            INSERT INTO pr_status (
              pr_url,
              owner,
              repo,
              pr_number,
              author,
              title,
              state,
              draft,
              last_fetched_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
          `
        )
        .get(
          'https://github.com/testowner/testrepo/pull/10',
          OWNER,
          REPO,
          10,
          'alice',
          'Closed PR',
          'closed',
          0,
          '2026-01-01T00:00:00.000Z'
        ) as { id: number };
      db.prepare(
        `
          INSERT INTO pr_review_request (
            pr_status_id,
            reviewer,
            requested_at,
            last_event_at
          ) VALUES (?, ?, ?, ?)
        `
      ).run(prStatusId.id, 'reviewer', '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z');

      await handleSlackMarkClosedNotifiedCommand({ dryRun: true });

      const row = db
        .prepare('SELECT notified_at FROM pr_review_request WHERE reviewer = ?')
        .get('reviewer') as { notified_at: string | null };
      expect(row.notified_at).toBeNull();
    });
  });

  describe('handleSlackMapCommand', () => {
    test('happy path: upserts into slack_user_map', async () => {
      await handleSlackMapCommand('alice', 'U123ALICE', { workspace: WORKSPACE_NAME }, fakeCommand);

      const db = getDatabase();
      const row = getUserMapping(db, WORKSPACE_NAME, 'alice');
      expect(row).toBeDefined();
      expect(row!.slack_user_id).toBe('U123ALICE');
      expect(row!.workspace).toBe(WORKSPACE_NAME);
    });

    test('happy path: upserts with optional display name', async () => {
      await handleSlackMapCommand(
        'bob',
        'U456BOB',
        { workspace: WORKSPACE_NAME, display: 'Bob Smith' },
        fakeCommand
      );

      const db = getDatabase();
      const row = getUserMapping(db, WORKSPACE_NAME, 'bob');
      expect(row).toBeDefined();
      expect(row!.slack_display).toBe('Bob Smith');
    });

    test('validation error: unknown workspace throws', async () => {
      await expect(
        handleSlackMapCommand('alice', 'U123', { workspace: 'no-such-ws' }, fakeCommand)
      ).rejects.toThrow('is not configured');
    });

    test('validation error: missing workspace throws', async () => {
      await expect(
        handleSlackMapCommand('alice', 'U123', { workspace: '' }, fakeCommand)
      ).rejects.toThrow('Missing required option');
    });
  });

  describe('handleSlackUnmapCommand', () => {
    test('removes an existing mapping', async () => {
      const db = getDatabase();
      upsertUserMapping(db, {
        workspace: WORKSPACE_NAME,
        githubLogin: 'carol',
        slackUserId: 'UCAROL',
      });

      await handleSlackUnmapCommand('carol', { workspace: WORKSPACE_NAME }, fakeCommand);

      expect(getUserMapping(db, WORKSPACE_NAME, 'carol')).toBeUndefined();
    });

    test('does not throw when no mapping exists (no-op)', async () => {
      await expect(
        handleSlackUnmapCommand('nobody', { workspace: WORKSPACE_NAME }, fakeCommand)
      ).resolves.not.toThrow();
    });

    test('validation error: unknown workspace throws', async () => {
      await expect(
        handleSlackUnmapCommand('alice', { workspace: 'no-such-ws' }, fakeCommand)
      ).rejects.toThrow('is not configured');
    });

    test('validation error: missing workspace throws', async () => {
      await expect(
        handleSlackUnmapCommand('alice', { workspace: '' }, fakeCommand)
      ).rejects.toThrow('Missing required option');
    });
  });

  describe('handleSlackListCommand', () => {
    test('happy path: runs without throwing and lists mappings', async () => {
      const db = getDatabase();
      upsertUserMapping(db, {
        workspace: WORKSPACE_NAME,
        githubLogin: 'alice',
        slackUserId: 'UA',
      });
      upsertUserMapping(db, {
        workspace: WORKSPACE_NAME,
        githubLogin: 'bob',
        slackUserId: 'UB',
      });

      await expect(handleSlackListCommand({}, fakeCommand)).resolves.not.toThrow();
    });

    test('prints daily digest status in the project setting summary', async () => {
      await handleSlackEnableCommand(
        { workspace: WORKSPACE_NAME, channel: '#reviews' },
        fakeCommand
      );
      await handleSlackDigestEnableCommand({}, fakeCommand);

      await handleSlackListCommand({}, fakeCommand);

      const { log } = await import('../../logging.js');
      expect(vi.mocked(log)).toHaveBeenCalledWith(
        'Slack setting: enabled, workspace=work, channel=#reviews, dailyDigest=enabled'
      );
    });

    test('filters by workspace when --workspace is given', async () => {
      const db = getDatabase();
      upsertUserMapping(db, {
        workspace: WORKSPACE_NAME,
        githubLogin: 'alice',
        slackUserId: 'UA',
      });
      upsertUserMapping(db, {
        workspace: 'personal',
        githubLogin: 'alice',
        slackUserId: 'UA-PERSONAL',
      });

      // Filtering by work workspace should not throw
      await expect(
        handleSlackListCommand({ workspace: WORKSPACE_NAME }, fakeCommand)
      ).resolves.not.toThrow();
    });

    test('validation error: unknown workspace in --workspace filter throws', async () => {
      await expect(
        handleSlackListCommand({ workspace: 'no-such-ws' }, fakeCommand)
      ).rejects.toThrow('is not configured');
    });
  });

  describe('missing project (loud error)', () => {
    test('throws "Project not found" when no project row exists for the resolved repo', async () => {
      // Point getGitRepository at a different repo that has no project row
      vi.mocked(getGitRepository).mockResolvedValue('unknown/repo');

      await expect(handleSlackListCommand({}, fakeCommand)).rejects.toThrow('Project not found');
    });

    test('handleSlackEnableCommand also throws when project is missing', async () => {
      vi.mocked(getGitRepository).mockResolvedValue('unknown/repo');

      await expect(
        handleSlackEnableCommand({ workspace: WORKSPACE_NAME, channel: '#ch' }, fakeCommand)
      ).rejects.toThrow('Project not found');
    });
  });
});
