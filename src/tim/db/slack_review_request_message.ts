import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

/** Tracked review-request messages older than this are pruned and no longer receive reactions. */
export const REVIEW_REQUEST_MESSAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Tracks the latest Slack review-request message posted for a PR so later review
 * events can react to it. One row per PR; a newer message replaces the old one.
 */
export interface SlackReviewRequestMessageRow {
  pr_status_id: number;
  workspace: string;
  /** Slack channel ID (e.g. C123...) returned by chat.postMessage, usable with reactions.add. */
  slack_channel: string;
  slack_ts: string;
  posted_at: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertSlackReviewRequestMessageInput {
  prStatusId: number;
  workspace: string;
  slackChannel: string;
  slackTs: string;
}

export function upsertSlackReviewRequestMessage(
  db: Database,
  input: UpsertSlackReviewRequestMessageInput
): void {
  const upsertInTransaction = db.transaction(
    (nextInput: UpsertSlackReviewRequestMessageInput): void => {
      db.prepare(
        `
          INSERT INTO slack_review_request_message (
            pr_status_id,
            workspace,
            slack_channel,
            slack_ts
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(pr_status_id) DO UPDATE SET
            workspace = excluded.workspace,
            slack_channel = excluded.slack_channel,
            slack_ts = excluded.slack_ts,
            posted_at = ${SQL_NOW_ISO_UTC},
            updated_at = ${SQL_NOW_ISO_UTC}
        `
      ).run(nextInput.prStatusId, nextInput.workspace, nextInput.slackChannel, nextInput.slackTs);
    }
  );

  upsertInTransaction.immediate(input);
}

export function getSlackReviewRequestMessage(
  db: Database,
  prStatusId: number
): SlackReviewRequestMessageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          pr_status_id,
          workspace,
          slack_channel,
          slack_ts,
          posted_at,
          created_at,
          updated_at
        FROM slack_review_request_message
        WHERE pr_status_id = ?
      `
    )
    .get(prStatusId) as SlackReviewRequestMessageRow | null;

  return row ?? undefined;
}

/** Deletes tracked review-request messages posted before the cutoff. Returns the deleted count. */
export function pruneSlackReviewRequestMessagesBefore(db: Database, cutoffIso: string): number {
  const result = db
    .prepare('DELETE FROM slack_review_request_message WHERE posted_at < ?')
    .run(cutoffIso);

  return result.changes;
}
