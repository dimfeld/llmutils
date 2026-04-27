import type { Database } from 'bun:sqlite';

import { getOrCreateProject, getProjectById } from '../db/project.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  type SyncFieldClockRow,
  type SyncOpLogRow,
  type SyncTombstoneRow,
} from '../db/sync_schema.js';
import { compareHlc, formatHlc, type Hlc } from './hlc.js';
import {
  getLocalGenerator,
  PLAN_LWW_FIELD_NAMES,
  PLAN_TASK_LWW_FIELD_NAMES,
  REVIEW_ISSUE_LWW_FIELD_NAMES,
} from './op_emission.js';
import { validateOpEnvelope } from './op_validation.js';

type JsonRecord = Record<string, unknown>;
type SqlValue = string | number | bigint | boolean | null;

export type SyncOpRecord = Pick<
  SyncOpLogRow,
  | 'op_id'
  | 'node_id'
  | 'hlc_physical_ms'
  | 'hlc_logical'
  | 'local_counter'
  | 'entity_type'
  | 'entity_id'
  | 'op_type'
  | 'payload'
  | 'base'
> & {
  seq?: number;
  created_at?: string;
};

export interface SkippedSyncOp {
  opId: string;
  reason: string;
  kind?: 'permanent' | 'deferred';
}

export interface SyncOpApplyError {
  opId: string;
  message: string;
}

export interface ApplyResult {
  applied: number;
  skipped: SkippedSyncOp[];
  errors: SyncOpApplyError[];
}

const PLAN_FIELDS = new Set<string>(PLAN_LWW_FIELD_NAMES);

const PLAN_TASK_FIELDS = new Set<string>(PLAN_TASK_LWW_FIELD_NAMES);

const REVIEW_ISSUE_FIELDS = new Set<string>(REVIEW_ISSUE_LWW_FIELD_NAMES);

const SKIPPED_SYNC_OP_MARKER = Symbol('SkippedSyncOp');

type MarkedSkippedSyncOp = SkippedSyncOp & { [SKIPPED_SYNC_OP_MARKER]: true };

class DeferredSkipRollback extends Error {
  constructor(public readonly skipped: SkippedSyncOp) {
    super(skipped.reason);
  }
}

function permanentSkip(op: SyncOpRecord, reason: string): MarkedSkippedSyncOp {
  const skip = { opId: op.op_id, reason, kind: 'permanent' as const } as MarkedSkippedSyncOp;
  Object.defineProperty(skip, SKIPPED_SYNC_OP_MARKER, {
    value: true,
    enumerable: false,
  });
  return skip;
}

function deferredSkip(op: SyncOpRecord, reason: string): SkippedSyncOp {
  return { opId: op.op_id, reason, kind: 'deferred' };
}

function opHlc(op: SyncOpRecord): Hlc {
  return { physicalMs: op.hlc_physical_ms, logical: op.hlc_logical };
}

function compareClock(
  remoteHlc: Hlc,
  remoteNodeId: string,
  storedHlc: Hlc,
  storedNodeId: string
): number {
  const byHlc = compareHlc(remoteHlc, storedHlc);
  if (byHlc !== 0) return byHlc;
  return remoteNodeId.localeCompare(storedNodeId);
}

function remoteWins(
  remoteHlc: Hlc,
  remoteNodeId: string,
  stored:
    | Pick<SyncFieldClockRow | SyncTombstoneRow, 'hlc_physical_ms' | 'hlc_logical' | 'node_id'>
    | null
    | undefined
): boolean {
  if (!stored) return true;
  return (
    compareClock(
      remoteHlc,
      remoteNodeId,
      { physicalMs: stored.hlc_physical_ms, logical: stored.hlc_logical },
      stored.node_id
    ) > 0
  );
}

function tombstoneWinsOrTies(db: Database, op: SyncOpRecord): boolean {
  const tombstone = db
    .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(op.entity_type, op.entity_id) as SyncTombstoneRow | null;
  return tombstone ? !remoteWins(opHlc(op), op.node_id, tombstone) : false;
}

function hasTombstone(db: Database, entityType: string, entityId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(entityType, entityId) as { present: number } | null;
  return row !== null;
}

