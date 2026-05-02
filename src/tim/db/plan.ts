import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { getProjectById } from './project.js';

// Canonical helpers write the main-node-confirmed mirror tables and require
// explicit revisions from that canonical source. Projection helpers write the
// user-visible working tables and keep the legacy local revision bump behavior.
// Sync-aware code must route writes through sync/write_router.ts.

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
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface PlanTaskRow {
  id: number;
  uuid: string | null;
  plan_uuid: string;
  task_index: number;
  title: string;
  description: string;
  done: number;
  revision: number;
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
  revision?: number;
  tasks?: Array<{
    uuid?: string;
    title: string;
    description: string;
    done?: boolean;
    revision?: number;
  }>;
  dependencyUuids?: string[];
  tags?: string[];
}

export type UpsertCanonicalPlanInput = Omit<UpsertPlanInput, 'revision' | 'tasks'> & {
  revision: number;
  tasks?: Array<{
    uuid?: string;
    title: string;
    description: string;
    done?: boolean;
    revision: number;
  }>;
};

type PlanTableSet = {
  plan: 'plan' | 'plan_canonical';
  task: 'plan_task' | 'task_canonical';
  dependency: 'plan_dependency' | 'plan_dependency_canonical';
  tag: 'plan_tag' | 'plan_tag_canonical';
};

type RevisionWriteMode = 'auto' | 'explicit';

const PROJECTION_PLAN_TABLES: PlanTableSet = {
  plan: 'plan',
  task: 'plan_task',
  dependency: 'plan_dependency',
  tag: 'plan_tag',
};

const CANONICAL_PLAN_TABLES: PlanTableSet = {
  plan: 'plan_canonical',
  task: 'task_canonical',
  dependency: 'plan_dependency_canonical',
  tag: 'plan_tag_canonical',
};

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

function getPlanTasksByUuidFromTable(
  db: Database,
  table: PlanTableSet['task'],
  planUuid: string
): PlanTaskRow[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE plan_uuid = ? ORDER BY task_index, id`)
    .all(planUuid) as PlanTaskRow[];
}

function getPlanDependenciesByUuidFromTable(
  db: Database,
  table: PlanTableSet['dependency'],
  planUuid: string
): PlanDependencyRow[] {
  return db
    .prepare(
      `
      SELECT plan_uuid, depends_on_uuid
      FROM ${table}
      WHERE plan_uuid = ?
      ORDER BY depends_on_uuid
    `
    )
    .all(planUuid) as PlanDependencyRow[];
}

function getPlanTagsByUuidFromTable(
  db: Database,
  table: PlanTableSet['tag'],
  planUuid: string
): PlanTagRow[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE plan_uuid = ? ORDER BY tag`)
    .all(planUuid) as PlanTagRow[];
}

