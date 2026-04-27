import type { Database } from 'bun:sqlite';
import type { TimConfig } from '../configSchema.js';
import { getProjectById, getProjectByUuid } from '../db/project.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import type { PlanRow } from '../db/plan.js';
import { getPlanByUuid, getPlanTasksByUuid, insertPlanTask } from '../db/plan.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import {
  applyBatch,
  applyOperation,
  type ApplyBatchResult,
  type ApplyOperationOptions,
  type ApplyOperationResult,
} from './apply.js';
import { getLocalNodeId } from './config.js';
import { SyncUuidSchema } from './entity_keys.js';
import {
  SyncFifoGapError,
  SyncValidationError,
  SyncWriteConflictError,
  SyncWriteRejectedError,
} from './errors.js';
import {
  addPlanDependencyOperation,
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  promotePlanTaskOperation,
  removePlanTaskOperation,
  removePlanDependencyOperation,
  removePlanListItemOperation,
  removePlanTagOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
  type SyncOperationConstructorOptions,
} from './operations.js';
import {
  allocateLocalSequence,
  allocateLocalSequenceRange,
  enqueueBatch,
  enqueueOperation,
  type EnqueueBatchResult,
  type EnqueueOperationResult,
  type QueueableOperation,
} from './queue.js';
import type {
  SyncOperationBatchEnvelope,
  SyncOperationEnvelope,
  SyncPlanCreatePayload,
  SyncPlanCreateTask,
  SyncPlanListName,
  SyncReviewIssueValue,
} from './types.js';
import { createBatchEnvelope } from './types.js';
import { resolveWriteMode, type WriteMode } from './write_mode.js';

export type SyncWriteResult =
  | {
      mode: 'applied';
      operation: SyncOperationEnvelope;
      result: ApplyOperationResult & { status: 'applied' };
    }
  | {
      mode: 'conflict';
      operation: SyncOperationEnvelope;
      result: ApplyOperationResult & { status: 'conflict' };
    }
  | { mode: 'queued'; operation: SyncOperationEnvelope; result: EnqueueOperationResult }
  | { mode: 'legacy' };

export type SyncBatchWriteResult =
  | {
      mode: 'applied';
      batch: SyncOperationBatchEnvelope;
      result: ApplyBatchResult & { status: 'applied' };
    }
  | { mode: 'queued'; batch: SyncOperationBatchEnvelope; result: EnqueueBatchResult }
  | { mode: 'legacy' };

type OperationBuilder = (
  options: SyncOperationConstructorOptions
) => Promise<SyncOperationEnvelope>;

export interface RouteSyncOperationOptions {
  acceptConflict?: boolean;
  applyOptions?: ApplyOperationOptions;
}

export interface RouteSyncBatchOptions extends RouteSyncOperationOptions {
  reason?: string;
  precondition?: () => void;
}

function shouldQueueOperation(mode: WriteMode): boolean {
  return mode === 'sync-persistent';
}

function shouldUseLegacyLocalFallback(
  mode: WriteMode,
  ...entityIds: Array<string | null | undefined>
): boolean {
  return (
    mode === 'local-operation' &&
    entityIds.some((id) => id != null && !SyncUuidSchema.safeParse(id).success)
  );
}

