import type { Database } from 'bun:sqlite';
import { getDatabase } from '../db/database.js';

export interface BackfillUuidResult {
  projectsUpdated: number;
  plansUpdated: number;
  tasksUpdated: number;
}

interface NullProjectUuidRow {
  id: number;
}

interface NullPlanUuidRow {
  rowid: number;
}

interface NullTaskUuidRow {
  id: number;
}

export function backfillMissingPlanAndTaskUuids(db: Database): BackfillUuidResult {
  const update = db.transaction((): BackfillUuidResult => {
    const projectRows = db
      .prepare('SELECT id FROM project WHERE uuid IS NULL')
      .all() as NullProjectUuidRow[];
    const planRows = db
      .prepare('SELECT rowid FROM plan WHERE uuid IS NULL')
      .all() as NullPlanUuidRow[];
    const taskRows = db
      .prepare('SELECT id FROM plan_task WHERE uuid IS NULL')
      .all() as NullTaskUuidRow[];

    const updateProject = db.prepare('UPDATE project SET uuid = ? WHERE id = ?');
    for (const row of projectRows) {
      updateProject.run(crypto.randomUUID(), row.id);
    }

    const updatePlan = db.prepare('UPDATE plan SET uuid = ? WHERE rowid = ?');
    for (const row of planRows) {
      updatePlan.run(crypto.randomUUID(), row.rowid);
    }

    const updateTask = db.prepare('UPDATE plan_task SET uuid = ? WHERE id = ?');
    for (const row of taskRows) {
      updateTask.run(crypto.randomUUID(), row.id);
    }

    return {
      projectsUpdated: projectRows.length,
      plansUpdated: planRows.length,
      tasksUpdated: taskRows.length,
    };
  });

  return update.immediate();
}

export async function handleBackfillUuidsCommand(): Promise<void> {
  const result = backfillMissingPlanAndTaskUuids(getDatabase());
  console.log(
    `Backfilled UUIDs: ${result.projectsUpdated} project${result.projectsUpdated === 1 ? '' : 's'}, ` +
      `${result.plansUpdated} plan${result.plansUpdated === 1 ? '' : 's'}, ` +
      `${result.tasksUpdated} plan task${result.tasksUpdated === 1 ? '' : 's'}`
  );
}
