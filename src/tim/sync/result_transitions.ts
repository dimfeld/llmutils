import type { Database } from 'bun:sqlite';
import {
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  getInboundProjectionOwnerPlanUuids,
  type SyncOperationQueueRow,
} from './queue.js';
import {
  rebuildPlanProjectionInTransaction,
  rebuildProjectSettingProjectionForPayload,
} from './projection.js';
import { PROJECTION_REBUILD_PLAN_REF_ROLES } from './plan_refs.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';
import type { SyncOperationResult } from './ws_protocol.js';

export interface ApplyOperationResultTransitionsOptions {
  afterTransition?: (result: SyncOperationResult, index: number) => void;
}

export function applyOperationResultTransitions(
  db: Database,
  results: SyncOperationResult[],
  options: ApplyOperationResultTransitionsOptions = {}
): void {
  const transition = db.transaction((nextResults: SyncOperationResult[]): void => {
    const planRebuilds = new Set<string>();
    const projectSettingRebuilds = new Map<string, ProjectSettingRebuildTarget>();
    for (const [index, result] of nextResults.entries()) {
      const ackMetadata = {
        sequenceIds: result.sequenceIds ?? [],
        invalidations: result.invalidations ?? [],
      };
      switch (result.status) {
        case 'applied':
          collectProjectionRebuilds(
            db,
            planRebuilds,
            projectSettingRebuilds,
            markOperationAcked(db, result.operationId, ackMetadata)
          );
          break;
        case 'conflict':
          collectProjectionRebuilds(
            db,
            planRebuilds,
            projectSettingRebuilds,
            markOperationConflict(
              db,
              result.operationId,
              result.conflictId ?? 'unknown-conflict',
              ackMetadata
            )
          );
          break;
        case 'rejected':
          collectProjectionRebuilds(
            db,
            planRebuilds,
            projectSettingRebuilds,
            markOperationRejected(
              db,
              result.operationId,
              result.error ?? 'Operation rejected by main node',
              ackMetadata
            )
          );
          break;
        case 'deferred':
        case 'failed_retryable':
          markOperationFailedRetryable(
            db,
            result.operationId,
            result.error ?? 'Operation not applied; retry later'
          );
          break;
      }
      options.afterTransition?.(result, index);
    }
    for (const planUuid of planRebuilds) {
      rebuildPlanProjectionInTransaction(db, planUuid);
    }
    for (const target of projectSettingRebuilds.values()) {
      rebuildProjectSettingProjectionForPayload(db, target.payload);
    }
  });
  transition.immediate(results);
}

interface ProjectSettingRebuildTarget {
  payload: Extract<
    SyncOperationPayload,
    { type: 'project_setting.set' | 'project_setting.delete' }
  >;
}

function collectProjectionRebuilds(
  db: Database,
  planTargets: Set<string>,
  targets: Map<string, ProjectSettingRebuildTarget>,
  row: SyncOperationQueueRow
): void {
  if (row.operation_type.startsWith('plan.')) {
    collectPlanProjectionRebuilds(db, planTargets, row);
    return;
  }
  collectProjectSettingProjectionRebuild(targets, row);
}

function collectProjectSettingProjectionRebuild(
  targets: Map<string, ProjectSettingRebuildTarget>,
  row: SyncOperationQueueRow
): void {
  if (
    row.operation_type !== 'project_setting.set' &&
    row.operation_type !== 'project_setting.delete'
  ) {
    return;
  }
  const payload = assertValidPayload(JSON.parse(row.payload));
  if (payload.type === 'project_setting.set' || payload.type === 'project_setting.delete') {
    const key = `${payload.projectUuid}:${payload.setting}`;
    targets.set(key, { payload });
  }
}

function collectPlanProjectionRebuilds(
  db: Database,
  targets: Set<string>,
  row: SyncOperationQueueRow
): void {
  const rolePlaceholders = [...PROJECTION_REBUILD_PLAN_REF_ROLES].map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
        SELECT DISTINCT plan_uuid
        FROM sync_operation_plan_ref
        WHERE operation_uuid = ?
          AND role IN (${rolePlaceholders})
        ORDER BY plan_uuid
      `
    )
    .all(row.operation_uuid, ...PROJECTION_REBUILD_PLAN_REF_ROLES) as Array<{ plan_uuid: string }>;
  for (const planRef of rows) {
    targets.add(planRef.plan_uuid);
  }

  const payload = assertValidPayload(JSON.parse(row.payload));
  if (payload.type === 'plan.delete') {
    for (const ownerPlanUuid of getInboundProjectionOwnerPlanUuids(db, payload.planUuid)) {
      targets.add(ownerPlanUuid);
    }
  }
}
