import type { Database, Statement } from 'bun:sqlite';
import { debugLog } from '../../logging.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { isForeignKeyConstraintError, logForeignKeyCheck } from '../db/sqlite_debug.js';
import { planKey, projectKey, projectSettingKey } from './entity_keys.js';

export interface BootstrapResult {
  projectsSeeded: number;
  plansSeeded: number;
  settingsSeeded: number;
}

interface ProjectBootstrapRow {
  project_uuid: string;
}

interface PlanBootstrapRow {
  project_uuid: string;
  plan_uuid: string;
  revision: number | null;
}

interface SettingBootstrapRow {
  project_uuid: string;
  setting: string;
  revision: number | null;
}

export function bootstrapSyncMetadata(db: Database): BootstrapResult {
  debugLog('[sync/bootstrap] Starting sync metadata bootstrap');
  const runBootstrap = db.transaction((): BootstrapResult => {
    const bootstrapCompleted = (
      db
        .prepare('SELECT bootstrap_completed FROM schema_version ORDER BY rowid DESC LIMIT 1')
        .get() as { bootstrap_completed?: number } | null
    )?.bootstrap_completed;

    // Per-task sync_sequence rows are intentionally not seeded: server.ts's
    // loadTaskSnapshot redirects to loadPlanSnapshot, so a task: invalidation
    // would just trigger another fetch of the same plan snapshot the plan:
    // invalidation already covers. Seeding the plan row alone is sufficient
    // and keeps first-connect bandwidth O(plans) instead of O(plans + tasks).
    const existingTargetKeys = new Set(
      (
        db.prepare('SELECT DISTINCT target_key FROM sync_sequence').all() as Array<{
          target_key: string;
        }>
      ).map((row) => row.target_key)
    );

    const insertSequence = db.prepare(`
      INSERT OR IGNORE INTO sync_sequence (
        project_uuid,
        target_type,
        target_key,
        revision,
        operation_uuid,
        origin_node_id,
        created_at
      )
      VALUES (?, ?, ?, ?, NULL, NULL, ${SQL_NOW_ISO_UTC})
    `);

    if (bootstrapCompleted === 1) {
      const result = {
        projectsSeeded: bootstrapProjects(db, insertSequence, existingTargetKeys),
        plansSeeded: bootstrapPlans(db, insertSequence, existingTargetKeys),
        settingsSeeded: bootstrapProjectSettings(db, insertSequence, existingTargetKeys),
      };
      debugLog(
        `[sync/bootstrap] Bootstrap already completed; seeded missing rows: projects=${result.projectsSeeded}, plans=${result.plansSeeded}, settings=${result.settingsSeeded}`
      );
      return result;
    }

    const result = {
      projectsSeeded: bootstrapProjects(db, insertSequence, existingTargetKeys),
      plansSeeded: bootstrapPlans(db, insertSequence, existingTargetKeys),
      settingsSeeded: bootstrapProjectSettings(db, insertSequence, existingTargetKeys),
    };
    db.prepare('UPDATE schema_version SET bootstrap_completed = 1').run();
    debugLog(
      `[sync/bootstrap] Completed bootstrap: projectsSeeded=${result.projectsSeeded}, plansSeeded=${result.plansSeeded}, settingsSeeded=${result.settingsSeeded}`
    );
    return result;
  });

  return runBootstrap.immediate();
}

function bootstrapProjects(
  db: Database,
  insertSequence: Statement,
  existingTargetKeys: Set<string>
): number {
  const rows = db
    .prepare(
      `
        SELECT uuid AS project_uuid
        FROM project
        WHERE uuid IS NOT NULL
        ORDER BY uuid
      `
    )
    .all() as ProjectBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = projectKey(row.project_uuid);
    if (existingTargetKeys.has(targetKey)) {
      continue;
    }
    const result = runBootstrapInsert(insertSequence, db, 'project', {
      projectUuid: row.project_uuid,
      targetKey,
      revision: null,
    });
    existingTargetKeys.add(targetKey);
    inserted += result.changes;
  }
  return inserted;
}

function bootstrapPlans(
  db: Database,
  insertSequence: Statement,
  existingTargetKeys: Set<string>
): number {
  const rows = db
    .prepare(
      `
        SELECT project.uuid AS project_uuid,
               plan.uuid AS plan_uuid,
               plan.revision AS revision
        FROM plan
        JOIN project ON project.id = plan.project_id
        WHERE project.uuid IS NOT NULL
        ORDER BY plan.uuid
      `
    )
    .all() as PlanBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = planKey(row.plan_uuid);
    if (existingTargetKeys.has(targetKey)) {
      continue;
    }
    const result = runBootstrapInsert(insertSequence, db, 'plan', {
      projectUuid: row.project_uuid,
      planUuid: row.plan_uuid,
      targetKey,
      revision: row.revision,
    });
    existingTargetKeys.add(targetKey);
    inserted += result.changes;
  }
  return inserted;
}

function bootstrapProjectSettings(
  db: Database,
  insertSequence: Statement,
  existingTargetKeys: Set<string>
): number {
  const rows = db
    .prepare(
      `
        SELECT project.uuid AS project_uuid,
               project_setting.setting AS setting,
               project_setting.revision AS revision
        FROM project_setting
        JOIN project ON project.id = project_setting.project_id
        WHERE project.uuid IS NOT NULL
        ORDER BY project.uuid, project_setting.setting
      `
    )
    .all() as SettingBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = projectSettingKey(row.project_uuid, row.setting);
    if (existingTargetKeys.has(targetKey)) {
      continue;
    }
    const result = runBootstrapInsert(insertSequence, db, 'project_setting', {
      projectUuid: row.project_uuid,
      setting: row.setting,
      targetKey,
      revision: row.revision,
    });
    existingTargetKeys.add(targetKey);
    inserted += result.changes;
  }
  return inserted;
}

function runBootstrapInsert(
  insertSequence: Statement,
  db: Database,
  targetType: 'project' | 'plan' | 'project_setting',
  context: Record<string, unknown>
): { changes: number } {
  try {
    if (targetType === 'project') {
      const { projectUuid, targetKey, revision } = context as {
        projectUuid: string;
        targetKey: string;
        revision: number | null;
      };
      return insertSequence.run(projectUuid, 'project', targetKey, revision);
    }

    if (targetType === 'plan') {
      const { projectUuid, targetKey, revision } = context as {
        projectUuid: string;
        targetKey: string;
        revision: number | null;
      };
      return insertSequence.run(projectUuid, 'plan', targetKey, revision);
    }

    const { projectUuid, targetKey, revision } = context as {
      projectUuid: string;
      targetKey: string;
      revision: number | null;
    };
    return insertSequence.run(projectUuid, 'project_setting', targetKey, revision);
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      debugLog(
        `[sync/bootstrap] Foreign key constraint failed while inserting ${targetType}`,
        context
      );
      logForeignKeyCheck(db, `[sync/bootstrap] failing insert for ${targetType}`);
    } else {
      debugLog(`[sync/bootstrap] Failed while inserting ${targetType}`, context, error);
    }
    throw error;
  }
}
