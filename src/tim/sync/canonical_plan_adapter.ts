import type { Database } from 'bun:sqlite';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import type { PlanDependencyRow, PlanRow, PlanTagRow } from '../db/plan.js';
import { recordSyncTombstone } from './conflicts.js';
import type { SyncOperationEnvelope } from './types.js';
import {
  clonePlanWithBump,
  type ApplyOperationToAdapter,
  type ApplyOperationToPlan,
  type ApplyOperationToTask,
} from './operation_fold.js';
import { BasePlanStateAdapter } from './plan_state_adapter.js';
import type { Mutation, ProjectRow } from './apply_shared.js';

export class CanonicalPlanAdapter extends BasePlanStateAdapter implements ApplyOperationToAdapter {
  readonly baseRevisionMode = 'strict';
  private touchedPlans = new Set<string>();
  private additionalMutations: Mutation[] = [];
  private maxResolvedPlanId = 0;

  constructor(
    private readonly db: Database,
    project: ProjectRow,
    private readonly envelope: SyncOperationEnvelope
  ) {
    super(project);
  }

  resolveLocalPlanId(planUuid: string | null | undefined): number | null {
    if (!planUuid) {
      return null;
    }
    return this.getPlan(planUuid)?.plan_id ?? null;
  }

  resolvePlanCreateNumericPlanId(
    requestedPlanId: number | undefined,
    preserveRequestedPlanIds?: boolean
  ): number {
    const resolved = resolvePlanCreateNumericPlanId(
      this.db,
      this.project.id,
      requestedPlanId,
      preserveRequestedPlanIds === true
    );
    this.maxResolvedPlanId = Math.max(this.maxResolvedPlanId, resolved.numericPlanId);
    return resolved.numericPlanId;
  }

  onPlanDeleted(planUuid: string): void {
    const plan = this.plans.get(planUuid);
    const revision = plan ? plan.revision + 1 : 1;
    recordSyncTombstone(this.db, {
      entityType: 'plan',
      entityKey: `plan:${planUuid}`,
      projectUuid: this.envelope.projectUuid,
      deletionOperationUuid: this.envelope.operationUuid,
      deletedRevision: revision,
      originNodeId: this.envelope.originNodeId,
    });
    for (const task of this.getTasks(planUuid)) {
      if (!task.uuid) {
        continue;
      }
      recordSyncTombstone(this.db, {
        entityType: 'task',
        entityKey: `task:${task.uuid}`,
        projectUuid: this.envelope.projectUuid,
        deletionOperationUuid: this.envelope.operationUuid,
        deletedRevision: task.revision + 1,
        originNodeId: this.envelope.originNodeId,
      });
    }
    const dependents = this.db
      .prepare(
        `
          SELECT DISTINCT plan_uuid
          FROM plan_dependency_canonical
          WHERE depends_on_uuid = ?
            AND plan_uuid <> ?
        `
      )
      .all(planUuid, planUuid) as Array<{ plan_uuid: string }>;
    for (const dependent of dependents) {
      const dependencies = this.getDependencies(dependent.plan_uuid);
      const next = dependencies.filter((dependency) => dependency.depends_on_uuid !== planUuid);
      if (next.length !== dependencies.length) {
        this.setDependencies(dependent.plan_uuid, next);
        const dependentPlan = this.getPlan(dependent.plan_uuid);
        if (dependentPlan) {
          this.setPlan(clonePlanWithBump(dependentPlan, {}));
          this.additionalMutations.push({
            targetType: 'plan',
            targetKey: `plan:${dependent.plan_uuid}`,
            revision: dependentPlan.revision + 1,
          });
        }
      }
    }
    removeAssignment(this.db, this.project.id, planUuid);
  }

  onTaskDeleted(taskUuid: string, revision: number): void {
    recordSyncTombstone(this.db, {
      entityType: 'task',
      entityKey: `task:${taskUuid}`,
      projectUuid: this.envelope.projectUuid,
      deletionOperationUuid: this.envelope.operationUuid,
      deletedRevision: revision + 1,
      originNodeId: this.envelope.originNodeId,
    });
  }

