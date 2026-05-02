import type { Database } from 'bun:sqlite';
import * as z from 'zod/v4';
import { removeAssignment } from '../db/assignment.js';
import {
  upsertCanonicalPlanInTransaction,
  type PlanRow,
} from '../db/plan.js';
import { getProjectByUuid } from '../db/project.js';
import {
  deleteCanonicalProjectSettingRow,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import { refreshExistingPrimaryMaterializedPlans } from '../materialized_projection_refresh.js';
import { recordSyncTombstone } from './conflicts.js';
import { planKey, taskKey } from './entity_keys.js';
import {
  rebuildPlanProjectionAndInboundOwnersInTransaction,
} from './queue.js';
import {
  rebuildPlanProjectionInTransaction,
  rebuildProjectSettingProjection,
} from './projection.js';
import { assertValidPayload } from './types.js';

export interface CanonicalPlanSnapshot {
  type: 'plan';
  projectUuid: string;
  plan: {
    uuid: string;
    planId: number;
    title: string | null;
    goal: string | null;
    note: string | null;
    details: string | null;
    status: PlanRow['status'];
    priority: PlanRow['priority'];
    branch: string | null;
    simple: boolean | null;
    tdd: boolean | null;
    discoveredFrom: string | null;
    issue: string[] | null;
    pullRequest: string[] | null;
    assignedTo: string | null;
    baseBranch: string | null;
    temp: boolean | null;
    docs: string[] | null;
    changedFiles: string[] | null;
    planGeneratedAt: string | null;
    reviewIssues: unknown[] | null;
    parentUuid: string | null;
    epic: boolean;
    revision: number;
    tasks: Array<{
      uuid: string;
      title: string;
      description: string;
      done: boolean;
      revision: number;
    }>;
    dependencyUuids: string[];
    tags: string[];
  };
}

export interface CanonicalDeletedPlanSnapshot {
  type: 'plan_deleted';
  projectUuid: string;
  planUuid: string;
  deletedAt: string;
  deletedBySequenceId?: number;
}

export type CanonicalNeverExistedSnapshot =
  | {
      type: 'never_existed';
      entityKey: string;
      targetType: 'plan';
      planUuid: string;
    }
  | {
      type: 'never_existed';
      entityKey: string;
      targetType: 'task';
      taskUuid: string;
    };

export type CanonicalProjectSettingSnapshot =
  | {
      type: 'project_setting';
      projectUuid: string;
      setting: string;
      deleted: true;
    }
  | {
      type: 'project_setting';
      projectUuid: string;
      setting: string;
      deleted?: false;
      value: unknown;
      revision: number;
      updatedAt?: string | null;
      updatedByNode?: string | null;
    };

export type CanonicalSnapshot =
  | CanonicalPlanSnapshot
  | CanonicalDeletedPlanSnapshot
  | CanonicalNeverExistedSnapshot
  | CanonicalProjectSettingSnapshot;

const ASSIGNMENT_CLEANUP_STATUSES = new Set(['done', 'needs_review', 'cancelled']);

const CanonicalPlanSnapshotSchema = z.object({
  type: z.literal('plan'),
  projectUuid: z.string(),
  plan: z.object({
    uuid: z.string(),
    planId: z.number(),
    title: z.string().nullable(),
    goal: z.string().nullable(),
    note: z.string().nullable(),
    details: z.string().nullable(),
    status: z.custom<PlanRow['status']>((value) => typeof value === 'string'),
    priority: z.custom<PlanRow['priority']>((value) => value === null || typeof value === 'string'),
    branch: z.string().nullable(),
    simple: z.boolean().nullable(),
    tdd: z.boolean().nullable(),
    discoveredFrom: z.string().nullable(),
    issue: z.array(z.string()).nullable(),
    pullRequest: z.array(z.string()).nullable(),
    assignedTo: z.string().nullable(),
    baseBranch: z.string().nullable(),
    temp: z.boolean().nullable(),
    docs: z.array(z.string()).nullable(),
    changedFiles: z.array(z.string()).nullable(),
    planGeneratedAt: z.string().nullable(),
    reviewIssues: z.array(z.unknown()).nullable(),
    parentUuid: z.string().nullable(),
    epic: z.boolean(),
    revision: z.number(),
    tasks: z.array(
      z.object({
        uuid: z.string(),
        title: z.string(),
        description: z.string(),
        done: z.boolean(),
        revision: z.number(),
      })
    ),
    dependencyUuids: z.array(z.string()),
    tags: z.array(z.string()),
  }),
}) satisfies z.ZodType<CanonicalPlanSnapshot>;

const CanonicalDeletedPlanSnapshotSchema = z.object({
  type: z.literal('plan_deleted'),
  projectUuid: z.string(),
  planUuid: z.string(),
  deletedAt: z.string(),
  deletedBySequenceId: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<CanonicalDeletedPlanSnapshot>;

const CanonicalNeverExistedSnapshotSchema = z.union([
  z.object({
    type: z.literal('never_existed'),
    entityKey: z.string(),
    targetType: z.literal('plan'),
    planUuid: z.string(),
  }),
  z.object({
    type: z.literal('never_existed'),
    entityKey: z.string(),
    targetType: z.literal('task'),
    taskUuid: z.string(),
  }),
]) satisfies z.ZodType<CanonicalNeverExistedSnapshot>;

const CanonicalProjectSettingDeleteSnapshotSchema = z.object({
  type: z.literal('project_setting'),
  projectUuid: z.string(),
  setting: z.string(),
  deleted: z.literal(true),
});

const CanonicalProjectSettingSetSnapshotSchema = z.object({
  type: z.literal('project_setting'),
  projectUuid: z.string(),
  setting: z.string(),
  deleted: z.literal(false).optional(),
  value: z.unknown().refine((v) => v !== undefined, { message: 'value is required' }),
  revision: z.number(),
  updatedAt: z.string().nullable().optional(),
  updatedByNode: z.string().nullable().optional(),
});

const CanonicalProjectSettingSnapshotSchema = z.union([
  CanonicalProjectSettingDeleteSnapshotSchema,
  CanonicalProjectSettingSetSnapshotSchema,
]) satisfies z.ZodType<CanonicalProjectSettingSnapshot>;

export const CanonicalSnapshotSchema = z.union([
  CanonicalPlanSnapshotSchema,
  CanonicalDeletedPlanSnapshotSchema,
  CanonicalNeverExistedSnapshotSchema,
  CanonicalProjectSettingSnapshotSchema,
]) satisfies z.ZodType<CanonicalSnapshot>;

/**
 * Applies one canonical entity snapshot from the main node, then layers this
 * node's still-active optimistic operations back on top.
 */
export function mergeCanonicalRefresh(db: Database, snapshot: CanonicalSnapshot): string[] {
  const parsedSnapshot = CanonicalSnapshotSchema.parse(snapshot);
  const merge = db.transaction((nextSnapshot: CanonicalSnapshot): string[] => {
    return writeCanonicalSnapshot(db, nextSnapshot);
  });
  const affectedPlanUuids = merge.immediate(parsedSnapshot);
  // File refresh intentionally runs after the SQLite transaction. A missed or
  // dirty materialization self-heals on the next explicit materialize/sync pass.
  refreshExistingPrimaryMaterializedPlans(db, affectedPlanUuids);
  return affectedPlanUuids;
}

function writeCanonicalSnapshot(db: Database, snapshot: CanonicalSnapshot): string[] {
  if (snapshot.type === 'never_existed') {
    return writeNeverExistedSnapshot(db, snapshot);
  }

  if (snapshot.type === 'plan_deleted') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    deleteCanonicalPlanState(db, snapshot.planUuid);
    if (project) {
      recordSyncTombstone(db, {
        entityType: 'plan',
        entityKey: planKey(snapshot.planUuid),
        projectUuid: snapshot.projectUuid,
        deletionOperationUuid:
          snapshot.deletedBySequenceId === undefined
            ? `canonical-delete:${snapshot.planUuid}`
            : `canonical-sequence:${snapshot.deletedBySequenceId}`,
        deletedRevision: null,
        originNodeId: 'main',
      });
      removeAssignment(db, project.id, snapshot.planUuid);
    }
    return rebuildPlanProjectionAndInboundOwnersInTransaction(db, snapshot.planUuid);
  }

  if (snapshot.type === 'project_setting') {
    const project = getProjectByUuid(db, snapshot.projectUuid);
    if (!project) {
      return [];
    }
    if (snapshot.deleted) {
      deleteCanonicalProjectSettingRow(db, project.id, snapshot.setting);
      rebuildProjectSettingProjection(db, project.id, snapshot.setting);
      return [];
    }
    writeCanonicalProjectSettingRow(db, project.id, snapshot.setting, snapshot.value, {
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt ?? null,
      updatedByNode: snapshot.updatedByNode ?? null,
    });
    rebuildProjectSettingProjection(db, project.id, snapshot.setting);
    return [];
  }

  const project = getProjectByUuid(db, snapshot.projectUuid);
  if (!project) {
    return [];
  }
  upsertCanonicalPlanInTransaction(db, project.id, {
    uuid: snapshot.plan.uuid,
    planId: snapshot.plan.planId,
    title: snapshot.plan.title,
    goal: snapshot.plan.goal,
    note: snapshot.plan.note,
    details: snapshot.plan.details,
    status: snapshot.plan.status,
    priority: snapshot.plan.priority,
    branch: snapshot.plan.branch,
    simple: snapshot.plan.simple,
    tdd: snapshot.plan.tdd,
    discoveredFrom: resolveCanonicalPlanId(db, project.id, snapshot.plan.discoveredFrom),
    parentUuid: snapshot.plan.parentUuid,
    epic: snapshot.plan.epic,
    revision: snapshot.plan.revision,
    issue: snapshot.plan.issue,
    pullRequest: snapshot.plan.pullRequest,
    assignedTo: snapshot.plan.assignedTo,
    baseBranch: snapshot.plan.baseBranch,
    baseCommit: null,
    baseChangeId: null,
    temp: snapshot.plan.temp,
    docs: snapshot.plan.docs,
    changedFiles: snapshot.plan.changedFiles,
    planGeneratedAt: snapshot.plan.planGeneratedAt,
    reviewIssues: snapshot.plan.reviewIssues as never,
    tasks: snapshot.plan.tasks.map((task) => ({
      uuid: task.uuid,
      title: task.title,
      description: task.description,
      done: task.done,
      revision: task.revision,
    })),
    dependencyUuids: snapshot.plan.dependencyUuids,
    tags: snapshot.plan.tags,
    forceOverwrite: true,
  });
  db.prepare('DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?').run(
    'plan',
    planKey(snapshot.plan.uuid)
  );
  const clearTaskTombstone = db.prepare(
    'DELETE FROM sync_tombstone WHERE entity_type = ? AND entity_key = ?'
  );
  for (const task of snapshot.plan.tasks) {
    clearTaskTombstone.run('task', taskKey(task.uuid));
  }
  rebuildPlanProjectionInTransaction(db, snapshot.plan.uuid);
  if (ASSIGNMENT_CLEANUP_STATUSES.has(snapshot.plan.status)) {
    removeAssignment(db, project.id, snapshot.plan.uuid);
  }
  return [snapshot.plan.uuid];
}

function writeNeverExistedSnapshot(
  db: Database,
  snapshot: CanonicalNeverExistedSnapshot
): string[] {
  if (snapshot.targetType === 'plan') {
    const projectUuid = resolveProjectUuidForPlanTombstone(db, snapshot.planUuid);
    deleteCanonicalPlanState(db, snapshot.planUuid);
    if (projectUuid) {
      recordSyncTombstone(db, {
        entityType: 'plan',
        entityKey: planKey(snapshot.planUuid),
        projectUuid,
        deletionOperationUuid: `canonical-never-existed:${snapshot.planUuid}`,
        deletedRevision: null,
        originNodeId: 'main',
      });
    }
    return rebuildPlanProjectionAndInboundOwnersInTransaction(db, snapshot.planUuid);
  }

  const ownerPlanUuid = resolveOwningPlanUuidForTaskNeverExisted(db, snapshot.taskUuid);
  const projectUuid =
    ownerPlanUuid === null ? resolveProjectUuidForTaskNeverExisted(db, snapshot.taskUuid) : null;
  db.prepare('DELETE FROM task_canonical WHERE uuid = ?').run(snapshot.taskUuid);
  const ownerProjectUuid =
    ownerPlanUuid === null ? projectUuid : resolveProjectUuidForPlanTombstone(db, ownerPlanUuid);
  if (ownerProjectUuid) {
    recordSyncTombstone(db, {
      entityType: 'task',
      entityKey: taskKey(snapshot.taskUuid),
      projectUuid: ownerProjectUuid,
      deletionOperationUuid: `canonical-never-existed:${snapshot.taskUuid}`,
      deletedRevision: null,
      originNodeId: 'main',
    });
  }
  if (ownerPlanUuid) {
    rebuildPlanProjectionInTransaction(db, ownerPlanUuid);
    return [ownerPlanUuid];
  }
  return [];
}

function deleteCanonicalPlanState(db: Database, planUuid: string): void {
  db.prepare(
    'DELETE FROM plan_dependency_canonical WHERE plan_uuid = ? OR depends_on_uuid = ?'
  ).run(planUuid, planUuid);
  db.prepare('DELETE FROM plan_tag_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM task_canonical WHERE plan_uuid = ?').run(planUuid);
  db.prepare('DELETE FROM plan_canonical WHERE uuid = ?').run(planUuid);
}

function resolveCanonicalPlanId(
  db: Database,
  projectId: number | null,
  planUuid: string | null | undefined
): number | null {
  if (!projectId || !planUuid) {
    return null;
  }
  const row = db
    .prepare('SELECT plan_id FROM plan_canonical WHERE project_id = ? AND uuid = ?')
    .get(projectId, planUuid) as { plan_id: number } | null;
  return row?.plan_id ?? null;
}

function resolveProjectUuidForPlanTombstone(db: Database, planUuid: string): string | null {
  const row = db
    .prepare(
      `
        SELECT p.uuid AS project_uuid
        FROM plan_canonical pc
        JOIN project p ON p.id = pc.project_id
        WHERE pc.uuid = ?
        UNION
        SELECT p.uuid AS project_uuid
        FROM plan pl
        JOIN project p ON p.id = pl.project_id
        WHERE pl.uuid = ?
        UNION
        SELECT project_uuid
        FROM sync_operation_plan_ref
        WHERE plan_uuid = ?
        LIMIT 1
      `
    )
    .get(planUuid, planUuid, planUuid) as { project_uuid: string } | null;
  return row?.project_uuid ?? null;
}

function resolveOwningPlanUuidForTaskNeverExisted(db: Database, taskUuid: string): string | null {
  const row = db
    .prepare(
      `
        SELECT plan_uuid
        FROM task_canonical
        WHERE uuid = ?
        UNION
        SELECT plan_uuid
        FROM plan_task
        WHERE uuid = ?
        LIMIT 1
      `
    )
    .get(taskUuid, taskUuid) as { plan_uuid: string } | null;
  if (row?.plan_uuid) {
    return row.plan_uuid;
  }

  for (const op of activeOperationsReferencingTask(db, taskUuid)) {
    const planUuid = planUuidFromTaskPayload(op);
    if (planUuid) {
      return planUuid;
    }
  }
  return null;
}

function resolveProjectUuidForTaskNeverExisted(db: Database, taskUuid: string): string | null {
  for (const op of activeOperationsReferencingTask(db, taskUuid)) {
    if (op.project_uuid) {
      return op.project_uuid;
    }
  }
  return null;
}

function activeOperationsReferencingTask(
  db: Database,
  taskUuid: string
): Array<{ project_uuid: string; payload: string }> {
  return db
    .prepare(
      `
        SELECT project_uuid, payload
        FROM sync_operation
        WHERE payload_task_uuid = ?
          AND status IN ('queued', 'sending', 'failed_retryable')
        ORDER BY origin_node_id, local_sequence
      `
    )
    .all(taskUuid) as Array<{ project_uuid: string; payload: string }>;
}

function planUuidFromTaskPayload(row: { payload: string }): string | null {
  const payload = assertValidPayload(JSON.parse(row.payload));
  if (!('taskUuid' in payload)) {
    return null;
  }
  if (payload.type === 'plan.promote_task') {
    return payload.sourcePlanUuid;
  }
  return 'planUuid' in payload ? payload.planUuid : null;
}
