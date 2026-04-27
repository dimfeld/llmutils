import type { Database } from 'bun:sqlite';

import { getProjectById } from '../db/project.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { ensureLocalNode } from '../db/sync_schema.js';
import { writeEdgeAddClock, writeEdgeRemoveClock } from './edge_clock.js';
import { formatHlc, formatOpId, HlcGenerator, type Hlc } from './hlc.js';

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
  localCounter: number;
}

type JsonValue = unknown;
type FieldUpdates = Record<string, JsonValue>;

export const PLAN_LWW_FIELD_NAMES = [
  'title',
  'goal',
  'note',
  'details',
  'status',
  'priority',
  'branch',
  'simple',
  'tdd',
  'discovered_from',
  'issue',
  'pull_request',
  'assigned_to',
  'base_branch',
  'base_commit',
  'base_change_id',
  'temp',
  'docs',
  'changed_files',
  'plan_generated_at',
  'docs_updated_at',
  'lessons_applied_at',
  'parent_uuid',
  'epic',
] as const;

export const PLAN_TASK_LWW_FIELD_NAMES = ['order_key', 'title', 'description', 'done'] as const;

export const REVIEW_ISSUE_LWW_FIELD_NAMES = [
  'order_key',
  'severity',
  'category',
  'content',
  'file',
  'line',
  'suggestion',
  'source',
  'source_ref',
] as const;

export const PROJECT_SETTING_LWW_FIELD_NAME = 'value';

export function getProjectSyncIdentity(db: Database, projectId: number): string {
  const project = getProjectById(db, projectId);
  if (!project) {
    return `local-project-${projectId}`;
  }
  return project.repository_id || `local-project-${project.id}`;
}

const generatorCache = new WeakMap<Database, { nodeId: string; generator: HlcGenerator }>();

export function getLocalGenerator(db: Database): { nodeId: string; generator: HlcGenerator } {
  const cached = generatorCache.get(db);
  if (cached) return cached;
  const localNode = ensureLocalNode(db);
  const entry = { nodeId: localNode.node_id, generator: new HlcGenerator(db, localNode.node_id) };
  generatorCache.set(db, entry);
  return entry;
}

function tickLocal(db: Database): EmittedSyncOperation {
  const { nodeId, generator } = getLocalGenerator(db);
  const tick = generator.tick(Date.now(), db);
  return {
    hlc: tick.hlc,
    hlcText: formatHlc(tick.hlc),
    nodeId,
    opId: tick.opId,
    localCounter: tick.localCounter,
  };
}

