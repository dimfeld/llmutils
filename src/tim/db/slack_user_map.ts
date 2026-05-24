import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface SlackUserMapRow {
  workspace: string;
  github_login: string;
  slack_user_id: string;
  slack_display: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertUserMappingInput {
  workspace: string;
  githubLogin: string;
  slackUserId: string;
  slackDisplay?: string | null;
}

export function upsertUserMapping(db: Database, input: UpsertUserMappingInput): void {
  const upsertInTransaction = db.transaction((nextInput: UpsertUserMappingInput): void => {
    db.prepare(
      `
        INSERT INTO slack_user_map (
          workspace,
          github_login,
          slack_user_id,
          slack_display
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(workspace, github_login) DO UPDATE SET
          slack_user_id = excluded.slack_user_id,
          slack_display = COALESCE(excluded.slack_display, slack_display),
          updated_at = ${SQL_NOW_ISO_UTC}
      `
    ).run(
      nextInput.workspace,
      nextInput.githubLogin,
      nextInput.slackUserId,
      nextInput.slackDisplay ?? null
    );
  });

  upsertInTransaction.immediate(input);
}

export function deleteUserMapping(db: Database, workspace: string, githubLogin: string): boolean {
  const deleteInTransaction = db.transaction(
    (nextWorkspace: string, nextGithubLogin: string): boolean => {
      const result = db
        .prepare('DELETE FROM slack_user_map WHERE workspace = ? AND github_login = ?')
        .run(nextWorkspace, nextGithubLogin);

      return result.changes > 0;
    }
  );

  return deleteInTransaction.immediate(workspace, githubLogin);
}

export function getUserMapping(
  db: Database,
  workspace: string,
  githubLogin: string
): SlackUserMapRow | undefined {
  const row = db
    .prepare(
      `
        SELECT workspace, github_login, slack_user_id, slack_display, created_at, updated_at
        FROM slack_user_map
        WHERE workspace = ? AND github_login = ?
      `
    )
    .get(workspace, githubLogin) as SlackUserMapRow | null;

  return row ?? undefined;
}

export function listUserMappings(db: Database, workspace?: string): SlackUserMapRow[] {
  if (workspace !== undefined) {
    return db
      .prepare(
        `
          SELECT workspace, github_login, slack_user_id, slack_display, created_at, updated_at
          FROM slack_user_map
          WHERE workspace = ?
          ORDER BY workspace ASC, github_login ASC
        `
      )
      .all(workspace) as SlackUserMapRow[];
  }

  return db
    .prepare(
      `
        SELECT workspace, github_login, slack_user_id, slack_display, created_at, updated_at
        FROM slack_user_map
        ORDER BY workspace ASC, github_login ASC
      `
    )
    .all() as SlackUserMapRow[];
}