function replacePlanTasksInTable(
  db: Database,
  table: PlanTableSet['task'],
  planUuid: string,
  tasks: Array<{
    uuid?: string;
    title: string;
    description: string;
    done?: boolean;
    revision?: number;
  }>,
  revisionMode: RevisionWriteMode
): boolean {
  const existingTasks = getPlanTasksByUuidFromTable(db, table, planUuid);
  const existingByUuid = new Map(
    existingTasks
      .filter((task): task is PlanTaskRow & { uuid: string } => typeof task.uuid === 'string')
      .map((task) => [task.uuid, task])
  );

  const normalizedTasks = tasks.map((task, index) => {
    const existing = task.uuid ? existingByUuid.get(task.uuid) : undefined;
    const done = task.done ? 1 : 0;
    const unchanged =
      existing &&
      existing.title === task.title &&
      existing.description === task.description &&
      existing.done === done &&
      existing.task_index === index;
    if (revisionMode === 'explicit' && typeof task.revision !== 'number') {
      throw new Error('Canonical task writes require an explicit revision');
    }

    return {
      uuid: task.uuid ?? crypto.randomUUID(),
      title: task.title,
      description: task.description,
      done,
      revision:
        revisionMode === 'explicit'
          ? (task.revision ?? 1)
          : existing
            ? unchanged
              ? existing.revision
              : existing.revision + 1
            : 1,
    };
  });

  const changed =
    existingTasks.length !== normalizedTasks.length ||
    normalizedTasks.some((task, index) => {
      const existing = existingTasks[index];
      return (
        !existing ||
        existing.uuid !== task.uuid ||
        existing.task_index !== index ||
        existing.title !== task.title ||
        existing.description !== task.description ||
        existing.done !== task.done ||
        existing.revision !== task.revision
      );
    });

  if (!changed) {
    return false;
  }

  db.prepare(`DELETE FROM ${table} WHERE plan_uuid = ?`).run(planUuid);

  if (normalizedTasks.length === 0) {
    return true;
  }

  const insertTask = db.prepare(
    `
    INSERT INTO ${table} (
      uuid,
      plan_uuid,
      task_index,
      title,
      description,
      done,
      revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  );
  normalizedTasks.forEach((task, index) => {
    insertTask.run(
      task.uuid,
      planUuid,
      index,
      task.title,
      task.description,
      task.done,
      task.revision
    );
  });

  return true;
}

function replacePlanDependenciesInTable(
  db: Database,
  table: PlanTableSet['dependency'],
  planUuid: string,
  dependencyUuids: string[]
): boolean {
  const nextDependencyUuids = [...new Set(dependencyUuids)].sort();
  const existingDependencyUuids = getPlanDependenciesByUuidFromTable(db, table, planUuid).map(
    (dependency) => dependency.depends_on_uuid
  );
  if (
    existingDependencyUuids.length === nextDependencyUuids.length &&
    existingDependencyUuids.every(
      (dependencyUuid, index) => dependencyUuid === nextDependencyUuids[index]
    )
  ) {
    return false;
  }

  db.prepare(`DELETE FROM ${table} WHERE plan_uuid = ?`).run(planUuid);

  if (nextDependencyUuids.length === 0) {
    return true;
  }

  const insertDependency = db.prepare(
    `
    INSERT INTO ${table} (
      plan_uuid,
      depends_on_uuid
    ) VALUES (?, ?)
  `
  );
  for (const dependencyUuid of nextDependencyUuids) {
    insertDependency.run(planUuid, dependencyUuid);
  }

  return true;
}

function replacePlanTagsInTable(
  db: Database,
  table: PlanTableSet['tag'],
  planUuid: string,
  tags: string[]
): boolean {
  const nextTags = [...new Set(tags)].sort();
  const existingTags = getPlanTagsByUuidFromTable(db, table, planUuid).map((tag) => tag.tag);
  if (
    existingTags.length === nextTags.length &&
    existingTags.every((tag, index) => tag === nextTags[index])
  ) {
    return false;
  }

  db.prepare(`DELETE FROM ${table} WHERE plan_uuid = ?`).run(planUuid);

  if (nextTags.length === 0) {
    return true;
  }

  const insertTag = db.prepare(
    `
    INSERT INTO ${table} (
      plan_uuid,
      tag
    ) VALUES (?, ?)
  `
  );
  for (const tag of nextTags) {
    insertTag.run(planUuid, tag);
  }

  return true;
}

type PlanWriteValues = {
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
};

function planWriteValues(projectId: number, input: UpsertPlanInput): PlanWriteValues {
  return {
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
}

function planRowMatches(existing: PlanRow, values: PlanWriteValues): boolean {
  return (Object.keys(values) as Array<keyof PlanWriteValues>).every(
    (key) => existing[key] === values[key]
  );
}

function getPlanByUuidFromTable(
  db: Database,
  table: PlanTableSet['plan'],
  uuid: string
): PlanRow | null {
  return (db.prepare(`SELECT * FROM ${table} WHERE uuid = ?`).get(uuid) as PlanRow | null) ?? null;
}

function upsertPlanRowInTransaction(
  db: Database,
  tables: PlanTableSet,
  projectId: number,
  input: UpsertPlanInput,
  revisionMode: RevisionWriteMode
): PlanRow {
  const existing = getPlanByUuidFromTable(db, tables.plan, input.uuid);
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

  const values = planWriteValues(projectId, input);
  const explicitRevision = revisionMode === 'explicit' ? input.revision : undefined;
  if (revisionMode === 'explicit' && typeof explicitRevision !== 'number') {
    throw new Error('Canonical plan writes require an explicit revision');
  }
  let planRowChanged = false;

  if (!existing) {
    db.prepare(
      `
      INSERT INTO ${tables.plan} (
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
        revision,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${SQL_NOW_ISO_UTC}), COALESCE(?, ${SQL_NOW_ISO_UTC}))
    `
    ).run(
      input.uuid,
      values.project_id,
      values.plan_id,
      values.title,
      values.goal,
      values.note,
      values.details,
      values.status,
      values.priority,
      values.branch,
      values.simple,
      values.tdd,
      values.discovered_from,
      values.issue,
      values.pull_request,
      values.assigned_to,
      values.base_branch,
      values.base_commit,
      values.base_change_id,
      values.temp,
      values.docs,
      values.changed_files,
      values.plan_generated_at,
      values.review_issues,
      values.docs_updated_at,
      values.lessons_applied_at,
      values.parent_uuid,
      values.epic,
      explicitRevision ?? 1,
      effectiveCreatedAt,
      effectiveUpdatedAt
    );
  } else if (
    !planRowMatches(existing, values) ||
    (revisionMode === 'explicit' && existing.revision !== explicitRevision)
  ) {
    planRowChanged = true;
    db.prepare(
      `
      UPDATE ${tables.plan} SET
        project_id = ?,
        plan_id = ?,
        title = ?,
        goal = ?,
        note = ?,
        details = ?,
        status = ?,
        priority = ?,
        branch = ?,
        simple = ?,
        tdd = ?,
        discovered_from = ?,
        issue = ?,
        pull_request = ?,
        assigned_to = ?,
        base_branch = ?,
        base_commit = ?,
        base_change_id = ?,
        temp = ?,
        docs = ?,
        changed_files = ?,
        plan_generated_at = ?,
        review_issues = ?,
        docs_updated_at = ?,
        lessons_applied_at = ?,
        parent_uuid = ?,
        epic = ?,
        revision = ?,
        updated_at = COALESCE(?, ${SQL_NOW_ISO_UTC})
      WHERE uuid = ?
    `
    ).run(
      values.project_id,
      values.plan_id,
      values.title,
      values.goal,
      values.note,
      values.details,
      values.status,
      values.priority,
      values.branch,
      values.simple,
      values.tdd,
      values.discovered_from,
      values.issue,
      values.pull_request,
      values.assigned_to,
      values.base_branch,
      values.base_commit,
      values.base_change_id,
      values.temp,
      values.docs,
      values.changed_files,
      values.plan_generated_at,
      values.review_issues,
      values.docs_updated_at,
      values.lessons_applied_at,
      values.parent_uuid,
      values.epic,
      explicitRevision ?? existing.revision + 1,
      effectiveUpdatedAt,
      input.uuid
    );
  }

  const tasksChanged = replacePlanTasksInTable(
    db,
    tables.task,
    input.uuid,
    input.tasks ?? [],
    revisionMode
  );
  const dependenciesChanged = replacePlanDependenciesInTable(
    db,
    tables.dependency,
    input.uuid,
    input.dependencyUuids ?? []
  );
  const tagsChanged = replacePlanTagsInTable(db, tables.tag, input.uuid, input.tags ?? []);

  if (
    revisionMode === 'auto' &&
    !planRowChanged &&
    (tasksChanged || dependenciesChanged || tagsChanged) &&
    existing
  ) {
    db.prepare(
      `UPDATE ${tables.plan} SET revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
    ).run(input.uuid);
  }

  const row = getPlanByUuidFromTable(db, tables.plan, input.uuid);
  if (!row) {
    throw new Error(`Failed to upsert plan ${input.uuid}`);
  }

  return row;
}

