import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface PlanRow {
  uuid: string;
  project_id: number;
  plan_id: number;
  title: string | null;
  goal: string | null;
  details: string | null;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  priority: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  branch: string | null;
  simple: number | null;
  tdd: number | null;
  discovered_from: number | null;
  issue: string | null;
  pull_request: string | null;
  assigned_to: string | null;
  base_branch: string | null;
  parent_uuid: string | null;
  epic: number;
  filename: string;
  created_at: string;
  updated_at: string;
}

export interface PlanTaskRow {
  id: number;
  plan_uuid: string;
  task_index: number;
  title: string;
  description: string;
  done: number;
}

export interface PlanDependencyRow {
  plan_uuid: string;
  depends_on_uuid: string;
}

export interface PlanTagRow {
  plan_uuid: string;
  tag: string;
}

export interface UpsertPlanInput {
  uuid: string;
  planId: number;
  title?: string | null;
  goal?: string | null;
  details?: string | null;
  sourceUpdatedAt?: string | null;
  forceOverwrite?: boolean;
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  branch?: string | null;
  simple?: boolean | null;
  tdd?: boolean | null;
  discoveredFrom?: number | null;
  issue?: string[] | null;
  pullRequest?: string[] | null;
  assignedTo?: string | null;
  baseBranch?: string | null;
  parentUuid?: string | null;
  epic?: boolean;
  filename: string;
  tasks?: Array<{
    title: string;
    description: string;
    done?: boolean;
  }>;
  dependencyUuids?: string[];
  tags?: string[];
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function replacePlanTasks(
  db: Database,
  planUuid: string,
  tasks: Array<{ title: string; description: string; done?: boolean }>
): void {
  db.prepare('DELETE FROM plan_task WHERE plan_uuid = ?').run(planUuid);

  if (tasks.length === 0) {
    return;
  }

  const insertTask = db.prepare(
    `
    INSERT INTO plan_task (
      plan_uuid,
      task_index,
      title,
      description,
      done
    ) VALUES (?, ?, ?, ?, ?)
  `
  );
  tasks.forEach((task, index) => {
    insertTask.run(planUuid, index, task.title, task.description, task.done ? 1 : 0);
  });
}

function replacePlanDependencies(db: Database, planUuid: string, dependencyUuids: string[]): void {
  db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ?').run(planUuid);

  if (dependencyUuids.length === 0) {
    return;
  }

  const insertDependency = db.prepare(
    `
    INSERT INTO plan_dependency (
      plan_uuid,
      depends_on_uuid
    ) VALUES (?, ?)
  `
  );
  for (const dependencyUuid of dependencyUuids) {
    insertDependency.run(planUuid, dependencyUuid);
  }
}

function replacePlanTags(db: Database, planUuid: string, tags: string[]): void {
  db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ?').run(planUuid);

  if (tags.length === 0) {
    return;
  }

  const insertTag = db.prepare(
    `
    INSERT INTO plan_tag (
      plan_uuid,
      tag
    ) VALUES (?, ?)
  `
  );
  for (const tag of new Set(tags)) {
    insertTag.run(planUuid, tag);
  }
}

export function upsertPlan(db: Database, projectId: number, input: UpsertPlanInput): PlanRow {
  const upsertInTransaction = db.transaction(
    (nextProjectId: number, nextInput: UpsertPlanInput): PlanRow => {
      const existing = getPlanByUuid(db, nextInput.uuid);
      if (existing && nextInput.forceOverwrite !== true) {
        const incomingTimestamp = parseTimestamp(nextInput.sourceUpdatedAt);
        const existingTimestamp = parseTimestamp(existing.updated_at);
        if (
          incomingTimestamp !== null &&
          existingTimestamp !== null &&
          incomingTimestamp < existingTimestamp
        ) {
          return existing;
        }
      }

      db.prepare(
        `
        INSERT INTO plan (
          uuid,
          project_id,
          plan_id,
          title,
          goal,
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
          parent_uuid,
          epic,
          filename,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
        ON CONFLICT(uuid) DO UPDATE SET
          project_id = excluded.project_id,
          plan_id = excluded.plan_id,
          title = excluded.title,
          goal = excluded.goal,
          details = excluded.details,
          status = excluded.status,
          priority = excluded.priority,
          branch = excluded.branch,
          simple = excluded.simple,
          tdd = excluded.tdd,
          discovered_from = excluded.discovered_from,
          issue = excluded.issue,
          pull_request = excluded.pull_request,
          assigned_to = excluded.assigned_to,
          base_branch = excluded.base_branch,
          parent_uuid = excluded.parent_uuid,
          epic = excluded.epic,
          filename = excluded.filename,
          updated_at = ${SQL_NOW_ISO_UTC}
      `
      ).run(
        nextInput.uuid,
        nextProjectId,
        nextInput.planId,
        nextInput.title ?? null,
        nextInput.goal ?? null,
        nextInput.details ?? null,
        nextInput.status ?? 'pending',
        nextInput.priority ?? null,
        nextInput.branch ?? null,
        typeof nextInput.simple === 'boolean' ? (nextInput.simple ? 1 : 0) : null,
        typeof nextInput.tdd === 'boolean' ? (nextInput.tdd ? 1 : 0) : null,
        nextInput.discoveredFrom ?? null,
        nextInput.issue ? JSON.stringify(nextInput.issue) : null,
        nextInput.pullRequest ? JSON.stringify(nextInput.pullRequest) : null,
        nextInput.assignedTo ?? null,
        nextInput.baseBranch ?? null,
        nextInput.parentUuid ?? null,
        nextInput.epic ? 1 : 0,
        nextInput.filename
      );

      replacePlanTasks(db, nextInput.uuid, nextInput.tasks ?? []);
      replacePlanDependencies(db, nextInput.uuid, nextInput.dependencyUuids ?? []);
      replacePlanTags(db, nextInput.uuid, nextInput.tags ?? []);

      const row = getPlanByUuid(db, nextInput.uuid);
      if (!row) {
        throw new Error(`Failed to upsert plan ${nextInput.uuid}`);
      }

      return row;
    }
  );

  return upsertInTransaction.immediate(projectId, input);
}

export function upsertPlanTasks(
  db: Database,
  planUuid: string,
  tasks: Array<{ title: string; description: string; done?: boolean }>
): void {
  const upsertTasksInTransaction = db.transaction(
    (
      nextPlanUuid: string,
      nextTasks: Array<{ title: string; description: string; done?: boolean }>
    ): void => {
      replacePlanTasks(db, nextPlanUuid, nextTasks);
    }
  );

  upsertTasksInTransaction.immediate(planUuid, tasks);
}

export function upsertPlanDependencies(
  db: Database,
  planUuid: string,
  dependencyUuids: string[]
): void {
  const upsertDependenciesInTransaction = db.transaction(
    (nextPlanUuid: string, nextDependencyUuids: string[]): void => {
      replacePlanDependencies(db, nextPlanUuid, nextDependencyUuids);
    }
  );

  upsertDependenciesInTransaction.immediate(planUuid, dependencyUuids);
}

export function getPlanByUuid(db: Database, uuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(uuid) as PlanRow | null) ?? null;
}

