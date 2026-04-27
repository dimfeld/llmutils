import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { prioritySchema, statusSchema } from '../planSchema.js';
import {
  PROJECT_SETTING_NAME_PATTERN,
  planKey,
  projectKey,
  projectSettingKey,
  taskKey,
  SyncEntityTypeSchema,
  SyncUuidSchema,
} from './entity_keys.js';
import { SyncValidationError } from './errors.js';

/**
 * Sync operation conventions:
 * - `envelope.projectUuid` is the canonical project identity for every operation.
 * - Payload-level `projectUuid` exists only on `project_setting.*` operations and
 *   must match the envelope-level project UUID.
 * - Operation UUIDs are v4 UUIDs generated locally with `crypto.randomUUID()`.
 * - Entity UUIDs (project/plan/task) are v4 in current migrations, but schemas
 *   accept any well-formed UUID for forward compatibility with external IDs.
 */
export const SyncOperationUuidSchema = z.uuidv4();
export const SyncIsoTimestampSchema = z.string().datetime({ offset: true });
export const SyncRevisionSchema = z.number().int().nonnegative();
export const ProjectSettingNameSchema = z
  .string()
  .min(1)
  .regex(PROJECT_SETTING_NAME_PATTERN, 'setting must not contain whitespace or ":"');

const baseRevisionShape = {
  baseRevision: SyncRevisionSchema.optional(),
};

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ])
);

export const SyncPlanCreateTaskSchema = z.object({
  taskUuid: SyncUuidSchema,
  title: z.string().min(1),
  description: z.string().default(''),
  done: z.boolean().default(false),
});
export type SyncPlanCreateTask = z.infer<typeof SyncPlanCreateTaskSchema>;

export const SyncReviewIssueValueSchema = z.object({
  id: z.string().optional(),
  severity: z.enum(['critical', 'major', 'minor', 'info']),
  category: z.string().min(1),
  content: z.string().min(1),
  file: z.string().optional(),
  line: z.union([z.number(), z.string()]).optional(),
  suggestion: z.string().optional(),
  source: z.enum(['claude-code', 'codex-cli']).optional(),
});
export type SyncReviewIssueValue = z.infer<typeof SyncReviewIssueValueSchema>;

export const SyncPlanCreatePayloadSchema = z.object({
  type: z.literal('plan.create'),
  planUuid: SyncUuidSchema,
  numericPlanId: z.number().int().positive().optional(),
  title: z.string(),
  goal: z.string().optional(),
  details: z.string().optional(),
  note: z.string().optional(),
  status: statusSchema.optional(),
  priority: prioritySchema.optional(),
  branch: z.string().nullable().optional(),
  simple: z.boolean().nullable().optional(),
  tdd: z.boolean().nullable().optional(),
  discoveredFrom: z.number().int().positive().nullable().optional(),
  assignedTo: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  temp: z.boolean().nullable().optional(),
  planGeneratedAt: SyncIsoTimestampSchema.nullable().optional(),
  docsUpdatedAt: SyncIsoTimestampSchema.nullable().optional(),
  lessonsAppliedAt: SyncIsoTimestampSchema.nullable().optional(),
  epic: z.boolean().optional(),
  parentUuid: SyncUuidSchema.nullable().optional(),
  issue: z.array(z.string().url()).default([]),
  pullRequest: z.array(z.string().url()).default([]),
  docs: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
  reviewIssues: z.array(SyncReviewIssueValueSchema).default([]),
  tags: z.array(z.string().min(1)).default([]),
  dependencies: z.array(SyncUuidSchema).default([]),
  tasks: z.array(SyncPlanCreateTaskSchema).default([]),
});
export type SyncPlanCreatePayload = z.infer<typeof SyncPlanCreatePayloadSchema>;

