import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import type { PlanSchema } from '../planSchema.js';
import { reconcileReviewIssuesForPlan } from './plan_review_issue.js';
import {
  emitDependencyAdd,
  emitDependencyRemove,
  emitPlanCreate,
  emitPlanDelete,
  emitPlanFieldUpdate,
  emitTagAdd,
  emitTagRemove,
  emitTaskCreate,
  emitTaskDelete,
  emitTaskFieldUpdate,
  emitTaskSetOrder,
  getProjectSyncIdentity,
  type EmitPlanContext,
} from '../sync/op_emission.js';

export interface PlanRow {
  uuid: string;
  project_id: number;
  plan_id: number;
  title: string | null;
  goal: string | null;
  note: string | null;
  details: string | null;
  status: PlanSchema['status'];
  priority: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  branch: string | null;
  simple: number | null;
  tdd: number | null;
  discovered_from: number | null;
  issue: string | null;
  pull_request: string | null;
  assigned_to: string | null;
  base_branch: string | null;
  base_commit: string | null;
  base_change_id: string | null;
  temp: number | null;
  docs: string | null;
  changed_files: string | null;
  plan_generated_at: string | null;
  review_issues: string | null;
  docs_updated_at: string | null;
  lessons_applied_at: string | null;
  parent_uuid: string | null;
  epic: number;
  created_at: string;
  updated_at: string;
}

