import type { TimConfig } from '../../tim/configSchema.js';
import { error } from '../../logging.js';
import type { LinearMilestoneDigestEntry } from '../linear_milestone_digest.js';
import { buildLinearPrReviewUrl } from '../linear_pr_review.js';
import { resolveSlackWorkspaceToken } from './slack_config.js';
import { DEFAULT_SLACK_DAILY_DIGEST_DEFAULT_GROUP_NAME } from './slack_daily_digest_config.js';

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';
const SLACK_UPDATE_MESSAGE_URL = 'https://slack.com/api/chat.update';
const SLACK_PIN_MESSAGE_URL = 'https://slack.com/api/pins.add';
const SLACK_UNPIN_MESSAGE_URL = 'https://slack.com/api/pins.remove';
const SLACK_ADD_REACTION_URL = 'https://slack.com/api/reactions.add';
const SLACK_UPDATE_MAX_ATTEMPTS = 2;

export interface ReviewRequestReviewer {
  githubLogin: string;
  slackUserId?: string | null;
  requestKind?: 'new' | 're-request';
}

export interface ReviewRequestPr {
  title: string;
  url: string;
  author: string;
  number?: number;
  owner?: string;
  repo?: string;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}

export interface SlackPostResult {
  ok: boolean;
  error?: string;
  channel?: string;
  ts?: string;
}

export interface SlackSectionBlock {
  type: 'section';
  text: {
    type: 'mrkdwn';
    text: string;
  };
}

export interface SlackDividerBlock {
  type: 'divider';
}

export type SlackBlock = SlackSectionBlock | SlackDividerBlock;

export interface SlackPostPayload {
  channel: string;
  text: string;
  blocks: SlackBlock[];
  unfurl_links?: boolean;
  unfurl_media?: boolean;
}

export interface SlackPostSenderArgs {
  token: string;
  payload: SlackPostPayload;
}

export type SlackPostSender = (args: SlackPostSenderArgs) => Promise<SlackPostResult>;

export interface SlackUpdateSenderArgs {
  token: string;
  channel: string;
  ts: string;
  payload: SlackPostPayload;
}

export type SlackUpdateSender = (args: SlackUpdateSenderArgs) => Promise<SlackPostResult>;

export interface SlackPinSenderArgs {
  token: string;
  channel: string;
  ts: string;
}

export type SlackPinSender = (args: SlackPinSenderArgs) => Promise<SlackPostResult>;

export interface SlackReactionSenderArgs {
  token: string;
  channel: string;
  ts: string;
  /** Emoji name without colons, e.g. `white_check_mark`. */
  name: string;
}

export type SlackReactionSender = (args: SlackReactionSenderArgs) => Promise<SlackPostResult>;

function isRetryableSlackHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function formatSlackHttpErrorMessage(operation: string, response: Response): Promise<string> {
  const responseText = await response.text().catch(() => '');
  const body = responseText.length > 0 ? responseText : '<empty response body>';
  return `Slack ${operation} failed with HTTP ${response.status}: ${body}`;
}

export interface AddSlackReactionArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  ts: string;
  /** Emoji name without colons, e.g. `white_check_mark`. */
  name: string;
  sender?: SlackReactionSender;
}

export interface PostReviewRequestMessageArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  pr: ReviewRequestPr;
  reviewers: ReviewRequestReviewer[];
  sender?: SlackPostSender;
}

// These types intentionally mirror DigestReviewer/DigestEntry/PrDigest in
// src/lib/server/pr_digest.ts structurally, so src/common stays free of a $lib/server
// dependency. Keep them in sync if the pr_digest shapes change.
export interface DailyDigestReviewer {
  login: string;
  waitedMs: number;
  waitedLabel: string;
}