function parsePayload(op: SyncOpRecord): JsonRecord | MarkedSkippedSyncOp {
  let parsed: unknown;
  try {
    parsed = JSON.parse(op.payload) as unknown;
  } catch (error) {
    return permanentSkip(
      op,
      `invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return permanentSkip(op, 'expected object payload');
  }
  return parsed as JsonRecord;
}

function isSkippedSyncOp(value: JsonRecord | MarkedSkippedSyncOp): value is MarkedSkippedSyncOp {
  return SKIPPED_SYNC_OP_MARKER in value;
}

function fieldsFromPayload(payload: JsonRecord): JsonRecord {
  const fields = payload.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }
  return fields as JsonRecord;
}

function sqlValue(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function insertRemoteOpLog(db: Database, op: SyncOpRecord): void {
  db.prepare(
    `
      INSERT INTO sync_op_log (
        op_id,
        node_id,
        hlc_physical_ms,
        hlc_logical,
        local_counter,
        entity_type,
        entity_id,
        op_type,
        payload,
        base,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}))
    `
  ).run(
    op.op_id,
    op.node_id,
    op.hlc_physical_ms,
    op.hlc_logical,
    op.local_counter,
    op.entity_type,
    op.entity_id,
    op.op_type,
    op.payload,
    op.base ?? null,
    op.created_at ?? null
  );
}

function updateFieldClock(
  db: Database,
  op: SyncOpRecord,
  fieldName: string,
  deleted = false
): void {
  db.prepare(
    `
      INSERT INTO sync_field_clock (
        entity_type,
        entity_id,
        field_name,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        deleted,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        deleted = excluded.deleted,
        updated_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(
    op.entity_type,
    op.entity_id,
    fieldName,
    op.hlc_physical_ms,
    op.hlc_logical,
    op.node_id,
    deleted ? 1 : 0
  );
}

function insertTombstone(db: Database, op: SyncOpRecord): void {
  const existing = db
    .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(op.entity_type, op.entity_id) as SyncTombstoneRow | null;
  if (!remoteWins(opHlc(op), op.node_id, existing)) {
    return;
  }
  db.prepare(
    `
      INSERT INTO sync_tombstone (
        entity_type,
        entity_id,
        hlc_physical_ms,
        hlc_logical,
        node_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        hlc_physical_ms = excluded.hlc_physical_ms,
        hlc_logical = excluded.hlc_logical,
        node_id = excluded.node_id,
        created_at = ${SQL_NOW_ISO_UTC}
    `
  ).run(op.entity_type, op.entity_id, op.hlc_physical_ms, op.hlc_logical, op.node_id);
}

function applyScalarFields(
  db: Database,
  op: SyncOpRecord,
  tableName: string,
  idColumn: string,
  allowedFields: Set<string>,
  fields: JsonRecord,
  options: { touchUpdatedAt?: boolean } = { touchUpdatedAt: true }
): string[] {
  const identifierPattern = /^[a-z_]+$/;
  if (!identifierPattern.test(tableName) || !identifierPattern.test(idColumn)) {
    throw new Error(`Invalid SQL identifier in sync scalar apply: ${tableName}.${idColumn}`);
  }
  const appliedFields: string[] = [];
  for (const [fieldName, value] of Object.entries(fields)) {
    if (!allowedFields.has(fieldName)) {
      continue;
    }
    if (!identifierPattern.test(fieldName)) {
      throw new Error(`Invalid SQL field identifier in sync scalar apply: ${fieldName}`);
    }
    const storedClock = db
      .prepare(
        `
          SELECT *
          FROM sync_field_clock
          WHERE entity_type = ?
            AND entity_id = ?
            AND field_name = ?
        `
      )
      .get(op.entity_type, op.entity_id, fieldName) as SyncFieldClockRow | null;
    if (!remoteWins(opHlc(op), op.node_id, storedClock)) {
      continue;
    }
    const updatedAtSql =
      options.touchUpdatedAt === false ? '' : `, updated_at = ${SQL_NOW_ISO_UTC}`;
    db.prepare(`UPDATE ${tableName} SET ${fieldName} = ?${updatedAtSql} WHERE ${idColumn} = ?`).run(
      sqlValue(value),
      op.entity_id
    );
    updateFieldClock(db, op, fieldName);
    appliedFields.push(fieldName);
  }
  return appliedFields;
}

function projectIdForIdentity(db: Database, projectIdentity: unknown): number | null {
  if (typeof projectIdentity !== 'string' || projectIdentity.length === 0) {
    return null;
  }
  return getOrCreateProject(db, projectIdentity).id;
}

function allocatePlanId(db: Database, projectId: number, planIdHint: unknown): number {
  if (typeof planIdHint === 'number' && Number.isInteger(planIdHint) && planIdHint > 0) {
    const existing = db
      .prepare('SELECT uuid FROM plan WHERE project_id = ? AND plan_id = ?')
      .get(projectId, planIdHint) as { uuid: string } | null;
    if (!existing) {
      db.prepare(
        `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
      ).run(planIdHint, projectId);
      return planIdHint;
    }
  }

  const row = db
    .prepare('SELECT COALESCE(MAX(plan_id), 0) AS maxPlanId FROM plan WHERE project_id = ?')
    .get(projectId) as { maxPlanId: number };
  const nextPlanId =
    Math.max(row.maxPlanId, getProjectById(db, projectId)?.highest_plan_id ?? 0) + 1;
  db.prepare(
    `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
  ).run(nextPlanId, projectId);
  return nextPlanId;
}

function applyPlanCreateOrUpdate(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  const projectId = projectIdForIdentity(db, payload.projectIdentity);
  if (projectId === null) {
    return { opId: op.op_id, reason: 'plan op missing projectIdentity' };
  }
  if (hasTombstone(db, 'plan', op.entity_id)) {
    return null;
  }

  const existing = db.prepare('SELECT uuid FROM plan WHERE uuid = ?').get(op.entity_id) as {
    uuid: string;
  } | null;
  if (!existing) {
    const planId = allocatePlanId(db, projectId, payload.planIdHint);
    const fields = fieldsFromPayload(payload);
    db.prepare(
      `
        INSERT INTO plan (
          uuid,
          project_id,
          plan_id,
          title,
          goal,
          note,
          details,
          status,
          priority,
          branch,
          simple,
          tdd,
          discovered_from,
          issue,
          pull_request,
          assigned_to,
          base_branch,
          base_commit,
          base_change_id,
          temp,
          docs,
          changed_files,
          plan_generated_at,
          docs_updated_at,
          lessons_applied_at,
          parent_uuid,
          epic
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0)
      `
    ).run(op.entity_id, projectId, planId);
    applyScalarFields(db, op, 'plan', 'uuid', PLAN_FIELDS, fields);
    return null;
  }

  applyScalarFields(db, op, 'plan', 'uuid', PLAN_FIELDS, fieldsFromPayload(payload));
  return null;
}

function maxTaskIndex(db: Database, planUuid: string): number {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(task_index), -1) AS maxTaskIndex FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL'
    )
    .get(planUuid) as { maxTaskIndex: number };
  return row.maxTaskIndex;
}

function planExists(db: Database, planUuid: string): boolean {
  const row = db.prepare('SELECT 1 AS present FROM plan WHERE uuid = ?').get(planUuid) as {
    present: number;
  } | null;
  return row !== null;
}

function applyTaskCreateOrUpdate(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  if (hasTombstone(db, 'plan_task', op.entity_id)) {
    return null;
  }
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  const fields = fieldsFromPayload(payload);
  const planUuidValue = fields.plan_uuid ?? payload.planUuid;
  if (typeof planUuidValue !== 'string' || planUuidValue.length === 0) {
    return { opId: op.op_id, reason: 'plan_task op missing plan_uuid' };
  }
  const planUuid = planUuidValue;
  if (hasTombstone(db, 'plan', planUuid)) {
    return { opId: op.op_id, reason: `plan_task op references tombstoned plan ${planUuid}` };
  }
  if (!planExists(db, planUuid)) {
    return deferredSkip(op, `plan_task op references missing plan ${planUuid}`);
  }
  const existing = db.prepare('SELECT uuid FROM plan_task WHERE uuid = ?').get(op.entity_id) as {
    uuid: string;
  } | null;
  const wasInserted = !existing;
  if (wasInserted) {
    const orderKey = String(fields.order_key ?? '0000000000');
    const taskIndex = maxTaskIndex(db, planUuid) + 1;
    db.prepare(
      `
        INSERT INTO plan_task (
          uuid,
          plan_uuid,
          task_index,
          order_key,
          title,
          description,
          done,
          created_node_id,
          created_hlc,
          updated_hlc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      op.entity_id,
      planUuid,
      taskIndex,
      orderKey,
      String(fields.title ?? ''),
      String(fields.description ?? ''),
      fields.done ? 1 : 0,
      op.node_id,
      formatHlc(opHlc(op)),
      formatHlc(opHlc(op))
    );
  }

  const applied = applyScalarFields(db, op, 'plan_task', 'uuid', PLAN_TASK_FIELDS, fields, {
    touchUpdatedAt: false,
  });
  if (applied.length > 0) {
    db.prepare('UPDATE plan_task SET updated_hlc = ? WHERE uuid = ? AND deleted_hlc IS NULL').run(
      formatHlc(opHlc(op)),
      op.entity_id
    );
  }
  if (wasInserted || applied.includes('order_key')) {
    renumberPlanTaskIndices(db, planUuid);
  }
  return null;
}

function renumberPlanTaskIndices(db: Database, planUuid: string): void {
  db.prepare(
    `
      UPDATE plan_task
      SET task_index = -id
      WHERE plan_uuid = ?
        AND deleted_hlc IS NULL
    `
  ).run(planUuid);

  const rows = db
    .prepare(
      'SELECT uuid FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, created_hlc, created_node_id, uuid'
    )
    .all(planUuid) as Array<{ uuid: string }>;
  const update = db.prepare('UPDATE plan_task SET task_index = ? WHERE uuid = ?');
  rows.forEach((row, index) => update.run(index, row.uuid));
}

function applyTaskSetOrder(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  if (hasTombstone(db, 'plan_task', op.entity_id)) {
    return null;
  }
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  if (typeof payload.planUuid !== 'string' || payload.planUuid.length === 0) {
    return { opId: op.op_id, reason: 'plan_task set_order op missing planUuid' };
  }
  if (hasTombstone(db, 'plan', payload.planUuid)) {
    return {
      opId: op.op_id,
      reason: `plan_task set_order references tombstoned plan ${payload.planUuid}`,
    };
  }
  if (!planExists(db, payload.planUuid)) {
    return deferredSkip(op, `plan_task set_order references missing plan ${payload.planUuid}`);
  }
  const taskRowExists = db
    .prepare('SELECT 1 AS present FROM plan_task WHERE uuid = ?')
    .get(op.entity_id) as { present: number } | null;
  if (!taskRowExists) {
    return deferredSkip(op, `plan_task set_order arrived before task ${op.entity_id} create`);
  }
  applyScalarFields(
    db,
    op,
    'plan_task',
    'uuid',
    PLAN_TASK_FIELDS,
    {
      order_key: payload.orderKey,
    },
    {
      touchUpdatedAt: false,
    }
  );
  renumberPlanTaskIndices(db, payload.planUuid);
  return null;
}

function applyReviewIssueCreateOrUpdate(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  if (hasTombstone(db, 'plan_review_issue', op.entity_id)) {
    return null;
  }
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  const fields = fieldsFromPayload(payload);
  const planUuidValue = fields.plan_uuid ?? payload.planUuid;
  if (typeof planUuidValue !== 'string' || planUuidValue.length === 0) {
    return { opId: op.op_id, reason: 'plan_review_issue op missing plan_uuid' };
  }
  const planUuid = planUuidValue;
  if (hasTombstone(db, 'plan', planUuid)) {
    return {
      opId: op.op_id,
      reason: `plan_review_issue op references tombstoned plan ${planUuid}`,
    };
  }
  if (!planExists(db, planUuid)) {
    return deferredSkip(op, `plan_review_issue op references missing plan ${planUuid}`);
  }
  const existing = db
    .prepare('SELECT uuid FROM plan_review_issue WHERE uuid = ?')
    .get(op.entity_id) as { uuid: string } | null;
  if (!existing) {
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
          source_ref,
          created_node_id,
          created_hlc,
          updated_hlc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      op.entity_id,
      planUuid,
      String(fields.order_key ?? '0000000000'),
      sqlValue(fields.severity),
      sqlValue(fields.category),
      String(fields.content ?? ''),
      sqlValue(fields.file),
      sqlValue(fields.line),
      sqlValue(fields.suggestion),
      sqlValue(fields.source),
      sqlValue(fields.source_ref),
      op.node_id,
      formatHlc(opHlc(op)),
      formatHlc(opHlc(op))
    );
  }

  const applied = applyScalarFields(
    db,
    op,
    'plan_review_issue',
    'uuid',
    REVIEW_ISSUE_FIELDS,
    fields
  );
  if (applied.length > 0) {
    db.prepare(
      `UPDATE plan_review_issue SET updated_hlc = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ? AND deleted_hlc IS NULL`
    ).run(formatHlc(opHlc(op)), op.entity_id);
  }
  return null;
}

function insertSyntheticTombstone(
  db: Database,
  op: SyncOpRecord,
  entityType: string,
  entityId: string
): void {
  insertTombstone(db, { ...op, entity_type: entityType, entity_id: entityId });
}

function tombstonePlanChildren(db: Database, op: SyncOpRecord): void {
  const planUuid = op.entity_id;
  const tasks = db
    .prepare('SELECT uuid FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL')
    .all(planUuid) as Array<{ uuid: string }>;
  for (const task of tasks) {
    insertSyntheticTombstone(db, op, 'plan_task', task.uuid);
  }

  const reviewIssues = db
    .prepare('SELECT uuid FROM plan_review_issue WHERE plan_uuid = ? AND deleted_hlc IS NULL')
    .all(planUuid) as Array<{ uuid: string }>;
  for (const issue of reviewIssues) {
    insertSyntheticTombstone(db, op, 'plan_review_issue', issue.uuid);
  }

  const dependencies = db
    .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
    .all(planUuid) as Array<{ depends_on_uuid: string }>;
  for (const dependency of dependencies) {
    insertSyntheticTombstone(
      db,
      op,
      'plan_dependency',
      `${planUuid}->${dependency.depends_on_uuid}`
    );
  }

  const tags = db.prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?').all(planUuid) as Array<{
    tag: string;
  }>;
  for (const tag of tags) {
    insertSyntheticTombstone(db, op, 'plan_tag', `${planUuid}#${tag.tag}`);
  }
}

function applyEntityDelete(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  const hlcText = formatHlc(opHlc(op));
  if (op.entity_type === 'plan_task') {
    insertTombstone(db, op);
    db.prepare(
      'UPDATE plan_task SET deleted_hlc = ?, updated_hlc = ?, task_index = -id WHERE uuid = ? AND (deleted_hlc IS NULL OR deleted_hlc < ?)'
    ).run(hlcText, hlcText, op.entity_id, hlcText);
  } else if (op.entity_type === 'plan_review_issue') {
    insertTombstone(db, op);
    db.prepare(
      `UPDATE plan_review_issue SET deleted_hlc = ?, updated_hlc = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ? AND (deleted_hlc IS NULL OR deleted_hlc < ?)`
    ).run(hlcText, hlcText, op.entity_id, hlcText);
  } else if (op.entity_type === 'project_setting') {
    const payload = parsePayload(op);
    if (isSkippedSyncOp(payload)) return payload;
    if (
      typeof payload.projectIdentity !== 'string' ||
      payload.projectIdentity.length === 0 ||
      typeof payload.setting !== 'string'
    ) {
      return {
        opId: op.op_id,
        reason: 'project_setting delete op missing projectIdentity or setting',
      };
    }
    insertTombstone(db, op);
    const projectId = projectIdForIdentity(db, payload.projectIdentity);
    const storedClock = db
      .prepare(
        'SELECT * FROM sync_field_clock WHERE entity_type = ? AND entity_id = ? AND field_name = ?'
      )
      .get('project_setting', op.entity_id, 'value') as SyncFieldClockRow | null;
    if (!remoteWins(opHlc(op), op.node_id, storedClock)) {
      return null;
    }
    if (projectId !== null) {
      db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
        projectId,
        payload.setting
      );
    }
    updateFieldClock(db, op, 'value', true);
  } else if (op.entity_type === 'plan') {
    insertTombstone(db, op);
    tombstonePlanChildren(db, op);
    db.prepare('DELETE FROM plan WHERE uuid = ?').run(op.entity_id);
  } else if (op.entity_type === 'plan_dependency') {
    const payload = parsePayload(op);
    if (isSkippedSyncOp(payload)) return payload;
    insertTombstone(db, op);
    if (typeof payload.planUuid === 'string' && typeof payload.dependsOnUuid === 'string') {
      db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
        payload.planUuid,
        payload.dependsOnUuid
      );
    }
  } else if (op.entity_type === 'plan_tag') {
    const payload = parsePayload(op);
    if (isSkippedSyncOp(payload)) return payload;
    insertTombstone(db, op);
    if (typeof payload.planUuid === 'string' && typeof payload.tag === 'string') {
      db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(
        payload.planUuid,
        payload.tag
      );
    }
  }
  return null;
}

