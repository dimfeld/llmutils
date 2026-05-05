import { randomUUID } from 'node:crypto';
import type { TimConfig } from '../configSchema.js';
import { getLocalNodeId } from './config.js';
import {
  assertValidEnvelope,
  deriveTargetKey,
  type SyncOperationEnvelope,
  type SyncOperationPayload,
  type SyncPlanAddTaskPayload,
  type SyncPlanCreatePayload,
  type SyncPlanCreateTask,
  type SyncPlanDeletePayload,
  type SyncPlanDependencyPayload,
  type SyncPlanListItemPayload,
  type SyncPlanListName,
  type SyncReviewIssueValue,
  type SyncPlanMarkTaskDonePayload,
  type SyncPlanPatchTextPayload,
  type SyncPlanPromoteTaskPayload,
  type SyncPlanRemoveTaskPayload,
  type SyncPlanSetParentPayload,
  type SyncPlanSetScalarPayload,
  type SyncPlanTagPayload,
  type SyncPlanUpdateTaskTextPayload,
  type SyncProjectSettingDeletePayload,
  type SyncProjectSettingSetPayload,
} from './types.js';

export interface SyncOperationConstructorOptions {
  config?: TimConfig;
  operationUuid?: string;
  originNodeId?: string;
  localSequence: number;
  createdAt?: string;
}

async function resolveOriginNodeId(options: SyncOperationConstructorOptions): Promise<string> {
  if (options.originNodeId) {
    return options.originNodeId;
  }
  if (!options.config) {
    throw new Error('config is required when originNodeId is not provided');
  }
  return getLocalNodeId(options.config);
}

async function buildEnvelope<T extends SyncOperationPayload>(
  projectUuid: string,
  op: T,
  options: SyncOperationConstructorOptions
): Promise<SyncOperationEnvelope & { op: T }> {
  const target = deriveTargetKey(op);
  const envelope = {
    operationUuid: options.operationUuid ?? randomUUID(),
    projectUuid,
    originNodeId: await resolveOriginNodeId(options),
    localSequence: options.localSequence,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...target,
    op,
  };
  return assertValidEnvelope(envelope) as SyncOperationEnvelope & { op: T };
}

function withTaskUuid(task: Omit<SyncPlanCreateTask, 'taskUuid'> & { taskUuid?: string }) {
  return {
    ...task,
    taskUuid: task.taskUuid ?? randomUUID(),
  };
}

/**
 * Plan creation embeds initial tasks so the main-node apply transaction can
 * create the plan and its initial task list atomically. Later task additions
 * use explicit `plan.add_task` operations.
 */
export async function createPlanOperation(
  input: Omit<SyncPlanCreatePayload, 'type' | 'tasks'> & {
    projectUuid: string;
    tasks?: Array<Omit<SyncPlanCreateTask, 'taskUuid'> & { taskUuid?: string }>;
  },
  options: SyncOperationConstructorOptions
) {
  const { projectUuid, tasks = [], ...rest } = input;
  return buildEnvelope(
    projectUuid,
    {
      type: 'plan.create',
      ...rest,
      tasks: tasks.map(withTaskUuid),
    },
    options
  );
}

export async function setPlanScalarOperation(
  projectUuid: string,
  input: Omit<SyncPlanSetScalarPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  // priority/status/epic are set-style scalar mutations. Parent changes are
  // deliberately modeled as `plan.set_parent` because they affect graph state.
  return buildEnvelope(projectUuid, { type: 'plan.set_scalar', ...input }, options);
}

export async function patchPlanTextOperation(
  projectUuid: string,
  input: Omit<SyncPlanPatchTextPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.patch_text', ...input }, options);
}

export async function addPlanTaskOperation(
  projectUuid: string,
  input: Omit<SyncPlanAddTaskPayload, 'type' | 'taskUuid'> & { taskUuid?: string },
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(
    projectUuid,
    {
      type: 'plan.add_task',
      ...input,
      taskUuid: input.taskUuid ?? randomUUID(),
    },
    options
  );
}

