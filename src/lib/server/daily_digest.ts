import type { Database } from 'bun:sqlite';

import { readDotEnvFromDirectory } from '$common/env.js';
import {
  constructGitHubRepositoryId,
  parseOwnerRepoFromRepositoryId,
} from '$common/github/pull_requests.js';
import {
  fetchLinearMilestonesDueOrOverdue,
  type LinearMilestoneDigestEntry,
} from '$common/linear_milestone_digest.js';
import {
  DEFAULT_SLACK_DAILY_DIGEST_WEEKDAYS,
  DEFAULT_SLACK_DAILY_DIGEST_TIME,
  getDefaultSlackDailyDigestTimezone,
  parseSlackDailyDigestTime,
  slackDailyDigestWeekdayToDayIndex,
} from '$common/slack/slack_daily_digest_config.js';
import {
  getSlackPinSender,
  getSlackUnpinSender,
  postDailyDigestMessage,
  updateDailyDigestMessage,
  type SlackPinSender,
  type SlackPostSender,
  type SlackUpdateSender,
} from '$common/slack/slack_client.js';
import { resolveSlackWorkspaceToken } from '$common/slack/slack_config.js';
import {
  parseSlackProjectSetting,
  SLACK_PROJECT_SETTING_KEY,
} from '$common/slack/slack_project_setting.js';
import type { TimConfig } from '$tim/configSchema.js';
import { debug as debugEnabled } from '../../common/process_state.js';
import { debugLog } from '../../logging.js';
import { listProjects, type Project } from '$tim/db/project.js';
import { getProjectSetting } from '$tim/db/project_settings.js';
import {
  getLatestSlackDailyDigestMessage,
  getLatestSlackDailyDigestMessageBeforeDate,
  getSameDaySlackDailyDigestMessage,
  type SlackDailyDigestMessageRow,
  upsertSlackDailyDigestMessage,
} from '$tim/db/slack_daily_digest_message.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import {
  getApprovedUnmergedRows,
  getAwaitingReviewResponseRows,
  getOtherReadyForReviewRows,
  getReviewRequestDebugRows,
  getStaleReviewRequestRows,
  type ReviewRequestDebugRow,
} from '$tim/db/pr_digest.js';

import { computeNextFireMs } from './digest_schedule.js';
import { buildPrDigest, type PrDigest } from './pr_digest.js';
import type { DailyDigestSchedulerHandle } from './session_context.js';
import { isWebhookPollingEnabled } from './webhook_poller.js';

const MAX_TIMEOUT_MS = 2_147_483_647;
const LINEAR_MILESTONE_CACHE_TTL_MS = 30 * 60 * 1000;

interface CachedLinearMilestones {
  expiresAtMs: number;
  entries: LinearMilestoneDigestEntry[];
}

const linearMilestoneCache = new Map<string, CachedLinearMilestones>();

export interface RunDailyDigestOptions {
  sender?: SlackPostSender;
  updateSender?: SlackUpdateSender;
  pinSender?: SlackPinSender;
  unpinSender?: SlackPinSender;
  nowMs?: number;
  loggedMisconfiguredWorkspaces?: Set<string>;
  linearMilestonesFetcher?: LinearMilestonesFetcher;
  updateExistingOnly?: boolean;
  repoFullNames?: ReadonlySet<string>;
  pinUpdatedExisting?: boolean;
}