export const SyncPlanSetScalarPayloadSchema = z
  .object({
    type: z.literal('plan.set_scalar'),
    planUuid: SyncUuidSchema,
    field: z.enum([
      'priority',
      'status',
      'epic',
      'branch',
      'simple',
      'tdd',
      'discovered_from',
      'assigned_to',
      'base_branch',
      'temp',
      'plan_generated_at',
      'docs_updated_at',
      'lessons_applied_at',
    ]),
    value: z.union([prioritySchema, statusSchema, z.string(), z.number(), z.boolean(), z.null()]),
    ...baseRevisionShape,
  })
  .superRefine((payload, ctx) => {
    if (
      payload.field === 'priority' &&
      !prioritySchema.nullable().safeParse(payload.value).success
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'priority value must be a priority or null',
      });
    }
    if (payload.field === 'status' && !statusSchema.safeParse(payload.value).success) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'status value must be a plan status',
      });
    }
    if (payload.field === 'epic' && typeof payload.value !== 'boolean') {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'epic value must be boolean',
      });
    }
  });
export type SyncPlanSetScalarPayload = z.infer<typeof SyncPlanSetScalarPayloadSchema>;

export const SyncPlanPatchTextPayloadSchema = z.object({
  type: z.literal('plan.patch_text'),
  planUuid: SyncUuidSchema,
  field: z.enum(['title', 'goal', 'note', 'details']),
  base: z.string(),
  new: z.string(),
  patch: z.string().optional(),
  ...baseRevisionShape,
});
export type SyncPlanPatchTextPayload = z.infer<typeof SyncPlanPatchTextPayloadSchema>;

export const SyncPlanAddTaskPayloadSchema = z.object({
  type: z.literal('plan.add_task'),
  planUuid: SyncUuidSchema,
  taskUuid: SyncUuidSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  taskIndex: z.number().int().nonnegative().optional(),
  done: z.boolean().optional(),
});
export type SyncPlanAddTaskPayload = z.infer<typeof SyncPlanAddTaskPayloadSchema>;

export const SyncPlanUpdateTaskTextPayloadSchema = z.object({
  type: z.literal('plan.update_task_text'),
  planUuid: SyncUuidSchema,
  taskUuid: SyncUuidSchema,
  field: z.enum(['title', 'description']),
  base: z.string(),
  new: z.string(),
  patch: z.string().optional(),
  ...baseRevisionShape,
});
export type SyncPlanUpdateTaskTextPayload = z.infer<typeof SyncPlanUpdateTaskTextPayloadSchema>;

export const SyncPlanMarkTaskDonePayloadSchema = z.object({
  type: z.literal('plan.mark_task_done'),
  planUuid: SyncUuidSchema,
  taskUuid: SyncUuidSchema,
  done: z.boolean(),
});
export type SyncPlanMarkTaskDonePayload = z.infer<typeof SyncPlanMarkTaskDonePayloadSchema>;

export const SyncPlanRemoveTaskPayloadSchema = z.object({
  type: z.literal('plan.remove_task'),
  planUuid: SyncUuidSchema,
  taskUuid: SyncUuidSchema,
  ...baseRevisionShape,
});
export type SyncPlanRemoveTaskPayload = z.infer<typeof SyncPlanRemoveTaskPayloadSchema>;

export const SyncPlanAddDependencyPayloadSchema = z.object({
  type: z.literal('plan.add_dependency'),
  planUuid: SyncUuidSchema,
  dependsOnPlanUuid: SyncUuidSchema,
});
export const SyncPlanRemoveDependencyPayloadSchema = z.object({
  type: z.literal('plan.remove_dependency'),
  planUuid: SyncUuidSchema,
  dependsOnPlanUuid: SyncUuidSchema,
});
export const SyncPlanDependencyPayloadSchema = z.discriminatedUnion('type', [
  SyncPlanAddDependencyPayloadSchema,
  SyncPlanRemoveDependencyPayloadSchema,
]);
export type SyncPlanDependencyPayload = z.infer<typeof SyncPlanDependencyPayloadSchema>;

export const SyncPlanAddTagPayloadSchema = z.object({
  type: z.literal('plan.add_tag'),
  planUuid: SyncUuidSchema,
  tag: z.string().min(1),
});
export const SyncPlanRemoveTagPayloadSchema = z.object({
  type: z.literal('plan.remove_tag'),
  planUuid: SyncUuidSchema,
  tag: z.string().min(1),
});
export const SyncPlanTagPayloadSchema = z.discriminatedUnion('type', [
  SyncPlanAddTagPayloadSchema,
  SyncPlanRemoveTagPayloadSchema,
]);
export type SyncPlanTagPayload = z.infer<typeof SyncPlanTagPayloadSchema>;

