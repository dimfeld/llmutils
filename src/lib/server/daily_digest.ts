import type { Database } from 'bun:sqlite';

import { parseOwnerRepoFromRepositoryId } from '$common/github/pull_requests.js';
import {
  DEFAULT_SLACK_DAILY_DIGEST_WEEKDAYS,
  DEFAULT_SLACK_DAILY_DIGEST_STALE_AFTER_HOURS,
  DEFAULT_SLACK_DAILY_DIGEST_TIME,
  getDefaultSlackDailyDigestTimezone,
  parseSlackDailyDigestTime,
  slackDailyDigestWeekdayToDayIndex,
} from '$common/slack/slack_daily_digest_config.js';
import { postDailyDigestMessage, type SlackPostSender } from '$common/slack/slack_client.js';
import { resolveSlackWorkspaceToken } from '$common/slack/slack_config.js';
import {
  parseSlackProjectSetting,
  SLACK_PROJECT_SETTING_KEY,
} from '$common/slack/slack_project_setting.js';
import type { TimConfig } from '$tim/configSchema.js';
import { listProjects } from '$tim/db/project.js';
import { getProjectSetting } from '$tim/db/project_settings.js';
import { getApprovedUnmergedRows, getStaleReviewRequestRows } from '$tim/db/pr_digest.js';

import { computeNextFireMs } from './digest_schedule.js';
import { buildPrDigest, type PrDigest } from './pr_digest.js';
import type { DailyDigestSchedulerHandle } from './session_context.js';
import { isWebhookPollingEnabled } from './webhook_poller.js';

const MAX_TIMEOUT_MS = 2_147_483_647;

export interface RunDailyDigestOptions {
  sender?: SlackPostSender;
  nowMs?: number;
  loggedMisconfiguredWorkspaces?: Set<string>;
}

export interface StartDailyDigestSchedulerOptions {
  sender?: SlackPostSender;
  nowMs?: () => number;
}

export interface CollectedProjectDigest {
  workspaceName: string;
  owner: string;
  repo: string;
  repoFullName: string;
  channel: string;
  digest: PrDigest;
}

export interface CollectDailyDigestsOptions {
  nowMs?: number;
  includeEmpty?: boolean;
  onProjectError?: (repositoryId: string, error: unknown) => void;
}

export function getEligibleDailyDigestWorkspaces(db: Database, config: TimConfig): string[] {
  const configuredWorkspaces = new Set(Object.keys(config.slack?.workspaces ?? {}));
  if (configuredWorkspaces.size === 0) {
    return [];
  }

  const eligibleWorkspaces = new Set<string>();
  for (const project of listProjects(db)) {
    const setting = parseSlackProjectSetting(
      getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
    );
    const workspace = setting?.workspace?.trim();
    const channel = setting?.channel?.trim();
    if (
      setting?.enabled === true &&
      setting.dailyDigest === true &&
      workspace &&
      channel &&
      configuredWorkspaces.has(workspace)
    ) {
      eligibleWorkspaces.add(workspace);
    }
  }

  return [...eligibleWorkspaces].sort();
}

export function shouldStartDailyDigest(db: Database, config: TimConfig): boolean {
  return isWebhookPollingEnabled() && getEligibleDailyDigestWorkspaces(db, config).length > 0;
}

export function collectDailyDigestsForWorkspace(
  db: Database,
  config: TimConfig,
  workspaceName: string,
  options: CollectDailyDigestsOptions = {}
): CollectedProjectDigest[] {
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterHours =
    config.slack?.workspaces?.[workspaceName]?.dailyDigest?.staleAfterHours ??
    DEFAULT_SLACK_DAILY_DIGEST_STALE_AFTER_HOURS;
  const collected: CollectedProjectDigest[] = [];

  for (const project of listProjects(db)) {
    try {
      const setting = parseSlackProjectSetting(
        getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
      );
      const workspace = setting?.workspace?.trim();
      const channel = setting?.channel?.trim();

      if (
        setting?.enabled !== true ||
        setting.dailyDigest !== true ||
        workspace !== workspaceName ||
        !channel
      ) {
        continue;
      }

      const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
      if (!ownerRepo) {
        continue;
      }

      const approvedUnmergedRows = getApprovedUnmergedRows(db, ownerRepo.owner, ownerRepo.repo);
      const staleReviewRequestRows = getStaleReviewRequestRows(
        db,
        ownerRepo.owner,
        ownerRepo.repo,
        {
          nowMs,
        }
      );
      const digest = buildPrDigest(
        { approvedUnmergedRows, staleReviewRequestRows },
        { nowMs, staleAfterHours }
      );

      if (
        options.includeEmpty !== true &&
        digest.approvedUnmerged.length === 0 &&
        digest.staleAwaitingReview.length === 0
      ) {
        continue;
      }

      const repoFullName = `${ownerRepo.owner}/${ownerRepo.repo}`;
      collected.push({
        workspaceName,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        repoFullName,
        channel,
        digest,
      });
    } catch (error) {
      if (options.onProjectError) {
        options.onProjectError(project.repository_id, error);
        continue;
      }

      throw error;
    }
  }

  return collected;
}

