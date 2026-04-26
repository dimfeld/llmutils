import type { Database } from 'bun:sqlite';

import { getProjectById } from '../db/project.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { ensureLocalNode } from '../db/sync_schema.js';
import { formatHlc, HlcGenerator, type Hlc } from './hlc.js';

export type SyncEntityType =
  | 'plan'
  | 'plan_task'
  | 'plan_dependency'
  | 'plan_tag'
  | 'plan_review_issue'
  | 'project_setting';

export interface EmittedSyncOperation {
  hlc: Hlc;
  hlcText: string;
  nodeId: string;
  opId: string;
}

type JsonValue = unknown;
type FieldUpdates = Record<string, JsonValue>;

export function getProjectSyncIdentity(db: Database, projectId: number): string {
  const project = getProjectById(db, projectId);
  if (!project) {
    return `local-project-${projectId}`;
  }
  return project.repository_id || `local-project-${project.id}`;
}

function tickLocal(db: Database): EmittedSyncOperation {
  const localNode = ensureLocalNode(db);
  const tick = new HlcGenerator(db, localNode.node_id).tick(Date.now(), db);
  return {
    hlc: tick.hlc,
    hlcText: formatHlc(tick.hlc),
    nodeId: localNode.node_id,
    opId: tick.opId,
  };
}

function insertOp(
  db: Database,
  emitted: EmittedSyncOperation,
  entityType: SyncEntityType,
  entityId: string,
  opType: string,
  payload: JsonValue,
  base?: JsonValue
): void {
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC})
    `
  ).run(
    emitted.opId,
    emitted.nodeId,
    emitted.hlc.physicalMs,
    emitted.hlc.logical,
    Number.parseInt(emitted.opId.split('/')[2] ?? '0', 10),
    entityType,
    entityId,
    opType,
    JSON.stringify(payload),
    base === undefined ? null : JSON.stringify(base)
  );
}

function updateFieldClock(
  db: Database,
  emitted: EmittedSyncOperation,
  entityType: SyncEntityType,
  entityId: string,
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
    entityType,
    entityId,
    fieldName,
    emitted.hlc.physicalMs,
    emitted.hlc.logical,
    emitted.nodeId,
    deleted ? 1 : 0
  );
}

function writeFieldClocks(
  db: Database,
  emitted: EmittedSyncOperation,
  entityType: SyncEntityType,
  entityId: string,
  fields: FieldUpdates,
  deleted = false
): void {
  for (const fieldName of Object.keys(fields)) {
    updateFieldClock(db, emitted, entityType, entityId, fieldName, deleted);
  }
}

function insertTombstone(
  db: Database,
  emitted: EmittedSyncOperation,
  entityType: SyncEntityType,
  entityId: string
): void {
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
  ).run(entityType, entityId, emitted.hlc.physicalMs, emitted.hlc.logical, emitted.nodeId);
}

function emitWithFields(
  db: Database,
  entityType: SyncEntityType,
  entityId: string,
  opType: string,
  payload: JsonValue,
  fields: FieldUpdates
): EmittedSyncOperation {
  const emitted = tickLocal(db);
  insertOp(db, emitted, entityType, entityId, opType, payload);
  writeFieldClocks(db, emitted, entityType, entityId, fields);
  return emitted;
}

export function emitPlanCreate(
  db: Database,
  planUuid: string,
  fields: FieldUpdates
): EmittedSyncOperation {
  return emitWithFields(db, 'plan', planUuid, 'create', { fields }, fields);
}

export function emitPlanFieldUpdate(
  db: Database,
  planUuid: string,
  fieldUpdates: FieldUpdates
): EmittedSyncOperation | null {
  if (Object.keys(fieldUpdates).length === 0) {
    return null;
  }
  return emitWithFields(
    db,
    'plan',
    planUuid,
    'update_fields',
    { fields: fieldUpdates },
    fieldUpdates
  );
}

export function emitPlanDelete(db: Database, planUuid: string): EmittedSyncOperation {
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan', planUuid, 'delete', {});
  insertTombstone(db, emitted, 'plan', planUuid);
  return emitted;
}

export function emitTaskCreate(
  db: Database,
  planUuid: string,
  taskUuid: string,
  fields: FieldUpdates
): EmittedSyncOperation {
  const emitted = emitWithFields(db, 'plan_task', taskUuid, 'create', { planUuid, fields }, fields);
  db.prepare('UPDATE plan_task SET created_hlc = ?, updated_hlc = ? WHERE uuid = ?').run(
    emitted.hlcText,
    emitted.hlcText,
    taskUuid
  );
  return emitted;
}

export function emitTaskFieldUpdate(
  db: Database,
  planUuid: string,
  taskUuid: string,
  fieldUpdates: FieldUpdates
): EmittedSyncOperation | null {
  if (Object.keys(fieldUpdates).length === 0) {
    return null;
  }
  const emitted = emitWithFields(
    db,
    'plan_task',
    taskUuid,
    'update_fields',
    { planUuid, fields: fieldUpdates },
    fieldUpdates
  );
  db.prepare('UPDATE plan_task SET updated_hlc = ? WHERE uuid = ? AND deleted_hlc IS NULL').run(
    emitted.hlcText,
    taskUuid
  );
  return emitted;
}

export function emitTaskDelete(
  db: Database,
  planUuid: string,
  taskUuid: string
): EmittedSyncOperation {
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_task', taskUuid, 'delete', { planUuid });
  insertTombstone(db, emitted, 'plan_task', taskUuid);
  db.prepare(
    `
      UPDATE plan_task
      SET deleted_hlc = ?,
          updated_hlc = ?,
          task_index = -id
      WHERE uuid = ?
        AND deleted_hlc IS NULL
    `
  ).run(emitted.hlcText, emitted.hlcText, taskUuid);
  return emitted;
}

export function emitTaskSetOrder(
  db: Database,
  planUuid: string,
  taskUuid: string,
  orderKey: string,
  taskIndex: number
): EmittedSyncOperation {
  const emitted = emitWithFields(
    db,
    'plan_task',
    taskUuid,
    'set_order',
    { planUuid, orderKey, taskIndex },
    { order_key: orderKey, task_index: taskIndex }
  );
  db.prepare('UPDATE plan_task SET updated_hlc = ? WHERE uuid = ? AND deleted_hlc IS NULL').run(
    emitted.hlcText,
    taskUuid
  );
  return emitted;
}

export function emitReviewIssueCreate(
  db: Database,
  planUuid: string,
  issueUuid: string,
  fields: FieldUpdates
): EmittedSyncOperation {
  const emitted = emitWithFields(
    db,
    'plan_review_issue',
    issueUuid,
    'create',
    { planUuid, fields },
    fields
  );
  db.prepare('UPDATE plan_review_issue SET created_hlc = ?, updated_hlc = ? WHERE uuid = ?').run(
    emitted.hlcText,
    emitted.hlcText,
    issueUuid
  );
  return emitted;
}

export function emitReviewIssueFieldUpdate(
  db: Database,
  planUuid: string,
  issueUuid: string,
  fieldUpdates: FieldUpdates
): EmittedSyncOperation | null {
  if (Object.keys(fieldUpdates).length === 0) {
    return null;
  }
  const emitted = emitWithFields(
    db,
    'plan_review_issue',
    issueUuid,
    'update_fields',
    { planUuid, fields: fieldUpdates },
    fieldUpdates
  );
  db.prepare(
    'UPDATE plan_review_issue SET updated_hlc = ? WHERE uuid = ? AND deleted_hlc IS NULL'
  ).run(emitted.hlcText, issueUuid);
  return emitted;
}

export function emitReviewIssueDelete(
  db: Database,
  planUuid: string,
  issueUuid: string
): EmittedSyncOperation {
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_review_issue', issueUuid, 'delete', { planUuid });
  insertTombstone(db, emitted, 'plan_review_issue', issueUuid);
  db.prepare(
    `
      UPDATE plan_review_issue
      SET deleted_hlc = ?,
          updated_hlc = ?,
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE uuid = ?
        AND deleted_hlc IS NULL
    `
  ).run(emitted.hlcText, emitted.hlcText, issueUuid);
  return emitted;
}

export function emitDependencyAdd(
  db: Database,
  planUuid: string,
  dependsOnUuid: string
): EmittedSyncOperation {
  const entityId = `${planUuid}->${dependsOnUuid}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_dependency', entityId, 'add_edge', { planUuid, dependsOnUuid });
  return emitted;
}