function bumpLegacyPlan(db: Database, planUuid: string): void {
  db.prepare(
    `UPDATE plan SET revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(planUuid);
}

function legacySetPlanStatus(db: Database, planUuid: string, status: PlanRow['status']): void {
  db.prepare(
    `UPDATE plan SET status = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(status, planUuid);
}

function legacyAddTask(db: Database, input: Parameters<typeof addPlanTaskOperation>[1]): void {
  const taskIndex =
    input.taskIndex ??
    (
      db
        .prepare(
          'SELECT COALESCE(MAX(task_index), -1) + 1 AS next_index FROM plan_task WHERE plan_uuid = ?'
        )
        .get(input.planUuid) as { next_index: number }
    ).next_index;
  insertPlanTask(db, input.planUuid, {
    taskIndex,
    title: input.title,
    description: input.description ?? '',
    done: input.done ?? false,
    uuid: input.taskUuid,
  });
  bumpLegacyPlan(db, input.planUuid);
}

function legacyRemoveListItem(
  db: Database,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): void {
  const column =
    input.list === 'issue'
      ? 'issue'
      : input.list === 'pullRequest'
        ? 'pull_request'
        : input.list === 'docs'
          ? 'docs'
          : input.list === 'changedFiles'
            ? 'changed_files'
            : 'review_issues';
  const row = db
    .prepare(`SELECT ${column} AS value FROM plan WHERE uuid = ?`)
    .get(input.planUuid) as { value: string | null } | null;
  if (!row) {
    throw new Error(`Plan ${input.planUuid} not found`);
  }
  const current = row.value ? (JSON.parse(row.value) as unknown[]) : [];
  const removeValue = JSON.stringify(input.value);
  const next = current.filter((item) => JSON.stringify(item) !== removeValue);
  if (next.length === current.length) {
    return;
  }
  db.prepare(
    `UPDATE plan SET ${column} = ?, revision = revision + 1, updated_at = ${SQL_NOW_ISO_UTC} WHERE uuid = ?`
  ).run(next.length > 0 ? JSON.stringify(next) : null, input.planUuid);
}

export async function routeSyncOperation(
  db: Database,
  config: TimConfig,
  buildOperation: OperationBuilder,
  options: RouteSyncOperationOptions = {}
): Promise<SyncWriteResult> {
  const mode = resolveWriteMode(config);
  const originNodeId = await getLocalNodeId(config);

  if (shouldQueueOperation(mode)) {
    const operation = await buildOperation({ originNodeId, localSequence: 0 });
    const result = enqueueOperation(db, operation as QueueableOperation);
    return { mode: 'queued', operation: result.operation, result };
  }

  const operationTemplate = await buildOperation({ originNodeId, localSequence: 0 });
  let operation: SyncOperationEnvelope = operationTemplate;
  let result: ApplyOperationResult;
  const applyLocalOperation = db.transaction((): ApplyOperationResult => {
    const localSequence = allocateLocalSequence(db, originNodeId);
    operation = {
      ...operationTemplate,
      localSequence,
    };
    return applyOperation(db, operation, {
      ...options.applyOptions,
      localMainNodeId: originNodeId,
      preserveRequestedPlanIds: mode === 'local-operation',
      cleanupAssignmentsOnStatusChange: mode !== 'local-operation',
    });
  });
  try {
    result = applyLocalOperation.immediate();
  } catch (error) {
    if (error instanceof SyncValidationError || error instanceof SyncFifoGapError) {
      throw new SyncWriteRejectedError(error.message, {
        operationUuid: operation.operationUuid,
        targetKey: operation.targetKey,
        reason: error.message,
        cause: error,
      });
    }
    throw error;
  }
  if (result.status === 'applied') {
    return {
      mode: 'applied',
      operation,
      result: result as ApplyOperationResult & { status: 'applied' },
    };
  }
  if (result.status === 'conflict') {
    if (options.acceptConflict) {
      return {
        mode: 'conflict',
        operation,
        result: result as ApplyOperationResult & { status: 'conflict' },
      };
    }
    throw new SyncWriteConflictError(
      `Sync write for ${operation.targetKey} was accepted as an unresolved conflict`,
      {
        operationUuid: operation.operationUuid,
        targetKey: operation.targetKey,
        conflictId: result.conflictId,
      }
    );
  }
  if (result.status === 'rejected') {
    const reason = result.error?.message ?? `Sync write for ${operation.targetKey} was rejected`;
    throw new SyncWriteRejectedError(reason, {
      operationUuid: operation.operationUuid,
      targetKey: operation.targetKey,
      reason,
      cause: result.error,
    });
  }
  throw new SyncWriteRejectedError(
    `Sync write for ${operation.targetKey} was deferred unexpectedly`,
    {
      operationUuid: operation.operationUuid,
      targetKey: operation.targetKey,
      reason: result.error?.message ?? 'deferred',
      cause: result.error,
    }
  );
}

export async function routeSyncBatch(
  db: Database,
  config: TimConfig,
  input: {
    originNodeId?: string;
    reason?: string;
    operations: SyncOperationEnvelope[];
  },
  options: RouteSyncBatchOptions = {}
): Promise<SyncBatchWriteResult> {
  const mode = resolveWriteMode(config);
  return routeSyncBatchWithMode(db, config, mode, input, options);
}

async function routeSyncBatchWithMode(
  db: Database,
  config: TimConfig,
  mode: WriteMode,
  input: {
    originNodeId?: string;
    reason?: string;
    operations: SyncOperationEnvelope[];
  },
  options: RouteSyncBatchOptions = {}
): Promise<SyncBatchWriteResult> {
  if (input.operations.length === 0) {
    return { mode: 'legacy' };
  }
  const originNodeId = input.originNodeId ?? (await getLocalNodeId(config));

  if (shouldQueueOperation(mode)) {
    const batch = createBatchEnvelope({
      originNodeId,
      reason: input.reason ?? options.reason,
      operations: input.operations,
    });
    const result = enqueueBatch(db, batch, { precondition: options.precondition });
    return { mode: 'queued', batch: result.batch, result };
  }

  let batch: SyncOperationBatchEnvelope | null = null;
  let result: ApplyBatchResult;
  const applyLocalBatch = db.transaction((): ApplyBatchResult => {
    options.precondition?.();
    const localSequenceStart = allocateLocalSequenceRange(
      db,
      originNodeId,
      input.operations.length
    );
    const operations = input.operations.map((operation, index) => ({
      ...operation,
      originNodeId,
      localSequence: localSequenceStart + index,
    }));
    batch = createBatchEnvelope({
      originNodeId,
      reason: input.reason ?? options.reason,
      operations,
    });
    const applied = applyBatch(db, batch, {
      ...options.applyOptions,
      localMainNodeId: originNodeId,
      preserveRequestedPlanIds: mode === 'local-operation',
      cleanupAssignmentsOnStatusChange: mode !== 'local-operation',
    });
    if (applied.status !== 'applied') {
      throw new LocalBatchNotApplied(applied);
    }
    const conflict = applied.results.find(
      (item): item is ApplyOperationResult & { status: 'conflict' } => item.status === 'conflict'
    );
    if (conflict && !options.acceptConflict) {
      throw new LocalBatchConflict(conflict, applied.results.indexOf(conflict));
    }
    return applied;
  });
  try {
    result = applyLocalBatch.immediate();
  } catch (error) {
    if (error instanceof LocalBatchNotApplied) {
      result = error.result;
    } else if (error instanceof LocalBatchConflict) {
      const operation = batch!.operations[error.operationIndex];
      throw new SyncWriteConflictError(
        `Sync batch write for ${operation.targetKey} was accepted as an unresolved conflict`,
        {
          operationUuid: operation.operationUuid,
          targetKey: operation.targetKey,
          conflictId: error.result.conflictId,
        }
      );
    } else {
      throw error;
    }
  }
  if (result.status === 'applied') {
    return {
      mode: 'applied',
      batch: batch!,
      result: result as ApplyBatchResult & { status: 'applied' },
    };
  }
  const failedIndex = result.results.findIndex(
    (item) => item.status === 'rejected' || item.status === 'deferred'
  );
  const failedOperation = batch!.operations[Math.max(0, failedIndex)];
  const reason = result.error?.message ?? `Sync batch ${batch!.batchId} was ${result.status}`;
  throw new SyncWriteRejectedError(reason, {
    operationUuid: failedOperation.operationUuid,
    targetKey: failedOperation.targetKey,
    reason,
    cause: result.error,
  });
}

class LocalBatchNotApplied extends Error {
  constructor(readonly result: ApplyBatchResult) {
    super(`Sync batch ${result.batchId} was ${result.status}`);
    this.name = 'LocalBatchNotApplied';
  }
}

class LocalBatchConflict extends Error {
  constructor(
    readonly result: ApplyOperationResult & { status: 'conflict' },
    readonly operationIndex: number
  ) {
    super('Sync batch accepted an unresolved conflict');
    this.name = 'LocalBatchConflict';
  }
}

export async function beginSyncBatch(
  db: Database,
  config: TimConfig,
  options: RouteSyncBatchOptions = {}
) {
  const mode = resolveWriteMode(config);
  const originNodeId = await getLocalNodeId(config);
  const builders: OperationBuilder[] = [];
  return {
    add(builder: OperationBuilder): void {
      builders.push(builder);
    },
    async commit(): Promise<SyncBatchWriteResult> {
      const operations: SyncOperationEnvelope[] = [];
      for (const [index, builder] of builders.entries()) {
        operations.push(await builder({ originNodeId, localSequence: index }));
      }
      return routeSyncBatchWithMode(
        db,
        config,
        mode,
        { originNodeId, reason: options.reason, operations },
        options
      );
    },
  };
}

export type SyncBatchHandle = Awaited<ReturnType<typeof beginSyncBatch>>;

function requireProjectUuid(project: { uuid: string | null } | null, label: string): string {
  if (!project?.uuid) {
    throw new Error(`${label} does not have a sync UUID`);
  }
  return project.uuid;
}

export function getProjectUuidForId(db: Database, projectId: number): string {
  return requireProjectUuid(getProjectById(db, projectId), `Project ${projectId}`);
}

export function getProjectIdForUuid(db: Database, projectUuid: string): number {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    throw new Error(`Project ${projectUuid} not found`);
  }
  return project.id;
}