function tickLocalWithHlc(db: Database, hlc: Hlc): EmittedSyncOperation {
  const { nodeId } = getLocalGenerator(db);
  const tick = tickLocal(db);
  const hlcText = formatHlc(hlc);
  return {
    hlc,
    hlcText,
    nodeId,
    opId: formatOpId(hlc, nodeId, tick.localCounter),
    localCounter: tick.localCounter,
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
    emitted.localCounter,
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

// Local-only plan columns that must not be carried in cross-node sync ops.
// `project_id` is a local SQLite integer that differs per node; the stable
// project identity is supplied as `projectIdentity` in the payload instead.
// `plan_id` is a display/convenience numeric ID that nodes allocate locally
// and reconcile out-of-band; it's emitted as a provisional hint, not a LWW
// register. `created_at`/`updated_at` are local clock values.
const PLAN_LOCAL_ONLY_FIELDS = new Set<string>([
  'project_id',
  'plan_id',
  'created_at',
  'updated_at',
]);

function pickPlanLwwFields(fields: FieldUpdates): FieldUpdates {
  const filtered: FieldUpdates = {};
  for (const [name, value] of Object.entries(fields)) {
    if (!PLAN_LOCAL_ONLY_FIELDS.has(name)) {
      filtered[name] = value;
    }
  }
  return filtered;
}

export interface EmitPlanContext {
  projectIdentity: string;
  planIdHint?: number | null;
}

export function emitPlanCreate(
  db: Database,
  planUuid: string,
  context: EmitPlanContext,
  fields: FieldUpdates
): EmittedSyncOperation {
  const lwwFields = pickPlanLwwFields(fields);
  return emitWithFields(
    db,
    'plan',
    planUuid,
    'create',
    {
      projectIdentity: context.projectIdentity,
      planIdHint: context.planIdHint ?? null,
      fields: lwwFields,
    },
    lwwFields
  );
}

export function emitPlanFieldUpdate(
  db: Database,
  planUuid: string,
  context: EmitPlanContext,
  fieldUpdates: FieldUpdates
): EmittedSyncOperation | null {
  const lwwFields = pickPlanLwwFields(fieldUpdates);
  if (Object.keys(lwwFields).length === 0) {
    return null;
  }
  return emitWithFields(
    db,
    'plan',
    planUuid,
    'update_fields',
    {
      projectIdentity: context.projectIdentity,
      planIdHint: context.planIdHint ?? null,
      fields: lwwFields,
    },
    lwwFields
  );
}

export function emitPlanDelete(db: Database, planUuid: string): EmittedSyncOperation {
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan', planUuid, 'delete', {});
  insertTombstone(db, emitted, 'plan', planUuid);

  const emitChild = (
    entityType: SyncEntityType,
    entityId: string,
    payload: JsonValue
  ): EmittedSyncOperation => {
    const child = tickLocalWithHlc(db, emitted.hlc);
    insertOp(db, child, entityType, entityId, 'delete', payload);
    insertTombstone(db, child, entityType, entityId);
    return child;
  };

  const tasks = db
    .prepare('SELECT uuid FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL')
    .all(planUuid) as Array<{ uuid: string }>;
  for (const task of tasks) {
    emitChild('plan_task', task.uuid, { planUuid });
  }

  const reviewIssues = db
    .prepare('SELECT uuid FROM plan_review_issue WHERE plan_uuid = ? AND deleted_hlc IS NULL')
    .all(planUuid) as Array<{ uuid: string }>;
  for (const issue of reviewIssues) {
    emitChild('plan_review_issue', issue.uuid, { planUuid });
  }

  const dependencies = db
    .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
    .all(planUuid) as Array<{ depends_on_uuid: string }>;
  for (const dependency of dependencies) {
    const entityId = `${planUuid}->${dependency.depends_on_uuid}`;
    const child = emitChild('plan_dependency', entityId, {
      planUuid,
      dependsOnUuid: dependency.depends_on_uuid,
    });
    writeEdgeRemoveClock(db, {
      entityType: 'plan_dependency',
      edgeKey: entityId,
      hlc: child.hlc,
      nodeId: child.nodeId,
    });
  }

  const tags = db.prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?').all(planUuid) as Array<{
    tag: string;
  }>;
  for (const tag of tags) {
    const entityId = `${planUuid}#${tag.tag}`;
    const child = emitChild('plan_tag', entityId, { planUuid, tag: tag.tag });
    writeEdgeRemoveClock(db, {
      entityType: 'plan_tag',
      edgeKey: entityId,
      hlc: child.hlc,
      nodeId: child.nodeId,
    });
  }

  return emitted;
}

export function emitTaskCreate(
  db: Database,
  planUuid: string,
  taskUuid: string,
  fields: FieldUpdates
): EmittedSyncOperation {
  const emitted = emitWithFields(db, 'plan_task', taskUuid, 'create', { planUuid, fields }, fields);
  db.prepare(
    'UPDATE plan_task SET created_hlc = ?, created_node_id = ?, updated_hlc = ? WHERE uuid = ?'
  ).run(emitted.hlcText, emitted.nodeId, emitted.hlcText, taskUuid);
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
    { order_key: orderKey }
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
  db.prepare(
    'UPDATE plan_review_issue SET created_hlc = ?, created_node_id = ?, updated_hlc = ? WHERE uuid = ?'
  ).run(emitted.hlcText, emitted.nodeId, emitted.hlcText, issueUuid);
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
  writeEdgeAddClock(db, {
    entityType: 'plan_dependency',
    edgeKey: entityId,
    hlc: emitted.hlc,
    nodeId: emitted.nodeId,
  });
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
  writeEdgeRemoveClock(db, {
    entityType: 'plan_dependency',
    edgeKey: entityId,
    hlc: emitted.hlc,
    nodeId: emitted.nodeId,
  });
  return emitted;
}

export function emitTagAdd(db: Database, planUuid: string, tag: string): EmittedSyncOperation {
  const entityId = `${planUuid}#${tag}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_tag', entityId, 'add_edge', { planUuid, tag });
  writeEdgeAddClock(db, {
    entityType: 'plan_tag',
    edgeKey: entityId,
    hlc: emitted.hlc,
    nodeId: emitted.nodeId,
  });
  return emitted;
}

export function emitTagRemove(db: Database, planUuid: string, tag: string): EmittedSyncOperation {
  const entityId = `${planUuid}#${tag}`;
  const emitted = tickLocal(db);
  insertOp(db, emitted, 'plan_tag', entityId, 'remove_edge', { planUuid, tag });
  writeEdgeRemoveClock(db, {
    entityType: 'plan_tag',
    edgeKey: entityId,
    hlc: emitted.hlc,
    nodeId: emitted.nodeId,
  });
  return emitted;
}

// project_setting uses a single-field LWW model: the entire stored value is one register
// keyed by the synthetic field name "value". This differs from plan/plan_task which carry
// per-field clocks. The apply path (Task 4) must treat both shapes accordingly.
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
