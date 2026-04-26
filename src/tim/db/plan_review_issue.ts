import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import type { PlanSchema } from '../planSchema.js';

// Temporary local tombstone marker until Task 3 threads real HLC values through
// review issue mutations and sync operation emission.
export const PLACEHOLDER_LOCAL_DELETE_HLC = 'local-delete';

export interface PlanReviewIssueRow {
  uuid: string;
  plan_uuid: string;
  severity: string | null;
  category: string | null;
  content: string;
  file: string | null;
  line: string | null;
  suggestion: string | null;
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
  file?: string | null;
  line?: string | number | null;
  suggestion?: string | null;
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
        file,
        line,
        suggestion,
        source,
        source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    uuid,
    input.planUuid,
    input.severity ?? null,
    input.category ?? null,
    input.content,
    input.file ?? null,
    input.line == null ? null : String(input.line),
    input.suggestion ?? null,
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
  deletedHlc = PLACEHOLDER_LOCAL_DELETE_HLC
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

type PlanReviewIssueInput = NonNullable<PlanSchema['reviewIssues']>[number];

function reviewIssueContentKey(issue: {
  content: string;
  file?: string | null;
  line?: string | number | null;
}): string {
  return JSON.stringify([
    issue.content,
    issue.file ?? null,
    issue.line == null ? null : String(issue.line),
  ]);
}

function sourceRefForIssue(issue: PlanReviewIssueInput): string | null {
  const sourceRef = (issue as PlanReviewIssueInput & { source_ref?: unknown }).source_ref;
  if (typeof sourceRef === 'string') {
    return sourceRef;
  }
  return issue.sourceRef ?? null;
}

function updateReviewIssueRow(db: Database, rowUuid: string, issue: PlanReviewIssueInput): void {
  db.prepare(
    `
      UPDATE plan_review_issue
      SET severity = ?,
          category = ?,
          content = ?,
          file = ?,
          line = ?,
          suggestion = ?,
          source = ?,
          source_ref = ?,
          deleted_hlc = NULL,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE uuid = ?
    `
  ).run(
    issue.severity ?? null,
    issue.category ?? null,
    issue.content,
    issue.file ?? null,
    issue.line == null ? null : String(issue.line),
    issue.suggestion ?? null,
    issue.source ?? null,
    sourceRefForIssue(issue),
    rowUuid
  );
}

export function reconcileReviewIssuesForPlan(
  db: Database,
  planUuid: string,
  desiredIssues: readonly PlanReviewIssueInput[]
): void {
  const existingRows = db
    .prepare('SELECT * FROM plan_review_issue WHERE plan_uuid = ?')
    .all(planUuid) as PlanReviewIssueRow[];
  const existingByUuid = new Map(existingRows.map((row) => [row.uuid, row]));
  const activeByContentKey = new Map<string, PlanReviewIssueRow[]>();

  for (const row of existingRows) {
    if (row.deleted_hlc !== null) {
      continue;
    }
    const key = reviewIssueContentKey(row);
    const rows = activeByContentKey.get(key) ?? [];
    rows.push(row);
    activeByContentKey.set(key, rows);
  }

  const retainedUuids = new Set<string>();

  for (const issue of desiredIssues) {
    const explicitUuid = issue.uuid && existingByUuid.has(issue.uuid) ? issue.uuid : null;
    const matchedByUuid = explicitUuid ? existingByUuid.get(explicitUuid) : undefined;
    const contentKey = reviewIssueContentKey(issue);
    const contentMatches = activeByContentKey.get(contentKey) ?? [];
    const matchedByContent = contentMatches.find((row) => !retainedUuids.has(row.uuid));
    const matchedRow = matchedByUuid ?? matchedByContent;

    if (matchedRow) {
      updateReviewIssueRow(db, matchedRow.uuid, issue);
      retainedUuids.add(matchedRow.uuid);
      continue;
    }

    const created = createReviewIssue(db, {
      uuid: issue.uuid,
      planUuid,
      severity: issue.severity ?? null,
      category: issue.category ?? null,
      content: issue.content,
      file: issue.file ?? null,
      line: issue.line ?? null,
      suggestion: issue.suggestion ?? null,
      source: issue.source ?? null,
      sourceRef: sourceRefForIssue(issue),
    });
    retainedUuids.add(created.uuid);
  }

  for (const row of existingRows) {
    if (row.deleted_hlc === null && !retainedUuids.has(row.uuid)) {
      softDeleteReviewIssue(db, row.uuid);
    }
  }
}
