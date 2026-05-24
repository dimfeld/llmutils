import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import {
  postReviewRequestMessage,
  type ReviewRequestReviewer,
  type SlackPostSender,
} from '$common/slack/slack_client.js';
import { resolveSlackWorkspaceToken } from '$common/slack/slack_config.js';
import {
  parseSlackProjectSetting,
  SLACK_PROJECT_SETTING_KEY,
} from '$common/slack/slack_project_setting.js';
import type { TimConfig } from '$tim/configSchema.js';
import { getProject } from '$tim/db/project.js';
import { getProjectSetting } from '$tim/db/project_settings.js';
import {
  getPendingReviewRequestNotifications,
  markReviewRequestsNotified,
  type PendingReviewRequestNotification,
} from '$tim/db/pr_review_request_notifications.js';
import { getUserMapping } from '$tim/db/slack_user_map.js';

import type { SlackNotifierHandle } from './session_context.js';
import { isWebhookPollingEnabled } from './webhook_poller.js';

const DEFAULT_NOTIFIER_INTERVAL_MS = 15_000;
const DEFAULT_DEBOUNCE_MS = 30_000;

export interface StartSlackNotifierOptions {
  sender?: SlackPostSender;
  intervalMs?: number;
  debounceMs?: number;
}

export interface RunSlackNotifierOnceOptions {
  sender?: SlackPostSender;
  debounceMs?: number;
  nowMs?: number;
  loggedMisconfiguredWorkspaces?: Set<string>;
}

interface PendingPrGroup {
  prStatusId: number;
  owner: string;
  repo: string;
  prUrl: string;
  prNumber: number;
  title: string;
  author: string;
  rows: PendingReviewRequestNotification[];
}

export function shouldRunSlackNotifier(config: TimConfig): boolean {
  return Object.keys(config.slack?.workspaces ?? {}).length > 0;
}

export function shouldStartSlackNotifier(config: TimConfig): boolean {
  return isWebhookPollingEnabled() && shouldRunSlackNotifier(config);
}

function groupPendingNotifications(pending: PendingReviewRequestNotification[]): PendingPrGroup[] {
  const groups = new Map<number, PendingPrGroup>();

  for (const row of pending) {
    const existing = groups.get(row.pr_status_id);
    if (existing) {
      existing.rows.push(row);
      continue;
    }

    groups.set(row.pr_status_id, {
      prStatusId: row.pr_status_id,
      owner: row.owner,
      repo: row.repo,
      prUrl: row.pr_url,
      prNumber: row.pr_number,
      title: row.title,
      author: row.author,
      rows: [row],
    });
  }

  return [...groups.values()];
}

function getMaxRequestedAtMs(group: PendingPrGroup): number | null {
  let maxRequestedAtMs: number | null = null;

  for (const row of group.rows) {
    if (!row.requested_at) {
      return null;
    }

    const requestedAtMs = Date.parse(row.requested_at);
    if (!Number.isFinite(requestedAtMs)) {
      return null;
    }

    maxRequestedAtMs =
      maxRequestedAtMs === null ? requestedAtMs : Math.max(maxRequestedAtMs, requestedAtMs);
  }

  return maxRequestedAtMs;
}

function buildReviewers(
  db: Database,
  workspace: string,
  rows: PendingReviewRequestNotification[]
): ReviewRequestReviewer[] {
  // Team review requests are not inserted into pr_review_request today; rows here are individual
  // GitHub logins from requested_reviewer payloads.
  return rows.map((row) => {
    const mapping = getUserMapping(db, workspace, row.reviewer);
    return {
      githubLogin: row.reviewer,
      slackUserId: mapping?.slack_user_id ?? null,
    };
  });
}