export async function updatePlanTaskTextOperation(
  projectUuid: string,
  input: Omit<SyncPlanUpdateTaskTextPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.update_task_text', ...input }, options);
}

export async function markPlanTaskDoneOperation(
  projectUuid: string,
  input: Omit<SyncPlanMarkTaskDonePayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.mark_task_done', ...input }, options);
}

export async function removePlanTaskOperation(
  projectUuid: string,
  input: Omit<SyncPlanRemoveTaskPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.remove_task', ...input }, options);
}

export async function addPlanDependencyOperation(
  projectUuid: string,
  input: Omit<Extract<SyncPlanDependencyPayload, { type: 'plan.add_dependency' }>, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.add_dependency', ...input }, options);
}

export async function removePlanDependencyOperation(
  projectUuid: string,
  input: Omit<Extract<SyncPlanDependencyPayload, { type: 'plan.remove_dependency' }>, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.remove_dependency', ...input }, options);
}

export async function addPlanTagOperation(
  projectUuid: string,
  input: Omit<Extract<SyncPlanTagPayload, { type: 'plan.add_tag' }>, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.add_tag', ...input }, options);
}

export async function removePlanTagOperation(
  projectUuid: string,
  input: Omit<Extract<SyncPlanTagPayload, { type: 'plan.remove_tag' }>, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.remove_tag', ...input }, options);
}

export async function addPlanListItemOperation(
  projectUuid: string,
  input: { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue },
  options: SyncOperationConstructorOptions
): Promise<SyncOperationEnvelope>;
export async function addPlanListItemOperation(
  projectUuid: string,
  input: {
    planUuid: string;
    list: Exclude<SyncPlanListName, 'reviewIssues'>;
    value: string;
  },
  options: SyncOperationConstructorOptions
): Promise<SyncOperationEnvelope>;
export async function addPlanListItemOperation(
  projectUuid: string,
  input: { planUuid: string; list: SyncPlanListName; value: unknown },
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(
    projectUuid,
    { type: 'plan.add_list_item', ...input } as SyncPlanListItemPayload,
    options
  );
}

export async function removePlanListItemOperation(
  projectUuid: string,
  input: { planUuid: string; list: 'reviewIssues'; value: SyncReviewIssueValue },
  options: SyncOperationConstructorOptions
): Promise<SyncOperationEnvelope>;
export async function removePlanListItemOperation(
  projectUuid: string,
  input: {
    planUuid: string;
    list: Exclude<SyncPlanListName, 'reviewIssues'>;
    value: string;
  },
  options: SyncOperationConstructorOptions
): Promise<SyncOperationEnvelope>;
export async function removePlanListItemOperation(
  projectUuid: string,
  input: { planUuid: string; list: SyncPlanListName; value: unknown },
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(
    projectUuid,
    { type: 'plan.remove_list_item', ...input } as SyncPlanListItemPayload,
    options
  );
}

export async function deletePlanOperation(
  projectUuid: string,
  input: Omit<SyncPlanDeletePayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.delete', ...input }, options);
}

export async function setProjectSettingOperation(
  input: Omit<SyncProjectSettingSetPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(input.projectUuid, { type: 'project_setting.set', ...input }, options);
}

export async function deleteProjectSettingOperation(
  input: Omit<SyncProjectSettingDeletePayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(input.projectUuid, { type: 'project_setting.delete', ...input }, options);
}

export async function setPlanParentOperation(
  projectUuid: string,
  input: Omit<SyncPlanSetParentPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  return buildEnvelope(projectUuid, { type: 'plan.set_parent', ...input }, options);
}

export async function promotePlanTaskOperation(
  projectUuid: string,
  input: Omit<SyncPlanPromoteTaskPayload, 'type'>,
  options: SyncOperationConstructorOptions
) {
  // TODO(Task 4): finalize any extra promotion metadata needed by the apply
  // engine once composite graph mutation semantics are implemented.
  return buildEnvelope(projectUuid, { type: 'plan.promote_task', ...input }, options);
}