export async function writePlanCreate(
  db: Database,
  config: TimConfig,
  input: Omit<SyncPlanCreatePayload, 'type' | 'tasks'> & {
    projectUuid: string;
    tasks?: Array<Omit<SyncPlanCreateTask, 'taskUuid'> & { taskUuid?: string }>;
  }
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) => createPlanOperation(input, options));
}

export function addPlanCreateToBatch(
  batch: SyncBatchHandle,
  input: Omit<SyncPlanCreatePayload, 'type' | 'tasks'> & {
    projectUuid: string;
    tasks?: Array<Omit<SyncPlanCreateTask, 'taskUuid'> & { taskUuid?: string }>;
  }
): void {
  batch.add((options) => createPlanOperation(input, options));
}

export async function writePlanSetScalar(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof setPlanScalarOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    setPlanScalarOperation(projectUuid, input, options)
  );
}

export function addPlanSetScalarToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof setPlanScalarOperation>[1]
): void {
  batch.add((options) => setPlanScalarOperation(projectUuid, input, options));
}

export async function writePlanSetStatus(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  planUuid: string,
  status: PlanRow['status'],
  baseRevision?: number
): Promise<SyncWriteResult> {
  const mode = resolveWriteMode(config);
  if (shouldUseLegacyLocalFallback(mode, planUuid)) {
    // SYNC-EXEMPT: legacy local-only databases/tests may contain pre-sync non-UUID
    // plan IDs. Configured sync nodes still require operation-schema-valid UUIDs.
    legacySetPlanStatus(db, planUuid, status);
    return { mode: 'legacy' };
  }
  return writePlanSetScalar(db, config, projectUuid, {
    planUuid,
    field: 'status',
    value: status,
    baseRevision,
  });
}

