import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import type { PlanSchema } from '../planSchema.js';
import {
  emitReviewIssueCreate,
  emitReviewIssueDelete,
  emitReviewIssueFieldUpdate,
} from '../sync/op_emission.js';

export interface PlanReviewIssueRow {
  uuid: string;
  plan_uuid: string;
  order_key: string;
  severity: string | null;
  category: string | null;
  content: string;
  file: string | null;
  line: string | null;
  suggestion: string | null;
  source: string | null;
  source_ref: string | null;
  created_hlc: string | null;
  created_node_id: string | null;
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
  orderKey?: string | null;
}

function nextReviewIssueOrderKey(db: Database, planUuid: string): string {
  const row = db
    .prepare(
      `
        SELECT order_key
        FROM plan_review_issue
        WHERE plan_uuid = ?
        ORDER BY order_key DESC
        LIMIT 1
      `
    )
    .get(planUuid) as { order_key: string } | null;
  const lastOrder = row ? Number.parseInt(row.order_key, 10) : 0;
  const nextOrder = Number.isFinite(lastOrder) ? lastOrder + 1000 : 1000;
  return String(nextOrder).padStart(10, '0');
}

export function createReviewIssue(db: Database, input: CreateReviewIssueInput): PlanReviewIssueRow {
  const createInTransaction = db.transaction(
    (nextInput: CreateReviewIssueInput): PlanReviewIssueRow => {
      const uuid = nextInput.uuid ?? randomUUID();
      const orderKey = nextInput.orderKey ?? nextReviewIssueOrderKey(db, nextInput.planUuid);
      db.prepare(
        `
        INSERT INTO plan_review_issue (
          uuid,
          plan_uuid,
          order_key,
          severity,
          category,
          content,
          file,
          line,
          suggestion,
          source,
          source_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        uuid,
        nextInput.planUuid,
        orderKey,
        nextInput.severity ?? null,
        nextInput.category ?? null,
        nextInput.content,
        nextInput.file ?? null,
        nextInput.line == null ? null : String(nextInput.line),
        nextInput.suggestion ?? null,
        nextInput.source ?? null,
        nextInput.sourceRef ?? null
      );
      emitReviewIssueCreate(db, nextInput.planUuid, uuid, {
        plan_uuid: nextInput.planUuid,
        order_key: orderKey,
        severity: nextInput.severity ?? null,
        category: nextInput.category ?? null,
        content: nextInput.content,
        file: nextInput.file ?? null,
        line: nextInput.line == null ? null : String(nextInput.line),
        suggestion: nextInput.suggestion ?? null,
        source: nextInput.source ?? null,
        source_ref: nextInput.sourceRef ?? null,
      });

      const row = getReviewIssueByUuid(db, uuid);
      if (!row) {
        throw new Error(`Failed to create review issue ${uuid}`);
      }
      return row;
    }
  );

  return createInTransaction.immediate(input);
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
        ORDER BY order_key, created_hlc, created_node_id, uuid
      `
    )
    .all(planUuid) as PlanReviewIssueRow[];
}

export function getPlanReviewIssuesByProject(
  db: Database,
  projectId: number
): PlanReviewIssueRow[] {
  return db
    .prepare(
      `
        SELECT plan_review_issue.*
        FROM plan_review_issue
        JOIN plan ON plan.uuid = plan_review_issue.plan_uuid
        WHERE plan.project_id = ?
          AND plan_review_issue.deleted_hlc IS NULL
        ORDER BY plan_review_issue.plan_uuid, plan_review_issue.order_key, plan_review_issue.created_hlc, plan_review_issue.created_node_id, plan_review_issue.uuid
      `
    )
    .all(projectId) as PlanReviewIssueRow[];
}

export function softDeleteReviewIssue(db: Database, uuid: string): boolean {
  const deleteInTransaction = db.transaction((issueUuid: string): boolean => {
    const row = getReviewIssueByUuid(db, issueUuid);
    if (!row || row.deleted_hlc !== null) {
      return false;
    }
    emitReviewIssueDelete(db, row.plan_uuid, issueUuid);
    return true;
  });

  return deleteInTransaction.immediate(uuid);
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

function updateReviewIssueRow(
  db: Database,
  rowUuid: string,
  issue: PlanReviewIssueInput,
  orderKey: string
): void {
  const existing = getReviewIssueByUuid(db, rowUuid);
  if (!existing || existing.deleted_hlc !== null) {
    return;
  }
  const nextFields = {
    order_key: orderKey,
    severity: issue.severity ?? null,
    category: issue.category ?? null,
    content: issue.content,
    file: issue.file ?? null,
    line: issue.line == null ? null : String(issue.line),
    suggestion: issue.suggestion ?? null,
    source: issue.source ?? null,
    source_ref: sourceRefForIssue(issue),
  };
  const fieldUpdates: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(nextFields)) {
    if (existing[fieldName as keyof PlanReviewIssueRow] !== value) {
      fieldUpdates[fieldName] = value;
    }
  }
  if (Object.keys(fieldUpdates).length === 0) {
    return;
  }
  db.prepare(
    `
      UPDATE plan_review_issue
      SET order_key = ?,
          severity = ?,
          category = ?,
          content = ?,
          file = ?,
          line = ?,
          suggestion = ?,
          source = ?,
          source_ref = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE uuid = ?
    `
  ).run(
    nextFields.order_key,
    nextFields.severity,
    nextFields.category,
    nextFields.content,
    nextFields.file,
    nextFields.line,
    nextFields.suggestion,
    nextFields.source,
    nextFields.source_ref,
    rowUuid
  );
  emitReviewIssueFieldUpdate(db, existing.plan_uuid, rowUuid, fieldUpdates);
}

export function reconcileReviewIssuesForPlan(
  db: Database,
  planUuid: string,
  desiredIssues: readonly PlanReviewIssueInput[]
): void {
  const reconcileInTransaction = db.transaction(
    (nextPlanUuid: string, nextDesiredIssues: readonly PlanReviewIssueInput[]): void => {
      const existingRows = db
        .prepare('SELECT * FROM plan_review_issue WHERE plan_uuid = ?')
        .all(nextPlanUuid) as PlanReviewIssueRow[];
      const existingByUuid = new Map(
        existingRows.filter((row) => row.deleted_hlc === null).map((row) => [row.uuid, row])
      );
      const allExistingUuids = new Set(existingRows.map((row) => row.uuid));
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
      const incomingOrderKeys = desiredIssues.map((issue) => issue.orderKey);
      const canPreserveIncomingOrderKeys =
        incomingOrderKeys.every((orderKey): orderKey is string => typeof orderKey === 'string') &&
        incomingOrderKeys.every(
          (orderKey, index, keys) => index === 0 || keys[index - 1]!.localeCompare(orderKey) <= 0
        );

      for (const [index, issue] of nextDesiredIssues.entries()) {
        const orderKey = canPreserveIncomingOrderKeys
          ? issue.orderKey!
          : String((index + 1) * 1000).padStart(10, '0');
        const explicitUuid = issue.uuid && existingByUuid.has(issue.uuid) ? issue.uuid : null;
        const matchedByUuid = explicitUuid ? existingByUuid.get(explicitUuid) : undefined;
        const contentKey = reviewIssueContentKey(issue);
        const contentMatches = activeByContentKey.get(contentKey) ?? [];
        const matchedByContent = contentMatches.find((row) => !retainedUuids.has(row.uuid));
        const matchedRow = matchedByUuid ?? matchedByContent;

        if (matchedRow) {
          updateReviewIssueRow(db, matchedRow.uuid, issue, orderKey);
          retainedUuids.add(matchedRow.uuid);
          continue;
        }

        const created = createReviewIssue(db, {
          uuid: issue.uuid && !allExistingUuids.has(issue.uuid) ? issue.uuid : undefined,
          planUuid: nextPlanUuid,
          severity: issue.severity ?? null,
          category: issue.category ?? null,
          content: issue.content,
          file: issue.file ?? null,
          line: issue.line ?? null,
          suggestion: issue.suggestion ?? null,
          source: issue.source ?? null,
          sourceRef: sourceRefForIssue(issue),
          orderKey,
        });
        retainedUuids.add(created.uuid);
      }

      for (const row of existingRows) {
        if (row.deleted_hlc === null && !retainedUuids.has(row.uuid)) {
          softDeleteReviewIssue(db, row.uuid);
        }
      }
    }
  );

  reconcileInTransaction.immediate(planUuid, desiredIssues);
}
