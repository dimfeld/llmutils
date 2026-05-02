import type { Database } from 'bun:sqlite';
import { removeAssignment } from '../db/assignment.js';
import {
  deleteCanonicalProjectSettingRow,
  deleteProjectionProjectSettingRow,
  writeCanonicalProjectSettingRow,
  writeProjectionProjectSettingRow,
} from '../db/project_settings.js';
import { SyncFifoGapError, SyncValidationError } from './errors.js';
import { createSyncConflict } from './conflicts.js';
import {
  assertValidEnvelope,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
} from './types.js';
import type { ApplyOperationOptions, ApplyOperationResult } from './apply_types.js';
import { ApplyOperationToPreconditionError, applyOperationTo } from './operation_fold.js';
import { CanonicalPlanAdapter } from './canonical_plan_adapter.js';
import { createTextMergeConflict, currentBaseRevision } from './apply_conflicts.js';
import {
  ConflictAccepted,
  TERMINAL_OPERATION_STATUSES,
  conflictBaseValue,
  conflictFieldPath,
  conflictIncomingValue,
  conflictPatch,
  getOperationByOriginSequence,
  getOperationRow,
  getPlan,
  getTask,
  getTombstone,
  insertReceivedOperation,
  insertSequence,
  isRecoverableTombstonedOperation,
  markOperationApplied,
  markOperationConflict,
  rejectOperation,
  rejectedResult,
  resultFromRecordedOperation,
  targetExists,
  type Mutation,
  type ProjectRow,
  validationError,
} from './apply_shared.js';

const ASSIGNMENT_CLEANUP_STATUSES = new Set(['done', 'needs_review', 'cancelled']);

export function applyOperation(
  db: Database,
  envelopeInput: SyncOperationEnvelope,
  options: ApplyOperationOptions = {}
): ApplyOperationResult {
  // Synced ops are limited to tim-owned plan/project-setting state. PR caches,
  // webhooks, sessions, workspaces, locks, launch locks, assignments, materialized
  // shadow metadata, and git/source history are excluded; touching them here is a bug.
  const originalPayload = JSON.stringify((envelopeInput as { op: unknown }).op);
  const envelope = assertValidEnvelope(envelopeInput);
  const normalizedPayload = JSON.stringify(envelope.op);

  const apply = db.transaction(
    (nextEnvelope: SyncOperationEnvelope): ApplyOperationResult =>
      applyOperationInTransaction(db, nextEnvelope, originalPayload, normalizedPayload, options)
  );

  const priorRow = getOperationRow(db, envelope.operationUuid);
  const isReplay = !!priorRow && TERMINAL_OPERATION_STATUSES.has(priorRow.status);

  const result = apply.immediate(envelope);
  if (result.error) {
    throw result.error;
  }
  if (!isReplay && result.status === 'applied' && result.resolvedNumericPlanId !== undefined) {
    const op = envelope.op;
    const requested =
      op.type === 'plan.create' || op.type === 'plan.promote_task' ? op.numericPlanId : undefined;
    const newPlanUuid =
      op.type === 'plan.create'
        ? op.planUuid
        : op.type === 'plan.promote_task'
          ? op.newPlanUuid
          : undefined;
    if (requested !== undefined && newPlanUuid && requested !== result.resolvedNumericPlanId) {
      console.log(
        `[sync] ${op.type} renumbered ${newPlanUuid} from ${requested} to ${result.resolvedNumericPlanId}`
      );
    }
  }
  return result;
}