export function upsertProjectionPlanInTransaction(
  db: Database,
  projectId: number,
  input: UpsertPlanInput
): PlanRow {
  return upsertPlanRowInTransaction(db, PROJECTION_PLAN_TABLES, projectId, input, 'auto');
}

export function upsertCanonicalPlanInTransaction(
  db: Database,
  projectId: number,
  input: UpsertCanonicalPlanInput
): PlanRow {
  return upsertPlanRowInTransaction(db, CANONICAL_PLAN_TABLES, projectId, input, 'explicit');
}

function nullableBoolean(value: number | null): boolean | null {
  return value === null ? null : Boolean(value);
}

function parseJsonArray<T>(value: string | null): T[] | null {
  return value ? (JSON.parse(value) as T[]) : null;
}

export function mirrorProjectionPlanToCanonicalInTransaction(
  db: Database,
  projectId: number,
  planUuid: string
): PlanRow {
  const row = getPlanByUuidFromTable(db, PROJECTION_PLAN_TABLES.plan, planUuid);
  if (!row) {
    throw new Error(`Cannot mirror missing projection plan ${planUuid}`);
  }
  const tasks = getPlanTasksByUuidFromTable(db, PROJECTION_PLAN_TABLES.task, planUuid).map(
    (task) => ({
      uuid: task.uuid ?? undefined,
      title: task.title,
      description: task.description,
      done: task.done === 1,
      revision: task.revision,
    })
  );
  const dependencyUuids = getPlanDependenciesByUuidFromTable(
    db,
    PROJECTION_PLAN_TABLES.dependency,
    planUuid
  ).map((dependency) => dependency.depends_on_uuid);
  const tags = getPlanTagsByUuidFromTable(db, PROJECTION_PLAN_TABLES.tag, planUuid).map(
    (tag) => tag.tag
  );

  return upsertCanonicalPlanInTransaction(db, projectId, {
    uuid: row.uuid,
    planId: row.plan_id,
    title: row.title,
    goal: row.goal,
    note: row.note,
    details: row.details,
    sourceCreatedAt: row.created_at,
    sourceUpdatedAt: row.updated_at,
    sourceDocsUpdatedAt: row.docs_updated_at,
    sourceLessonsAppliedAt: row.lessons_applied_at,
    status: row.status,
    priority: row.priority,
    branch: row.branch,
    simple: nullableBoolean(row.simple),
    tdd: nullableBoolean(row.tdd),
    discoveredFrom: row.discovered_from,
    issue: parseJsonArray<string>(row.issue),
    pullRequest: parseJsonArray<string>(row.pull_request),
    assignedTo: row.assigned_to,
    baseBranch: row.base_branch,
    baseCommit: row.base_commit,
    baseChangeId: row.base_change_id,
    temp: nullableBoolean(row.temp),
    docs: parseJsonArray<string>(row.docs),
    changedFiles: parseJsonArray<string>(row.changed_files),
    planGeneratedAt: row.plan_generated_at,
    reviewIssues: parseJsonArray<NonNullable<PlanSchema['reviewIssues']>[number]>(
      row.review_issues
    ),
    parentUuid: row.parent_uuid,
    epic: Boolean(row.epic),
    revision: row.revision,
    tasks,
    dependencyUuids,
    tags,
    forceOverwrite: true,
  });
}

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper writes projection state and mirrors it to canonical for local/main
 * setup paths where canonical and projection are equivalent.
 */