function latestAddEdge(db: Database, op: SyncOpRecord): SyncOpLogRow | null {
  return db
    .prepare(
      `
        SELECT *
        FROM sync_op_log
        WHERE entity_type = ?
          AND entity_id = ?
          AND op_type = 'add_edge'
        ORDER BY hlc_physical_ms DESC, hlc_logical DESC, node_id DESC, local_counter DESC
        LIMIT 1
      `
    )
    .get(op.entity_type, op.entity_id) as SyncOpLogRow | null;
}

function applyDependencyEdge(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  if (typeof payload.planUuid !== 'string' || typeof payload.dependsOnUuid !== 'string') {
    return { opId: op.op_id, reason: 'dependency edge op missing planUuid or dependsOnUuid' };
  }
  if (op.op_type === 'remove_edge') {
    insertTombstone(db, op);
  }
  const add = latestAddEdge(db, op);
  const remove = db
    .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(op.entity_type, op.entity_id) as SyncTombstoneRow | null;
  const present =
    add !== null &&
    remoteWins({ physicalMs: add.hlc_physical_ms, logical: add.hlc_logical }, add.node_id, remove);
  if (present) {
    if (
      hasTombstone(db, 'plan', payload.planUuid) ||
      hasTombstone(db, 'plan', payload.dependsOnUuid)
    ) {
      return { opId: op.op_id, reason: 'parent plan tombstoned; dropping dependency edge' };
    }
    if (!planExists(db, payload.planUuid) || !planExists(db, payload.dependsOnUuid)) {
      return deferredSkip(op, 'dependency edge references missing parent plan; deferring');
    }
    db.prepare(
      'INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)'
    ).run(payload.planUuid, payload.dependsOnUuid);
  } else {
    db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
      payload.planUuid,
      payload.dependsOnUuid
    );
  }
  return null;
}

