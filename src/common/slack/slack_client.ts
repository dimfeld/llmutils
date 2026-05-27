import type { TimConfig } from '../../tim/configSchema.js';
import { error } from '../../logging.js';
import { resolveSlackWorkspaceToken } from './slack_config.js';

const SLACK_POST_MESSAGE_URL = 'https://slack.com/api/chat.postMessage';

export interface ReviewRequestReviewer {
  githubLogin: string;
  slackUserId?: string | null;
}

export interface ReviewRequestPr {
  title: string;
  url: string;
  author: string;
  number?: number;
  owner?: string;
  repo?: string;
}

export interface SlackPostResult {
  ok: boolean;
  error?: string;
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
}

export interface SlackPostSenderArgs {
  token: string;
  payload: SlackPostPayload;
}

export type SlackPostSender = (args: SlackPostSenderArgs) => Promise<SlackPostResult>;

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
  reviewers?: DailyDigestReviewer[];
}

export interface DailyDigestPayloadInput {
  approvedUnmerged: DailyDigestEntry[];
  staleAwaitingReview: DailyDigestEntry[];
}

export interface PostDailyDigestMessageArgs {
  config: TimConfig;
  workspace: string;
  channel: string;
  repoFullName: string;
  digest: DailyDigestPayloadInput;
  sender?: SlackPostSender;
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

function escapeSlackMrkdwnText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeSlackCodeSpan(value: string): string {
  return escapeSlackMrkdwnText(value).replaceAll('`', "'");
}

function formatReviewer(reviewer: ReviewRequestReviewer): string {
  const slackUserId = reviewer.slackUserId?.trim();
  if (slackUserId) {
    return `<@${escapeSlackMrkdwnText(slackUserId)}>`;
  }

  return `\`${escapeSlackCodeSpan(reviewer.githubLogin)}\``;
}

function formatReviewerList(reviewers: ReviewRequestReviewer[]): string {
  if (reviewers.length === 0) {
    return '_No reviewers listed_';
  }

  return reviewers.map(formatReviewer).join(', ');
}

function formatPlainLogin(login: string): string {
  return `\`${escapeSlackCodeSpan(login)}\``;
}

function formatPrLink(entry: DailyDigestEntry): string {
  const escapedUrl = escapeSlackMrkdwnText(entry.prUrl);
  const escapedTitle = escapeSlackMrkdwnText(entry.title || `PR #${entry.prNumber}`);
  return `<${escapedUrl}|${escapedTitle}>`;
}

function formatApprovedDigestLine(entry: DailyDigestEntry): string {
  return `• ${formatPrLink(entry)} by ${formatPlainLogin(entry.author)}`;
}

function formatWaitingReviewer(reviewer: DailyDigestReviewer): string {
  return `${formatPlainLogin(reviewer.login)} (${escapeSlackMrkdwnText(reviewer.waitedLabel)})`;
}

function formatStaleDigestLine(entry: DailyDigestEntry): string {
  const reviewers = entry.reviewers ?? [];
  const waitingText =
    reviewers.length > 0 ? reviewers.map(formatWaitingReviewer).join(', ') : '_reviewer unknown_';
  return `• ${formatPrLink(entry)} by ${formatPlainLogin(entry.author)} — waiting on ${waitingText}`;
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
  const escapedTitle = escapeSlackMrkdwnText(pr.title);
  const escapedAuthor = escapeSlackMrkdwnText(pr.author);
  const escapedUrl = escapeSlackMrkdwnText(pr.url);
  const reviewerText = formatReviewerList(reviewers);
  const fallbackReviewers =
    reviewers.length > 0
      ? reviewers.map((reviewer) => escapeSlackMrkdwnText(reviewer.githubLogin)).join(', ')
      : 'none';
  const fallbackText = `Review requested on ${escapedTitle} by ${escapedAuthor}: ${fallbackReviewers}`;

  return {
    channel,
    text: fallbackText,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Review requested:* <${escapedUrl}|${escapedTitle}>\n*Author:* ${escapedAuthor}\n*Reviewers:* ${reviewerText}`,
        },
      },
    ],
  };
}

export function buildDailyDigestSlackPayload(
  channel: string,
  repoFullName: string,
  digest: DailyDigestPayloadInput
): SlackPostPayload {
  const approvedCount = digest.approvedUnmerged.length;
  const staleCount = digest.staleAwaitingReview.length;
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
    blocks.push(
      ...buildDigestSectionBlocks(
        'Awaiting review for > 1 day',
        digest.staleAwaitingReview.map(formatStaleDigestLine)
      )
    );
  }

  return {
    channel,
    text: `Daily PR digest for ${repoFullName}: ${approvedCount} approved, ${staleCount} awaiting review`,
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
        const responseText = await response.text().catch(() => '');
        const message = `Slack chat.postMessage failed with HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`;
        error(message);
        return { ok: false, error: message };
      }

      const responseBody = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!responseBody?.ok) {
        const message = responseBody?.error ?? 'Slack chat.postMessage returned ok=false';
        error(`Slack chat.postMessage failed: ${message}`);
        return { ok: false, error: message };
      }

      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Slack chat.postMessage failed: ${message}`);
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

export function clearSlackClientCache(): void {
  cachedSlackSenders.clear();
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
  if (args.digest.approvedUnmerged.length === 0 && args.digest.staleAwaitingReview.length === 0) {
    return { ok: true };
  }

  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const payload = buildDailyDigestSlackPayload(args.channel, args.repoFullName, args.digest);
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}

export async function postSlackTestMessage(
  args: PostSlackTestMessageArgs
): Promise<SlackPostResult> {
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const payload = buildSlackTestMessagePayload(args.channel, args.message);
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}