export function upsertPlan(db: Database, projectId: number, input: UpsertPlanInput): PlanRow {
  const upsertInTransaction = db.transaction(
    (nextProjectId: number, nextInput: UpsertPlanInput): PlanRow => {
      const row = upsertProjectionPlanInTransaction(db, nextProjectId, nextInput);
      mirrorProjectionPlanToCanonicalInTransaction(db, nextProjectId, row.uuid);
      return row;
    }
  );

  return upsertInTransaction.immediate(projectId, input);
}

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper writes projection state and mirrors it to canonical for local/main
 * setup paths where canonical and projection are equivalent.
 */
export function upsertPlanTasks(
  db: Database,
  planUuid: string,
  tasks: Array<{
    uuid?: string;
    title: string;
    description: string;
    done?: boolean;
    revision?: number;
  }>
): void {
  const upsertTasksInTransaction = db.transaction(
    (
      nextPlanUuid: string,
      nextTasks: Array<{
        uuid?: string;
        title: string;
        description: string;
        done?: boolean;
        revision?: number;
      }>
    ): void => {
      if (
        replacePlanTasksInTable(db, PROJECTION_PLAN_TABLES.task, nextPlanUuid, nextTasks, 'auto')
      ) {
        db.prepare(
          `UPDATE ${PROJECTION_PLAN_TABLES.plan} SET revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
        ).run(nextPlanUuid);
      }
      const row = getPlanByUuidFromTable(db, PROJECTION_PLAN_TABLES.plan, nextPlanUuid);
      if (row) {
        mirrorProjectionPlanToCanonicalInTransaction(db, row.project_id, nextPlanUuid);
      }
    }
  );

  upsertTasksInTransaction.immediate(planUuid, tasks);
}

function insertPlanTaskIntoTable(
  db: Database,
  table: PlanTableSet['task'],
  planUuid: string,
  task: {
    taskIndex: number;
    title: string;
    description: string;
    done?: boolean;
    uuid?: string;
    revision?: number;
  }
): void {
  db.prepare(
    `
    INSERT INTO ${table} (
      uuid,
      plan_uuid,
      task_index,
      title,
      description,
      done,
      revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    task.uuid ?? crypto.randomUUID(),
    planUuid,
    task.taskIndex,
    task.title,
    task.description,
    task.done ? 1 : 0,
    task.revision ?? 1
  );
}

export function insertProjectionPlanTask(
  db: Database,
  planUuid: string,
  task: {
    taskIndex: number;
    title: string;
    description: string;
    done?: boolean;
    uuid?: string;
  }
): void {
  insertPlanTaskIntoTable(db, PROJECTION_PLAN_TABLES.task, planUuid, task);
}

export function insertCanonicalPlanTask(
  db: Database,
  planUuid: string,
  task: {
    taskIndex: number;
    title: string;
    description: string;
    done?: boolean;
    uuid?: string;
    revision: number;
  }
): void {
  if (typeof task.revision !== 'number') {
    throw new Error('Canonical task writes require an explicit revision');
  }
  insertPlanTaskIntoTable(db, CANONICAL_PLAN_TABLES.task, planUuid, task);
}

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper writes projection state and mirrors it to canonical for local/main
 * setup paths where canonical and projection are equivalent.
 */
export function upsertPlanDependencies(
  db: Database,
  planUuid: string,
  dependencyUuids: string[]
): void {
  const upsertDependenciesInTransaction = db.transaction(
    (nextPlanUuid: string, nextDependencyUuids: string[]): void => {
      if (
        replacePlanDependenciesInTable(
          db,
          PROJECTION_PLAN_TABLES.dependency,
          nextPlanUuid,
          nextDependencyUuids
        )
      ) {
        db.prepare(
          `UPDATE ${PROJECTION_PLAN_TABLES.plan} SET revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
        ).run(nextPlanUuid);
      }
      const row = getPlanByUuidFromTable(db, PROJECTION_PLAN_TABLES.plan, nextPlanUuid);
      if (row) {
        mirrorProjectionPlanToCanonicalInTransaction(db, row.project_id, nextPlanUuid);
      }
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

export function getPlansByParentUuid(
  db: Database,
  projectId: number,
  parentUuid: string
): PlanRow[] {
  return db
    .prepare('SELECT * FROM plan WHERE project_id = ? AND parent_uuid = ? ORDER BY plan_id, uuid')
    .all(projectId, parentUuid) as PlanRow[];
}

async function setSyncedPlanScalar(
  db: Database,
  config: TimConfig,
  planUuid: string,
  field: 'branch' | 'base_branch',
  value: string | null
): Promise<void> {
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    return;
  }
  const project = getProjectById(db, plan.project_id);
  if (!project) {
    return;
  }
  const { writePlanSetScalar } = await import('../sync/write_router.js');
  await writePlanSetScalar(db, config, project.uuid, {
    planUuid,
    field,
    value,
    baseRevision: plan.revision,
  });
}

export async function setPlanBranch(
  db: Database,
  config: TimConfig,
  planUuid: string,
  branch: string
): Promise<void> {
  await setSyncedPlanScalar(db, config, planUuid, 'branch', branch);
}

export type PlanBaseTrackingUpdate = {
  baseBranch?: string | null;
  baseCommit?: string | null;
  baseChangeId?: string | null;
};

export async function setPlanBaseTracking(
  db: Database,
  config: TimConfig,
  planUuid: string,
  update: PlanBaseTrackingUpdate
): Promise<void> {
  await setPlanBaseTrackingInternal(db, config, planUuid, update);
}

async function setPlanBaseTrackingInternal(
  db: Database,
  config: TimConfig,
  planUuid: string,
  update: PlanBaseTrackingUpdate
): Promise<void> {
  // baseCommit and baseChangeId are intentionally local-only machine tracking fields.
  // Apply them first so that if the sync-routed baseBranch write fails afterward,
  // the local-only columns are still in a consistent state with each other.
  // branch/baseBranch are synced canonical fields and route through the sync write router.
  const updates: string[] = [];
  const values: Array<string | null> = [];

  if (update.baseCommit !== undefined) {
    updates.push('base_commit = ?');
    values.push(update.baseCommit ?? null);
  }
  if (update.baseChangeId !== undefined) {
    updates.push('base_change_id = ?');
    values.push(update.baseChangeId ?? null);
  }

  if (updates.length > 0) {
    db.prepare(`UPDATE plan SET ${updates.join(', ')} WHERE uuid = ?`).run(...values, planUuid);
  }

  if (update.baseBranch !== undefined) {
    await setSyncedPlanScalar(db, config, planUuid, 'base_branch', update.baseBranch ?? null);
  }
}

export async function clearPlanBaseTracking(
  db: Database,
  config: TimConfig,
  planUuid: string
): Promise<void> {
  // baseCommit/baseChangeId are local-only; apply them first so a sync-routing
  // failure on the baseBranch clear leaves the local-only columns consistent.
  db.prepare(
    `UPDATE plan
     SET base_commit = NULL,
         base_change_id = NULL
     WHERE uuid = ?`
  ).run(planUuid);
  await setSyncedPlanScalar(db, config, planUuid, 'base_branch', null);
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

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper deletes projection state and mirrors the deletion to canonical for
 * local/main setup paths where canonical and projection are equivalent.
 */
export function deletePlan(db: Database, uuid: string): boolean {
  const deleteInTransaction = db.transaction((nextUuid: string): boolean => {
    const result = db.prepare('DELETE FROM plan WHERE uuid = ?').run(nextUuid);
    db.prepare('DELETE FROM plan_canonical WHERE uuid = ?').run(nextUuid);
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