export const SyncPlanListNameSchema = z.enum([
  'issue',
  'pullRequest',
  'docs',
  'changedFiles',
  'reviewIssues',
]);
export type SyncPlanListName = z.infer<typeof SyncPlanListNameSchema>;

const ReviewIssuesPlanListValueShape = {
  planUuid: SyncUuidSchema,
  list: z.literal('reviewIssues'),
  value: SyncReviewIssueValueSchema,
};

const UrlPlanListValueShape = {
  planUuid: SyncUuidSchema,
  list: z.enum(['issue', 'pullRequest']),
  value: z.string().url(),
};

const StringPlanListValueShape = {
  planUuid: SyncUuidSchema,
  list: z.enum(['docs', 'changedFiles']),
  value: z.string().min(1),
};

export const SyncPlanAddListItemPayloadSchema = z.discriminatedUnion('list', [
  z.object({ type: z.literal('plan.add_list_item'), ...UrlPlanListValueShape }),
  z.object({ type: z.literal('plan.add_list_item'), ...StringPlanListValueShape }),
  z.object({ type: z.literal('plan.add_list_item'), ...ReviewIssuesPlanListValueShape }),
]);
export const SyncPlanRemoveListItemPayloadSchema = z.discriminatedUnion('list', [
  z.object({ type: z.literal('plan.remove_list_item'), ...UrlPlanListValueShape }),
  z.object({ type: z.literal('plan.remove_list_item'), ...StringPlanListValueShape }),
  z.object({ type: z.literal('plan.remove_list_item'), ...ReviewIssuesPlanListValueShape }),
]);
export const SyncPlanListItemPayloadSchema = z.discriminatedUnion('type', [
  SyncPlanAddListItemPayloadSchema,
  SyncPlanRemoveListItemPayloadSchema,
]);
export type SyncPlanListItemPayload = z.infer<typeof SyncPlanListItemPayloadSchema>;

export const SyncPlanDeletePayloadSchema = z.object({
  type: z.literal('plan.delete'),
  planUuid: SyncUuidSchema,
  ...baseRevisionShape,
});
export type SyncPlanDeletePayload = z.infer<typeof SyncPlanDeletePayloadSchema>;

export const SyncProjectSettingSetPayloadSchema = z.object({
  type: z.literal('project_setting.set'),
  projectUuid: SyncUuidSchema,
  setting: ProjectSettingNameSchema,
  value: JsonValueSchema,
  ...baseRevisionShape,
});
export type SyncProjectSettingSetPayload = z.infer<typeof SyncProjectSettingSetPayloadSchema>;

export const SyncProjectSettingDeletePayloadSchema = z.object({
  type: z.literal('project_setting.delete'),
  projectUuid: SyncUuidSchema,
  setting: ProjectSettingNameSchema,
  ...baseRevisionShape,
});
export type SyncProjectSettingDeletePayload = z.infer<typeof SyncProjectSettingDeletePayloadSchema>;

export const SyncPlanSetParentPayloadSchema = z.object({
  type: z.literal('plan.set_parent'),
  planUuid: SyncUuidSchema,
  newParentUuid: SyncUuidSchema.nullable(),
  previousParentUuid: SyncUuidSchema.nullable().optional(),
  ...baseRevisionShape,
});
export type SyncPlanSetParentPayload = z.infer<typeof SyncPlanSetParentPayloadSchema>;

export const SyncPlanPromoteTaskPayloadSchema = z.object({
  type: z.literal('plan.promote_task'),
  sourcePlanUuid: SyncUuidSchema,
  taskUuid: SyncUuidSchema,
  newPlanUuid: SyncUuidSchema,
  numericPlanId: z.number().int().positive().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  parentUuid: SyncUuidSchema.nullable().optional(),
  tags: z.array(z.string().min(1)).default([]),
  dependencies: z.array(SyncUuidSchema).default([]),
  // baseRevision refers to the source plan; the new plan is created and has no base revision.
  ...baseRevisionShape,
});
export type SyncPlanPromoteTaskPayload = z.infer<typeof SyncPlanPromoteTaskPayloadSchema>;