export interface StartDailyDigestSchedulerOptions {
  sender?: SlackPostSender;
  pinSender?: SlackPinSender;
  unpinSender?: SlackPinSender;
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

export interface FetchWorkspaceLinearMilestonesOptions {
  nowMs: number;
  fetcher?: LinearMilestonesFetcher;
}

export type LinearMilestonesFetcher = (args: {
  nowMs: number;
  timezone: string;
  apiKey?: string;
}) => Promise<LinearMilestoneDigestEntry[]>;

export function clearLinearMilestoneCache(): void {
  linearMilestoneCache.clear();
}

function buildLinearMilestoneCacheKey(args: {
  workspaceName: string;
  timezone: string;
  apiKeyEnv: string;
}): string {
  return JSON.stringify(args);
}

function isDailyDigestEnabledForWorkspace(config: TimConfig, workspaceName: string): boolean {
  return config.slack?.workspaces?.[workspaceName]?.dailyDigest?.enabled === true;
}

export function getEligibleDailyDigestWorkspaces(db: Database, config: TimConfig): string[] {
  const configuredWorkspaces = new Set(
    Object.entries(config.slack?.workspaces ?? {})
      .filter(([, workspaceConfig]) => workspaceConfig.dailyDigest?.enabled === true)
      .map(([workspaceName]) => workspaceName)
  );
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
  if (!isDailyDigestEnabledForWorkspace(config, workspaceName)) {
    return [];
  }

  const nowMs = options.nowMs ?? Date.now();
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
      const awaitingReviewResponseRows = getAwaitingReviewResponseRows(
        db,
        ownerRepo.owner,
        ownerRepo.repo,
        {
          nowMs,
        }
      );
      const otherReadyForReviewRows = getOtherReadyForReviewRows(
        db,
        ownerRepo.owner,
        ownerRepo.repo,
        {
          nowMs,
        }
      );
      const digest = buildPrDigest(
        {
          approvedUnmergedRows,
          staleReviewRequestRows,
          awaitingReviewResponseRows,
          otherReadyForReviewRows,
        },
        { nowMs }
      );
      const repoFullName = `${ownerRepo.owner}/${ownerRepo.repo}`;

      if (debugEnabled) {
        debugLog(
          '[daily_digest] PR digest input for %s: approvedRows=%d staleRequestRows=%d awaitingResponseRows=%d otherReadyRows=%d outputApproved=%d outputAwaiting=%d outputAwaitingResponse=%d outputOtherReady=%d',
          repoFullName,
          approvedUnmergedRows.length,
          staleReviewRequestRows.length,
          awaitingReviewResponseRows.length,
          otherReadyForReviewRows.length,
          digest.approvedUnmerged.length,
          digest.staleAwaitingReview.length,
          digest.awaitingReviewResponse.length,
          digest.otherReadyForReview.length
        );
        logReviewRequestDebugRows(
          repoFullName,
          getReviewRequestDebugRows(db, ownerRepo.owner, ownerRepo.repo)
        );
      }

      if (
        options.includeEmpty !== true &&
        digest.approvedUnmerged.length === 0 &&
        digest.staleAwaitingReview.length === 0 &&
        digest.awaitingReviewResponse.length === 0 &&
        digest.otherReadyForReview.length === 0
      ) {
        continue;
      }

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

/**
 * Computes the PR digest for a single project regardless of whether its Slack daily digest is
 * enabled. Used by the `slack digest run --dry-run` flow so the current project always shows its
 * digest. Returns null when the project's repository id is not a parseable GitHub repo.
 *
 * `workspaceName`/`channel` fall back to placeholders when the project has no Slack setting, since
 * a not-yet-enabled project may not have either configured.
 */
export function collectProjectDigest(
  db: Database,
  project: Project,
  options: CollectDailyDigestsOptions = {}
): CollectedProjectDigest | null {
  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
  if (!ownerRepo) {
    return null;
  }

  const nowMs = options.nowMs ?? Date.now();
  const setting = parseSlackProjectSetting(
    getProjectSetting(db, project.id, SLACK_PROJECT_SETTING_KEY)
  );

  const approvedUnmergedRows = getApprovedUnmergedRows(db, ownerRepo.owner, ownerRepo.repo);
  const staleReviewRequestRows = getStaleReviewRequestRows(db, ownerRepo.owner, ownerRepo.repo, {
    nowMs,
  });
  const awaitingReviewResponseRows = getAwaitingReviewResponseRows(
    db,
    ownerRepo.owner,
    ownerRepo.repo,
    {
      nowMs,
    }
  );
  const otherReadyForReviewRows = getOtherReadyForReviewRows(db, ownerRepo.owner, ownerRepo.repo, {
    nowMs,
  });
  const digest = buildPrDigest(
    {
      approvedUnmergedRows,
      staleReviewRequestRows,
      awaitingReviewResponseRows,
      otherReadyForReviewRows,
    },
    { nowMs }
  );

  return {
    workspaceName: setting?.workspace?.trim() || '(no workspace)',
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
    repoFullName: `${ownerRepo.owner}/${ownerRepo.repo}`,
    channel: setting?.channel?.trim() || '(no channel)',
    digest,
  };
}

function logReviewRequestDebugRows(
  repoFullName: string,
  rows: ReadonlyArray<ReviewRequestDebugRow>
): void {
  if (rows.length === 0) {
    debugLog(
      '[daily_digest] Review request debug for %s: no open non-draft PR reviews/requests',
      repoFullName
    );
    return;
  }

  for (const row of rows) {
    const requestState =
      row.request_reviewer === null
        ? 'no-request'
        : row.removed_at === null
          ? 'active-request'
          : 'removed-request';
    const clearingReview =
      row.clearing_review_author === null
        ? 'none'
        : `${row.clearing_review_author}:${row.clearing_review_state}@${row.clearing_review_submitted_at}`;
    const requestedReviewerClearingReview =
      row.pr_clearing_review_author === null
        ? 'none'
        : `${row.pr_clearing_review_author}:${row.pr_clearing_review_state}@${row.pr_clearing_review_submitted_at}`;
    const latestReviewerReview =
      row.latest_reviewer_review_state === null
        ? 'none'
        : `${row.latest_reviewer_review_state}@${row.latest_reviewer_review_submitted_at}`;
    const latestPrReviews = row.latest_pr_reviews?.replaceAll('\n', ', ') ?? 'none';

    debugLog(
      '[daily_digest] Review request debug for %s#%d: title=%o author=%s reviewDecision=%s readyAt=%s requestReviewer=%s requestState=%s requestedAt=%s removedAt=%s requestVersion=%s latestActiveRequestedAt=%s requestedReviewerClearingReview=%s reviewerClearingReview=%s latestReviewerReview=%s latestPrReviews=[%s]',
      repoFullName,
      row.pr_number,
      row.title,
      row.author,
      row.review_decision ?? 'null',
      row.ready_at ?? 'null',
      row.request_reviewer ?? 'null',
      requestState,
      row.requested_at ?? 'null',
      row.removed_at ?? 'null',
      row.request_version === null ? 'null' : String(row.request_version),
      row.latest_active_requested_at ?? 'null',
      requestedReviewerClearingReview,
      clearingReview,
      latestReviewerReview,
      latestPrReviews
    );
  }
}

function isPrDigestEmpty(digest: PrDigest): boolean {
  return (
    digest.approvedUnmerged.length === 0 &&
    digest.staleAwaitingReview.length === 0 &&
    digest.awaitingReviewResponse.length === 0 &&
    digest.otherReadyForReview.length === 0
  );
}

export function getWorkspaceDigestDate(
  config: TimConfig,
  workspaceName: string,
  nowMs: number
): string {
  const timezone =
    config.slack?.workspaces?.[workspaceName]?.dailyDigest?.timezone ??
    getDefaultSlackDailyDigestTimezone();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const values = new Map<string, string>();
  for (const part of formatter.formatToParts(new Date(nowMs))) {
    if (part.type !== 'literal') {
      values.set(part.type, part.value);
    }
  }

  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  if (!year || !month || !day) {
    throw new Error(`Failed to compute daily digest date for Slack workspace "${workspaceName}"`);
  }

  return `${year}-${month}-${day}`;
}

async function pinNewDailyDigestMessage(args: {
  token: string;
  workspaceName: string;
  repoFullName: string;
  newMessage: { channel: string; ts: string };
  previousMessage?: SlackDailyDigestMessageRow;
  pinSender?: SlackPinSender;
  unpinSender?: SlackPinSender;
}): Promise<void> {
  const pinSender = args.pinSender ?? getSlackPinSender(args.token);
  const pinResult = await pinSender({
    token: args.token,
    channel: args.newMessage.channel,
    ts: args.newMessage.ts,
  });

  if (!pinResult.ok) {
    console.warn(
      `[daily_digest] Failed to pin daily PR digest for ${args.repoFullName}: ${pinResult.error ?? 'unknown Slack error'}`
    );
    return;
  }

  const previousMessage = args.previousMessage;
  if (
    !previousMessage ||
    (previousMessage.slack_channel === args.newMessage.channel &&
      previousMessage.slack_ts === args.newMessage.ts)
  ) {
    return;
  }

  const unpinSender = args.unpinSender ?? getSlackUnpinSender(args.token);
  const unpinResult = await unpinSender({
    token: args.token,
    channel: previousMessage.slack_channel,
    ts: previousMessage.slack_ts,
  });

  if (!unpinResult.ok) {
    console.warn(
      `[daily_digest] Failed to unpin previous daily PR digest for ${args.repoFullName}: ${unpinResult.error ?? 'unknown Slack error'}`
    );
  }
}

function parseOwnerRepoFromPrUrl(prUrl: string): { owner: string; repo: string } | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(prUrl);
  } catch {
    return null;
  }