export async function writePlanPatchText(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof patchPlanTextOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    patchPlanTextOperation(projectUuid, input, options)
  );
}

export function addPlanPatchTextToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof patchPlanTextOperation>[1]
): void {
  batch.add((options) => patchPlanTextOperation(projectUuid, input, options));
}

export async function writePlanPatchTextFromCurrent(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  planUuid: string,
  field: Parameters<typeof patchPlanTextOperation>[1]['field'],
  nextValue: string
): Promise<SyncWriteResult> {
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    throw new Error(`Plan ${planUuid} not found`);
  }
  const current = ((plan[field] ?? '') as string).toString();
  return writePlanPatchText(db, config, projectUuid, {
    planUuid,
    field,
    base: current,
    new: nextValue,
    baseRevision: plan.revision,
  });
}

export async function writePlanAddTask(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof addPlanTaskOperation>[1]
): Promise<SyncWriteResult> {
  const mode = resolveWriteMode(config);
  if (shouldUseLegacyLocalFallback(mode, input.planUuid, input.taskUuid)) {
    // SYNC-EXEMPT: legacy local-only databases/tests may contain pre-sync non-UUID
    // plan IDs. Configured sync nodes still require operation-schema-valid UUIDs.
    legacyAddTask(db, input);
    return { mode: 'legacy' };
  }
  return routeSyncOperation(db, config, (options) =>
    addPlanTaskOperation(projectUuid, input, options)
  );
}