export interface DailyDigestEntry {
  prUrl: string;
  prNumber: number;
  title: string;
  author: string;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  reviewers?: DailyDigestReviewer[];
  /** Label names on the PR, used to group awaiting-review entries into prioritized sections. */
  labels?: string[];
  /** True when the PR is stacked on another open PR (its base is that PR's head branch). */
  isStacked?: boolean;
  readyForReviewMs?: number;
  readyForReviewLabel?: string;
  previousReviewMs?: number;
  previousReviewLabel?: string;
  approvedMs?: number;
  approvedLabel?: string;
  /** GitHub login of the reviewer whose review the PR author still needs to respond to. */
  reviewResponseReviewer?: string;
  /** State of that review (e.g. CHANGES_REQUESTED, COMMENTED). */
  reviewResponseState?: string;
  reviewedMs?: number;
  reviewedLabel?: string;
}

/** A configured prioritized review group: PRs carrying `label` are listed under `name`. */
export interface DigestReviewGroupConfig {
  name: string;
  label: string;
}

export interface DigestReviewGroupingOptions {
  reviewGroups?: DigestReviewGroupConfig[];
  /** Section title for awaiting-review PRs matching no configured group. */
  defaultGroupName?: string;
}

export interface DailyDigestPayloadInput {
  approvedUnmerged: DailyDigestEntry[];
  staleAwaitingReview: DailyDigestEntry[];
  awaitingReviewResponse?: DailyDigestEntry[];
  otherReadyForReview: DailyDigestEntry[];
  linearMilestones?: LinearMilestoneDigestEntry[];
}

export interface PostDailyDigestMessageArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  repoFullName: string;
  digest: DailyDigestPayloadInput;
  sender?: SlackPostSender;
  allowEmpty?: boolean;
}

export interface UpdateDailyDigestMessageArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  ts: string;
  repoFullName: string;
  digest: DailyDigestPayloadInput;
  sender?: SlackUpdateSender;
}

export interface PostSlackTestMessageArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  message: string;
  sender?: SlackPostSender;
}

/** Cached Slack senders, keyed by resolved bot token. */
const cachedSlackSenders = new Map<string, SlackPostSender>();
const cachedSlackUpdateSenders = new Map<string, SlackUpdateSender>();
const cachedSlackPinSenders = new Map<string, SlackPinSender>();
const cachedSlackUnpinSenders = new Map<string, SlackPinSender>();
const cachedSlackReactionSenders = new Map<string, SlackReactionSender>();

function escapeSlackMrkdwnText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeSlackCodeSpan(value: string): string {
  return escapeSlackMrkdwnText(value).replaceAll('`', "'");
}

function formatReviewer(reviewer: ReviewRequestReviewer, includeRequestKind: boolean): string {
  const slackUserId = reviewer.slackUserId?.trim();
  const kindSuffix = includeRequestKind && reviewer.requestKind ? ` (${reviewer.requestKind})` : '';
  if (slackUserId) {
    return `<@${escapeSlackMrkdwnText(slackUserId)}>${kindSuffix}`;
  }

  return `\`${escapeSlackCodeSpan(reviewer.githubLogin)}\`${kindSuffix}`;
}

function formatReviewerList(reviewers: ReviewRequestReviewer[]): string {
  if (reviewers.length === 0) {
    return '_No reviewers listed_';
  }

  const includeRequestKind =
    reviewers.some((reviewer) => reviewer.requestKind === 're-request') &&
    !reviewers.every((reviewer) => reviewer.requestKind === 'new');
  return reviewers.map((reviewer) => formatReviewer(reviewer, includeRequestKind)).join(', ');
}

function getReviewRequestTitle(reviewers: ReviewRequestReviewer[]): string {
  if (
    reviewers.length > 0 &&
    reviewers.every((reviewer) => reviewer.requestKind === 're-request')
  ) {
    return 'Review Re-Requested';
  }

  return 'Review Requested';
}