export function applyOperationInTransaction(
  db: Database,
  nextEnvelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions = {},
  batchId?: string,
  batchAtomic = false
): ApplyOperationResult {
  const existing = getOperationRow(db, nextEnvelope.operationUuid);
  if (existing && TERMINAL_OPERATION_STATUSES.has(existing.status)) {
    return resultFromRecordedOperation(db, existing);
  }

  if (!existing) {
    // Check for duplicate localSequence before inserting to avoid SQLiteError from the
    // UNIQUE(origin_node_id, local_sequence) constraint.
    const duplicateSeq = getOperationByOriginSequence(
      db,
      nextEnvelope.originNodeId,
      nextEnvelope.localSequence,
      nextEnvelope.operationUuid
    );
    if (duplicateSeq) {
      throw validationError(
        nextEnvelope,
        `localSequence ${nextEnvelope.localSequence} is already used by ${duplicateSeq.operation_uuid}`
      );
    }
    insertReceivedOperation(db, nextEnvelope, normalizedPayload, batchId, batchAtomic);
  }

  const project = db
    .prepare('SELECT id, uuid FROM project WHERE uuid = ?')
    .get(nextEnvelope.projectUuid) as ProjectRow | null;
  if (!project) {
    const error = validationError(nextEnvelope, `Unknown project ${nextEnvelope.projectUuid}`);
    rejectOperation(db, nextEnvelope.operationUuid, error.message);
    return rejectedResult(error);
  }

  const fifoError = checkFifo(db, nextEnvelope);
  if (fifoError) {
    return {
      status: 'deferred',
      sequenceIds: [],
      invalidations: [],
      acknowledged: false,
      error: fifoError,
    };
  }

  try {
    const selfTombstone = getTombstone(db, nextEnvelope.targetType, nextEnvelope.targetKey);
    // Task-scoped ops (anything carrying planUuid) must also honor the owning
    // plan's tombstone so a task add/edit against a deleted plan is captured
    // as a recoverable conflict instead of rejected with "Unknown plan".
    const ownerPlanUuid =
      'planUuid' in nextEnvelope.op &&
      nextEnvelope.targetType !== 'plan' &&
      typeof (nextEnvelope.op as { planUuid?: unknown }).planUuid === 'string'
        ? (nextEnvelope.op as { planUuid: string }).planUuid
        : null;
    const ownerTombstone = ownerPlanUuid ? getTombstone(db, 'plan', `plan:${ownerPlanUuid}`) : null;
    const tombstone = selfTombstone ?? ownerTombstone;
    if (tombstone && nextEnvelope.op.type !== 'plan.create' && !targetExists(db, nextEnvelope.op)) {
      if (nextEnvelope.op.type === 'plan.delete' || nextEnvelope.op.type === 'plan.remove_task') {
        markOperationApplied(db, nextEnvelope.operationUuid, [], []);
        return {
          status: 'applied',
          sequenceIds: [],
          invalidations: [],
          acknowledged: true,
        };
      }
      if (isRecoverableTombstonedOperation(nextEnvelope.op)) {
        const conflictId = createSyncConflict(db, {
          envelope: nextEnvelope,
          originalPayload,
          normalizedPayload,
          fieldPath: conflictFieldPath(nextEnvelope.op),
          baseValue: conflictBaseValue(nextEnvelope.op),
          incomingValue: conflictIncomingValue(nextEnvelope.op),
          attemptedPatch: conflictPatch(nextEnvelope.op),
          currentValue: null,
          reason: 'tombstoned_target',
        });
        markOperationConflict(db, nextEnvelope.operationUuid, conflictId);
        return {
          status: 'conflict',
          sequenceIds: [],
          invalidations: [],
          conflictId,
          acknowledged: true,
        };
      }
      const error = validationError(nextEnvelope, 'Operation targets a tombstoned entity');
      rejectOperation(db, nextEnvelope.operationUuid, error.message);
      return rejectedResult(error);
    }

    let mutations: Mutation[];
    try {
      mutations = applyPayload(
        db,
        project,
        nextEnvelope,
        originalPayload,
        normalizedPayload,
        options
      );
    } catch (error) {
      if (error instanceof ConflictAccepted) {
        return {
          status: 'conflict',
          sequenceIds: [],
          invalidations: [],
          conflictId: error.conflictId,
          acknowledged: true,
        };
      }
      throw error;
    }
    const sequenceIds = mutations.map(
      (mutation) => insertSequence(db, nextEnvelope, mutation).sequence
    );
    const invalidations = [...new Set(mutations.map((mutation) => mutation.targetKey))];
    const resolvedNumericPlanId = resolvedNumericPlanIdForOperation(db, nextEnvelope.op);
    markOperationApplied(db, nextEnvelope.operationUuid, sequenceIds, invalidations, {
      resolvedNumericPlanId,
    });
    return {
      status: 'applied',
      sequenceId: sequenceIds.at(-1),
      sequenceIds,
      invalidations,
      resolvedNumericPlanId,
      acknowledged: true,
    };
  } catch (error) {
    if (error instanceof SyncValidationError) {
      rejectOperation(db, nextEnvelope.operationUuid, error.message);
      return rejectedResult(error);
    }
    throw error;
  }
}