  flush(): void {
    for (const planUuid of this.touchedPlans) {
      const plan = this.plans.get(planUuid) ?? null;
      if (!plan) {
        deletePlanFromTableSet(this.db, 'plan_canonical', 'task_canonical', planUuid);
        deletePlanFromTableSet(this.db, 'plan', 'plan_task', planUuid);
        continue;
      }
      writePlanToTableSet(this.db, 'plan_canonical', 'task_canonical', plan);
      // base_commit and base_change_id are machine-local tracking fields updated
      // only via legacy-direct paths. Preserve any existing projection values so
      // that a sync write (e.g. set_scalar for base_branch) does not clobber them.
      const existingProjection = this.db
        .prepare('SELECT base_commit, base_change_id FROM plan WHERE uuid = ?')
        .get(planUuid) as { base_commit: string | null; base_change_id: string | null } | null;
      writePlanToTableSet(this.db, 'plan', 'plan_task', {
        ...plan,
        base_commit: existingProjection?.base_commit ?? plan.base_commit,
        base_change_id: existingProjection?.base_change_id ?? plan.base_change_id,
      });
      replacePlanCollectionsInTableSet(
        this.db,
        'plan_dependency_canonical',
        'plan_tag_canonical',
        planUuid,
        this.dependencies.get(planUuid) ?? [],
        this.tags.get(planUuid) ?? []
      );
      replacePlanCollectionsInTableSet(
        this.db,
        'plan_dependency',
        'plan_tag',
        planUuid,
        this.dependencies.get(planUuid) ?? [],
        this.tags.get(planUuid) ?? []
      );
      replaceTasksInTable(this.db, 'task_canonical', planUuid, this.tasks.get(planUuid) ?? []);
      replaceTasksInTable(this.db, 'plan_task', planUuid, this.tasks.get(planUuid) ?? []);
      this.db
        .prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?')
        .run('plan', `plan:${planUuid}`);
    }
    if (this.maxResolvedPlanId > 0) {
      setProjectHighestPlanId(this.db, this.project.id, this.maxResolvedPlanId);
    }
  }

  extraMutations(): Mutation[] {
    return this.additionalMutations;
  }

  protected onPlanStateTouched(planUuid: string): void {
    this.touchedPlans.add(planUuid);
  }

  protected loadPlanState(planUuid: string): void {
    this.setLoadedPlanState(planUuid, {
      plan: getCanonicalPlanOnly(this.db, planUuid),
      tasks: readTasksFromTable(this.db, 'task_canonical', planUuid),
      dependencies: readDependenciesFromTable(this.db, 'plan_dependency_canonical', planUuid),
      tags: readTagsFromTable(this.db, 'plan_tag_canonical', planUuid),
    });
  }

  protected readTaskByUuid(taskUuid: string): ApplyOperationToTask | null {
    const task =
      (this.db
        .prepare('SELECT * FROM task_canonical WHERE uuid = ?')
        .get(taskUuid) as ApplyOperationToTask | null) ?? null;
    return task ? { ...task } : null;
  }
}

type PlanTableName = 'plan' | 'plan_canonical';
type TaskTableName = 'plan_task' | 'task_canonical';
type DependencyTableName = 'plan_dependency' | 'plan_dependency_canonical';
type TagTableName = 'plan_tag' | 'plan_tag_canonical';

function getCanonicalPlanOnly(db: Database, planUuid: string): PlanRow | null {
  return (
    (db.prepare('SELECT * FROM plan_canonical WHERE uuid = ?').get(planUuid) as PlanRow | null) ??
    null
  );
}

function readTasksFromTable(
  db: Database,
  table: TaskTableName,
  planUuid: string
): ApplyOperationToTask[] {
  return db
    .prepare(`SELECT * FROM ${table} WHERE plan_uuid = ? ORDER BY task_index, id`)
    .all(planUuid) as ApplyOperationToTask[];
}

function readDependenciesFromTable(
  db: Database,
  table: DependencyTableName,
  planUuid: string
): PlanDependencyRow[] {
  return db
    .prepare(`SELECT plan_uuid, depends_on_uuid FROM ${table} WHERE plan_uuid = ?`)
    .all(planUuid) as PlanDependencyRow[];
}

function readTagsFromTable(db: Database, table: TagTableName, planUuid: string): PlanTagRow[] {
  return db.prepare(`SELECT plan_uuid, tag FROM ${table} WHERE plan_uuid = ?`).all(planUuid) as
    | PlanTagRow[]
    | [];
}

function deletePlanFromTableSet(
  db: Database,
  planTable: PlanTableName,
  taskTable: TaskTableName,
  planUuid: string
): void {
  const dependencyTable = planTable === 'plan' ? 'plan_dependency' : 'plan_dependency_canonical';
  const tagTable = planTable === 'plan' ? 'plan_tag' : 'plan_tag_canonical';
  db.prepare(`DELETE FROM ${dependencyTable} WHERE plan_uuid = ? OR depends_on_uuid = ?`).run(
    planUuid,
    planUuid
  );
  db.prepare(`DELETE FROM ${tagTable} WHERE plan_uuid = ?`).run(planUuid);
  db.prepare(`DELETE FROM ${taskTable} WHERE plan_uuid = ?`).run(planUuid);
  db.prepare(`DELETE FROM ${planTable} WHERE uuid = ?`).run(planUuid);
}