function formatPrChangeStats(pr: ReviewRequestPr): string | null {
  const parts: string[] = [];

  if (typeof pr.changedFiles === 'number') {
    parts.push(`${pr.changedFiles} ${pr.changedFiles === 1 ? 'file' : 'files'}`);
  }

  if (typeof pr.additions === 'number' && typeof pr.deletions === 'number') {
    parts.push(`(+${pr.additions}/-${pr.deletions})`);
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

function formatDailyDigestChangeStats(entry: DailyDigestEntry): string {
  if (typeof entry.additions !== 'number' || typeof entry.deletions !== 'number') {
    return '';
  }

  return ` · +${entry.additions}/-${entry.deletions}`;
}

function formatPlainLogin(login: string): string {
  return `\`${escapeSlackCodeSpan(login)}\``;
}

function formatPrDisplayTitle(title: string, prNumber: number | undefined): string {
  const trimmedTitle = title.trim();
  if (typeof prNumber !== 'number') {
    return trimmedTitle;
  }

  return `#${prNumber} - ${trimmedTitle}`;
}

function formatPrLink(entry: DailyDigestEntry): string {
  const url =
    buildLinearPrReviewUrl({ prUrl: entry.prUrl, prNumber: entry.prNumber }) ?? entry.prUrl;
  const escapedUrl = escapeSlackMrkdwnText(url);
  const displayTitle = entry.title
    ? formatPrDisplayTitle(entry.title, entry.prNumber)
    : `PR #${entry.prNumber}`;
  const escapedTitle = escapeSlackMrkdwnText(displayTitle);
  return `<${escapedUrl}|${escapedTitle}>`;
}

/**
 * Renders a leading marker for PRs stacked on another open PR (base branch is not the default
 * branch), so reviewers can scan them at the start of the line. Returns an empty string for
 * non-stacked PRs (digest lines are unchanged for them).
 */
function formatStackedPrefix(entry: DailyDigestEntry): string {
  return entry.isStacked ? `🔗 stacked · ` : '';
}

function formatApprovedDigestLine(entry: DailyDigestEntry): string {
  const approved = entry.approvedLabel
    ? ` — approved ${escapeSlackMrkdwnText(entry.approvedLabel)} ago`
    : '';
  return `• ${formatStackedPrefix(entry)}${formatPrLink(entry)} by ${formatPlainLogin(entry.author)}${formatDailyDigestChangeStats(entry)}${approved}`;
}

function formatStaleDigestLine(entry: DailyDigestEntry): string {
  const reviewers = entry.reviewers ?? [];
  const author = formatPlainLogin(entry.author);
  if (reviewers.length === 0) {
    return `• ${formatStackedPrefix(entry)}${formatPrLink(entry)} by ${author}${formatDailyDigestChangeStats(entry)} — waiting on _reviewer unknown_`;
  }

  const reviewerLogins = reviewers.map((reviewer) => formatPlainLogin(reviewer.login)).join(', ');
  // Use a single waited time across all reviewers: the shortest (most recently requested) wait.
  const shortestWait = reviewers.reduce((shortest, reviewer) =>
    reviewer.waitedMs < shortest.waitedMs ? reviewer : shortest
  );
  return `• ${formatStackedPrefix(entry)}${formatPrLink(entry)} by ${author}${formatDailyDigestChangeStats(entry)} — waiting on ${reviewerLogins} (${escapeSlackMrkdwnText(shortestWait.waitedLabel)})`;
}

function formatOtherReadyDigestLine(entry: DailyDigestEntry): string {
  const author = formatPlainLogin(entry.author);
  const readyLabel = entry.readyForReviewLabel
    ? escapeSlackMrkdwnText(entry.readyForReviewLabel)
    : 'unknown duration';
  const previousReview = entry.previousReviewLabel
    ? `; previous review ${escapeSlackMrkdwnText(entry.previousReviewLabel)} ago`
    : '; no previous review';
  return `• ${formatStackedPrefix(entry)}${formatPrLink(entry)} by ${author}${formatDailyDigestChangeStats(entry)} — ready for ${readyLabel}${previousReview}`;
}

function formatReviewStateVerb(state: string | undefined): string {
  switch (state) {
    case 'CHANGES_REQUESTED':
      return 'requested changes';
    case 'COMMENTED':
      return 'commented';
    case 'APPROVED':
      return 'approved';
    default:
      return 'reviewed';
  }
}

function formatAwaitingResponseDigestLine(entry: DailyDigestEntry): string {
  const author = formatPlainLogin(entry.author);
  const reviewer = entry.reviewResponseReviewer
    ? formatPlainLogin(entry.reviewResponseReviewer)
    : '_reviewer unknown_';
  const verb = formatReviewStateVerb(entry.reviewResponseState);
  const agoLabel = entry.reviewedLabel ? ` ${escapeSlackMrkdwnText(entry.reviewedLabel)} ago` : '';
  return `• ${formatStackedPrefix(entry)}${formatPrLink(entry)} by ${author}${formatDailyDigestChangeStats(entry)} — ${reviewer} ${verb}${agoLabel}`;
}

function formatDateLabel(date: string): string {
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return date;
  }

  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  }).format(new Date(parsed));
}