function checkFifo(db: Database, envelope: SyncOperationEnvelope): SyncFifoGapError | null {
  const duplicateSequence = getOperationByOriginSequence(
    db,
    envelope.originNodeId,
    envelope.localSequence,
    envelope.operationUuid
  );
  if (duplicateSequence) {
    throw validationError(
      envelope,
      `localSequence ${envelope.localSequence} is already used by ${duplicateSequence.operation_uuid}`
    );
  }

  const row = db
    .prepare(
      `
        SELECT MAX(local_sequence) AS max_sequence
        FROM sync_operation
        WHERE origin_node_id = ?
          AND status IN ('applied', 'conflict', 'rejected')
          AND operation_uuid <> ?
      `
    )
    .get(envelope.originNodeId, envelope.operationUuid) as { max_sequence: number | null };
  const maxSequence = row.max_sequence;
  if (maxSequence === null) {
    // Existing operation constructors/tests have historically started at either
    // 0 or 1. Once a terminal operation exists, the floor is strict max(seq)+1.
    if (envelope.localSequence <= 1) {
      return null;
    }
    return new SyncFifoGapError('Sync operation is waiting for earlier localSequence values', {
      operationUuid: envelope.operationUuid,
      originNodeId: envelope.originNodeId,
      localSequence: envelope.localSequence,
      expectedSequence: 1,
    });
  }
  const expected = maxSequence + 1;
  if (envelope.localSequence < expected) {
    throw validationError(
      envelope,
      `localSequence ${envelope.localSequence} is below next expected sequence ${expected}`
    );
  }
  if (envelope.localSequence > expected) {
    return new SyncFifoGapError('Sync operation is waiting for earlier localSequence values', {
      operationUuid: envelope.operationUuid,
      originNodeId: envelope.originNodeId,
      localSequence: envelope.localSequence,
      expectedSequence: expected,
    });
  }
  return null;
}

function applyPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  switch (op.type) {
    case 'plan.create':
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.add_task':
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
    case 'plan.add_tag':
    case 'plan.remove_tag':
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
    case 'plan.delete':
    case 'plan.set_parent':
    case 'plan.promote_task':
      return applyCanonicalPlanPayload(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload,
        options
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      return applyProjectSetting(
        db,
        project,
        { ...envelope, op },
        originalPayload,
        normalizedPayload
      );
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

function applyCanonicalPlanPayload(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  options: ApplyOperationOptions
): Mutation[] {
  const adapter = new CanonicalPlanAdapter(db, project, envelope);
  const priorStatus =
    envelope.op.type === 'plan.set_scalar' && envelope.op.field === 'status'
      ? adapter.getPlan(envelope.op.planUuid)?.status
      : null;
  try {
    const mutations = applyOperationTo(adapter, envelope, options);
    if (
      envelope.op.type === 'plan.set_scalar' &&
      envelope.op.field === 'status' &&
      typeof envelope.op.value === 'string' &&
      priorStatus !== envelope.op.value &&
      ASSIGNMENT_CLEANUP_STATUSES.has(envelope.op.value) &&
      options.cleanupAssignmentsOnStatusChange !== false
    ) {
      removeAssignment(db, project.id, envelope.op.planUuid);
    }
    adapter.flush();
    return [...mutations, ...adapter.extraMutations()];
  } catch (error) {
    if (error instanceof ApplyOperationToPreconditionError) {
      if (error.code === 'text_merge_failed') {
        const conflictId = createTextMergeConflict(
          db,
          adapter,
          envelope,
          originalPayload,
          normalizedPayload
        );
        markOperationConflict(db, envelope.operationUuid, conflictId);
        throw new ConflictAccepted(conflictId);
      }
      if (error.code === 'stale_revision') {
        const currentValue = currentBaseRevision(adapter, envelope.op);
        if (currentValue !== null) {
          const conflictId = createSyncConflict(db, {
            envelope,
            originalPayload,
            normalizedPayload,
            fieldPath: conflictFieldPath(envelope.op),
            baseValue:
              'baseRevision' in envelope.op && typeof envelope.op.baseRevision === 'number'
                ? envelope.op.baseRevision
                : null,
            incomingValue: conflictIncomingValue(envelope.op),
            attemptedPatch: conflictPatch(envelope.op),
            currentValue,
            reason: 'stale_revision',
          });
          markOperationConflict(db, envelope.operationUuid, conflictId);
          throw new ConflictAccepted(conflictId);
        }
      }
      throw validationError(envelope, error.message);
    }
    throw error;
  }
}

function applyProjectSetting(
  db: Database,
  project: ProjectRow,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'project_setting.set' | 'project_setting.delete' }>;
  },
  originalPayload: string,
  normalizedPayload: string
): Mutation[] {
  const row = db
    .prepare(
      'SELECT setting, value, revision FROM project_setting WHERE project_id = ? AND setting = ?'
    )
    .get(project.id, envelope.op.setting) as { value: string; revision: number } | null;
  if (envelope.op.type === 'project_setting.delete') {
    if (!row) {
      return [];
    }
    if (envelope.op.baseRevision !== undefined && envelope.op.baseRevision !== row.revision) {
      return staleSettingConflict(db, envelope, originalPayload, normalizedPayload, row.value);
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
  const nextValue = JSON.stringify(envelope.op.value);
  if (row && envelope.op.baseRevision !== undefined && envelope.op.baseRevision !== row.revision) {
    return staleSettingConflict(db, envelope, originalPayload, normalizedPayload, row.value);
  }
  if (row?.value === nextValue) {
    return [];
  }
  const nextRevision = (row?.revision ?? 0) + 1;
  writeCanonicalProjectSettingRow(db, project.id, envelope.op.setting, envelope.op.value, {
    revision: nextRevision,
    updatedByNode: envelope.originNodeId,
  });
  writeProjectionProjectSettingRow(db, project.id, envelope.op.setting, envelope.op.value, {
    updatedByNode: envelope.originNodeId,
  });
  return [
    { targetType: envelope.targetType, targetKey: envelope.targetKey, revision: nextRevision },
  ];
}

function staleSettingConflict(
  db: Database,
  envelope: SyncOperationEnvelope,
  originalPayload: string,
  normalizedPayload: string,
  currentValue: string
): never {
  const op = envelope.op as Extract<
    SyncOperationPayload,
    { type: 'project_setting.set' | 'project_setting.delete' }
  >;
  const conflictId = createSyncConflict(db, {
    envelope,
    originalPayload,
    normalizedPayload,
    fieldPath: op.setting,
    baseValue: op.baseRevision,
    incomingValue: op.type === 'project_setting.set' ? op.value : null,
    currentValue,
    reason: 'stale_revision',
  });
  markOperationConflict(db, envelope.operationUuid, conflictId);
  throw new ConflictAccepted(conflictId);
}

function resolvedNumericPlanIdForOperation(
  db: Database,
  op: SyncOperationPayload
): number | undefined {
  if (op.type === 'plan.create') {
    return getPlan(db, op.planUuid)?.plan_id;
  }
  if (op.type === 'plan.promote_task') {
    return getPlan(db, op.newPlanUuid)?.plan_id;
  }
  return undefined;
}