export function getPlansByProject(db: Database, projectId: number): PlanRow[] {
  return db
    .prepare('SELECT * FROM plan WHERE project_id = ? ORDER BY plan_id, uuid')
    .all(projectId) as PlanRow[];
}

export function getPlanTasksByUuid(db: Database, planUuid: string): PlanTaskRow[] {
  return db
    .prepare('SELECT * FROM plan_task WHERE plan_uuid = ? ORDER BY task_index, id')
    .all(planUuid) as PlanTaskRow[];
}

export function getPlanTasksByProject(db: Database, projectId: number): PlanTaskRow[] {
  return db
    .prepare(
      `
      SELECT pt.*
      FROM plan_task pt
      INNER JOIN plan p ON p.uuid = pt.plan_uuid
      WHERE p.project_id = ?
      ORDER BY pt.plan_uuid, pt.task_index, pt.id
    `
    )
    .all(projectId) as PlanTaskRow[];
}

export function getPlanDependenciesByProject(db: Database, projectId: number): PlanDependencyRow[] {
  return db
    .prepare(
      `
      SELECT pd.plan_uuid, pd.depends_on_uuid
      FROM plan_dependency pd
      INNER JOIN plan p ON p.uuid = pd.plan_uuid
      WHERE p.project_id = ?
      ORDER BY pd.plan_uuid, pd.depends_on_uuid
    `
    )
    .all(projectId) as PlanDependencyRow[];
}

export function getPlanTagsByUuid(db: Database, planUuid: string): PlanTagRow[] {
  return db
    .prepare('SELECT * FROM plan_tag WHERE plan_uuid = ? ORDER BY tag')
    .all(planUuid) as PlanTagRow[];
}

export function getPlanTagsByProject(db: Database, projectId: number): PlanTagRow[] {
  return db
    .prepare(
      `
      SELECT pt.*
      FROM plan_tag pt
      INNER JOIN plan p ON p.uuid = pt.plan_uuid
      WHERE p.project_id = ?
      ORDER BY pt.plan_uuid, pt.tag
    `
    )
    .all(projectId) as PlanTagRow[];
}

export function deletePlan(db: Database, uuid: string): boolean {
  const result = db.prepare('DELETE FROM plan WHERE uuid = ?').run(uuid);
  return result.changes > 0;
}

export function getPlansNotInSet(db: Database, projectId: number, uuids: Set<string>): PlanRow[] {
  const uuidList = [...uuids];
  if (uuidList.length === 0) {
    return getPlansByProject(db, projectId);
  }

  // Avoid SQLITE_MAX_VARIABLE_NUMBER limits for large UUID sets.
  db.run('CREATE TEMP TABLE IF NOT EXISTS _prune_keep_uuids (uuid TEXT PRIMARY KEY)');
  try {
    db.run('DELETE FROM _prune_keep_uuids');

    const insertStmt = db.prepare('INSERT OR IGNORE INTO _prune_keep_uuids (uuid) VALUES (?)');
    for (const uuid of uuidList) {
      insertStmt.run(uuid);
    }

    return db
      .prepare(
        `
        SELECT p.*
        FROM plan p
        WHERE p.project_id = ?
          AND p.uuid NOT IN (SELECT uuid FROM _prune_keep_uuids)
        ORDER BY p.plan_id, p.uuid
      `
      )
      .all(projectId) as PlanRow[];
  } finally {
    db.run('DROP TABLE IF EXISTS _prune_keep_uuids');
  }
}
