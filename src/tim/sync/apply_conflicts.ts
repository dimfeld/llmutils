import type { Database } from 'bun:sqlite';
import {
  deleteCanonicalProjectSettingRow,
  deleteProjectionProjectSettingRow,
  writeCanonicalProjectSettingRow,
  writeProjectionProjectSettingRow,
} from '../db/project_settings.js';
import { createSyncConflict } from './conflicts.js';
import {
  assertValidPayload,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
} from './types.js';
import type { ResolveSyncConflictOptions, ResolveSyncConflictResult } from './apply_types.js';
import {
  applyOperationTo,
  PLAN_TEXT_COLUMNS,
  requireAdapterPlan,
  requireAdapterTask,
  TASK_TEXT_COLUMNS,
  type ApplyOperationToAdapter,
} from './operation_fold.js';
import { CanonicalPlanAdapter } from './canonical_plan_adapter.js';
import {
  conflictBaseValue,
  conflictFieldPath,
  conflictIncomingValue,
  conflictPatch,
  insertSequence,
  markConflictResolved,
  type Mutation,
  type ProjectRow,
  validationError,
} from './apply_shared.js';

export function resolveSyncConflict(
  db: Database,
  conflictId: string,
  options: ResolveSyncConflictOptions
): ResolveSyncConflictResult {
  const resolve = db.transaction(
    (
      nextConflictId: string,
      nextOptions: ResolveSyncConflictOptions
    ): ResolveSyncConflictResult => {
      const conflict = db
        .prepare('SELECT * FROM sync_conflict WHERE conflict_id = ?')
        .get(nextConflictId) as {
        conflict_id: string;
        operation_uuid: string;
        project_uuid: string;
        target_type: string;
        target_key: string;
        normalized_payload: string;
        reason: string;
        status: string;
      } | null;
      if (!conflict) {
        throw new Error(`Unknown sync conflict ${nextConflictId}`);
      }
      if (conflict.status !== 'open') {
        throw new Error(`Sync conflict ${nextConflictId} is already resolved`);
      }

      if (nextOptions.mode === 'apply-current') {
        markConflictResolved(db, nextConflictId, 'resolved_discarded', nextOptions);
        return {
          conflictId: nextConflictId,
          status: 'resolved_discarded',
          sequenceIds: [],
          invalidations: [],
        };
      }

      const op = assertValidPayload(JSON.parse(conflict.normalized_payload));
      const project = db
        .prepare('SELECT id, uuid FROM project WHERE uuid = ?')
        .get(conflict.project_uuid) as ProjectRow | null;
      if (!project) {
        throw new Error(`Unknown project ${conflict.project_uuid}`);
      }
      const envelope = {
        operationUuid: conflict.operation_uuid,
        projectUuid: conflict.project_uuid,
        originNodeId: `resolver:${nextOptions.resolvedByNode}`,
        localSequence: 0,
        createdAt: new Date().toISOString(),
        targetType: conflict.target_type,
        targetKey: conflict.target_key,
        op,
      } as SyncOperationEnvelope;

      const mutations = applyConflictResolutionPayload(
        db,
        project,
        envelope,
        nextOptions,
        conflict.reason
      );
      const sequenceIds = mutations.map(
        (mutation) => insertSequence(db, envelope, mutation).sequence
      );
      const invalidations = [...new Set(mutations.map((mutation) => mutation.targetKey))];
      markConflictResolved(db, nextConflictId, 'resolved_applied', nextOptions);
      return {
        conflictId: nextConflictId,
        status: 'resolved_applied',
        sequenceIds,
        invalidations,
      };
    }
  );

  return resolve.immediate(conflictId, options);
}

function applyConflictResolutionPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  options: ResolveSyncConflictOptions,
  conflictReason: string
): Mutation[] {
  // Conflict resolution is a new local decision on the main node. It
  // intentionally uses wall-clock updated_at values and does not accept
  // ApplyOperationOptions/source timestamps from the original operation.
  if (conflictReason === 'tombstoned_target') {
    throw new Error(
      'Tombstoned-target conflicts can only be resolved with --apply-current (discard); the target plan or task no longer exists. To recover the deleted entity, recreate it first via the appropriate command.'
    );
  }
  const op = envelope.op;
  switch (op.type) {
    case 'plan.patch_text':
      return applyResolvedPlanTextWithCanonicalAdapter(
        db,
        project,
        { ...envelope, op },
        resolvedTextValue(op.new, options)
      );
    case 'plan.update_task_text':
      return applyResolvedTaskTextWithCanonicalAdapter(
        db,
        project,
        { ...envelope, op },
        resolvedTextValue(op.new, options)
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      return applyResolvedProjectSetting(db, project, { ...envelope, op }, options);
    case 'plan.add_task':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.mark_task_done':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.add_tag':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    case 'plan.add_list_item':
      rejectManualResolution(options, op.type);
      return applyResolvedPlanOperationWithCanonicalAdapter(db, project, { ...envelope, op });
    default:
      throw new Error(`Sync conflict resolution does not support ${op.type}`);
  }
}

function rejectManualResolution(options: ResolveSyncConflictOptions, operationType: string): void {
  if (options.mode === 'manual') {
    throw new Error(
      `--manual is not compatible with ${operationType}; use --apply-incoming or --apply-current`
    );
  }
}

function resolvedTextValue(incomingValue: string, options: ResolveSyncConflictOptions): string {
  if (options.mode === 'apply-incoming') {
    return incomingValue;
  }
  if (typeof options.manualValue !== 'string') {
    throw new Error('--manual must be a JSON string for text conflict resolution');
  }
  return options.manualValue;
}

function applyResolvedPlanTextWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  value: string
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  if (current === value) {
    return [];
  }
  const mutations = applyOperationTo(adapter, {
    ...envelope,
    op: {
      ...envelope.op,
      base: current,
      new: value,
      patch: undefined,
      baseRevision: plan.revision,
    },
  });
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
}

function applyResolvedTaskTextWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  value: string
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  const current = task[column] ?? '';
  if (current === value) {
    return [];
  }
  const mutations = applyOperationTo(adapter, {
    ...envelope,
    op: {
      ...envelope.op,
      base: current,
      new: value,
      patch: undefined,
      baseRevision: plan.revision,
    },
  });
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
}

function applyResolvedPlanOperationWithCanonicalAdapter(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const mutations = applyOperationTo(adapter, envelope);
  adapter.flush();
  return [...mutations, ...adapter.extraMutations()];
}

function applyResolvedProjectSetting(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>;
  },
  options: ResolveSyncConflictOptions
): Mutation[] {
  const row = db
    .prepare(
      'SELECT setting, value, revision FROM project_setting WHERE project_id = ? AND setting = ?'
    )
    .get(project.id, envelope.op.setting) as { value: string; revision: number } | null;

  if (options.mode === 'manual' && envelope.op.type === 'project_setting.delete') {
    throw new Error(
      'manual value is not compatible with delete operations; use --apply-incoming or --apply-current'
    );
  }

  if (options.mode === 'apply-incoming' && envelope.op.type === 'project_setting.delete') {
    if (!row) {
      return [];
    }
    deleteCanonicalProjectSettingRow(db, project.id, envelope.op.setting);
    deleteProjectionProjectSettingRow(db, project.id, envelope.op.setting);
    return [
      {
        targetType: envelope.targetType,
        targetKey: envelope.targetKey,
        revision: row.revision + 1,
      },
    ];
  }

  const value =
    options.mode === 'manual'
      ? options.manualValue
      : envelope.op.type === 'project_setting.set'
        ? envelope.op.value
        : null;
  if (value === undefined) {
    throw new Error('--manual must be valid JSON for project setting conflict resolution');
  }
  const nextValue = JSON.stringify(value);
  if (row?.value === nextValue) {
    return [];
  }
  const nextRevision = (row?.revision ?? 0) + 1;
  writeCanonicalProjectSettingRow(db, project.id, envelope.op.setting, value, {
    revision: nextRevision,
    updatedByNode: envelope.originNodeId,
  });
  writeProjectionProjectSettingRow(db, project.id, envelope.op.setting, value, {
    updatedByNode: envelope.originNodeId,
  });
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: nextRevision },
  ];
}

export function createTextMergeConflict(
  db: Database,
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string
): string {
  const op = envelope.op;
  if (op.type === 'plan.patch_text') {
    const plan = adapter.getPlan(op.planUuid);
    const column = PLAN_TEXT_COLUMNS[op.field];
    return createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: op.field,
      baseValue: op.base,
      incomingValue: op.new,
      attemptedPatch: op.patch ?? null,
      currentValue: plan ? ((plan[column] ?? '') as string).toString() : null,
      reason: 'text_merge_failed',
    });
  }
  if (op.type === 'plan.update_task_text') {
    const task = adapter.getTasks(op.planUuid).find((item) => item.uuid === op.taskUuid);
    const column = TASK_TEXT_COLUMNS[op.field];
    return createSyncConflict(db, {
      envelope,
      originalPayload,
      normalizedPayload,
      fieldPath: op.field,
      baseValue: op.base,
      incomingValue: op.new,
      attemptedPatch: op.patch ?? null,
      currentValue: task ? (task[column] ?? '') : null,
      reason: 'text_merge_failed',
    });
  }
  throw validationError(envelope, 'text merge failed');
}

export function currentBaseRevision(
  adapter: ApplyOperationToAdapter,
  op: SyncOperationPayload
): number | null {
  switch (op.type) {
    case 'plan.update_task_text':
    case 'plan.remove_task':
      return (
        adapter.getTasks(op.planUuid).find((task) => task.uuid === op.taskUuid)?.revision ?? null
      );
    case 'plan.promote_task':
      return adapter.getPlan(op.sourcePlanUuid)?.revision ?? null;
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.delete':
    case 'plan.set_parent':
      return adapter.getPlan(op.planUuid)?.revision ?? null;
    default:
      return null;
  }
}