function applyTagEdge(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  if (typeof payload.planUuid !== 'string' || typeof payload.tag !== 'string') {
    return { opId: op.op_id, reason: 'tag edge op missing planUuid or tag' };
  }
  if (op.op_type === 'remove_edge') {
    insertTombstone(db, op);
  }
  const add = latestAddEdge(db, op);
  const remove = db
    .prepare('SELECT * FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
    .get(op.entity_type, op.entity_id) as SyncTombstoneRow | null;
  const present =
    add !== null &&
    remoteWins({ physicalMs: add.hlc_physical_ms, logical: add.hlc_logical }, add.node_id, remove);
  if (present) {
    if (hasTombstone(db, 'plan', payload.planUuid)) {
      return { opId: op.op_id, reason: 'parent plan tombstoned; dropping tag edge' };
    }
    if (!planExists(db, payload.planUuid)) {
      return deferredSkip(op, 'tag edge references missing parent plan; deferring');
    }
    db.prepare('INSERT OR IGNORE INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(
      payload.planUuid,
      payload.tag
    );
  } else {
    db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(
      payload.planUuid,
      payload.tag
    );
  }
  return null;
}

function applyProjectSettingUpdate(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  if (tombstoneWinsOrTies(db, op)) {
    return null;
  }
  const payload = parsePayload(op);
  if (isSkippedSyncOp(payload)) return payload;
  const projectId = projectIdForIdentity(db, payload.projectIdentity);
  if (projectId === null || typeof payload.setting !== 'string') {
    return { opId: op.op_id, reason: 'project_setting op missing projectIdentity or setting' };
  }
  const storedClock = db
    .prepare(
      'SELECT * FROM sync_field_clock WHERE entity_type = ? AND entity_id = ? AND field_name = ?'
    )
    .get('project_setting', op.entity_id, 'value') as SyncFieldClockRow | null;
  if (!remoteWins(opHlc(op), op.node_id, storedClock)) {
    return null;
  }
  db.prepare(
    'INSERT OR REPLACE INTO project_setting (project_id, setting, value) VALUES (?, ?, ?)'
  ).run(projectId, payload.setting, JSON.stringify(payload.value));
  updateFieldClock(db, op, 'value');
  return null;
}

function observeRemoteHlc(db: Database, op: SyncOpRecord): void {
  const cached = getLocalGenerator(db);
  cached.generator.observe(opHlc(op), Date.now(), db);
}

function applyKnownOp(db: Database, op: SyncOpRecord): SkippedSyncOp | null {
  if (op.entity_type === 'plan' && (op.op_type === 'create' || op.op_type === 'update_fields')) {
    return applyPlanCreateOrUpdate(db, op);
  }
  if (
    op.entity_type === 'plan_task' &&
    (op.op_type === 'create' || op.op_type === 'update_fields')
  ) {
    return applyTaskCreateOrUpdate(db, op);
  }
  if (op.entity_type === 'plan_task' && op.op_type === 'set_order') {
    return applyTaskSetOrder(db, op);
  }
  if (
    op.entity_type === 'plan_review_issue' &&
    (op.op_type === 'create' || op.op_type === 'update_fields')
  ) {
    return applyReviewIssueCreateOrUpdate(db, op);
  }
  if (
    (op.entity_type === 'plan' ||
      op.entity_type === 'plan_task' ||
      op.entity_type === 'plan_review_issue' ||
      op.entity_type === 'project_setting' ||
      op.entity_type === 'plan_dependency' ||
      op.entity_type === 'plan_tag') &&
    op.op_type === 'delete'
  ) {
    return applyEntityDelete(db, op);
  }
  if (
    op.entity_type === 'plan_dependency' &&
    (op.op_type === 'add_edge' || op.op_type === 'remove_edge')
  ) {
    return applyDependencyEdge(db, op);
  }
  if (
    op.entity_type === 'plan_tag' &&
    (op.op_type === 'add_edge' || op.op_type === 'remove_edge')
  ) {
    return applyTagEdge(db, op);
  }
  if (op.entity_type === 'project_setting' && op.op_type === 'update_fields') {
    return applyProjectSettingUpdate(db, op);
  }
  return { opId: op.op_id, reason: `unsupported op ${op.entity_type}:${op.op_type}` };
}

function isSupportedOp(op: SyncOpRecord): boolean {
  return (
    (op.entity_type === 'plan' &&
      (op.op_type === 'create' || op.op_type === 'update_fields' || op.op_type === 'delete')) ||
    (op.entity_type === 'plan_task' &&
      (op.op_type === 'create' ||
        op.op_type === 'update_fields' ||
        op.op_type === 'set_order' ||
        op.op_type === 'delete')) ||
    (op.entity_type === 'plan_review_issue' &&
      (op.op_type === 'create' || op.op_type === 'update_fields' || op.op_type === 'delete')) ||
    (op.entity_type === 'project_setting' &&
      (op.op_type === 'update_fields' || op.op_type === 'delete')) ||
    (op.entity_type === 'plan_dependency' &&
      (op.op_type === 'add_edge' || op.op_type === 'remove_edge' || op.op_type === 'delete')) ||
    (op.entity_type === 'plan_tag' &&
      (op.op_type === 'add_edge' || op.op_type === 'remove_edge' || op.op_type === 'delete'))
  );
}

function sortOps(ops: SyncOpRecord[]): SyncOpRecord[] {
  return [...ops].sort((a, b) => {
    if (a.hlc_physical_ms !== b.hlc_physical_ms) return a.hlc_physical_ms - b.hlc_physical_ms;
    if (a.hlc_logical !== b.hlc_logical) return a.hlc_logical - b.hlc_logical;
    const nodeCompare = a.node_id.localeCompare(b.node_id);
    if (nodeCompare !== 0) return nodeCompare;
    return a.local_counter - b.local_counter;
  });
}

function stableOpId(op: unknown): string | null {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    return null;
  }
  const opId = (op as { op_id?: unknown }).op_id;
  return typeof opId === 'string' && opId.length > 0 ? opId : null;
}