export interface PlanTaskRow {
  id: number;
  uuid: string;
  plan_uuid: string;
  task_index: number;
  order_key: string;
  title: string;
  description: string;
  done: number;
  created_hlc: string | null;
  updated_hlc: string | null;
  deleted_hlc: string | null;
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
  note?: string | null;
  details?: string | null;
  sourceCreatedAt?: string | null;
  sourceUpdatedAt?: string | null;
  sourceDocsUpdatedAt?: string | null;
  sourceLessonsAppliedAt?: string | null;
  forceOverwrite?: boolean;
  status?: PlanSchema['status'];
  priority?: 'low' | 'medium' | 'high' | 'urgent' | 'maybe' | null;
  branch?: string | null;
  simple?: boolean | null;
  tdd?: boolean | null;
  discoveredFrom?: number | null;
  issue?: string[] | null;
  pullRequest?: string[] | null;
  assignedTo?: string | null;
  baseBranch?: string | null;
  baseCommit?: string | null;
  baseChangeId?: string | null;
  temp?: boolean | null;
  docs?: string[] | null;
  changedFiles?: string[] | null;
  planGeneratedAt?: string | null;
  reviewIssues?: PlanSchema['reviewIssues'] | null;
  parentUuid?: string | null;
  epic?: boolean;
  tasks?: Array<{
    uuid?: string;
    orderKey?: string;
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
  tasks: Array<{
    uuid?: string;
    orderKey?: string;
    title: string;
    description: string;
    done?: boolean;
  }>
): void {
  const existingTasks = db
    .prepare('SELECT * FROM plan_task WHERE plan_uuid = ? ORDER BY order_key, uuid')
    .all(planUuid) as PlanTaskRow[];
  const existingTasksByUuid = new Map(existingTasks.map((task) => [task.uuid, task]));

  const insertTask = db.prepare(
    `
    INSERT INTO plan_task (
      uuid,
      plan_uuid,
      task_index,
      order_key,
      title,
      description,
      done,
      created_hlc,
      updated_hlc,
      deleted_hlc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  );
  const updateTask = db.prepare(
    `
      UPDATE plan_task
      SET task_index = ?,
          order_key = ?,
          title = ?,
          description = ?,
          done = ?
      WHERE uuid = ?
      AND deleted_hlc IS NULL
    `
  );
  const retainedUuids = new Set<string>();
  db.prepare(
    `
      UPDATE plan_task
      SET task_index = -id
      WHERE plan_uuid = ?
        AND deleted_hlc IS NULL
    `
  ).run(planUuid);
  const incomingOrderKeys = tasks.map((task) => task.orderKey);
  const canPreserveIncomingOrderKeys =
    incomingOrderKeys.every((orderKey): orderKey is string => typeof orderKey === 'string') &&
    incomingOrderKeys.every(
      (orderKey, index, keys) => index === 0 || keys[index - 1]!.localeCompare(orderKey) <= 0
    );
  tasks.forEach((task, index) => {
    const existingTask = task.uuid ? existingTasksByUuid.get(task.uuid) : undefined;
    const canReuseIncomingUuid = !existingTask || existingTask.deleted_hlc === null;
    // Preserve round-tripped order keys when they already agree with list order.
    // If a materialized file reorders task objects without editing orderKey, the
    // keys no longer sort like the list, so v1 rewrites all order keys by index.
    const orderKey = canPreserveIncomingOrderKeys
      ? task.orderKey!
      : String(index).padStart(10, '0');
    const taskUuid =
      typeof task.uuid === 'string' && task.uuid.length > 0 && canReuseIncomingUuid
        ? task.uuid
        : randomUUID();
    const done = task.done ? 1 : 0;
    retainedUuids.add(taskUuid);
    if (!existingTask || existingTask.deleted_hlc !== null) {
      insertTask.run(
        taskUuid,
        planUuid,
        index,
        orderKey,
        task.title,
        task.description,
        done,
        null,
        null,
        null
      );
      emitTaskCreate(db, planUuid, taskUuid, {
        plan_uuid: planUuid,
        task_index: index,
        order_key: orderKey,
        title: task.title,
        description: task.description,
        done,
      });
      return;
    }

    const fieldUpdates: Record<string, unknown> = {};
    if (existingTask.title !== task.title) fieldUpdates.title = task.title;
    if (existingTask.description !== task.description) fieldUpdates.description = task.description;
    if (existingTask.done !== done) fieldUpdates.done = done;

    const orderChanged =
      existingTask.order_key !== orderKey || existingTask.task_index !== index;
    const fieldsChanged = Object.keys(fieldUpdates).length > 0;
    // Always rewrite the row: the pre-iteration sweep above sets task_index = -id
    // for every existing task to free the (plan_uuid, task_index) UNIQUE slot, so
    // retained tasks must restore their canonical task_index even when nothing in
    // the schema view changed.
    updateTask.run(index, orderKey, task.title, task.description, done, taskUuid);
    if (fieldsChanged) {
      emitTaskFieldUpdate(db, planUuid, taskUuid, fieldUpdates);
    }
    if (orderChanged) {
      emitTaskSetOrder(db, planUuid, taskUuid, orderKey, index);
    }
  });

  for (const existingTask of existingTasks) {
    if (existingTask.deleted_hlc === null && !retainedUuids.has(existingTask.uuid)) {
      emitTaskDelete(db, planUuid, existingTask.uuid);
    }
  }
}

function replacePlanDependencies(db: Database, planUuid: string, dependencyUuids: string[]): void {
  const existing = new Set(
    (
      db
        .prepare('SELECT depends_on_uuid FROM plan_dependency WHERE plan_uuid = ?')
        .all(planUuid) as Array<{ depends_on_uuid: string }>
    ).map((row) => row.depends_on_uuid)
  );
  const desired = new Set(dependencyUuids);

  for (const dependencyUuid of existing) {
    if (!desired.has(dependencyUuid)) {
      db.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(
        planUuid,
        dependencyUuid
      );
      emitDependencyRemove(db, planUuid, dependencyUuid);
    }
  }

  const insertDependency = db.prepare(
    `
    INSERT INTO plan_dependency (
      plan_uuid,
      depends_on_uuid
    ) VALUES (?, ?)
  `
  );
  for (const dependencyUuid of desired) {
    if (!existing.has(dependencyUuid)) {
      insertDependency.run(planUuid, dependencyUuid);
      emitDependencyAdd(db, planUuid, dependencyUuid);
    }
  }
}

function replacePlanTags(db: Database, planUuid: string, tags: string[]): void {
  const existing = new Set(
    (
      db.prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?').all(planUuid) as Array<{
        tag: string;
      }>
    ).map((row) => row.tag)
  );
  const desired = new Set(tags);

  for (const tag of existing) {
    if (!desired.has(tag)) {
      db.prepare('DELETE FROM plan_tag WHERE plan_uuid = ? AND tag = ?').run(planUuid, tag);
      emitTagRemove(db, planUuid, tag);
    }
  }

  const insertTag = db.prepare(
    `
    INSERT INTO plan_tag (
      plan_uuid,
      tag
    ) VALUES (?, ?)
  `
  );
  for (const tag of desired) {
    if (!existing.has(tag)) {
      insertTag.run(planUuid, tag);
      emitTagAdd(db, planUuid, tag);
    }
  }
}

export function upsertPlanInTransaction(
  db: Database,
  projectId: number,
  input: UpsertPlanInput
): PlanRow {
  const existing = getPlanByUuid(db, input.uuid);
  const incomingTimestamp = parseTimestamp(input.sourceUpdatedAt);
  const effectiveUpdatedAt = incomingTimestamp === null ? null : (input.sourceUpdatedAt ?? null);
  const incomingCreatedAt = parseTimestamp(input.sourceCreatedAt);
  const effectiveCreatedAt = incomingCreatedAt === null ? null : (input.sourceCreatedAt ?? null);
  if (existing && input.forceOverwrite !== true) {
    const existingTimestamp = parseTimestamp(existing.updated_at);
    if (
      incomingTimestamp !== null &&
      existingTimestamp !== null &&
      incomingTimestamp < existingTimestamp
    ) {
      return existing;
    }
  }

  const nextPlanFields = {
    project_id: projectId,
    plan_id: input.planId,
    title: input.title ?? null,
    goal: input.goal ?? null,
    note: input.note ?? null,
    details: input.details ?? null,
    status: input.status ?? 'pending',
    priority: input.priority ?? null,
    branch: input.branch ?? null,
    simple: typeof input.simple === 'boolean' ? (input.simple ? 1 : 0) : null,
    tdd: typeof input.tdd === 'boolean' ? (input.tdd ? 1 : 0) : null,
    discovered_from: input.discoveredFrom ?? null,
    issue: input.issue ? JSON.stringify(input.issue) : null,
    pull_request: input.pullRequest ? JSON.stringify(input.pullRequest) : null,
    assigned_to: input.assignedTo ?? null,
    base_branch: input.baseBranch ?? null,
    base_commit: input.baseCommit ?? null,
    base_change_id: input.baseChangeId ?? null,
    temp: typeof input.temp === 'boolean' ? (input.temp ? 1 : 0) : null,
    docs: input.docs ? JSON.stringify(input.docs) : null,
    changed_files: input.changedFiles ? JSON.stringify(input.changedFiles) : null,
    plan_generated_at: input.planGeneratedAt ?? null,
    review_issues: input.reviewIssues ? JSON.stringify(input.reviewIssues) : null,
    docs_updated_at: input.sourceDocsUpdatedAt ?? null,
    lessons_applied_at: input.sourceLessonsAppliedAt ?? null,
    parent_uuid: input.parentUuid ?? null,
    epic: input.epic ? 1 : 0,
  };

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
      review_issues,
      docs_updated_at,
      lessons_applied_at,
      parent_uuid,
      epic,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}), COALESCE(?, ${SQL_NOW_ISO_UTC}))
    ON CONFLICT(uuid) DO UPDATE SET
      project_id = excluded.project_id,
      plan_id = excluded.plan_id,
      title = excluded.title,
      goal = excluded.goal,
      note = excluded.note,
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
      base_commit = excluded.base_commit,
      base_change_id = excluded.base_change_id,
      temp = excluded.temp,
      docs = excluded.docs,
      changed_files = excluded.changed_files,
      plan_generated_at = excluded.plan_generated_at,
      review_issues = excluded.review_issues,
      docs_updated_at = excluded.docs_updated_at,
      lessons_applied_at = excluded.lessons_applied_at,
      parent_uuid = excluded.parent_uuid,
      epic = excluded.epic,
      created_at = COALESCE(excluded.created_at, ${SQL_NOW_ISO_UTC}),
      updated_at = COALESCE(excluded.updated_at, ${SQL_NOW_ISO_UTC})
  `
  ).run(
    input.uuid,
    projectId,
    input.planId,
    nextPlanFields.title,
    nextPlanFields.goal,
    nextPlanFields.note,
    nextPlanFields.details,
    nextPlanFields.status,
    nextPlanFields.priority,
    nextPlanFields.branch,
    nextPlanFields.simple,
    nextPlanFields.tdd,
    nextPlanFields.discovered_from,
    nextPlanFields.issue,
    nextPlanFields.pull_request,
    nextPlanFields.assigned_to,
    nextPlanFields.base_branch,
    nextPlanFields.base_commit,
    nextPlanFields.base_change_id,
    nextPlanFields.temp,
    nextPlanFields.docs,
    nextPlanFields.changed_files,
    nextPlanFields.plan_generated_at,
    nextPlanFields.review_issues,
    nextPlanFields.docs_updated_at,
    nextPlanFields.lessons_applied_at,
    nextPlanFields.parent_uuid,
    nextPlanFields.epic,
    effectiveCreatedAt,
    effectiveUpdatedAt
  );

  const planContext: EmitPlanContext = {
    projectIdentity: getProjectSyncIdentity(db, projectId),
    planIdHint: input.planId ?? null,
  };
  if (!existing) {
    emitPlanCreate(db, input.uuid, planContext, nextPlanFields);
  } else {
    const fieldUpdates: Record<string, unknown> = {};
    for (const [fieldName, value] of Object.entries(nextPlanFields)) {
      if (existing[fieldName as keyof PlanRow] !== value) {
        fieldUpdates[fieldName] = value;
      }
    }
    emitPlanFieldUpdate(db, input.uuid, planContext, fieldUpdates);
  }

  replacePlanTasks(db, input.uuid, input.tasks ?? []);
  replacePlanDependencies(db, input.uuid, input.dependencyUuids ?? []);
  replacePlanTags(db, input.uuid, input.tags ?? []);
  reconcileReviewIssuesForPlan(db, input.uuid, input.reviewIssues ?? []);

  const row = getPlanByUuid(db, input.uuid);
  if (!row) {
    throw new Error(`Failed to upsert plan ${input.uuid}`);
  }

  return row;
}

export function upsertPlan(db: Database, projectId: number, input: UpsertPlanInput): PlanRow {
  const upsertInTransaction = db.transaction(
    (nextProjectId: number, nextInput: UpsertPlanInput): PlanRow =>
      upsertPlanInTransaction(db, nextProjectId, nextInput)
  );

  return upsertInTransaction.immediate(projectId, input);
}

export function upsertPlanTasks(
  db: Database,
  planUuid: string,
  tasks: Array<{
    uuid?: string;
    orderKey?: string;
    title: string;
    description: string;
    done?: boolean;
  }>
): void {
  const upsertTasksInTransaction = db.transaction(
    (
      nextPlanUuid: string,
      nextTasks: Array<{
        uuid?: string;
        orderKey?: string;
        title: string;
        description: string;
        done?: boolean;
      }>
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

export function appendPlanTask(
  db: Database,
  planUuid: string,
  task: { uuid?: string; title: string; description: string; done?: boolean }
): string {
  const appendInTransaction = db.transaction(
    (
      nextPlanUuid: string,
      nextTask: { uuid?: string; title: string; description: string; done?: boolean }
    ): string => {
      const taskIndexRow = db
        .prepare(
          `
            SELECT MAX(task_index) as maxTaskIndex
            FROM plan_task
            WHERE plan_uuid = ?
              AND deleted_hlc IS NULL
          `
        )
        .get(nextPlanUuid) as { maxTaskIndex: number | null };
      const nextIndex = (taskIndexRow.maxTaskIndex ?? -1) + 1;
      const orderKey = String(nextIndex).padStart(10, '0');
      let taskUuid = nextTask.uuid ?? randomUUID();
      if (nextTask.uuid) {
        const collision = db
          .prepare('SELECT deleted_hlc FROM plan_task WHERE uuid = ?')
          .get(nextTask.uuid) as { deleted_hlc: string | null } | undefined;
        if (collision) {
          taskUuid = randomUUID();
        }
      }
      const done = nextTask.done ? 1 : 0;

      db.prepare(
        `
          INSERT INTO plan_task (uuid, plan_uuid, task_index, order_key, title, description, done)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        taskUuid,
        nextPlanUuid,
        nextIndex,
        orderKey,
        nextTask.title,
        nextTask.description,
        done
      );
      emitTaskCreate(db, nextPlanUuid, taskUuid, {
        plan_uuid: nextPlanUuid,
        task_index: nextIndex,
        order_key: orderKey,
        title: nextTask.title,
        description: nextTask.description,
        done,
      });
      return taskUuid;
    }
  );

  return appendInTransaction.immediate(planUuid, task);
}

function planContextFor(db: Database, plan: PlanRow): EmitPlanContext {
  return {
    projectIdentity: getProjectSyncIdentity(db, plan.project_id),
    planIdHint: plan.plan_id ?? null,
  };
}

export function setPlanStatus(db: Database, planUuid: string, status: PlanSchema['status']): void {
  const updateInTransaction = db.transaction(
    (nextPlanUuid: string, nextStatus: PlanSchema['status']): void => {
      const existing = getPlanByUuid(db, nextPlanUuid);
      if (!existing || existing.status === nextStatus) {
        return;
      }
      db.prepare(`UPDATE plan SET status = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`).run(
        nextStatus,
        nextPlanUuid
      );
      emitPlanFieldUpdate(db, nextPlanUuid, planContextFor(db, existing), { status: nextStatus });
    }
  );

  updateInTransaction.immediate(planUuid, status);
}

export function getPlanByUuid(db: Database, uuid: string): PlanRow | null {
  return (db.prepare('SELECT * FROM plan WHERE uuid = ?').get(uuid) as PlanRow | null) ?? null;
}

export function getPlansByProject(db: Database, projectId: number): PlanRow[] {
  return db
    .prepare('SELECT * FROM plan WHERE project_id = ? ORDER BY plan_id, uuid')
    .all(projectId) as PlanRow[];
}

export function getPlansByParentUuid(
  db: Database,
  projectId: number,
  parentUuid: string
): PlanRow[] {
  return db
    .prepare('SELECT * FROM plan WHERE project_id = ? AND parent_uuid = ? ORDER BY plan_id, uuid')
    .all(projectId, parentUuid) as PlanRow[];
}

export function setPlanBranch(db: Database, planUuid: string, branch: string): void {
  const updateInTransaction = db.transaction((nextPlanUuid: string, nextBranch: string): void => {
    const existing = getPlanByUuid(db, nextPlanUuid);
    if (!existing || existing.branch === nextBranch) {
      return;
    }
    db.prepare(`UPDATE plan SET branch = ?, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`).run(
      nextBranch,
      nextPlanUuid
    );
    emitPlanFieldUpdate(db, nextPlanUuid, planContextFor(db, existing), { branch: nextBranch });
  });

  updateInTransaction.immediate(planUuid, branch);
}

export type PlanBaseTrackingUpdate = {
  baseBranch?: string | null;
  baseCommit?: string | null;
  baseChangeId?: string | null;
};

export function setPlanBaseTracking(
  db: Database,
  planUuid: string,
  update: PlanBaseTrackingUpdate
): void {
  const updateInTransaction = db.transaction(
    (nextPlanUuid: string, nextUpdate: PlanBaseTrackingUpdate): void => {
      const updates: string[] = [];
      const values: Array<string | null> = [];
      const fieldUpdates: Record<string, string | null> = {};
      const existing = getPlanByUuid(db, nextPlanUuid);
      if (!existing) {
        return;
      }

      if (
        nextUpdate.baseBranch !== undefined &&
        existing.base_branch !== (nextUpdate.baseBranch ?? null)
      ) {
        updates.push('base_branch = ?');
        values.push(nextUpdate.baseBranch ?? null);
        fieldUpdates.base_branch = nextUpdate.baseBranch ?? null;
      }
      if (
        nextUpdate.baseCommit !== undefined &&
        existing.base_commit !== (nextUpdate.baseCommit ?? null)
      ) {
        updates.push('base_commit = ?');
        values.push(nextUpdate.baseCommit ?? null);
        fieldUpdates.base_commit = nextUpdate.baseCommit ?? null;
      }
      if (
        nextUpdate.baseChangeId !== undefined &&
        existing.base_change_id !== (nextUpdate.baseChangeId ?? null)
      ) {
        updates.push('base_change_id = ?');
        values.push(nextUpdate.baseChangeId ?? null);
        fieldUpdates.base_change_id = nextUpdate.baseChangeId ?? null;
      }

      if (updates.length === 0) {
        return;
      }

      db.prepare(
        `UPDATE plan SET ${updates.join(', ')}, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
      ).run(...values, nextPlanUuid);
      emitPlanFieldUpdate(db, nextPlanUuid, planContextFor(db, existing), fieldUpdates);
    }
  );

  updateInTransaction.immediate(planUuid, update);
}

export function clearPlanBaseTracking(db: Database, planUuid: string): void {
  setPlanBaseTracking(db, planUuid, {
    baseBranch: null,
    baseCommit: null,
    baseChangeId: null,
  });
}

export function getPlanByPlanId(db: Database, projectId: number, planId: number): PlanRow | null {
  const rows = db
    .prepare('SELECT * FROM plan WHERE project_id = ? AND plan_id = ? ORDER BY uuid')
    .all(projectId, planId) as PlanRow[];

  if (rows.length > 1) {
    throw new Error(`Multiple plans found for project ${projectId} with plan ID ${planId}`);
  }

  return rows[0] ?? null;
}

export function getPlanTasksByUuid(db: Database, planUuid: string): PlanTaskRow[] {
  return db
    .prepare(
      'SELECT * FROM plan_task WHERE plan_uuid = ? AND deleted_hlc IS NULL ORDER BY order_key, uuid'
    )
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
        AND pt.deleted_hlc IS NULL
      ORDER BY pt.plan_uuid, pt.order_key, pt.uuid
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

export function getPlanDependenciesByUuid(db: Database, planUuid: string): PlanDependencyRow[] {
  return db
    .prepare(
      `
      SELECT plan_uuid, depends_on_uuid
      FROM plan_dependency
      WHERE plan_uuid = ?
      ORDER BY depends_on_uuid
    `
    )
    .all(planUuid) as PlanDependencyRow[];
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
  const deleteInTransaction = db.transaction((planUuid: string): boolean => {
    const result = db.prepare('DELETE FROM plan WHERE uuid = ?').run(planUuid);
    if (result.changes > 0) {
      emitPlanDelete(db, planUuid);
    }
    return result.changes > 0;
  });
  return deleteInTransaction.immediate(uuid);
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
