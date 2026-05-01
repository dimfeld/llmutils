import type { Database, Statement } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { planKey, projectSettingKey, taskKey } from './entity_keys.js';

export interface BootstrapResult {
  plansSeeded: number;
  tasksSeeded: number;
  settingsSeeded: number;
}

interface PlanBootstrapRow {
  project_uuid: string;
  plan_uuid: string;
  revision: number | null;
}

interface TaskBootstrapRow {
  project_uuid: string;
  task_uuid: string;
  revision: number | null;
}

interface SettingBootstrapRow {
  project_uuid: string;
  setting: string;
  revision: number | null;
}

export function bootstrapSyncMetadata(db: Database): BootstrapResult {
  const runBootstrap = db.transaction((): BootstrapResult => {
    const insertSequence = db.prepare(`
      INSERT INTO sync_sequence (
        project_uuid,
        target_type,
        target_key,
        revision,
        operation_uuid,
        origin_node_id,
        created_at
      )
      SELECT ?, ?, ?, ?, NULL, NULL, ${SQL_NOW_ISO_UTC}
      WHERE NOT EXISTS (
        SELECT 1
        FROM sync_sequence
        WHERE target_key = ?
      )
    `);

    return {
      plansSeeded: bootstrapPlans(db, insertSequence),
      tasksSeeded: bootstrapTasks(db, insertSequence),
      settingsSeeded: bootstrapProjectSettings(db, insertSequence),
    };
  });

  return runBootstrap.immediate();
}

function bootstrapPlans(db: Database, insertSequence: Statement): number {
  const rows = db
    .prepare(
      `
        SELECT project.uuid AS project_uuid,
               plan.uuid AS plan_uuid,
               plan.revision AS revision
        FROM plan
        JOIN project ON project.id = plan.project_id
        ORDER BY plan.uuid
      `
    )
    .all() as PlanBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = planKey(row.plan_uuid);
    inserted += insertSequence.run(
      row.project_uuid,
      'plan',
      targetKey,
      row.revision,
      targetKey
    ).changes;
  }
  return inserted;
}

function bootstrapTasks(db: Database, insertSequence: Statement): number {
  const rows = db
    .prepare(
      `
        SELECT project.uuid AS project_uuid,
               plan_task.uuid AS task_uuid,
               plan_task.revision AS revision
        FROM plan_task
        JOIN plan ON plan.uuid = plan_task.plan_uuid
        JOIN project ON project.id = plan.project_id
        WHERE plan_task.uuid IS NOT NULL
        ORDER BY plan_task.uuid
      `
    )
    .all() as TaskBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = taskKey(row.task_uuid);
    inserted += insertSequence.run(
      row.project_uuid,
      'task',
      targetKey,
      row.revision,
      targetKey
    ).changes;
  }
  return inserted;
}

function bootstrapProjectSettings(db: Database, insertSequence: Statement): number {
  const rows = db
    .prepare(
      `
        SELECT project.uuid AS project_uuid,
               project_setting.setting AS setting,
               project_setting.revision AS revision
        FROM project_setting
        JOIN project ON project.id = project_setting.project_id
        ORDER BY project.uuid, project_setting.setting
      `
    )
    .all() as SettingBootstrapRow[];

  let inserted = 0;
  for (const row of rows) {
    const targetKey = projectSettingKey(row.project_uuid, row.setting);
    inserted += insertSequence.run(
      row.project_uuid,
      'project_setting',
      targetKey,
      row.revision,
      targetKey
    ).changes;
  }
  return inserted;
}