export function addPlanAddTaskToBatch(
  batch: SyncBatchHandle,
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof addPlanTaskOperation>[1]
): SyncWriteResult | void {
  const mode = resolveWriteMode(config);
  if (shouldUseLegacyLocalFallback(mode, input.planUuid, input.taskUuid)) {
    // SYNC-EXEMPT: legacy local-only databases/tests may contain pre-sync non-UUID
    // plan IDs. Configured sync nodes still require operation-schema-valid UUIDs.
    legacyAddTask(db, input);
    return { mode: 'legacy' };
  }
  batch.add((options) => addPlanTaskOperation(projectUuid, input, options));
}

export async function writePlanUpdateTaskText(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof updatePlanTaskTextOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    updatePlanTaskTextOperation(projectUuid, input, options)
  );
}

export function addPlanUpdateTaskTextToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof updatePlanTaskTextOperation>[1]
): void {
  batch.add((options) => updatePlanTaskTextOperation(projectUuid, input, options));
}

export async function writePlanUpdateTaskTextFromCurrent(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  planUuid: string,
  taskUuid: string,
  field: Parameters<typeof updatePlanTaskTextOperation>[1]['field'],
  nextValue: string
): Promise<SyncWriteResult> {
  const task = getPlanTasksByUuid(db, planUuid).find((candidate) => candidate.uuid === taskUuid);
  if (!task) {
    throw new Error(`Task ${taskUuid} not found in plan ${planUuid}`);
  }
  const current = ((task[field] ?? '') as string).toString();
  return writePlanUpdateTaskText(db, config, projectUuid, {
    planUuid,
    taskUuid,
    field,
    base: current,
    new: nextValue,
    baseRevision: task.revision,
  });
}

export async function writePlanMarkTaskDone(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof markPlanTaskDoneOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    markPlanTaskDoneOperation(projectUuid, input, options)
  );
}

export function addPlanMarkTaskDoneToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof markPlanTaskDoneOperation>[1]
): void {
  batch.add((options) => markPlanTaskDoneOperation(projectUuid, input, options));
}

export async function writePlanRemoveTask(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof removePlanTaskOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    removePlanTaskOperation(projectUuid, input, options)
  );
}

export function addPlanRemoveTaskToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof removePlanTaskOperation>[1]
): void {
  batch.add((options) => removePlanTaskOperation(projectUuid, input, options));
}

export async function writePlanAddDependency(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof addPlanDependencyOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    addPlanDependencyOperation(projectUuid, input, options)
  );
}

export function addPlanAddDependencyToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof addPlanDependencyOperation>[1]
): void {
  batch.add((options) => addPlanDependencyOperation(projectUuid, input, options));
}

export async function writePlanRemoveDependency(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof removePlanDependencyOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    removePlanDependencyOperation(projectUuid, input, options)
  );
}

export function addPlanRemoveDependencyToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof removePlanDependencyOperation>[1]
): void {
  batch.add((options) => removePlanDependencyOperation(projectUuid, input, options));
}

export async function writePlanAddTag(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof addPlanTagOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    addPlanTagOperation(projectUuid, input, options)
  );
}

