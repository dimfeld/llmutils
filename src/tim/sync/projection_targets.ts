import type { Database } from 'bun:sqlite';
import { refreshExistingPrimaryMaterializedPlans } from '../materialized_projection_refresh.js';
import { getProjectByUuid } from '../db/project.js';
import {
  getProjectionPlanRefUuids,
  isProjectOperation,
  isProjectSettingOperation,
} from './operation_metadata.js';
import {
  rebuildPlanProjectionInTransaction,
  rebuildProjectSettingProjectionForPayload,
} from './projection.js';
import { deleteProjectStateInTransaction } from './project_delete.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';

export type ProjectSettingPayload = Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
>;

export interface ProjectionRebuildTargets {
  planUuids: Set<string>;
  projectSettings: Map<string, ProjectSettingPayload>;
  projectUuids: Set<string>;
}

export interface ProjectionOperationRow {
  operation_uuid: string;
  operation_type: string;
  payload: string;
}

export function createProjectionRebuildTargets(): ProjectionRebuildTargets {
  return {
    planUuids: new Set<string>(),
    projectSettings: new Map<string, ProjectSettingPayload>(),
    projectUuids: new Set<string>(),
  };
}

export function collectProjectionTargetsForPayload(
  db: Database,
  targets: ProjectionRebuildTargets,
  payload: SyncOperationPayload
): void {
  if (isProjectSettingOperation(payload)) {
    targets.projectSettings.set(`${payload.projectUuid}:${payload.setting}`, payload);
    return;
  }
  if (isProjectOperation(payload)) {
    if (payload.type === 'project.upsert') {
      return;
    }
    targets.projectUuids.add(payload.projectUuid);
    return;
  }
  for (const planUuid of getAffectedProjectionPlanUuids(db, payload)) {
    targets.planUuids.add(planUuid);
  }
}

export function collectProjectionTargetsForOperationRow(
  db: Database,
  targets: ProjectionRebuildTargets,
  row: ProjectionOperationRow
): void {
  const payload = assertValidPayload(JSON.parse(row.payload));
  collectProjectionTargetsForPayload(db, targets, payload);
}

export function rebuildProjectionTargetsInTransaction(
  db: Database,
  targets: ProjectionRebuildTargets
): string[] {
  for (const projectUuid of targets.projectUuids) {
    const project = getProjectByUuid(db, projectUuid);
    if (project) {
      deleteProjectStateInTransaction(db, project);
    }
  }
  const requestedPlanRebuilds = [...targets.planUuids];
  for (const planUuid of requestedPlanRebuilds) {
    for (const affectedPlanUuid of rebuildPlanProjectionAndInboundOwnersInTransaction(
      db,
      planUuid
    )) {
      targets.planUuids.add(affectedPlanUuid);
    }
  }
  for (const payload of targets.projectSettings.values()) {
    rebuildProjectSettingProjectionForPayload(db, payload);
  }
  return [...targets.planUuids];
}

export function refreshMaterializedPlansForProjectionRebuilds(
  db: Database,
  affectedPlanUuids: Iterable<string>
): string[] {
  // File refresh intentionally runs after the SQLite transaction. A missed or
  // dirty materialization self-heals on the next explicit materialize/sync pass.
  refreshExistingPrimaryMaterializedPlans(db, affectedPlanUuids);
  return [...affectedPlanUuids];
}

export function getAffectedProjectionPlanUuids(
  db: Database,
  payload: SyncOperationPayload
): string[] {
  if (isProjectOperation(payload) || isProjectSettingOperation(payload)) {
    return [];
  }
  const affected = new Set(getProjectionPlanRefUuids(payload));
  if (payload.type === 'plan.delete') {
    for (const ownerPlanUuid of getInboundProjectionOwnerPlanUuids(db, payload.planUuid)) {
      affected.add(ownerPlanUuid);
    }
  }
  return [...affected];
}

export function getInboundProjectionOwnerPlanUuids(
  db: Database,
  deletedPlanUuid: string
): string[] {
  const rows = db
    .prepare(
      `
        WITH deleted_identity AS (
          SELECT project_id, plan_id FROM plan WHERE uuid = ?
          UNION
          SELECT project_id, plan_id FROM plan_canonical WHERE uuid = ?
        )
        SELECT plan_uuid
        FROM plan_dependency
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan
        WHERE parent_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan
        WHERE base_plan_uuid = ?
        UNION
        SELECT plan_uuid
        FROM plan_dependency_canonical
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan_canonical
        WHERE parent_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan_canonical
        WHERE base_plan_uuid = ?
        UNION
        SELECT owner.uuid AS plan_uuid
        FROM plan AS owner
        JOIN deleted_identity AS deleted
          ON deleted.project_id = owner.project_id
         AND deleted.plan_id = owner.discovered_from
        UNION
        SELECT owner.uuid AS plan_uuid
        FROM plan_canonical AS owner
        JOIN deleted_identity AS deleted
          ON deleted.project_id = owner.project_id
         AND deleted.plan_id = owner.discovered_from
      `
    )
    .all(
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid,
      deletedPlanUuid
    ) as Array<{
    plan_uuid: string;
  }>;
  return rows.map((row) => row.plan_uuid);
}

export function rebuildPlanProjectionAndInboundOwnersInTransaction(
  db: Database,
  planUuid: string
): string[] {
  const rebuildPlanUuids = new Set([planUuid]);
  for (const ownerPlanUuid of getInboundProjectionOwnerPlanUuids(db, planUuid)) {
    rebuildPlanUuids.add(ownerPlanUuid);
  }
  for (const rebuildPlanUuid of rebuildPlanUuids) {
    rebuildPlanProjectionInTransaction(db, rebuildPlanUuid);
  }
  return [...rebuildPlanUuids];
}
