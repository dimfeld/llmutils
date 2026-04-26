import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface PlanReviewIssueRow {
  uuid: string;
  plan_uuid: string;
  severity: string | null;
  category: string | null;
  content: string;
  source: string | null;
  source_ref: string | null;
  created_hlc: string | null;
  updated_hlc: string | null;
  deleted_hlc: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateReviewIssueInput {
  uuid?: string;
  planUuid: string;
  severity?: string | null;
  category?: string | null;
  content: string;
  source?: string | null;
  sourceRef?: string | null;
}

export function createReviewIssue(db: Database, input: CreateReviewIssueInput): PlanReviewIssueRow {
  const uuid = input.uuid ?? randomUUID();
  db.prepare(
    `
      INSERT INTO plan_review_issue (
        uuid,
        plan_uuid,
        severity,
        category,
        content,
        source,
        source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    uuid,
    input.planUuid,
    input.severity ?? null,
    input.category ?? null,
    input.content,
    input.source ?? null,
    input.sourceRef ?? null
  );

  const row = getReviewIssueByUuid(db, uuid);
  if (!row) {
    throw new Error(`Failed to create review issue ${uuid}`);
  }
  return row;
}

export function getReviewIssueByUuid(db: Database, uuid: string): PlanReviewIssueRow | null {
  return (
    (db
      .prepare('SELECT * FROM plan_review_issue WHERE uuid = ?')
      .get(uuid) as PlanReviewIssueRow | null) ?? null
  );
}

export function listReviewIssuesForPlan(db: Database, planUuid: string): PlanReviewIssueRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM plan_review_issue
        WHERE plan_uuid = ?
          AND deleted_hlc IS NULL
        ORDER BY created_at, uuid
      `
    )
    .all(planUuid) as PlanReviewIssueRow[];
}

export function softDeleteReviewIssue(
  db: Database,
  uuid: string,
  deletedHlc = 'local-delete'
): boolean {
  const result = db
    .prepare(
      `
        UPDATE plan_review_issue
        SET deleted_hlc = ?,
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE uuid = ?
          AND deleted_hlc IS NULL
      `
    )
    .run(deletedHlc, uuid);
  return result.changes > 0;
}
