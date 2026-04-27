import type { Database } from 'bun:sqlite';

import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { ensureLocalNode, getOrCreateClockRow } from '../db/sync_schema.js';
import { writeEdgeAddClock, writeEdgeRemoveClock } from './edge_clock.js';
import { formatHlc, formatOpId, type Hlc } from './hlc.js';
import {
  getLocalGenerator,
  getProjectSyncIdentity,
  PLAN_LWW_FIELD_NAMES,
  PLAN_TASK_LWW_FIELD_NAMES,
  PROJECT_SETTING_LWW_FIELD_NAME,
  REVIEW_ISSUE_LWW_FIELD_NAMES,
  type SyncEntityType,
} from './op_emission.js';

type JsonRecord = Record<string, unknown>;

interface BootstrapClock {
  hlc: Hlc;
  hlcText: string;
  nodeId: string;
  nextLocalCounter: number;
}

interface BootstrapStats {
  fieldClocksInserted: number;
  syntheticOpsInserted: number;
  taskRowsStamped: number;
  reviewIssueRowsStamped: number;
}

interface BootstrapOptions {
  force?: boolean;
}

interface PlanRow extends JsonRecord {
  uuid: string;
  project_id: number;
  plan_id: number;
}

interface PlanTaskRow extends JsonRecord {
  uuid: string;
  plan_uuid: string;
  created_hlc: string | null;
  updated_hlc: string | null;
  created_node_id: string | null;
}

interface ReviewIssueRow extends JsonRecord {
  uuid: string;
  plan_uuid: string;
  created_hlc: string | null;
  updated_hlc: string | null;
  created_node_id: string | null;
}

interface ProjectSettingRow {
  project_id: number;
  setting: string;
  value: string;
}

type GetBootstrapClock = () => BootstrapClock;

interface PlanTombstoneRow {
  hlc_physical_ms: number;
  hlc_logical: number;
  node_id: string;
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | null;
  return row !== null;
}

function pickFields(row: JsonRecord, fieldNames: readonly string[]): JsonRecord {
  const fields: JsonRecord = {};
  for (const fieldName of fieldNames) {
    if (Object.hasOwn(row, fieldName)) {
      fields[fieldName] = row[fieldName];
    }
  }
  return fields;
}

function needsFieldClock(
  db: Database,
  entityType: SyncEntityType,
  entityId: string,
  fieldName: string
): boolean {
  const row = db
    .prepare(
      `
        SELECT 1
        FROM sync_field_clock
        WHERE entity_type = ?
          AND entity_id = ?
          AND field_name = ?
      `
    )
    .get(entityType, entityId, fieldName) as { 1: number } | null;
  return row === null;
}

function hasOp(
  db: Database,
  entityType: SyncEntityType,
  entityId: string,
  opType: string
): boolean {
  const row = db
    .prepare(
      `
        SELECT 1
        FROM sync_op_log
        WHERE entity_type = ?
          AND entity_id = ?
          AND op_type = ?
        LIMIT 1
      `
    )
    .get(entityType, entityId, opType) as { 1: number } | null;
  return row !== null;
}

function insertFieldClockIfMissing(
  db: Database,
  getBootstrap: GetBootstrapClock,
  entityType: SyncEntityType,
  entityId: string,
  fieldName: string
): boolean {
  if (!needsFieldClock(db, entityType, entityId, fieldName)) {
    return false;
  }
  const bootstrap = getBootstrap();
  const result = db
    .prepare(
      `
        INSERT OR IGNORE INTO sync_field_clock (
          entity_type,
          entity_id,
          field_name,
          hlc_physical_ms,
          hlc_logical,
          node_id,
          deleted,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ${SQL_NOW_ISO_UTC})
      `
    )
    .run(
      entityType,
      entityId,
      fieldName,
      bootstrap.hlc.physicalMs,
      bootstrap.hlc.logical,
      bootstrap.nodeId
    );
  return result.changes > 0;
}

function insertFieldClocksIfMissing(
  db: Database,
  getBootstrap: GetBootstrapClock,
  entityType: SyncEntityType,
  entityId: string,
  fields: JsonRecord
): number {
  let inserted = 0;
  for (const fieldName of Object.keys(fields)) {
    if (insertFieldClockIfMissing(db, getBootstrap, entityType, entityId, fieldName)) {
      inserted += 1;
    }
  }
  return inserted;
}

