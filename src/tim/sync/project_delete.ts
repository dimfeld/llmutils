import type { Database, SQLQueryBindings } from 'bun:sqlite';
import type { Project } from '../db/project.js';

export interface ProjectDeleteSummary {
  project: Project;
  plans: number;
  tasks: number;
  workspaces: number;
  assignments: number;
  permissions: number;
  reviews: number;
  prStatuses: number;
}

function countRows(db: Database, sql: string, ...params: SQLQueryBindings[]): number {
  const row = db.prepare(sql).get(...params) as { count: number } | null;
  return row?.count ?? 0;
}

export function getProjectDeleteSummary(db: Database, project: Project): ProjectDeleteSummary {
  return {
    project,
    plans: countRows(db, 'SELECT COUNT(*) AS count FROM plan WHERE project_id = ?', project.id),
    tasks: countRows(
      db,
      `
        SELECT COUNT(*) AS count
        FROM plan_task
        JOIN plan ON plan.uuid = plan_task.plan_uuid
        WHERE plan.project_id = ?
      `,
      project.id
    ),
    workspaces: countRows(
      db,
      'SELECT COUNT(*) AS count FROM workspace WHERE project_id = ?',
      project.id
    ),
    assignments: countRows(
      db,
      'SELECT COUNT(*) AS count FROM assignment WHERE project_id = ?',
      project.id
    ),
    permissions: countRows(
      db,
      'SELECT COUNT(*) AS count FROM permission WHERE project_id = ?',
      project.id
    ),
    reviews: countRows(db, 'SELECT COUNT(*) AS count FROM review WHERE project_id = ?', project.id),
    prStatuses: 0,
  };
}

export function deleteProjectStateInTransaction(
  db: Database,
  project: Project
): ProjectDeleteSummary {
  const summary = getProjectDeleteSummary(db, project);
  const prStatusIds = (
    db
      .prepare(
        `
          SELECT DISTINCT plan_pr.pr_status_id
          FROM plan_pr
          JOIN plan ON plan.uuid = plan_pr.plan_uuid
          WHERE plan.project_id = ?
        `
      )
      .all(project.id) as Array<{ pr_status_id: number }>
  ).map((row) => row.pr_status_id);

  db.prepare('DELETE FROM project WHERE id = ?').run(project.id);
  summary.prStatuses = deleteOrphanedPrStatuses(db, prStatusIds);
  return summary;
}

function deleteOrphanedPrStatuses(db: Database, prStatusIds: number[]): number {
  let deleted = 0;
  const deletePrStatus = db.prepare(`
    DELETE FROM pr_status
    WHERE id = ?
      AND NOT EXISTS (
        SELECT 1
        FROM plan_pr
        WHERE plan_pr.pr_status_id = pr_status.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM review
        WHERE review.pr_status_id = pr_status.id
      )
  `);

  for (const prStatusId of prStatusIds) {
    deleted += deletePrStatus.run(prStatusId).changes;
  }

  return deleted;
}
