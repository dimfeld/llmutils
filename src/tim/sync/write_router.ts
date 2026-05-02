import type { Database } from 'bun:sqlite';
import type { TimConfig } from '../configSchema.js';
import { getProjectById, getProjectByUuid } from '../db/project.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import type { PlanRow } from '../db/plan.js';
import { getPlanByUuid, getPlanTasksByUuid } from '../db/plan.js';
import {
  applyBatch,
  applyOperation,
  type ApplyBatchResult,
  type ApplyOperationOptions,
  type ApplyOperationResult,
} from './apply.js';
import { getLocalNodeId } from './config.js';
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
  atomic?: boolean;
  precondition?: () => void;
}

function shouldQueueOperation(mode: WriteMode): boolean {
  return mode === 'sync-persistent';
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
    atomic?: boolean;
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
    atomic?: boolean;
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
      atomic: input.atomic ?? options.atomic,
      operations: input.operations,
    });
    const result = enqueueBatch(db, batch, { precondition: options.precondition });
    return { mode: 'queued', batch: result.batch, result };
  }

  options.precondition?.();
  const localSequenceStart = allocateLocalSequenceRange(db, originNodeId, input.operations.length);
  const operations = input.operations.map((operation, index) => ({
    ...operation,
    originNodeId,
    localSequence: localSequenceStart + index,
  }));
  const batch = createBatchEnvelope({
    originNodeId,
    reason: input.reason ?? options.reason,
    atomic: input.atomic ?? options.atomic,
    operations,
  });

  const result = applyBatch(db, batch, {
    ...options.applyOptions,
    localMainNodeId: originNodeId,
    preserveRequestedPlanIds: mode === 'local-operation',
    cleanupAssignmentsOnStatusChange: mode !== 'local-operation',
  });
  const conflict = result.results.find(
    (item): item is ApplyOperationResult & { status: 'conflict' } => item.status === 'conflict'
  );
  if (result.status === 'applied' && conflict && !batch.atomic && !options.acceptConflict) {
    const operation = batch.operations[result.results.indexOf(conflict)];
    throw new SyncWriteConflictError(
      `Sync batch write for ${operation.targetKey} was accepted as an unresolved conflict`,
      {
        operationUuid: operation.operationUuid,
        targetKey: operation.targetKey,
        conflictId: conflict.conflictId,
      }
    );
  }
  if (result.status === 'applied') {
    return {
      mode: 'applied',
      batch,
      result: result as ApplyBatchResult & { status: 'applied' },
    };
  }
  if (result.status === 'conflict') {
    const conflictIndex = result.results.findIndex((item) => item.status === 'conflict');
    const conflictOperation = batch.operations[Math.max(0, conflictIndex)];
    throw new SyncWriteConflictError(
      result.error?.message ?? `Sync batch write for ${conflictOperation.targetKey} conflicted`,
      {
        operationUuid: conflictOperation.operationUuid,
        targetKey: conflictOperation.targetKey,
        conflictId: result.results[conflictIndex]?.conflictId,
      }
    );
  }
  const failedIndex = result.results.findIndex(
    (item) => item.status === 'rejected' || item.status === 'deferred'
  );
  const failedOperation = batch.operations[Math.max(0, failedIndex)];
  const reason = result.error?.message ?? `Sync batch ${batch.batchId} was ${result.status}`;
  throw new SyncWriteRejectedError(reason, {
    operationUuid: failedOperation.operationUuid,
    targetKey: failedOperation.targetKey,
    reason,
    cause: result.error,
  });
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
    atomic: options.atomic === true,
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
        { originNodeId, reason: options.reason, atomic: options.atomic, operations },
        options
      );
    },
  };
}

export type SyncBatchHandle = Awaited<ReturnType<typeof beginSyncBatch>>;

export function getProjectUuidForId(db: Database, projectId: number): string {
  const project = getProjectById(db, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }
  return project.uuid;
}

export function getProjectIdForUuid(db: Database, projectUuid: string): number {
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    throw new Error(`Project ${projectUuid} not found`);
  }
  return project.id;
}

type ProjectOperationBuilder<Input> = (
  projectUuid: string,
  input: Input,
  options: SyncOperationConstructorOptions
) => Promise<SyncOperationEnvelope>;

function writeProjectOperation<Input>(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Input,
  build: ProjectOperationBuilder<Input>
): Promise<SyncWriteResult> {
  return routeSyncOperation(db, config, (options) => build(projectUuid, input, options));
}

function addProjectOperationToBatch<Input>(
  batch: SyncBatchHandle,
  projectUuid: string,
  input: Input,
  build: ProjectOperationBuilder<Input>
): void {
  batch.add((options) => build(projectUuid, input, options));
}