async function processPendingPrGroup(
  db: Database,
  config: TimConfig,
  group: PendingPrGroup,
  options: Required<Pick<RunSlackNotifierOnceOptions, 'debounceMs' | 'nowMs'>> &
    Pick<RunSlackNotifierOnceOptions, 'sender' | 'loggedMisconfiguredWorkspaces'>
): Promise<void> {
  const repositoryId = constructGitHubRepositoryId(group.owner, group.repo);
  const project = getProject(db, repositoryId);
  if (!project) {
    return;
  }

  const setting = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );
  const workspace = setting?.workspace?.trim();
  const channel = setting?.channel?.trim();
  if (setting?.enabled !== true || !workspace || !channel) {
    return;
  }

  try {
    resolveSlackWorkspaceToken(config, workspace);
  } catch (error) {
    if (
      !options.loggedMisconfiguredWorkspaces ||
      !options.loggedMisconfiguredWorkspaces.has(workspace)
    ) {
      console.error(
        `[slack_notifier] Slack is enabled for ${group.owner}/${group.repo}, but workspace "${workspace}" is not usable; skipping notification for ${group.prUrl}`,
        error
      );
      options.loggedMisconfiguredWorkspaces?.add(workspace);
    }
    return;
  }

  const maxRequestedAtMs = getMaxRequestedAtMs(group);
  if (maxRequestedAtMs === null) {
    console.warn(
      `[slack_notifier] Skipping ${group.prUrl}; pending review request has missing or invalid requested_at`
    );
    return;
  }
  if (options.nowMs - maxRequestedAtMs < options.debounceMs) {
    return;
  }

  const reviewers = buildReviewers(db, workspace, group.rows);
  const result = await postReviewRequestMessage({
    config,
    workspace,
    channel,
    pr: {
      title: group.title,
      url: group.prUrl,
      author: group.author,
      number: group.prNumber,
      owner: group.owner,
      repo: group.repo,
    },
    reviewers,
    sender: options.sender,
  });

  if (!result.ok) {
    console.warn(
      `[slack_notifier] Failed to post review-request notification for ${group.prUrl}: ${result.error ?? 'unknown Slack error'}`
    );
    return;
  }

  markReviewRequestsNotified(
    db,
    group.rows.map((row) => ({ id: row.id, request_version: row.request_version }))
  );
  console.info(
    `[slack_notifier] Posted review-request notification for ${group.prUrl} to ${workspace}/${channel}`
  );
}

export async function runSlackNotifierOnce(
  db: Database,
  config: TimConfig,
  options: RunSlackNotifierOnceOptions = {}
): Promise<void> {
  const pending = getPendingReviewRequestNotifications(db);
  if (pending.length === 0) {
    return;
  }

  const runOptions = {
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    nowMs: options.nowMs ?? Date.now(),
    sender: options.sender,
    loggedMisconfiguredWorkspaces: options.loggedMisconfiguredWorkspaces,
  };

  for (const group of groupPendingNotifications(pending)) {
    try {
      await processPendingPrGroup(db, config, group, runOptions);
    } catch (error) {
      console.error(
        `[slack_notifier] Failed to process pending review-request notifications for ${group.prUrl}`,
        error
      );
    }
  }
}

export function startSlackNotifier(
  db: Database,
  config: TimConfig,
  options: StartSlackNotifierOptions = {}
): SlackNotifierHandle | null {
  if (!shouldRunSlackNotifier(config)) {
    return null;
  }

  const intervalMs = options.intervalMs ?? DEFAULT_NOTIFIER_INTERVAL_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let inProgress = false;
  let stopped = false;
  const loggedMisconfiguredWorkspaces = new Set<string>();

  const runNotifier = async (): Promise<void> => {
    if (inProgress || stopped) {
      return;
    }

    inProgress = true;
    try {
      await runSlackNotifierOnce(db, config, {
        sender: options.sender,
        debounceMs,
        loggedMisconfiguredWorkspaces,
      });
    } catch (error) {
      console.error('[slack_notifier] Notification tick failed', error);
    } finally {
      inProgress = false;
    }
  };

  intervalTimer = setInterval(() => {
    void runNotifier();
  }, intervalMs);
  intervalTimer.unref?.();

  console.info(`[slack_notifier] Started review-request notifier every ${intervalMs / 1000}s`);

  return {
    stop: (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }

      console.info('[slack_notifier] Stopped review-request notifier');
    },
    kick: runNotifier,
  };
}