function formatSlackLink(url: string | null | undefined, label: string): string {
  const escapedLabel = escapeSlackMrkdwnText(label);
  if (!url) {
    return escapedLabel;
  }

  return `<${escapeSlackMrkdwnText(url)}|${escapedLabel}>`;
}

function formatLinearMilestoneDigestLine(entry: LinearMilestoneDigestEntry): string {
  return `• ${formatSlackLink(entry.milestoneUrl, entry.milestoneName)} — ${formatSlackLink(entry.projectUrl, entry.projectName)} · owner: ${formatPlainLogin(entry.milestoneOwner)} · due ${escapeSlackMrkdwnText(formatDateLabel(entry.targetDate))}`;
}

function buildReviewRequestedPullsUrl(repoFullName: string): string {
  const [owner, repo] = repoFullName.split('/', 2);
  const encodedRepoFullName =
    owner && repo
      ? `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
      : encodeURIComponent(repoFullName);
  return `https://github.com/${encodedRepoFullName}/pulls?q=is%3Apr+is%3Aopen+user-review-requested%3A%40me`;
}

/**
 * Slack rejects a section block whose mrkdwn text exceeds 3000 characters with `invalid_blocks`.
 * Stay comfortably under that so a busy repo's digest still posts.
 */
const MAX_SLACK_SECTION_TEXT_LENGTH = 2900;

function truncateToSectionLimit(text: string): string {
  if (text.length <= MAX_SLACK_SECTION_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_SLACK_SECTION_TEXT_LENGTH - 1)}…`;
}

/**
 * Renders a digest bucket into one or more section blocks, chunking lines so no block's text
 * exceeds Slack's per-section character limit. The title appears on the first block; continuation
 * blocks carry only additional lines. (Slack allows up to 50 blocks per message.)
 */
function buildDigestSectionBlocks(title: string, lines: string[]): SlackSectionBlock[] {
  const blocks: SlackSectionBlock[] = [];
  let current = `*${title}*`;

  for (const line of lines) {
    const candidate = `${current}\n${line}`;
    if (candidate.length > MAX_SLACK_SECTION_TEXT_LENGTH && current.length > 0) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
      current = truncateToSectionLimit(line);
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
  }

  return blocks;
}

export function buildReviewRequestSlackPayload(
  channel: string,
  pr: ReviewRequestPr,
  reviewers: ReviewRequestReviewer[]
): SlackPostPayload {
  const displayTitle = formatPrDisplayTitle(pr.title, pr.number);
  const escapedTitle = escapeSlackMrkdwnText(displayTitle);
  const escapedAuthor = escapeSlackMrkdwnText(pr.author);
  const prUrl = buildLinearPrReviewUrl({ prUrl: pr.url, prNumber: pr.number }) ?? pr.url;
  const escapedUrl = escapeSlackMrkdwnText(prUrl);
  const reviewerText = formatReviewerList(reviewers);
  const title = getReviewRequestTitle(reviewers);
  const includeRequestKind =
    reviewers.some((reviewer) => reviewer.requestKind === 're-request') &&
    !reviewers.every((reviewer) => reviewer.requestKind === 'new');
  const changeStats = formatPrChangeStats(pr);
  const escapedChangeStats = changeStats ? escapeSlackMrkdwnText(changeStats) : null;
  const fallbackReviewers =
    reviewers.length > 0
      ? reviewers
          .map((reviewer) => {
            const escapedLogin = escapeSlackMrkdwnText(reviewer.githubLogin);
            return includeRequestKind && reviewer.requestKind
              ? `${escapedLogin} (${reviewer.requestKind})`
              : escapedLogin;
          })
          .join(', ')
      : 'none';
  const fallbackStats = escapedChangeStats ? ` (${escapedChangeStats})` : '';
  const fallbackText = `${title} on ${escapedTitle} by ${escapedAuthor}${fallbackStats}: ${fallbackReviewers}`;
  const statsLine = escapedChangeStats ? `\n*Changes:* ${escapedChangeStats}` : '';

  return {
    channel,
    text: fallbackText,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${title}:* <${escapedUrl}|${escapedTitle}>\n*Author:* ${escapedAuthor}${statsLine}\n*Reviewers:* ${reviewerText}`,
        },
      },
    ],
  };
}