function insertSyntheticOpIfMissing(
  db: Database,
  getBootstrap: GetBootstrapClock,
  entityType: SyncEntityType,
  entityId: string,
  opType: string,
  payload: unknown
): boolean {
  if (hasOp(db, entityType, entityId, opType)) {
    return false;
  }
  const bootstrap = getBootstrap();
  const localCounter = bootstrap.nextLocalCounter;
  bootstrap.nextLocalCounter += 1;
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ${SQL_NOW_ISO_UTC})
    `
  ).run(
    formatOpId(bootstrap.hlc, bootstrap.nodeId, localCounter),
    bootstrap.nodeId,
    bootstrap.hlc.physicalMs,
    bootstrap.hlc.logical,
    localCounter,
    entityType,
    entityId,
    opType,
    JSON.stringify(payload)
  );
  return true;
}

function parsedSettingValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function projectIdentityForRow(db: Database, projectId: number): string {
  if (!tableExists(db, 'project')) {
    return `local-project-${projectId}`;
  }
  return getProjectSyncIdentity(db, projectId);
}

function planExists(db: Database, planUuid: string): boolean {
  const row = db.prepare('SELECT 1 FROM plan WHERE uuid = ?').get(planUuid) as { 1: number } | null;
  return row !== null;
}

function getPlanTombstone(db: Database, planUuid: string): PlanTombstoneRow | null {
  return db
    .prepare(
      `
        SELECT hlc_physical_ms, hlc_logical, node_id
        FROM sync_tombstone
        WHERE entity_type = 'plan'
          AND entity_id = ?
      `
    )
    .get(planUuid) as PlanTombstoneRow | null;
}

function writeEdgeRemoveClockFromPlanTombstone(
  db: Database,
  entityType: 'plan_dependency' | 'plan_tag',
  edgeKey: string,
  tombstone: PlanTombstoneRow
): void {
  writeEdgeRemoveClock(db, {
    entityType,
    edgeKey,
    hlc: { physicalMs: tombstone.hlc_physical_ms, logical: tombstone.hlc_logical },
    nodeId: tombstone.node_id,
  });
}

function updateClockLocalCounter(db: Database, bootstrap: BootstrapClock): void {
  db.prepare(
    `
      UPDATE sync_clock
      SET local_counter = max(local_counter, ?),
          updated_at = ${SQL_NOW_ISO_UTC}
      WHERE id = 1
    `
  ).run(bootstrap.nextLocalCounter - 1);
}

function emptyStats(): BootstrapStats {
  return {
    fieldClocksInserted: 0,
    syntheticOpsInserted: 0,
    taskRowsStamped: 0,
    reviewIssueRowsStamped: 0,
  };
}

function getBootstrapCompletedAt(db: Database): string | null {
  try {
    const row = db.prepare('SELECT bootstrap_completed_at FROM sync_clock WHERE id = 1').get() as {
      bootstrap_completed_at: string | null;
    } | null;
    return row?.bootstrap_completed_at ?? null;
  } catch (error) {
    if (error instanceof Error && /no such column: bootstrap_completed_at/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function markBootstrapCompleted(db: Database): void {
  try {
    getOrCreateClockRow(db);
    db.prepare(
      `
        UPDATE sync_clock
        SET bootstrap_completed_at = ${SQL_NOW_ISO_UTC},
            updated_at = ${SQL_NOW_ISO_UTC}
        WHERE id = 1
      `
    ).run();
  } catch (error) {
    if (error instanceof Error && /no such column: bootstrap_completed_at/.test(error.message)) {
      return;
    }
    throw error;
  }
}

export function bootstrapSyncMetadata(
  db: Database,
  options: BootstrapOptions = {}
): BootstrapStats {
  if (!options.force && getBootstrapCompletedAt(db) !== null) {
    return emptyStats();
  }

  const run = db.transaction((): BootstrapStats => {
    ensureLocalNode(db);
    let bootstrap: BootstrapClock | null = null;
    const getBootstrap = (): BootstrapClock => {
      if (bootstrap) {
        return bootstrap;
      }
      const { nodeId, generator } = getLocalGenerator(db);
      const tick = generator.tick(Date.now(), db);
      bootstrap = {
        hlc: tick.hlc,
        hlcText: formatHlc(tick.hlc),
        nodeId,
        nextLocalCounter: tick.localCounter,
      };
      return bootstrap;
    };

    const stats = emptyStats();

    if (tableExists(db, 'plan')) {
      const plans = db.prepare('SELECT * FROM plan ORDER BY uuid').all() as PlanRow[];
      for (const plan of plans) {
        const fields = pickFields(plan, PLAN_LWW_FIELD_NAMES);
        stats.fieldClocksInserted += insertFieldClocksIfMissing(
          db,
          getBootstrap,
          'plan',
          plan.uuid,
          fields
        );
        if (
          insertSyntheticOpIfMissing(db, getBootstrap, 'plan', plan.uuid, 'create', {
            projectIdentity: projectIdentityForRow(db, plan.project_id),
            planIdHint: plan.plan_id,
            fields,
          })
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (tableExists(db, 'plan_task')) {
      const tasks = db
        .prepare(
          'SELECT * FROM plan_task WHERE deleted_hlc IS NULL ORDER BY plan_uuid, order_key, uuid'
        )
        .all() as PlanTaskRow[];
      for (const task of tasks) {
        const fields = pickFields(task, PLAN_TASK_LWW_FIELD_NAMES);
        stats.fieldClocksInserted += insertFieldClocksIfMissing(
          db,
          getBootstrap,
          'plan_task',
          task.uuid,
          fields
        );
        if (
          task.created_hlc === null ||
          task.updated_hlc === null ||
          task.created_node_id === null
        ) {
          const bootstrapClock = getBootstrap();
          const stampResult = db
            .prepare(
              `
              UPDATE plan_task
              SET created_hlc = COALESCE(created_hlc, ?),
                  updated_hlc = COALESCE(updated_hlc, ?),
                  created_node_id = COALESCE(created_node_id, ?)
              WHERE uuid = ?
                AND (created_hlc IS NULL OR updated_hlc IS NULL OR created_node_id IS NULL)
            `
            )
            .run(bootstrapClock.hlcText, bootstrapClock.hlcText, bootstrapClock.nodeId, task.uuid);
          stats.taskRowsStamped += stampResult.changes;
        }
        if (
          insertSyntheticOpIfMissing(db, getBootstrap, 'plan_task', task.uuid, 'create', {
            planUuid: task.plan_uuid,
            fields,
          })
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (tableExists(db, 'plan_review_issue')) {
      const issues = db
        .prepare(
          'SELECT * FROM plan_review_issue WHERE deleted_hlc IS NULL ORDER BY plan_uuid, order_key, uuid'
        )
        .all() as ReviewIssueRow[];
      for (const issue of issues) {
        const fields = pickFields(issue, REVIEW_ISSUE_LWW_FIELD_NAMES);
        stats.fieldClocksInserted += insertFieldClocksIfMissing(
          db,
          getBootstrap,
          'plan_review_issue',
          issue.uuid,
          fields
        );
        if (
          issue.created_hlc === null ||
          issue.updated_hlc === null ||
          issue.created_node_id === null
        ) {
          const bootstrapClock = getBootstrap();
          const stampResult = db
            .prepare(
              `
              UPDATE plan_review_issue
              SET created_hlc = COALESCE(created_hlc, ?),
                  updated_hlc = COALESCE(updated_hlc, ?),
                  created_node_id = COALESCE(created_node_id, ?),
                  updated_at = ${SQL_NOW_ISO_UTC}
              WHERE uuid = ?
                AND (created_hlc IS NULL OR updated_hlc IS NULL OR created_node_id IS NULL)
            `
            )
            .run(bootstrapClock.hlcText, bootstrapClock.hlcText, bootstrapClock.nodeId, issue.uuid);
          stats.reviewIssueRowsStamped += stampResult.changes;
        }
        if (
          insertSyntheticOpIfMissing(db, getBootstrap, 'plan_review_issue', issue.uuid, 'create', {
            planUuid: issue.plan_uuid,
            fields,
          })
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (tableExists(db, 'plan_dependency')) {
      const dependencies = db
        .prepare(
          'SELECT plan_uuid, depends_on_uuid FROM plan_dependency ORDER BY plan_uuid, depends_on_uuid'
        )
        .all() as Array<{ plan_uuid: string; depends_on_uuid: string }>;
      for (const dependency of dependencies) {
        const edgeKey = `${dependency.plan_uuid}->${dependency.depends_on_uuid}`;
        const sourceTombstone = getPlanTombstone(db, dependency.plan_uuid);
        const targetTombstone = getPlanTombstone(db, dependency.depends_on_uuid);
        const sourceExists = sourceTombstone === null && planExists(db, dependency.plan_uuid);
        const targetExists = targetTombstone === null && planExists(db, dependency.depends_on_uuid);

        if (!sourceExists || !targetExists) {
          if (sourceTombstone) {
            writeEdgeRemoveClockFromPlanTombstone(db, 'plan_dependency', edgeKey, sourceTombstone);
          }
          if (targetTombstone) {
            writeEdgeRemoveClockFromPlanTombstone(db, 'plan_dependency', edgeKey, targetTombstone);
          }
          db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
            dependency.plan_uuid,
            dependency.depends_on_uuid
          );
          continue;
        }

        const bootstrapClock = getBootstrap();
        writeEdgeAddClock(db, {
          entityType: 'plan_dependency',
          edgeKey,
          hlc: bootstrapClock.hlc,
          nodeId: bootstrapClock.nodeId,
        });
        if (
          insertSyntheticOpIfMissing(db, getBootstrap, 'plan_dependency', edgeKey, 'add_edge', {
            planUuid: dependency.plan_uuid,
            dependsOnUuid: dependency.depends_on_uuid,
          })
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (tableExists(db, 'plan_tag')) {
      const tags = db
        .prepare('SELECT plan_uuid, tag FROM plan_tag ORDER BY plan_uuid, tag')
        .all() as Array<{ plan_uuid: string; tag: string }>;
      for (const tag of tags) {
        const edgeKey = `${tag.plan_uuid}#${tag.tag}`;
        const planTombstone = getPlanTombstone(db, tag.plan_uuid);
        const livePlanExists = planTombstone === null && planExists(db, tag.plan_uuid);

        if (!livePlanExists) {
          if (planTombstone) {
            writeEdgeRemoveClockFromPlanTombstone(db, 'plan_tag', edgeKey, planTombstone);
          }
          db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(
            tag.plan_uuid,
            tag.tag
          );
          continue;
        }

        const bootstrapClock = getBootstrap();
        writeEdgeAddClock(db, {
          entityType: 'plan_tag',
          edgeKey,
          hlc: bootstrapClock.hlc,
          nodeId: bootstrapClock.nodeId,
        });
        if (
          insertSyntheticOpIfMissing(db, getBootstrap, 'plan_tag', edgeKey, 'add_edge', {
            planUuid: tag.plan_uuid,
            tag: tag.tag,
          })
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (tableExists(db, 'project_setting')) {
      const settings = db
        .prepare(
          'SELECT project_id, setting, value FROM project_setting ORDER BY project_id, setting'
        )
        .all() as ProjectSettingRow[];
      for (const setting of settings) {
        const projectIdentity = projectIdentityForRow(db, setting.project_id);
        const entityId = `${projectIdentity}:${setting.setting}`;
        if (
          insertFieldClockIfMissing(
            db,
            getBootstrap,
            'project_setting',
            entityId,
            PROJECT_SETTING_LWW_FIELD_NAME
          )
        ) {
          stats.fieldClocksInserted += 1;
        }
        if (
          insertSyntheticOpIfMissing(
            db,
            getBootstrap,
            'project_setting',
            entityId,
            'update_fields',
            {
              projectIdentity,
              setting: setting.setting,
              value: parsedSettingValue(setting.value),
            }
          )
        ) {
          stats.syntheticOpsInserted += 1;
        }
      }
    }

    if (bootstrap) {
      updateClockLocalCounter(db, bootstrap);
    }
    markBootstrapCompleted(db);
    return stats;
  });

  return run.immediate();
}