function existingOpLogRow(db: Database, opId: string): { op_id: string } | null {
  return db.prepare('SELECT op_id FROM sync_op_log WHERE op_id = ?').get(opId) as {
    op_id: string;
  } | null;
}

function hasInsertableShape(op: unknown): op is SyncOpRecord {
  return (
    op !== null &&
    typeof op === 'object' &&
    !Array.isArray(op) &&
    typeof (op as { op_id?: unknown }).op_id === 'string' &&
    typeof (op as { node_id?: unknown }).node_id === 'string' &&
    typeof (op as { hlc_physical_ms?: unknown }).hlc_physical_ms === 'number' &&
    Number.isSafeInteger((op as { hlc_physical_ms?: unknown }).hlc_physical_ms) &&
    typeof (op as { hlc_logical?: unknown }).hlc_logical === 'number' &&
    Number.isSafeInteger((op as { hlc_logical?: unknown }).hlc_logical) &&
    typeof (op as { local_counter?: unknown }).local_counter === 'number' &&
    Number.isSafeInteger((op as { local_counter?: unknown }).local_counter) &&
    typeof (op as { entity_type?: unknown }).entity_type === 'string' &&
    typeof (op as { entity_id?: unknown }).entity_id === 'string' &&
    typeof (op as { op_type?: unknown }).op_type === 'string' &&
    typeof (op as { payload?: unknown }).payload === 'string'
  );
}