/**
 * Reads the prioritized review-group configuration for a workspace's daily digest. Returns an
 * empty `reviewGroups` (i.e. no grouping) when none is configured. `defaultGroupName` falls back
 * to {@link DEFAULT_SLACK_DAILY_DIGEST_DEFAULT_GROUP_NAME}.
 */
export function resolveDigestReviewGrouping(
  config: TimConfig,
  workspace: string
): DigestReviewGroupingOptions {
  const dailyDigest = config.slack?.workspaces?.[workspace]?.dailyDigest;
  return {
    reviewGroups: dailyDigest?.reviewGroups ?? [],
    defaultGroupName:
      dailyDigest?.defaultGroupName ?? DEFAULT_SLACK_DAILY_DIGEST_DEFAULT_GROUP_NAME,
  };
}

interface ResolvedReviewGroup {
  name: string;
  /** The configured label this group matches, or null for the trailing default group. */
  label: string | null;
  entries: DailyDigestEntry[];
}

/**
 * Partitions awaiting-review entries into the configured prioritized groups (in config order),
 * with a trailing default group for entries matching no configured label. A PR matching multiple
 * configured labels is placed in the highest-priority (earliest) group only (first-match-wins).
 */
function partitionStaleEntriesByGroup(
  entries: DailyDigestEntry[],
  reviewGroups: DigestReviewGroupConfig[],
  defaultGroupName: string
): ResolvedReviewGroup[] {
  const groups: ResolvedReviewGroup[] = reviewGroups.map((group) => ({
    name: group.name,
    label: group.label,
    entries: [],
  }));
  const defaultGroup: ResolvedReviewGroup = { name: defaultGroupName, label: null, entries: [] };

  for (const entry of entries) {
    const labels = entry.labels ?? [];
    const matchIndex = reviewGroups.findIndex((group) => labels.includes(group.label));
    if (matchIndex === -1) {
      defaultGroup.entries.push(entry);
    } else {
      groups[matchIndex].entries.push(entry);
    }
  }

  return [...groups, defaultGroup];
}

/**
 * Renders the awaiting-review bucket. With no configured review groups this is a single
 * "Awaiting review" section (unchanged behavior). With groups configured, each non-empty group
 * becomes its own "Awaiting review — {name} ({label})" section in priority order; the trailing
 * default group has no label suffix.
 */
function buildStaleAwaitingReviewBlocks(
  entries: DailyDigestEntry[],
  grouping: DigestReviewGroupingOptions | undefined
): SlackSectionBlock[] {
  const reviewGroups = grouping?.reviewGroups ?? [];
  if (reviewGroups.length === 0) {
    return buildDigestSectionBlocks('Awaiting review', entries.map(formatStaleDigestLine));
  }

  const defaultGroupName =
    grouping?.defaultGroupName ?? DEFAULT_SLACK_DAILY_DIGEST_DEFAULT_GROUP_NAME;
  const blocks: SlackSectionBlock[] = [];
  for (const group of partitionStaleEntriesByGroup(entries, reviewGroups, defaultGroupName)) {
    if (group.entries.length === 0) {
      continue;
    }
    const labelSuffix = group.label ? ` (${escapeSlackMrkdwnText(group.label)})` : '';
    blocks.push(
      ...buildDigestSectionBlocks(
        `Awaiting review — ${group.name}${labelSuffix}`,
        group.entries.map(formatStaleDigestLine)
      )
    );
  }
  return blocks;
}