function writePlanToTableSet(
  db: Database,
  table: PlanTableName,
  taskTable: TaskTableName,
  plan: ApplyOperationToPlan
): void {
  void taskTable;
  db.prepare(
    `
      INSERT INTO ${table} (
        uuid, project_id, plan_id, title, goal, note, details, status, priority,
        branch, simple, tdd, discovered_from, issue, pull_request, assigned_to,
        base_branch, base_commit, base_change_id, temp, docs, changed_files,
        plan_generated_at, review_issues, docs_updated_at, lessons_applied_at,
        parent_uuid, epic, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        revision = excluded.revision,
        updated_at = excluded.updated_at
    `
  ).run(
    plan.uuid,
    plan.project_id,
    plan.plan_id,
    plan.title,
    plan.goal,
    plan.note,
    plan.details,
    plan.status,
    plan.priority,
    plan.branch,
    plan.simple,
    plan.tdd,
    plan.discovered_from,
    plan.issue,
    plan.pull_request,
    plan.assigned_to,
    plan.base_branch,
    plan.base_commit,
    plan.base_change_id,
    plan.temp,
    plan.docs,
    plan.changed_files,
    plan.plan_generated_at,
    plan.review_issues,
    plan.docs_updated_at,
    plan.lessons_applied_at,
    plan.parent_uuid,
    plan.epic,
    plan.revision,
    plan.created_at,
    plan.updated_at
  );
}

function replaceTasksInTable(
  db: Database,
  table: TaskTableName,
  planUuid: string,
  tasks: ApplyOperationToTask[]
): void {
  db.prepare(`DELETE FROM ${table} WHERE plan_uuid = ?`).run(planUuid);
  const insert = db.prepare(
    `INSERT INTO ${table} (uuid, plan_uuid, task_index, title, description, done, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const task of tasks.sort((a, b) => a.task_index - b.task_index)) {
    if (!task.uuid) {
      throw new Error('task missing uuid in canonical apply write');
    }
    insert.run(
      task.uuid,
      planUuid,
      task.task_index,
      task.title,
      task.description,
      task.done,
      task.revision
    );
  }
}

function replacePlanCollectionsInTableSet(
  db: Database,
  dependencyTable: DependencyTableName,
  tagTable: TagTableName,
  planUuid: string,
  dependencies: PlanDependencyRow[],
  tags: PlanTagRow[]
): void {
  db.prepare(`DELETE FROM ${dependencyTable} WHERE plan_uuid = ?`).run(planUuid);
  const insertDependency = db.prepare(
    `INSERT OR IGNORE INTO ${dependencyTable} (plan_uuid, depends_on_uuid) VALUES (?, ?)`
  );
  for (const dependency of dependencies) {
    insertDependency.run(dependency.plan_uuid, dependency.depends_on_uuid);
  }
  db.prepare(`DELETE FROM ${tagTable} WHERE plan_uuid = ?`).run(planUuid);
  const insertTag = db.prepare(`INSERT OR IGNORE INTO ${tagTable} (plan_uuid, tag) VALUES (?, ?)`);
  for (const tag of tags) {
    insertTag.run(tag.plan_uuid, tag.tag);
  }
}

function reserveMainNodePlanId(db: Database, projectId: number): number {
  // Use max(highest_plan_id, MAX(plan_id)) + 1 so we never reuse an ID already
  // reserved by `reserveNextPlanId` (which bumps highest_plan_id ahead of any
  // actual plan row insert). MAX(plan_id) is still folded in to defend against
  // backfills/imports that bypass the project counter.
  const row = db
    .prepare(
      `SELECT
         max(
           COALESCE((SELECT MAX(plan_id) FROM plan WHERE project_id = ?), 0),
           COALESCE((SELECT highest_plan_id FROM project WHERE id = ?), 0)
         ) + 1 AS next_id`
    )
    .get(projectId, projectId) as { next_id: number };
  return row.next_id;
}

interface ResolvedNumericPlanId {
  numericPlanId: number;
  renumberedFrom?: number;
}

function resolvePlanCreateNumericPlanId(
  db: Database,
  projectId: number,
  requestedPlanId: number | undefined,
  preserveRequestedPlanIds = false
): ResolvedNumericPlanId {
  if (requestedPlanId === undefined) {
    return { numericPlanId: reserveMainNodePlanId(db, projectId) };
  }
  // The offline-requested ID is only safe to preserve when it has not been
  // claimed by either an existing plan row OR a prior `reserveNextPlanId()`
  // call that advanced project.highest_plan_id ahead of any insert. Treat
  // both as collisions; otherwise a concurrent local create can produce a
  // duplicate (project_id, plan_id).
  const conflictingPlan = db
    .prepare('SELECT uuid FROM plan WHERE project_id = ? AND plan_id = ? LIMIT 1')
    .get(projectId, requestedPlanId) as { uuid: string } | null;
  const highest = db.prepare('SELECT highest_plan_id FROM project WHERE id = ?').get(projectId) as {
    highest_plan_id: number;
  } | null;
  const reservedAhead =
    !preserveRequestedPlanIds && !!highest && requestedPlanId <= highest.highest_plan_id;
  if (!conflictingPlan && !reservedAhead) {
    return { numericPlanId: requestedPlanId };
  }
  const numericPlanId = reserveMainNodePlanId(db, projectId);
  return { numericPlanId, renumberedFrom: requestedPlanId };
}

function setProjectHighestPlanId(db: Database, projectId: number, planId: number): void {
  db.prepare(
    `UPDATE project SET highest_plan_id = max(highest_plan_id, ?), updated_at = ${SQL_NOW_ISO_UTC} WHERE id = ?`
  ).run(planId, projectId);
}