export function applyRemoteOps(db: Database, ops: unknown[]): ApplyResult {
  const result: ApplyResult = { applied: 0, skipped: [], errors: [] };
  const validOps: SyncOpRecord[] = [];

  for (const op of ops) {
    const validation = validateOpEnvelope(op);
    if (validation.ok) {
      validOps.push(op as SyncOpRecord);
      continue;
    }

    const opId = stableOpId(op);
    if (!opId) {
      result.skipped.push({
        opId: '<invalid>',
        reason: validation.reason,
        kind: 'permanent',
      });
      continue;
    }

    const existing = existingOpLogRow(db, opId);
    if (existing) {
      result.skipped.push({ opId, reason: 'already applied' });
      continue;
    }
    if (!hasInsertableShape(op)) {
      result.skipped.push({
        opId,
        reason: validation.reason,
        kind: 'permanent',
      });
      continue;
    }

    try {
      const insertInvalid = db.transaction((nextOp: SyncOpRecord): SkippedSyncOp => {
        insertRemoteOpLog(db, nextOp);
        return permanentSkip(nextOp, validation.reason);
      });
      result.skipped.push(insertInvalid.immediate(op));
    } catch (error) {
      result.errors.push({
        opId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const op of sortOps(validOps)) {
    const existing = existingOpLogRow(db, op.op_id);
    if (existing) {
      result.skipped.push({ opId: op.op_id, reason: 'already applied' });
      continue;
    }

    try {
      const applyOne = db.transaction((nextOp: SyncOpRecord): SkippedSyncOp | null => {
        // Permanent skips keep this op-log row so malformed or unsupported ops
        // dedupe on retry. Deferred skips deliberately roll the row back below
        // so out-of-order ops can be re-delivered after their parents arrive.
        insertRemoteOpLog(db, nextOp);
        if (!isSupportedOp(nextOp)) {
          observeRemoteHlc(db, nextOp);
          return {
            opId: nextOp.op_id,
            reason: `unsupported op ${nextOp.entity_type}:${nextOp.op_type}`,
            kind: 'permanent',
          };
        }
        const skipped = applyKnownOp(db, nextOp);
        if (skipped?.kind === 'deferred') {
          throw new DeferredSkipRollback(skipped);
        }
        observeRemoteHlc(db, nextOp);
        return skipped ? { ...skipped, kind: skipped.kind ?? 'permanent' } : null;
      });
      const skipped = applyOne.immediate(op);
      if (skipped) {
        result.skipped.push(skipped);
      } else {
        result.applied += 1;
      }
    } catch (error) {
      if (error instanceof DeferredSkipRollback) {
        // The apply transaction rolled back so the op-log row can be retried,
        // but the remote HLC must still advance — otherwise a high-HLC deferred
        // op that we durably retain in sync_pending_op could be overwritten by
        // a later local write that picked a lower HLC.
        observeRemoteHlc(db, op);
        result.skipped.push(error.skipped);
        continue;
      }
      result.errors.push({
        opId: op.op_id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