export const SyncOperationPayloadSchema = z.discriminatedUnion('type', [
  SyncPlanCreatePayloadSchema,
  SyncPlanSetScalarPayloadSchema,
  SyncPlanPatchTextPayloadSchema,
  SyncPlanAddTaskPayloadSchema,
  SyncPlanUpdateTaskTextPayloadSchema,
  SyncPlanMarkTaskDonePayloadSchema,
  SyncPlanRemoveTaskPayloadSchema,
  SyncPlanAddDependencyPayloadSchema,
  SyncPlanRemoveDependencyPayloadSchema,
  SyncPlanAddTagPayloadSchema,
  SyncPlanRemoveTagPayloadSchema,
  SyncPlanAddListItemPayloadSchema,
  SyncPlanRemoveListItemPayloadSchema,
  SyncPlanDeletePayloadSchema,
  SyncProjectSettingSetPayloadSchema,
  SyncProjectSettingDeletePayloadSchema,
  SyncPlanSetParentPayloadSchema,
  SyncPlanPromoteTaskPayloadSchema,
]);
export type SyncOperationPayload = z.infer<typeof SyncOperationPayloadSchema>;

export const SyncOperationTargetSchema = z.object({
  targetType: SyncEntityTypeSchema,
  targetKey: z.string().min(1),
});
export type SyncOperationTarget = z.infer<typeof SyncOperationTargetSchema>;

/**
 * Immutable sync operation envelope. `localSequence` is a per-origin-node FIFO
 * sequence allocated durably by the queue/apply layer; constructors only
 * validate that the caller supplied a non-negative integer.
 */
export const SyncOperationEnvelopeSchema = z
  .object({
    operationUuid: SyncOperationUuidSchema,
    projectUuid: SyncUuidSchema,
    originNodeId: z.string().min(1),
    localSequence: z.number().int().nonnegative(),
    createdAt: SyncIsoTimestampSchema,
    targetType: SyncEntityTypeSchema,
    targetKey: z.string().min(1),
    op: SyncOperationPayloadSchema,
  })
  .superRefine((envelope, ctx) => {
    let expectedTarget: SyncOperationTarget;
    try {
      expectedTarget = deriveTargetKey(envelope.op);
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        path: ['op'],
        message: err instanceof Error ? err.message : 'failed to derive operation target key',
      });
      return;
    }

    if (envelope.targetType !== expectedTarget.targetType) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetType'],
        message: `targetType must match operation target type ${expectedTarget.targetType}`,
      });
    }
    if (envelope.targetKey !== expectedTarget.targetKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetKey'],
        message: `targetKey must match operation target key ${expectedTarget.targetKey}`,
      });
    }
    if (
      (envelope.op.type === 'project_setting.set' ||
        envelope.op.type === 'project_setting.delete') &&
      envelope.projectUuid !== envelope.op.projectUuid
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['projectUuid'],
        message: 'envelope projectUuid must match project setting operation projectUuid',
      });
    }
  });
export type SyncOperationEnvelope = z.infer<typeof SyncOperationEnvelopeSchema>;

export const SyncOperationBatchEnvelopeSchema = z
  .object({
    batchId: SyncOperationUuidSchema,
    originNodeId: z.string().min(1),
    createdAt: SyncIsoTimestampSchema,
    operations: z.array(SyncOperationEnvelopeSchema).min(1),
    reason: z.string().min(1).optional(),
  })
  .superRefine((batch, ctx) => {
    const projectUuids = new Set<string>();
    const operationUuids = new Map<string, number>();
    let previousSequence: number | null = null;
    for (const [index, operation] of batch.operations.entries()) {
      projectUuids.add(operation.projectUuid);
      const firstIndex = operationUuids.get(operation.operationUuid);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'operationUuid'],
          message: `duplicate operationUuid also appears at operations.${firstIndex}.operationUuid`,
        });
      } else {
        operationUuids.set(operation.operationUuid, index);
      }
      if (operation.originNodeId !== batch.originNodeId) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'originNodeId'],
          message: 'operation originNodeId must match batch originNodeId',
        });
      }
      if (previousSequence !== null && operation.localSequence !== previousSequence + 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'localSequence'],
          message: 'operation localSequence values must be strictly contiguous and ascending',
        });
      }
      previousSequence = operation.localSequence;
    }
    if (projectUuids.size > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations'],
        message: 'all batch operations must target the same projectUuid',
      });
    }
  });