export function buildDailyDigestSlackPayload(
  channel: string,
  repoFullName: string,
  digest: DailyDigestPayloadInput,
  grouping?: DigestReviewGroupingOptions
): SlackPostPayload {
  const awaitingReviewResponse = digest.awaitingReviewResponse ?? [];
  const approvedCount = digest.approvedUnmerged.length;
  const staleCount = digest.staleAwaitingReview.length;
  const awaitingResponseCount = awaitingReviewResponse.length;
  const otherReadyCount = digest.otherReadyForReview.length;
  const linearMilestones = digest.linearMilestones ?? [];
  const linearMilestoneCount = linearMilestones.length;
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Daily PR digest — ${escapeSlackMrkdwnText(repoFullName)}*`,
      },
    },
  ];

  if (approvedCount > 0) {
    blocks.push(
      ...buildDigestSectionBlocks(
        'Approved, not yet merged',
        digest.approvedUnmerged.map(formatApprovedDigestLine)
      )
    );
  }

  if (approvedCount > 0 && staleCount > 0) {
    blocks.push({ type: 'divider' });
  }

  if (staleCount > 0) {
    blocks.push(...buildStaleAwaitingReviewBlocks(digest.staleAwaitingReview, grouping));
  }

  if ((approvedCount > 0 || staleCount > 0) && awaitingResponseCount > 0) {
    blocks.push({ type: 'divider' });
  }

  if (awaitingResponseCount > 0) {
    blocks.push(
      ...buildDigestSectionBlocks(
        'Awaiting Review Response > 24 hours',
        awaitingReviewResponse.map(formatAwaitingResponseDigestLine)
      )
    );
  }

  if ((approvedCount > 0 || staleCount > 0 || awaitingResponseCount > 0) && otherReadyCount > 0) {
    blocks.push({ type: 'divider' });
  }

  if (otherReadyCount > 0) {
    blocks.push(
      ...buildDigestSectionBlocks(
        'Other PRs ready for review for > 3 days',
        digest.otherReadyForReview.map(formatOtherReadyDigestLine)
      )
    );
  }

  if (
    (approvedCount > 0 || staleCount > 0 || awaitingResponseCount > 0 || otherReadyCount > 0) &&
    linearMilestoneCount > 0
  ) {
    blocks.push({ type: 'divider' });
  }

  if (linearMilestoneCount > 0) {
    blocks.push(
      ...buildDigestSectionBlocks(
        'Linear milestones due or overdue',
        linearMilestones.map(formatLinearMilestoneDigestLine)
      )
    );
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `<${buildReviewRequestedPullsUrl(repoFullName)}|View all PRs awaiting your review> · <https://linear.app/deviceflow/reviews|Linear>`,
    },
  });

  return {
    channel,
    text: `Daily PR digest for ${repoFullName}: ${approvedCount} approved, ${staleCount} awaiting review, ${awaitingResponseCount} awaiting author response, ${otherReadyCount} other ready, ${linearMilestoneCount} Linear milestones`,
    unfurl_links: false,
    unfurl_media: false,
    blocks,
  };
}

export function buildSlackTestMessagePayload(channel: string, message: string): SlackPostPayload {
  const escapedMessage = escapeSlackMrkdwnText(message);

  return {
    channel,
    text: message,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: escapedMessage,
        },
      },
    ],
  };
}

