import type { Database } from 'bun:sqlite';
import { removeAssignment } from '../db/assignment.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  deletePlanStateFromTableSetInTransaction,
  replacePlanStateInTableSetInTransaction,
  type PlanDependencyRow,
  type PlanRow,
  type PlanTagRow,
} from '../db/plan.js';
import { recordSyncTombstone } from './conflicts.js';
import type { SyncOperationEnvelope } from './types.js';
import {
  clonePlanWithBump,
  type ApplyOperationToAdapter,
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
    const affectedPlanUuids = new Set(
      (
        this.db
          .prepare(
            `
              SELECT DISTINCT plan_uuid
              FROM plan_dependency_canonical
              WHERE depends_on_uuid = ?
                AND plan_uuid <> ?
            `
          )
          .all(planUuid, planUuid) as Array<{ plan_uuid: string }>
      ).map((row) => row.plan_uuid)
    );
    if (plan) {
      const referenceOwners = this.db
        .prepare(
          `
            SELECT uuid
            FROM plan_canonical
            WHERE project_id = ?
              AND uuid <> ?
              AND (parent_uuid = ? OR base_plan_uuid = ? OR discovered_from = ?)
          `
        )
        .all(this.project.id, planUuid, planUuid, planUuid, plan.plan_id) as Array<{
        uuid: string;
      }>;
      for (const owner of referenceOwners) {
        affectedPlanUuids.add(owner.uuid);
      }
    }
    for (const affectedPlanUuid of affectedPlanUuids) {
      const affectedPlan = this.getPlan(affectedPlanUuid);
      if (!affectedPlan) {
        continue;
      }
      const dependencies = this.getDependencies(affectedPlanUuid);
      const nextDependencies = dependencies.filter(
        (dependency) => dependency.depends_on_uuid !== planUuid
      );
      const patch: Partial<PlanRow> = {};
      if (affectedPlan.parent_uuid === planUuid) {
        patch.parent_uuid = null;
      }
      if (affectedPlan.base_plan_uuid === planUuid) {
        patch.base_plan_uuid = null;
      }
      if (plan && affectedPlan.discovered_from === plan.plan_id) {
        patch.discovered_from = null;
      }
      if (nextDependencies.length === dependencies.length && Object.keys(patch).length === 0) {
        continue;
      }
      if (nextDependencies.length !== dependencies.length) {
        this.setDependencies(affectedPlanUuid, nextDependencies);
      }
      this.setPlan(clonePlanWithBump(affectedPlan, patch));
      this.additionalMutations.push({
        targetType: 'plan',
        targetKey: `plan:${affectedPlanUuid}`,
        revision: affectedPlan.revision + 1,
      });
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
        deletePlanStateFromTableSetInTransaction(this.db, 'canonical', planUuid, {
          deleteInboundDependencies: true,
        });
        deletePlanStateFromTableSetInTransaction(this.db, 'projection', planUuid, {
          deleteInboundDependencies: true,
        });
        continue;
      }
      const tasks = this.tasks.get(planUuid) ?? [];
      const dependencies = this.dependencies.get(planUuid) ?? [];
      const tags = this.tags.get(planUuid) ?? [];
      replacePlanStateInTableSetInTransaction(this.db, 'canonical', {
        plan,
        tasks,
        dependencies,
        tags,
      });
      // base_commit and base_change_id are machine-local tracking fields updated
      // only via legacy-direct paths. Preserve any existing projection values so
      // that a sync write (e.g. set_scalar for base_branch) does not clobber them.
      const existingProjection = this.db
        .prepare('SELECT base_commit, base_change_id FROM plan WHERE uuid = ?')
        .get(planUuid) as { base_commit: string | null; base_change_id: string | null } | null;
      replacePlanStateInTableSetInTransaction(this.db, 'projection', {
        plan: {
          ...plan,
          base_commit: existingProjection?.base_commit ?? plan.base_commit,
          base_change_id: existingProjection?.base_change_id ?? plan.base_change_id,
        },
        tasks,
        dependencies,
        tags,
      });
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
  table: 'plan_task' | 'task_canonical',
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