function defineProjectOperationRoutes<Input>(build: ProjectOperationBuilder<Input>) {
  return {
    write(
      db: Database,
      config: TimConfig,
      projectUuid: string,
      input: Input
    ): Promise<SyncWriteResult> {
      return writeProjectOperation(db, config, projectUuid, input, build);
    },
    addToBatch(batch: SyncBatchHandle, projectUuid: string, input: Input): void {
      addProjectOperationToBatch(batch, projectUuid, input, build);
    },
  };
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

const planSetScalarRoutes = defineProjectOperationRoutes(setPlanScalarOperation);
export const writePlanSetScalar = planSetScalarRoutes.write;
export const addPlanSetScalarToBatch = planSetScalarRoutes.addToBatch;

export async function writePlanSetStatus(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  planUuid: string,
  status: PlanRow['status'],
  baseRevision?: number
): Promise<SyncWriteResult> {
  return writePlanSetScalar(db, config, projectUuid, {
    planUuid,
    field: 'status',
    value: status,
    baseRevision,
  });
}

const planPatchTextRoutes = defineProjectOperationRoutes(patchPlanTextOperation);
export const writePlanPatchText = planPatchTextRoutes.write;
export const addPlanPatchTextToBatch = planPatchTextRoutes.addToBatch;

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
  const current = (plan[field] ?? '').toString();
  return writePlanPatchText(db, config, projectUuid, {
    planUuid,
    field,
    base: current,
    new: nextValue,
    baseRevision: plan.revision,
  });
}

const planAddTaskRoutes = defineProjectOperationRoutes(addPlanTaskOperation);
export const writePlanAddTask = planAddTaskRoutes.write;
export const addPlanAddTaskToBatch = planAddTaskRoutes.addToBatch;

const planUpdateTaskTextRoutes = defineProjectOperationRoutes(updatePlanTaskTextOperation);
export const writePlanUpdateTaskText = planUpdateTaskTextRoutes.write;
export const addPlanUpdateTaskTextToBatch = planUpdateTaskTextRoutes.addToBatch;

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
  const current = (task[field] ?? '').toString();
  return writePlanUpdateTaskText(db, config, projectUuid, {
    planUuid,
    taskUuid,
    field,
    base: current,
    new: nextValue,
    baseRevision: task.revision,
  });
}

const planMarkTaskDoneRoutes = defineProjectOperationRoutes(markPlanTaskDoneOperation);
export const writePlanMarkTaskDone = planMarkTaskDoneRoutes.write;
export const addPlanMarkTaskDoneToBatch = planMarkTaskDoneRoutes.addToBatch;

const planRemoveTaskRoutes = defineProjectOperationRoutes(removePlanTaskOperation);
export const writePlanRemoveTask = planRemoveTaskRoutes.write;
export const addPlanRemoveTaskToBatch = planRemoveTaskRoutes.addToBatch;

const planAddDependencyRoutes = defineProjectOperationRoutes(addPlanDependencyOperation);
export const writePlanAddDependency = planAddDependencyRoutes.write;
export const addPlanAddDependencyToBatch = planAddDependencyRoutes.addToBatch;

const planRemoveDependencyRoutes = defineProjectOperationRoutes(removePlanDependencyOperation);
export const writePlanRemoveDependency = planRemoveDependencyRoutes.write;
export const addPlanRemoveDependencyToBatch = planRemoveDependencyRoutes.addToBatch;

const planAddTagRoutes = defineProjectOperationRoutes(addPlanTagOperation);
export const writePlanAddTag = planAddTagRoutes.write;
export const addPlanAddTagToBatch = planAddTagRoutes.addToBatch;

const planRemoveTagRoutes = defineProjectOperationRoutes(removePlanTagOperation);
export const writePlanRemoveTag = planRemoveTagRoutes.write;
export const addPlanRemoveTagToBatch = planRemoveTagRoutes.addToBatch;

export async function writePlanListAdd(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): Promise<SyncWriteResult> {
  return writeProjectOperation(db, config, projectUuid, input as never, addPlanListItemOperation);
}

export function addPlanListAddToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): void {
  addProjectOperationToBatch(batch, projectUuid, input as never, addPlanListItemOperation);
}

export async function writePlanListRemove(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): Promise<SyncWriteResult> {
  return writeProjectOperation(
    db,
    config,
    projectUuid,
    input as never,
    removePlanListItemOperation
  );
}

export function addPlanListRemoveToBatch(
  batch: SyncBatchHandle,
  projectUuid: string,
  input:
    | { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue }
    | { planUuid: string; list: Exclude<SyncPlanListName, 'reviewIssues'>; value: string }
): void {
  addProjectOperationToBatch(batch, projectUuid, input as never, removePlanListItemOperation);
}

const planSetParentRoutes = defineProjectOperationRoutes(setPlanParentOperation);
export const writePlanSetParent = planSetParentRoutes.write;
export const addPlanSetParentToBatch = planSetParentRoutes.addToBatch;

const planDeleteRoutes = defineProjectOperationRoutes(deletePlanOperation);
export const writePlanDelete = planDeleteRoutes.write;
export const addPlanDeleteToBatch = planDeleteRoutes.addToBatch;

export async function writePlanPromoteTask(
  db: Database,
  config: TimConfig,
  projectUuid: string,
  input: Parameters<typeof promotePlanTaskOperation>[1]
): Promise<SyncWriteResult> {
  return writeProjectOperation(db, config, projectUuid, input, promotePlanTaskOperation);
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