export function createFetchSlackSender(
  token: string,
  fetchImpl: typeof fetch = fetch
): SlackPostSender {
  // If Slack API coverage grows, @slack/web-api's WebClient is the heavier alternative here.
  return async ({ payload }: SlackPostSenderArgs): Promise<SlackPostResult> => {
    try {
      const response = await fetchImpl(SLACK_POST_MESSAGE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const message = await formatSlackHttpErrorMessage('chat.postMessage', response);
        error(message);
        return { ok: false, error: message };
      }

      const responseBody = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        channel?: string;
        ts?: string;
      } | null;
      if (!responseBody?.ok) {
        const message = responseBody?.error ?? 'Slack chat.postMessage returned ok=false';
        error(`Slack chat.postMessage failed: ${message}`);
        return { ok: false, error: message };
      }

      return {
        ok: true,
        channel: typeof responseBody.channel === 'string' ? responseBody.channel : undefined,
        ts: typeof responseBody.ts === 'string' ? responseBody.ts : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Slack chat.postMessage failed: ${message}`);
      return { ok: false, error: message };
    }
  };
}

export function createFetchSlackUpdateSender(
  token: string,
  fetchImpl: typeof fetch = fetch
): SlackUpdateSender {
  return async ({ channel, ts, payload }: SlackUpdateSenderArgs): Promise<SlackPostResult> => {
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= SLACK_UPDATE_MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(SLACK_UPDATE_MESSAGE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: JSON.stringify({
            ...payload,
            channel,
            ts,
          }),
        });

        if (!response.ok) {
          const message = await formatSlackHttpErrorMessage('chat.update', response);
          lastError = message;
          if (attempt < SLACK_UPDATE_MAX_ATTEMPTS && isRetryableSlackHttpStatus(response.status)) {
            error(`${message}; retrying once`);
            continue;
          }
          error(message);
          return { ok: false, error: message };
        }

        const responseBody = (await response.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          channel?: string;
          ts?: string;
        } | null;
        if (!responseBody?.ok) {
          const message = responseBody?.error ?? 'Slack chat.update returned ok=false';
          error(`Slack chat.update failed: ${message}`);
          return { ok: false, error: message };
        }

        return {
          ok: true,
          channel: typeof responseBody.channel === 'string' ? responseBody.channel : channel,
          ts: typeof responseBody.ts === 'string' ? responseBody.ts : ts,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        lastError = message;
        error(`Slack chat.update failed: ${message}`);
        return { ok: false, error: message };
      }
    }

    return { ok: false, error: lastError ?? 'Slack chat.update failed' };
  };
}

function createFetchSlackPinOperationSender(
  token: string,
  url: string,
  operation: 'pins.add' | 'pins.remove',
  fetchImpl: typeof fetch = fetch
): SlackPinSender {
  return async ({ channel, ts }: SlackPinSenderArgs): Promise<SlackPostResult> => {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, timestamp: ts }),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const message = `Slack ${operation} failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`;
        error(message);
        return { ok: false, error: message };
      }

      const responseBody = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!responseBody?.ok) {
        const message = responseBody?.error ?? `Slack ${operation} returned ok=false`;
        error(`Slack ${operation} failed: ${message}`);
        return { ok: false, error: message };
      }

      return { ok: true, channel, ts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Slack ${operation} failed: ${message}`);
      return { ok: false, error: message };
    }
  };
}

export function createFetchSlackPinSender(
  token: string,
  fetchImpl: typeof fetch = fetch
): SlackPinSender {
  return createFetchSlackPinOperationSender(token, SLACK_PIN_MESSAGE_URL, 'pins.add', fetchImpl);
}

export function createFetchSlackUnpinSender(
  token: string,
  fetchImpl: typeof fetch = fetch
): SlackPinSender {
  return createFetchSlackPinOperationSender(
    token,
    SLACK_UNPIN_MESSAGE_URL,
    'pins.remove',
    fetchImpl
  );
}

