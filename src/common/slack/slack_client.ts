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

export type SlackBlock = SlackSectionBlock;

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

export async function postSlackTestMessage(
  args: PostSlackTestMessageArgs
): Promise<SlackPostResult> {
  const token = resolveSlackWorkspaceToken(args.config, args.workspace);
  const payload = buildSlackTestMessagePayload(args.channel, args.message);
  const sender = args.sender ?? getSlackPostSender(token);

  return await sender({ token, payload });
}