export function addPlanAddTagToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof addPlanTagOperation>[1]
): void {
  batch.add((options) => addPlanTagOperation(projectUuid, input, options));
}

export async function writePlanRemoveTag(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof removePlanTagOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    removePlanTagOperation(projectUuid, input, options)
  );
}

export function addPlanRemoveTagToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof removePlanTagOperation>[1]
): void {
  batch.add((options) => removePlanTagOperation(projectUuid, input, options));
}

export async function writePlanListAdd(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    addPlanListItemOperation(projectUuid, input as never, options)
  );
}

export function addPlanListAddToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): void {
  batch.add((options) => addPlanListItemOperation(projectUuid, input as never, options));
}

export async function writePlanListRemove(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): Promise<SyncWriteResult> {
  const mode = resolveWriteMode(config);
  if (shouldUseLegacyLocalFallback(mode, input.planUuid)) {
    // SYNC-EXEMPT: legacy local-only databases/tests may contain pre-sync non-UUID
    // plan IDs. Configured sync nodes still require operation-schema-valid UUIDs.
    legacyRemoveListItem(db, input);
    return { mode: 'legacy' };
  }
  return routeSyncOperation(db, config, (options) =>
    removePlanListItemOperation(projectUuid, input as never, options)
  );
}

export function addPlanListRemoveToBatch(
  batch: SyncBatchHandle,
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): SyncWriteResult | void {
  const mode = resolveWriteMode(config);
  if (shouldUseLegacyLocalFallback(mode, input.planUuid)) {
    // SYNC-EXEMPT: legacy local-only databases/tests may contain pre-sync non-UUID
    // plan IDs. Configured sync nodes still require operation-schema-valid UUIDs.
    legacyRemoveListItem(db, input);
    return { mode: 'legacy' };
  }
  batch.add((options) => removePlanListItemOperation(projectUuid, input as never, options));
}

export async function writePlanSetParent(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof setPlanParentOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    setPlanParentOperation(projectUuid, input, options)
  );
}

export function addPlanSetParentToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof setPlanParentOperation>[1]
): void {
  batch.add((options) => setPlanParentOperation(projectUuid, input, options));
}

export async function writePlanDelete(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof deletePlanOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    deletePlanOperation(projectUuid, input, options)
  );
}

export function addPlanDeleteToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Parameters<typeof deletePlanOperation>[1]
): void {
  batch.add((options) => deletePlanOperation(projectUuid, input, options));
}

export async function writePlanPromoteTask(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof promotePlanTaskOperation>[1]
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) =>
    promotePlanTaskOperation(projectUuid, input, options)
  );
}

export async function writeProjectSettingSet(
  db: Database,
  config: TimConfig,
  projectId: number,
  setting: string,
  value: unknown,
  baseRevision: number | 'latest'
): Promise<SyncWriteResult> {
  if (value === undefined) {
    throw new Error('Cannot set a project setting to undefined. Use writeProjectSettingDelete.');
  }
  const projectUuid = getProjectUuidForId(db, projectId);
  const metadata =
    baseRevision === 'latest' ? getProjectSettingWithMetadata(db, projectId, setting) : null;
  return routeSyncOperation(db, config, (options) =>
    setProjectSettingOperation(
      {
        projectUuid,
        setting,
        value,
        baseRevision: baseRevision === 'latest' ? metadata?.revision : baseRevision,
      },
      options
    )
  );
}

export async function writeProjectSettingDelete(
  db: Database,
  config: TimConfig,
  projectId: number,
  setting: string,
  baseRevision: number | 'latest'
): Promise<SyncWriteResult> {
  const projectUuid = getProjectUuidForId(db, projectId);
  const metadata =
    baseRevision === 'latest' ? getProjectSettingWithMetadata(db, projectId, setting) : null;
  return routeSyncOperation(db, config, (options) =>
    deleteProjectSettingOperation(
      {
        projectUuid,
        setting,
        baseRevision: baseRevision === 'latest' ? metadata?.revision : baseRevision,
      },
      options
    )
  );
}
