import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface SlackDailyDigestMessageRow {
  workspace: string;
  channel: string;
  repo_full_name: string;
  digest_date: string;
  slack_channel: string;
  slack_ts: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertSlackDailyDigestMessageInput {
  workspace: string;
  channel: string;
  repoFullName: string;
  digestDate: string;
  slackChannel: string;
  slackTs: string;
}

export function getSlackDailyDigestMessage(
  db: Database,
  workspace: string,
  channel: string,
  repoFullName: string,
  digestDate: string
): SlackDailyDigestMessageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          workspace,
          channel,
          repo_full_name,
          digest_date,
          slack_channel,
          slack_ts,
          created_at,
          updated_at
        FROM slack_daily_digest_message
        WHERE workspace = ?
          AND channel = ?
          AND repo_full_name = ?
          AND digest_date = ?
      `
    )
    .get(workspace, channel, repoFullName, digestDate) as SlackDailyDigestMessageRow | null;

  return row ?? undefined;
}

export function getLatestSlackDailyDigestMessageBeforeDate(
  db: Database,
  workspace: string,
  channel: string,
  repoFullName: string,
  beforeDigestDate: string
): SlackDailyDigestMessageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          workspace,
          channel,
          repo_full_name,
          digest_date,
          slack_channel,
          slack_ts,
          created_at,
          updated_at
        FROM slack_daily_digest_message
        WHERE workspace = ?
          AND channel = ?
          AND repo_full_name = ?
          AND digest_date < ?
        ORDER BY digest_date DESC, updated_at DESC
        LIMIT 1
      `
    )
    .get(workspace, channel, repoFullName, beforeDigestDate) as SlackDailyDigestMessageRow | null;

  return row ?? undefined;
}

export function upsertSlackDailyDigestMessage(
  db: Database,
  input: UpsertSlackDailyDigestMessageInput
): void {
  const upsertInTransaction = db.transaction(
    (nextInput: UpsertSlackDailyDigestMessageInput): void => {
      db.prepare(
        `
          INSERT INTO slack_daily_digest_message (
            workspace,
            channel,
            repo_full_name,
            digest_date,
            slack_channel,
            slack_ts
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace, channel, repo_full_name, digest_date) DO UPDATE SET
            slack_channel = excluded.slack_channel,
            slack_ts = excluded.slack_ts,
            updated_at = ${SQL_NOW_ISO_UTC}
        `
      ).run(
        nextInput.workspace,
        nextInput.channel,
        nextInput.repoFullName,
        nextInput.digestDate,
        nextInput.slackChannel,
        nextInput.slackTs
      );
    }
  );

  upsertInTransaction.immediate(input);
}