export type SyncOperationBatchEnvelope = z.infer<typeof SyncOperationBatchEnvelopeSchema>;

export const SyncOperationTypeSchema = z.enum([
  'plan.create',
  'plan.set_scalar',
  'plan.patch_text',
  'plan.add_task',
  'plan.update_task_text',
  'plan.mark_task_done',
  'plan.remove_task',
  'plan.add_dependency',
  'plan.remove_dependency',
  'plan.add_tag',
  'plan.remove_tag',
  'plan.add_list_item',
  'plan.remove_list_item',
  'plan.delete',
  'project_setting.set',
  'project_setting.delete',
  'plan.set_parent',
  'plan.promote_task',
]);
export type SyncOperationType = SyncOperationPayload['type'];

export function deriveTargetKey(op: SyncOperationPayload): SyncOperationTarget {
  switch (op.type) {
    case 'project_setting.set':
    case 'project_setting.delete':
      return {
        targetType: 'project_setting',
        targetKey: projectSettingKey(op.projectUuid, op.setting),
      };
    case 'plan.add_task':
    case 'plan.update_task_text':
    case 'plan.mark_task_done':
    case 'plan.remove_task':
      return { targetType: 'task', targetKey: taskKey(op.taskUuid) };
    case 'plan.create':
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
    case 'plan.add_tag':
    case 'plan.remove_tag':
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
    case 'plan.delete':
    case 'plan.set_parent':
      return { targetType: 'plan', targetKey: planKey(op.planUuid) };
    case 'plan.promote_task':
      return { targetType: 'plan', targetKey: planKey(op.newPlanUuid) };
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

/**
 * For project_setting.* operations only. Other operation types use the
 * envelope-level projectUuid as their canonical project identity.
 */
export function deriveProjectUuid(op: SyncOperationPayload): string {
  if (op.type === 'project_setting.set' || op.type === 'project_setting.delete') {
    return op.projectUuid;
  }
  throw new Error(
    `deriveProjectUuid only supports project_setting.* operations; use envelope.projectUuid for ${op.type}`
  );
}

export function assertValidEnvelope(value: unknown): SyncOperationEnvelope {
  const result = SyncOperationEnvelopeSchema.safeParse(value);
  if (!result.success) {
    const operationUuid =
      value && typeof value === 'object' && 'operationUuid' in value
        ? String((value as { operationUuid?: unknown }).operationUuid)
        : undefined;
    throw new SyncValidationError('Invalid sync operation envelope', {
      operationUuid,
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function assertValidBatchEnvelope(value: unknown): SyncOperationBatchEnvelope {
  const result = SyncOperationBatchEnvelopeSchema.safeParse(value);
  if (!result.success) {
    const batchId =
      value && typeof value === 'object' && 'batchId' in value
        ? String((value as { batchId?: unknown }).batchId)
        : undefined;
    throw new SyncValidationError('Invalid sync operation batch envelope', {
      operationUuid: batchId,
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function createBatchEnvelope(input: {
  batchId?: string;
  originNodeId: string;
  createdAt?: string;
  operations: SyncOperationEnvelope[];
  reason?: string;
}): SyncOperationBatchEnvelope {
  return assertValidBatchEnvelope({
    batchId: input.batchId ?? randomUUID(),
    originNodeId: input.originNodeId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    operations: input.operations,
    reason: input.reason,
  });
}

export function assertValidPayload(value: unknown): SyncOperationPayload {
  const result = SyncOperationPayloadSchema.safeParse(value);
  if (!result.success) {
    throw new SyncValidationError('Invalid sync operation payload', {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function projectOperationTarget(projectUuid: string): SyncOperationTarget {
  return { targetType: 'project', targetKey: projectKey(projectUuid) };
}
