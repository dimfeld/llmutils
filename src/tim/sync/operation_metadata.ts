import { SyncOperationPayloadSchema, type SyncOperationPayload } from './types.js';

export type SyncOperationPlanRefRole =
  | 'target'
  | 'source'
  | 'new_plan'
  | 'parent'
  | 'new_parent'
  | 'previous_parent'
  | 'discovered_from'
  | 'depends_on'
  | 'dependency';

export interface SyncOperationPlanRef {
  planUuid: string;
  role: SyncOperationPlanRefRole;
}

export interface SyncOperationPayloadIndexes {
  payloadTaskUuid: string | null;
}

type SyncOperationType = SyncOperationPayload['type'];
type SyncOperationEntity = 'plan' | 'project_setting';
type BaseRevisionTargetKind = 'plan' | 'task' | 'source_plan' | null;

export const SYNC_OPERATION_METADATA = {
  'plan.create': { entity: 'plan', baseRevisionTarget: null },
  'plan.set_scalar': { entity: 'plan', baseRevisionTarget: 'plan' },
  'plan.patch_text': { entity: 'plan', baseRevisionTarget: 'plan' },
  'plan.add_task': { entity: 'plan', baseRevisionTarget: null },
  'plan.update_task_text': { entity: 'plan', baseRevisionTarget: 'task' },
  'plan.mark_task_done': { entity: 'plan', baseRevisionTarget: null },
  'plan.remove_task': { entity: 'plan', baseRevisionTarget: 'task' },
  'plan.add_dependency': { entity: 'plan', baseRevisionTarget: null },
  'plan.remove_dependency': { entity: 'plan', baseRevisionTarget: null },
  'plan.add_tag': { entity: 'plan', baseRevisionTarget: null },
  'plan.remove_tag': { entity: 'plan', baseRevisionTarget: null },
  'plan.add_list_item': { entity: 'plan', baseRevisionTarget: null },
  'plan.remove_list_item': { entity: 'plan', baseRevisionTarget: null },
  'plan.delete': { entity: 'plan', baseRevisionTarget: 'plan' },
  'plan.set_parent': { entity: 'plan', baseRevisionTarget: 'plan' },
  'plan.promote_task': { entity: 'plan', baseRevisionTarget: 'source_plan' },
  'project_setting.set': { entity: 'project_setting', baseRevisionTarget: null },
  'project_setting.delete': { entity: 'project_setting', baseRevisionTarget: null },
} as const satisfies Record<
  SyncOperationType,
  { entity: SyncOperationEntity; baseRevisionTarget: BaseRevisionTargetKind }
>;

export const PROJECTION_REBUILD_PLAN_REF_ROLES = new Set<SyncOperationPlanRefRole>([
  'target',
  'parent',
  'new_parent',
  'previous_parent',
  'source',
  'new_plan',
]);

export function parseSyncOperationPayload(
  payload: SyncOperationPayload | string
): SyncOperationPayload {
  return typeof payload === 'string'
    ? SyncOperationPayloadSchema.parse(JSON.parse(payload) as unknown)
    : payload;
}

export function isProjectSettingOperation(
  payload: SyncOperationPayload
): payload is Extract<
  SyncOperationPayload,
  { type: 'project_setting.set' | 'project_setting.delete' }
> {
  return SYNC_OPERATION_METADATA[payload.type].entity === 'project_setting';
}

export function isPlanOperation(
  payload: SyncOperationPayload
): payload is Exclude<
  SyncOperationPayload,
  Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>
> {
  return !isProjectSettingOperation(payload);
}

export function getSyncOperationPayloadIndexes(
  payload: SyncOperationPayload | string
): SyncOperationPayloadIndexes {
  const parsed = parseSyncOperationPayload(payload);
  return {
    payloadTaskUuid:
      'taskUuid' in parsed && typeof parsed.taskUuid === 'string' ? parsed.taskUuid : null,
  };
}

export function getSyncOperationPlanRefs(
  payload: SyncOperationPayload | string
): SyncOperationPlanRef[] {
  const parsed = parseSyncOperationPayload(payload);
  const refs: SyncOperationPlanRef[] = [];
  const addRef = (planUuid: string | null | undefined, role: SyncOperationPlanRefRole): void => {
    if (planUuid) {
      refs.push({ planUuid, role });
    }
  };

  switch (parsed.type) {
    case 'plan.create':
      addRef(parsed.planUuid, 'target');
      addRef(parsed.parentUuid, 'parent');
      addRef(parsed.discoveredFrom, 'discovered_from');
      for (const dependency of parsed.dependencies) {
        addRef(dependency, 'dependency');
      }
      break;
    case 'plan.patch_text':
    case 'plan.add_task':
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
    case 'plan.add_tag':
    case 'plan.remove_tag':
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
    case 'plan.delete':
      addRef(parsed.planUuid, 'target');
      break;
    case 'plan.set_scalar':
      addRef(parsed.planUuid, 'target');
      if (parsed.field === 'discovered_from' && typeof parsed.value === 'string') {
        addRef(parsed.value, 'discovered_from');
      }
      break;
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
      addRef(parsed.planUuid, 'target');
      addRef(parsed.dependsOnPlanUuid, 'depends_on');
      break;
    case 'plan.set_parent':
      addRef(parsed.planUuid, 'target');
      addRef(parsed.newParentUuid, 'new_parent');
      addRef(parsed.previousParentUuid, 'previous_parent');
      break;
    case 'plan.promote_task':
      addRef(parsed.newPlanUuid, 'target');
      addRef(parsed.sourcePlanUuid, 'source');
      addRef(parsed.newPlanUuid, 'new_plan');
      addRef(parsed.parentUuid, 'parent');
      for (const dependency of parsed.dependencies) {
        addRef(dependency, 'dependency');
      }
      break;
    case 'project_setting.set':
    case 'project_setting.delete':
      break;
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.planUuid}:${ref.role}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function getProjectionPlanRefUuids(payload: SyncOperationPayload | string): string[] {
  return getSyncOperationPlanRefs(payload)
    .filter((ref) => PROJECTION_REBUILD_PLAN_REF_ROLES.has(ref.role))
    .map((ref) => ref.planUuid);
}

export function getBaseRevisionPlanUuid(payload: SyncOperationPayload): string | null {
  if (!('baseRevision' in payload) || typeof payload.baseRevision !== 'number') {
    return null;
  }
  switch (SYNC_OPERATION_METADATA[payload.type].baseRevisionTarget) {
    case 'source_plan':
      return payload.type === 'plan.promote_task' ? payload.sourcePlanUuid : null;
    case 'plan':
      return 'planUuid' in payload ? payload.planUuid : null;
    default:
      return null;
  }
}

export function getBaseRevisionTaskUuid(payload: SyncOperationPayload): string | null {
  if (
    SYNC_OPERATION_METADATA[payload.type].baseRevisionTarget === 'task' &&
    'taskUuid' in payload &&
    'baseRevision' in payload &&
    typeof payload.baseRevision === 'number'
  ) {
    return payload.taskUuid;
  }
  return null;
}