  if (parsedUrl.hostname !== 'github.com') {
    return null;
  }

  const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+$/.exec(parsedUrl.pathname);
  if (!match) {
    return null;
  }

  return { owner: match[1], repo: match[2] };
}

async function getLinearApiKeyFromProjectDotEnv(
  db: Database,
  projectId: number,
  apiKeyEnv: string
): Promise<string | undefined> {
  const gitRoot = getPreferredProjectGitRoot(db, projectId);
  if (!gitRoot) {
    return undefined;
  }

  const workspaceEnv = await readDotEnvFromDirectory(gitRoot);
  return workspaceEnv?.[apiKeyEnv]?.trim() || undefined;
}

async function resolveWorkspaceLinearApiKey(
  db: Database,
  workspaceName: string,
  apiKeyEnv: string
): Promise<string | undefined> {
  for (const project of listProjects(db)) {
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

    const apiKey = await getLinearApiKeyFromProjectDotEnv(db, project.id, apiKeyEnv);
    if (apiKey) {
      return apiKey;
    }
  }

  return process.env[apiKeyEnv]?.trim() || undefined;
}

export async function fetchWorkspaceLinearMilestones(
  db: Database,
  config: TimConfig,
  workspaceName: string,
  options: FetchWorkspaceLinearMilestonesOptions
): Promise<LinearMilestoneDigestEntry[]> {
  const dailyDigestConfig = config.slack?.workspaces?.[workspaceName]?.dailyDigest;
  const linearMilestonesConfig = dailyDigestConfig?.linearMilestones;
  if (linearMilestonesConfig?.enabled !== true) {
    debugLog('[daily_digest] Linear milestones disabled for Slack workspace "%s"', workspaceName);
    return [];
  }

  const apiKeyEnv = linearMilestonesConfig.apiKeyEnv ?? 'LINEAR_API_KEY';
  const apiKey = await resolveWorkspaceLinearApiKey(db, workspaceName, apiKeyEnv);
  debugLog(
    '[daily_digest] Linear milestones enabled for Slack workspace "%s"; apiKeyEnv=%s configured=%s',
    workspaceName,
    apiKeyEnv,
    apiKey ? 'yes' : 'no'
  );
  if (!apiKey) {
    throw new Error(
      `Slack daily digest Linear milestones are enabled for workspace "${workspaceName}", but ${apiKeyEnv} is not set.`
    );
  }

  const timezone =
    config.slack?.workspaces?.[workspaceName]?.dailyDigest?.timezone ??
    getDefaultSlackDailyDigestTimezone();
  const cacheKey = buildLinearMilestoneCacheKey({ workspaceName, timezone, apiKeyEnv });
  const cached = linearMilestoneCache.get(cacheKey);
  if (cached && options.nowMs < cached.expiresAtMs) {
    debugLog(
      '[daily_digest] Using cached Linear milestones for Slack workspace "%s"; entries=%d expiresInMs=%d',
      workspaceName,
      cached.entries.length,
      cached.expiresAtMs - options.nowMs
    );
    return cached.entries;
  }

  const fetcher = options.fetcher ?? fetchLinearMilestonesDueOrOverdue;
  const entries = await fetcher({ nowMs: options.nowMs, timezone, apiKey });
  linearMilestoneCache.set(cacheKey, {
    expiresAtMs: options.nowMs + LINEAR_MILESTONE_CACHE_TTL_MS,
    entries,
  });
  return entries;
}