export function createFetchSlackReactionSender(
  token: string,
  fetchImpl: typeof fetch = fetch
): SlackReactionSender {
  return async ({ channel, ts, name }: SlackReactionSenderArgs): Promise<SlackPostResult> => {
    try {
      const response = await fetchImpl(SLACK_ADD_REACTION_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel, timestamp: ts, name }),
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        const message = `Slack reactions.add failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`;
        error(message);
        return { ok: false, error: message };
      }

      const responseBody = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!responseBody?.ok) {
        // The same reaction already being present means the message is already in the
        // desired state, e.g. after a duplicate webhook delivery.
        if (responseBody?.error === 'already_reacted') {
          return { ok: true, channel, ts };
        }

        const message = responseBody?.error ?? 'Slack reactions.add returned ok=false';
        error(`Slack reactions.add failed: ${message}`);
        return { ok: false, error: message };
      }

      return { ok: true, channel, ts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Slack reactions.add failed: ${message}`);
      return { ok: false, error: message };
    }
  };
}

export function getSlackPostSender(token: string): SlackPostSender {
  const cachedSender = cachedSlackSenders.get(token);
  if (cachedSender) {
    return cachedSender;
  }

  const sender = createFetchSlackSender(token);
  cachedSlackSenders.set(token, sender);
  return sender;
}

export function getSlackUpdateSender(token: string): SlackUpdateSender {
  const cachedSender = cachedSlackUpdateSenders.get(token);
  if (cachedSender) {
    return cachedSender;
  }

  const sender = createFetchSlackUpdateSender(token);
  cachedSlackUpdateSenders.set(token, sender);
  return sender;
}

export function getSlackPinSender(token: string): SlackPinSender {
  const cachedSender = cachedSlackPinSenders.get(token);
  if (cachedSender) {
    return cachedSender;
  }

  const sender = createFetchSlackPinSender(token);
  cachedSlackPinSenders.set(token, sender);
  return sender;
}

export function getSlackUnpinSender(token: string): SlackPinSender {
  const cachedSender = cachedSlackUnpinSenders.get(token);
  if (cachedSender) {
    return cachedSender;
  }

  const sender = createFetchSlackUnpinSender(token);
  cachedSlackUnpinSenders.set(token, sender);
  return sender;
}

export function getSlackReactionSender(token: string): SlackReactionSender {
  const cachedSender = cachedSlackReactionSenders.get(token);
  if (cachedSender) {
    return cachedSender;
  }

  const sender = createFetchSlackReactionSender(token);
  cachedSlackReactionSenders.set(token, sender);
  return sender;
}

export function clearSlackClientCache(): void {
  cachedSlackSenders.clear();
  cachedSlackUpdateSenders.clear();
  cachedSlackPinSenders.clear();
  cachedSlackUnpinSenders.clear();
  cachedSlackReactionSenders.clear();
}

export async function addSlackReaction(args: AddSlackReactionArgs): Promise<SlackPostResult> {
  // Token resolution intentionally throws on misconfiguration; callers decide whether to retry.
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const sender = args.sender ?? getSlackReactionSender(token);

  return await sender({ token, channel: args.channel, ts: args.ts, name: args.name });
}

export async function postReviewRequestMessage(
  args: PostReviewRequestMessageArgs
): Promise<SlackPostResult> {
  // Token resolution intentionally throws on misconfiguration; callers decide whether to retry.
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const payload = buildReviewRequestSlackPayload(args.channel, args.pr, args.reviewers);
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}

export async function postDailyDigestMessage(
  args: PostDailyDigestMessageArgs
): Promise<SlackPostResult> {
  if (
    args.allowEmpty !== true &&
    args.digest.approvedUnmerged.length === 0 &&
    args.digest.staleAwaitingReview.length === 0 &&
    (args.digest.awaitingReviewResponse?.length ?? 0) === 0 &&
    args.digest.otherReadyForReview.length === 0 &&
    (args.digest.linearMilestones?.length ?? 0) === 0
  ) {
    return { ok: true };
  }

  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const grouping = resolveDigestReviewGrouping(args.config, args.workspace);
  const payload = buildDailyDigestSlackPayload(
    args.channel,
    args.repoFullName,
    args.digest,
    grouping
  );
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}

export async function updateDailyDigestMessage(
  args: UpdateDailyDigestMessageArgs
): Promise<SlackPostResult> {
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const grouping = resolveDigestReviewGrouping(args.config, args.workspace);
  const payload = buildDailyDigestSlackPayload(
    args.channel,
    args.repoFullName,
    args.digest,
    grouping
  );
  const sender = args.sender ?? getSlackUpdateSender(token);

  return await sender({ token, channel: args.channel, ts: args.ts, payload });
}

export async function postSlackTestMessage(
  args: PostSlackTestMessageArgs
): Promise<SlackPostResult> {
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const payload = buildSlackTestMessagePayload(args.channel, args.message);
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}
