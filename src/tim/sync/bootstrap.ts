import type { Database, Statement } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { planKey, projectSettingKey } from './entity_keys.js';

export interface BootstrapResult {
  plansSeeded: number;
  settingsSeeded: number;
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
  const runBootstrap = db.transaction((): BootstrapResult => {
    const bootstrapCompleted = (
      db
        .prepare('SELECT bootstrap_completed FROM schema_version ORDER BY rowid DESC LIMIT 1')
        .get() as { bootstrap_completed?: number } | null
    )?.bootstrap_completed;
    if (bootstrapCompleted === 1) {
      return { plansSeeded: 0, settingsSeeded: 0 };
    }

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

    const result = {
      plansSeeded: bootstrapPlans(db, insertSequence, existingTargetKeys),
      settingsSeeded: bootstrapProjectSettings(db, insertSequence, existingTargetKeys),
    };
    db.prepare('UPDATE schema_version SET bootstrap_completed = 1').run();
    return result;
  });

  return runBootstrap.immediate();
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
    const result = insertSequence.run(row.project_uuid, 'plan', targetKey, row.revision);
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
    const result = insertSequence.run(row.project_uuid, 'project_setting', targetKey, row.revision);
    existingTargetKeys.add(targetKey);
    inserted += result.changes;
  }
  return inserted;
}