export function emitDependencyRemove(
  db: Database,
  planUuid: string,
  dependsOnUuid: string
): EmittedSyncOperation {
  const entityId = `${planUuid}->${dependsOnUuid}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_dependency', entityId, 'remove_edge', { planUuid, dependsOnUuid });
  insertTombstone(db, emitted, 'plan_dependency', entityId);
  return emitted;
}

export function emitTagAdd(db: Database, planUuid: string, tag: string): EmittedSyncOperation {
  const entityId = `${planUuid}#${tag}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_tag', entityId, 'add_edge', { planUuid, tag });
  return emitted;
}

export function emitTagRemove(db: Database, planUuid: string, tag: string): EmittedSyncOperation {
  const entityId = `${planUuid}#${tag}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_tag', entityId, 'remove_edge', { planUuid, tag });
  insertTombstone(db, emitted, 'plan_tag', entityId);
  return emitted;
}

export function emitProjectSettingUpdate(
  db: Database,
  projectIdentity: string,
  settingName: string,
  value: unknown
): EmittedSyncOperation {
  const entityId = `${projectIdentity}:${settingName}`;
  return emitWithFields(
    db,
    'project_setting',
    entityId,
    'update_fields',
    { projectIdentity, setting: settingName, value },
    { value }
  );
}

export function emitProjectSettingDelete(
  db: Database,
  projectIdentity: string,
  settingName: string
): EmittedSyncOperation {
  const entityId = `${projectIdentity}:${settingName}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'project_setting', entityId, 'delete', {
    projectIdentity,
    setting: settingName,
  });
  updateFieldClock(db, emitted, 'project_setting', entityId, 'value', true);
  insertTombstone(db, emitted, 'project_setting', entityId);
  return emitted;
}
