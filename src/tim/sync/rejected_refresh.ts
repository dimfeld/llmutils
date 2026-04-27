import type { Database } from 'bun:sqlite';
import { planKey, projectSettingKey, taskKey } from './entity_keys.js';
import { assertValidPayload, type SyncOperationPayload } from './types.js';
import type { SyncOperationResult } from './ws_protocol.js';

export function rejectedOperationSnapshotKeys(
  db: Database,
  results: SyncOperationResult[]
): string[] {
  const rejectedIds = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.operationId);
  if (rejectedIds.length === 0) {
    return [];
  }

  const keys = new Set<string>();
  for (const operationId of rejectedIds) {
    const row = db
      .prepare('SELECT payload FROM sync_operation WHERE operation_uuid = ?')
      .get(operationId) as { payload: string } | null;
    if (!row) {
      continue;
    }
    const op = assertValidPayload(JSON.parse(row.payload) as unknown);
    for (const key of optimisticSnapshotKeysForOperation(op)) {
      keys.add(key);
    }
  }
  return [...keys];
}

export function optimisticSnapshotKeysForOperation(op: SyncOperationPayload): string[] {
  switch (op.type) {
    case 'project_setting.set':
    case 'project_setting.delete':
      return [projectSettingKey(op.projectUuid, op.setting)];
    case 'plan.add_task':
      return [planKey(op.planUuid), taskKey(op.taskUuid)];
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
      return [planKey(op.planUuid)];
    case 'plan.promote_task':
      return [
        planKey(op.sourcePlanUuid),
        planKey(op.newPlanUuid),
        taskKey(op.taskUuid),
        ...(op.parentUuid ? [planKey(op.parentUuid)] : []),
      ];
    case 'plan.create':
      return [planKey(op.planUuid), ...(op.parentUuid ? [planKey(op.parentUuid)] : [])];
    case 'plan.set_parent':
      return [
        planKey(op.planUuid),
        ...(op.newParentUuid ? [planKey(op.newParentUuid)] : []),
        ...(op.previousParentUuid ? [planKey(op.previousParentUuid)] : []),
      ];
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
    case 'plan.add_tag':
    case 'plan.remove_tag':
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
    case 'plan.delete':
      return [planKey(op.planUuid)];
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}
