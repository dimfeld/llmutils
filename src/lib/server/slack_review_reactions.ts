import type { Database } from 'bun:sqlite';

import { normalizeGitHubUsername } from '$common/github/username.js';
import type { SubmittedPrReview } from '$common/github/webhook_ingest.js';
import { addSlackReaction, type SlackReactionSender } from '$common/slack/slack_client.js';
import type { TimConfig } from '$tim/configSchema.js';
import { getPrStatusByRepoAndNumber } from '$tim/db/pr_status.js';
import {
  getSlackReviewRequestMessage,
  REVIEW_REQUEST_MESSAGE_RETENTION_MS,
} from '$tim/db/slack_review_request_message.js';
import { getUserMapping } from '$tim/db/slack_user_map.js';

import { loadEffectiveConfig } from '../../tim/configLoader.js';

/** Emoji reaction (without colons) added to the review-request message per review state. */
export const REVIEW_STATE_REACTIONS: Record<string, string> = {
  APPROVED: 'white_check_mark',
  COMMENTED: 'speech_balloon',
  CHANGES_REQUESTED: 'arrows_counterclockwise',
};

export interface ProcessSlackReviewReactionsOptions {
  config?: TimConfig;
  sender?: SlackReactionSender;
  nowMs?: number;
}

function isBotLogin(login: string): boolean {
  return login.toLowerCase().endsWith('[bot]');
}

/**
 * For each review submitted by a non-bot user, add an emoji reaction to the latest tracked
 * Slack review-request message for that PR: ✅ approved, 💬 commented, 🔄 changes requested.
 * Reactions are best-effort; failures are logged and not retried.
 */
export async function processSlackReviewReactions(
  db: Database,
  reviews: SubmittedPrReview[],
  options: ProcessSlackReviewReactionsOptions = {}
): Promise<void> {
  if (reviews.length === 0) {
    return;
  }

  const nowMs = options.nowMs ?? Date.now();
  let config = options.config;

  for (const review of reviews) {
    try {
      const emoji = REVIEW_STATE_REACTIONS[review.state];
      if (!emoji) {
        continue;
      }

      if (review.authorType === 'Bot' || isBotLogin(review.author)) {
        continue;
      }

      const prStatus = getPrStatusByRepoAndNumber(db, review.owner, review.repo, review.prNumber);
      if (!prStatus) {
        continue;
      }

      if (
        prStatus.author != null &&
        normalizeGitHubUsername(prStatus.author) === normalizeGitHubUsername(review.author)
      ) {
        continue;
      }

      const message = getSlackReviewRequestMessage(db, prStatus.id);
      if (!message) {
        continue;
      }

      // The notifier prunes old rows on its own schedule; skip stale rows here too in case
      // the notifier is not currently running.
      const postedAtMs = Date.parse(message.posted_at);
      if (Number.isFinite(postedAtMs) && nowMs - postedAtMs > REVIEW_REQUEST_MESSAGE_RETENTION_MS) {
        continue;
      }

      // When the payload did not say whether the author is a bot, fall back to reacting only
      // for reviewers with a Slack user mapping in the message's workspace.
      if (review.authorType === null && !getUserMapping(db, message.workspace, review.author)) {
        continue;
      }

      config ??= await loadEffectiveConfig(undefined, { quiet: true });

      const result = await addSlackReaction({
        config,
        workspace: message.workspace,
        channel: message.slack_channel,
        ts: message.slack_ts,
        name: emoji,
        sender: options.sender,
      });

      if (result.ok) {
        console.info(
          `[slack_review_reactions] Added :${emoji}: for ${review.author}'s ${review.state} review on ${review.prUrl}`
        );
      } else {
        console.warn(
          `[slack_review_reactions] Failed to add :${emoji}: reaction for ${review.prUrl}: ${result.error ?? 'unknown Slack error'}`
        );
      }
    } catch (err) {
      console.error(`[slack_review_reactions] Error adding reaction for ${review.prUrl}`, err);
    }
  }
}
