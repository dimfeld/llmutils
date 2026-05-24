import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { getProjectSetting } from '../db/project_settings.js';
import { getUserMapping, upsertUserMapping } from '../db/slack_user_map.js';
import {
  handleSlackDisableCommand,
  handleSlackEnableCommand,
  handleSlackListCommand,
  handleSlackMarkClosedNotifiedCommand,
  handleSlackMapCommand,
  handleSlackTestCommand,
  handleSlackUnmapCommand,
} from './slack.js';
import type { SlackPostResult, SlackPostSenderArgs } from '../../common/slack/slack_client.js';

const OWNER = 'testowner';
const REPO = 'testrepo';
const REPOSITORY_ID = constructGitHubRepositoryId(OWNER, REPO);
const WORKSPACE_NAME = 'work';
const SLACK_PROJECT_SETTING_KEY = 'slack';

const configWithWorkspace = {
  slack: {
    workspaces: {
      [WORKSPACE_NAME]: { token: 'xoxb-test-token' },
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