export async function runDailyDigestForWorkspace(
  db: Database,
  config: TimConfig,
  workspaceName: string,
  options: RunDailyDigestOptions = {}
): Promise<void> {
  if (!isDailyDigestEnabledForWorkspace(config, workspaceName)) {
    return;
  }

  let token: string;
  try {
    token = resolveSlackWorkspaceToken(config, workspaceName);
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
  const digestDate = getWorkspaceDigestDate(config, workspaceName, nowMs);
  let linearMilestones: LinearMilestoneDigestEntry[] = [];
  try {
    linearMilestones = await fetchWorkspaceLinearMilestones(db, config, workspaceName, {
      nowMs,
      fetcher: options.linearMilestonesFetcher,
    });
  } catch (error) {
    console.warn(
      `[daily_digest] Failed to fetch Linear milestones for workspace ${workspaceName}; continuing with PR digest only`,
      error
    );
  }

  const collected = collectDailyDigestsForWorkspace(db, config, workspaceName, {
    nowMs,
    includeEmpty: options.updateExistingOnly === true || linearMilestones.length > 0,
    onProjectError: (repositoryId: string, error: unknown): void => {
      console.error(
        `[daily_digest] Failed to process daily PR digest for project ${repositoryId}`,
        error
      );
    },
  });

  const channelsWithPrContent = new Set(
    collected
      .filter((projectDigest) => !isPrDigestEmpty(projectDigest.digest))
      .map((projectDigest) => projectDigest.channel)
  );
  const milestoneChannels = new Set<string>();
  for (const projectDigest of collected) {
    try {
      if (options.repoFullNames && !options.repoFullNames.has(projectDigest.repoFullName)) {
        continue;
      }

      const existingMessage =
        options.updateExistingOnly === true
          ? getLatestSlackDailyDigestMessage(
              db,
              workspaceName,
              projectDigest.channel,
              projectDigest.repoFullName
            )
          : getSameDaySlackDailyDigestMessage(
              db,
              workspaceName,
              projectDigest.channel,
              projectDigest.repoFullName,
              digestDate
            );
      if (!existingMessage && options.updateExistingOnly === true) {
        continue;
      }
      const previousMessage =
        existingMessage && options.pinUpdatedExisting !== true
          ? undefined
          : getLatestSlackDailyDigestMessageBeforeDate(
              db,
              workspaceName,
              projectDigest.channel,
              projectDigest.repoFullName,
              existingMessage?.digest_date ?? digestDate
            );

      const includeMilestones =
        linearMilestones.length > 0 &&
        !milestoneChannels.has(projectDigest.channel) &&
        (!isPrDigestEmpty(projectDigest.digest) ||
          !channelsWithPrContent.has(projectDigest.channel));
      if (includeMilestones) {
        milestoneChannels.add(projectDigest.channel);
      }
      const digest = {
        ...projectDigest.digest,
        linearMilestones: includeMilestones ? linearMilestones : [],
      };
      const result = existingMessage
        ? await updateDailyDigestMessage({
            config,
            workspace: workspaceName,
            channel: existingMessage.slack_channel,
            ts: existingMessage.slack_ts,
            repoFullName: projectDigest.repoFullName,
            digest,
            sender: options.updateSender,
          })
        : await postDailyDigestMessage({
            config,
            workspace: workspaceName,
            channel: projectDigest.channel,
            repoFullName: projectDigest.repoFullName,
            digest,
            sender: options.sender,
          });

      const operation = existingMessage ? 'update' : 'post';
      if (!result.ok && existingMessage) {
        console.warn(
          `[daily_digest] Failed to update daily PR digest for ${projectDigest.repoFullName}: ${result.error ?? 'unknown Slack error'}; posting a replacement`
        );
        const replacement = await postDailyDigestMessage({
          config,
          workspace: workspaceName,
          channel: projectDigest.channel,
          repoFullName: projectDigest.repoFullName,
          digest,
          sender: options.sender,
          allowEmpty: true,
        });
        if (!replacement.ok) {
          console.warn(
            `[daily_digest] Failed to post replacement daily PR digest for ${projectDigest.repoFullName}: ${replacement.error ?? 'unknown Slack error'}`
          );
          continue;
        }
        if (replacement.channel && replacement.ts) {
          upsertSlackDailyDigestMessage(db, {
            workspace: workspaceName,
            channel: projectDigest.channel,
            repoFullName: projectDigest.repoFullName,
            digestDate,
            slackChannel: replacement.channel,
            slackTs: replacement.ts,
          });
          await pinNewDailyDigestMessage({
            token,
            workspaceName,
            repoFullName: projectDigest.repoFullName,
            newMessage: { channel: replacement.channel, ts: replacement.ts },
            previousMessage: existingMessage,
            pinSender: options.pinSender,
            unpinSender: options.unpinSender,
          });
        }
        continue;
      }

      if (!result.ok) {
        console.warn(
          `[daily_digest] Failed to ${operation} daily PR digest for ${projectDigest.repoFullName}: ${result.error ?? 'unknown Slack error'}`
        );
        continue;
      }

      if (result.channel && result.ts) {
        upsertSlackDailyDigestMessage(db, {
          workspace: workspaceName,
          channel: projectDigest.channel,
          repoFullName: projectDigest.repoFullName,
          digestDate,
          slackChannel: result.channel,
          slackTs: result.ts,
        });
        if (!existingMessage || options.pinUpdatedExisting === true) {
          await pinNewDailyDigestMessage({
            token,
            workspaceName,
            repoFullName: projectDigest.repoFullName,
            newMessage: { channel: result.channel, ts: result.ts },
            previousMessage,
            pinSender: options.pinSender,
            unpinSender: options.unpinSender,
          });
        }
      }

      console.info(
        `[daily_digest] ${existingMessage ? 'Updated' : 'Posted'} daily PR digest for ${projectDigest.repoFullName} to ${workspaceName}/${projectDigest.channel}`
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

  for (const workspaceName of getEligibleDailyDigestWorkspaces(db, config)) {
    await runDailyDigestForWorkspace(db, config, workspaceName, {
      sender: options.sender,
      updateSender: options.updateSender,
      pinSender: options.pinSender,
      unpinSender: options.unpinSender,
      nowMs,
      loggedMisconfiguredWorkspaces,
      linearMilestonesFetcher: options.linearMilestonesFetcher,
      updateExistingOnly: options.updateExistingOnly,
      repoFullNames: options.repoFullNames,
    });
  }
}

export async function updateDailyDigestMessagesForPrUrls(
  db: Database,
  config: TimConfig,
  prUrls: string[],
  options: RunDailyDigestOptions = {}
): Promise<void> {
  const affectedWorkspaces = new Set<string>();
  const affectedRepoFullNames = new Set<string>();
  const repositoryIds = new Set<string>();

  for (const prUrl of prUrls) {
    const ownerRepo = parseOwnerRepoFromPrUrl(prUrl);
    if (ownerRepo) {
      repositoryIds.add(constructGitHubRepositoryId(ownerRepo.owner, ownerRepo.repo));
      affectedRepoFullNames.add(`${ownerRepo.owner}/${ownerRepo.repo}`);
    }
  }

  if (repositoryIds.size === 0) {
    return;
  }

  for (const project of listProjects(db)) {
    if (!repositoryIds.has(project.repository_id)) {
      continue;
    }

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
      isDailyDigestEnabledForWorkspace(config, workspace)
    ) {
      affectedWorkspaces.add(workspace);
    }
  }

  for (const workspaceName of affectedWorkspaces) {
    await runDailyDigestForWorkspace(db, config, workspaceName, {
      ...options,
      updateExistingOnly: true,
      repoFullNames: affectedRepoFullNames,
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
        pinSender: options.pinSender,
        unpinSender: options.unpinSender,
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