export async function runDailyDigestForWorkspace(
  db: Database,
  config: TimConfig,
  workspaceName: string,
  options: RunDailyDigestOptions = {}
): Promise<void> {
  try {
    resolveSlackWorkspaceToken(config, workspaceName);
  } catch (error) {
    if (
      !options.loggedMisconfiguredWorkspaces ||
      !options.loggedMisconfiguredWorkspaces.has(workspaceName)
    ) {
      console.error(
        `[daily_digest] Slack workspace "${workspaceName}" is not usable; skipping daily digest run for any of its projects`,
        error
      );
      options.loggedMisconfiguredWorkspaces?.add(workspaceName);
    }
    return;
  }

  const nowMs = options.nowMs ?? Date.now();

  const collected = collectDailyDigestsForWorkspace(db, config, workspaceName, {
    nowMs,
    onProjectError: (repositoryId: string, error: unknown): void => {
      console.error(
        `[daily_digest] Failed to process daily PR digest for project ${repositoryId}`,
        error
      );
    },
  });

  for (const projectDigest of collected) {
    try {
      const result = await postDailyDigestMessage({
        config,
        workspace: workspaceName,
        channel: projectDigest.channel,
        repoFullName: projectDigest.repoFullName,
        digest: projectDigest.digest,
        sender: options.sender,
      });

      if (!result.ok) {
        console.warn(
          `[daily_digest] Failed to post daily PR digest for ${projectDigest.repoFullName}: ${result.error ?? 'unknown Slack error'}`
        );
        continue;
      }

      console.info(
        `[daily_digest] Posted daily PR digest for ${projectDigest.repoFullName} to ${workspaceName}/${projectDigest.channel}`
      );
    } catch (error) {
      console.error(
        `[daily_digest] Failed to process daily PR digest for project ${projectDigest.repoFullName}`,
        error
      );
    }
  }
}

export async function runAllDailyDigests(
  db: Database,
  config: TimConfig,
  options: RunDailyDigestOptions = {}
): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const loggedMisconfiguredWorkspaces = options.loggedMisconfiguredWorkspaces ?? new Set<string>();

  for (const workspaceName of Object.keys(config.slack?.workspaces ?? {})) {
    await runDailyDigestForWorkspace(db, config, workspaceName, {
      sender: options.sender,
      nowMs,
      loggedMisconfiguredWorkspaces,
    });
  }
}

export function startDailyDigestScheduler(
  db: Database,
  config: TimConfig,
  options: StartDailyDigestSchedulerOptions = {}
): DailyDigestSchedulerHandle | null {
  if (!shouldStartDailyDigest(db, config)) {
    return null;
  }

  const workspaceNames = getEligibleDailyDigestWorkspaces(db, config);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inProgressWorkspaces = new Set<string>();
  const loggedMisconfiguredWorkspaces = new Set<string>();
  let stopped = false;

  const nowMs = (): number => options.nowMs?.() ?? Date.now();

  const clearWorkspaceTimer = (workspaceName: string): void => {
    const timer = timers.get(workspaceName);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    timers.delete(workspaceName);
  };

  const runWorkspace = async (workspaceName: string): Promise<void> => {
    if (stopped || inProgressWorkspaces.has(workspaceName)) {
      return;
    }

    inProgressWorkspaces.add(workspaceName);
    try {
      await runDailyDigestForWorkspace(db, config, workspaceName, {
        sender: options.sender,
        nowMs: nowMs(),
        loggedMisconfiguredWorkspaces,
      });
    } catch (error) {
      console.error(
        `[daily_digest] Digest scheduler tick failed for workspace "${workspaceName}"`,
        error
      );
    } finally {
      inProgressWorkspaces.delete(workspaceName);
    }
  };

  const scheduleWorkspace = (workspaceName: string): void => {
    if (stopped) {
      return;
    }

    const workspaceConfig = config.slack?.workspaces?.[workspaceName];
    const { hour, minute } = parseSlackDailyDigestTime(
      workspaceConfig?.dailyDigest?.time ?? DEFAULT_SLACK_DAILY_DIGEST_TIME
    );
    const timeZone = workspaceConfig?.dailyDigest?.timezone ?? getDefaultSlackDailyDigestTimezone();
    const weekdays = workspaceConfig?.dailyDigest?.weekdays ?? DEFAULT_SLACK_DAILY_DIGEST_WEEKDAYS;
    const weekdayIndexes = new Set(weekdays.map(slackDailyDigestWeekdayToDayIndex));
    const weekdaySummary = [...weekdays].sort().join(',');
    const currentMs = nowMs();
    const targetMs = computeNextFireMs(currentMs, timeZone, hour, minute, weekdayIndexes);
    const delayMs = Math.min(Math.max(targetMs - currentMs, 0), MAX_TIMEOUT_MS);

    clearWorkspaceTimer(workspaceName);
    const timer = setTimeout(() => {
      timers.delete(workspaceName);
      void (async (): Promise<void> => {
        try {
          await runWorkspace(workspaceName);
        } finally {
          // Always re-arm the next tick, even if the run threw, so one bad cycle cannot
          // permanently silence a workspace's digest until restart.
          try {
            scheduleWorkspace(workspaceName);
          } catch (error) {
            console.error(
              `[daily_digest] Failed to reschedule daily digest for workspace "${workspaceName}"`,
              error
            );
          }
        }
      })();
    }, delayMs);
    timer.unref?.();
    timers.set(workspaceName, timer);

    console.info(
      `[daily_digest] Scheduled workspace "${workspaceName}" daily PR digest for ${new Date(targetMs).toISOString()} (${timeZone} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}, weekdays=${weekdaySummary})`
    );
  };

  for (const workspaceName of workspaceNames) {
    scheduleWorkspace(workspaceName);
  }

  console.info(
    `[daily_digest] Started daily PR digest scheduler for ${workspaceNames.length} workspace(s)`
  );

  return {
    stop: (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      for (const workspaceName of timers.keys()) {
        clearWorkspaceTimer(workspaceName);
      }

      console.info('[daily_digest] Stopped daily PR digest scheduler');
    },
    runNow: async (): Promise<void> => {
      // Route through the same guarded path as scheduled ticks so a manual run never double-posts
      // a workspace that is mid-tick and never posts after stop().
      for (const workspaceName of workspaceNames) {
        await runWorkspace(workspaceName);
      }
    },
  };
}
