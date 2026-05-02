import type { Database } from 'bun:sqlite';
import { getProjectionPlanRefUuids, isProjectSettingOperation } from './operation_metadata.js';
import {
  rebuildPlanProjectionInTransaction,
  rebuildProjectSettingProjectionForPayload,
} from './projection.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';

export type ProjectSettingPayload = Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
>;

export interface ProjectionRebuildTargets {
  planUuids: Set<string>;
  projectSettings: Map<string, ProjectSettingPayload>;
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

export function getAffectedProjectionPlanUuids(
  db: Database,
  payload: SyncOperationPayload
): string[] {
  if (isProjectSettingOperation(payload)) {
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
        SELECT plan_uuid
        FROM plan_dependency
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan
        WHERE parent_uuid = ?
        UNION
        SELECT plan_uuid
        FROM plan_dependency_canonical
        WHERE depends_on_uuid = ?
        UNION
        SELECT uuid AS plan_uuid
        FROM plan_canonical
        WHERE parent_uuid = ?
      `
    )
    .all(deletedPlanUuid, deletedPlanUuid, deletedPlanUuid, deletedPlanUuid) as Array<{
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
