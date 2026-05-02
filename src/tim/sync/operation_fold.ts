import type { PlanDependencyRow, PlanRow, PlanTagRow, PlanTaskRow } from '../db/plan.js';
import * as diff from 'diff';
import type { SyncOperationEnvelope, SyncOperationPayload } from './types.js';
import type { ApplyOperationOptions } from './apply_types.js';

type ProjectRow = { id: number; uuid: string };

type Mutation = {
  targetType: string;
  targetKey: string;
  revision: number | null;
};

const PLAN_TEXT_COLUMNS = {
  title: 'title',
  goal: 'goal',
  note: 'note',
  details: 'details',
} as const;
const TASK_TEXT_COLUMNS = {
  title: 'title',
  description: 'description',
} as const;
const LIST_COLUMNS = {
  issue: 'issue',
  pullRequest: 'pull_request',
  docs: 'docs',
  changedFiles: 'changed_files',
  reviewIssues: 'review_issues',
} as const;

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function mergeText(current: string, base: string, incoming: string): string | null {
  // Contract: no-op patches keep the current value, clean patches from base to
  // incoming are applied to current, and failed patch application means conflict.
  if (base === incoming) {
    return current;
  }
  if (current === incoming) {
    return current;
  }
  if (current === base) {
    return incoming;
  }
  const patch = diff.createPatch('field', base, incoming, '', '', { context: 3 });
  const merged = diff.applyPatch(current, patch, { fuzzFactor: 0 });
  return merged === false ? null : merged;
}

function parseJsonArray(value: string | null): unknown[] {
  if (!value) {
    return [];
  }
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

export type ApplyOperationToPlan = PlanRow;
export type ApplyOperationToTask = Omit<PlanTaskRow, 'id'> & { id?: number };

export interface ApplyOperationToAdapter {
  readonly project: ProjectRow;
  readonly skipPreconditionFailures?: boolean;
  readonly baseRevisionMode?: 'strict' | 'projection';
  getPlan(planUuid: string): ApplyOperationToPlan | null;
  getPlanForCreateDuplicateCheck?(planUuid: string): ApplyOperationToPlan | null;
  getTaskByUuid(taskUuid: string): ApplyOperationToTask | null;
  setPlan(plan: ApplyOperationToPlan): void;
  deletePlan(planUuid: string): void;
  getTasks(planUuid: string): ApplyOperationToTask[];
  setTasks(planUuid: string, tasks: ApplyOperationToTask[]): void;
  getDependencies(planUuid: string): PlanDependencyRow[];
  setDependencies(planUuid: string, dependencies: PlanDependencyRow[]): void;
  getTags(planUuid: string): PlanTagRow[];
  setTags(planUuid: string, tags: PlanTagRow[]): void;
  resolveLocalPlanId(planUuid: string | null | undefined): number | null;
  resolvePlanCreateNumericPlanId(
    requestedPlanId: number | undefined,
    preserveRequestedPlanIds?: boolean
  ): number;
  onPlanDeleted?(planUuid: string): void;
  onTaskDeleted?(taskUuid: string, revision: number): void;
}

export class ApplyOperationToPreconditionError extends Error {}

export function applyOperationToPrecondition(message: string): never {
  throw new ApplyOperationToPreconditionError(message);
}

/**
 * Adapter-based operation fold used by both canonical apply and projection
 * rebuilds. Canonical apply uses strict CAS against the entity revision.
 * Projection replay uses field-aware stale checks: future revisions are skipped,
 * equal revisions apply normally, and stale revisions apply only when the op's
 * target field/sub-entity still matches the pre-state recorded in the payload.
 * This preserves unrelated pending edits over newer canonical snapshots without
 * letting stale same-field writes overwrite canonical state.
 */
export function applyOperationTo(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  options: ApplyOperationOptions = {}
): Mutation[] {
  try {
    return applyOperationToUnchecked(adapter, envelope, options);
  } catch (error) {
    if (adapter.skipPreconditionFailures && error instanceof ApplyOperationToPreconditionError) {
      return [];
    }
    throw error;
  }
}

function applyOperationToUnchecked(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope,
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  if ('baseRevision' in op && typeof op.baseRevision === 'number') {
    const baseTarget = getBaseRevisionTarget(adapter, op);
    if (baseTarget) {
      const baselineRevision =
        adapter.baseRevisionMode !== 'projection' && baseTarget.exists
          ? getAtomicBatchBaselineRevision(options, op, baseTarget)
          : baseTarget.revision;
      const isStale =
        adapter.baseRevisionMode === 'projection'
          ? shouldSkipProjectionBaseRevision(adapter, op, baseTarget)
          : !baseTarget.exists || baselineRevision !== op.baseRevision;
      if (isStale) {
        applyOperationToPrecondition(`Stale base revision for plan ${baseTarget.planUuid}`);
      }
    }
  }
  validateAdapterPlanOperation(adapter, envelope);

  switch (op.type) {
    case 'plan.create':
      return applyOperationToPlanCreate(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.create' }>;
        },
        options
      );
    case 'plan.set_scalar':
      return applyOperationToPlanScalar(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>;
        },
        options
      );
    case 'plan.patch_text':
      return applyOperationToPlanText(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
        },
        options
      );
    case 'plan.add_task':
      return applyOperationToAddTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.add_task' }>;
        },
        options
      );
    case 'plan.update_task_text':
      return applyOperationToTaskText(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
        },
        options
      );
    case 'plan.mark_task_done':
      return applyOperationToMarkTaskDone(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.mark_task_done' }>;
        },
        options
      );
    case 'plan.remove_task':
      return applyOperationToRemoveTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.remove_task' }>;
        },
        options
      );
    case 'plan.add_dependency':
    case 'plan.remove_dependency':
      return applyOperationToDependency(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<
            SyncOperationPayload,
            { type: 'plan.add_dependency' | 'plan.remove_dependency' }
          >;
        },
        options
      );
    case 'plan.add_tag':
    case 'plan.remove_tag':
      return applyOperationToTag(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.add_tag' | 'plan.remove_tag' }>;
        },
        options
      );
    case 'plan.add_list_item':
    case 'plan.remove_list_item':
      return applyOperationToListItem(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<
            SyncOperationPayload,
            { type: 'plan.add_list_item' | 'plan.remove_list_item' }
          >;
        },
        options
      );
    case 'plan.delete':
      return applyOperationToPlanDelete(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.delete' }>;
        }
      );
    case 'plan.set_parent':
      return applyOperationToSetParent(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>;
        },
        options
      );
    case 'plan.promote_task':
      return applyOperationToPromoteTask(
        adapter,
        envelope as SyncOperationEnvelope & {
          op: Extract<SyncOperationPayload, { type: 'plan.promote_task' }>;
        },
        options
      );
    case 'project_setting.set':
    case 'project_setting.delete':
      throw new Error(
        'applyOperationTo does not handle project_setting.*; use rebuildProjectSettingProjection instead'
      );
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
}

type BaseRevisionTarget = {
  planUuid: string;
  taskUuid?: string;
  revision: number;
  exists: boolean;
};

function getBaseRevisionTarget(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { baseRevision?: number }>
): BaseRevisionTarget | null {
  switch (op.type) {
    case 'plan.update_task_text':
    case 'plan.remove_task': {
      const task = adapter.getTasks(op.planUuid).find((item) => item.uuid === op.taskUuid);
      return {
        planUuid: op.planUuid,
        taskUuid: op.taskUuid,
        revision: task?.revision ?? -1,
        exists: task !== undefined,
      };
    }
    case 'plan.promote_task': {
      const plan = adapter.getPlan(op.sourcePlanUuid);
      return {
        planUuid: op.sourcePlanUuid,
        revision: plan?.revision ?? -1,
        exists: plan !== null,
      };
    }
    case 'plan.set_scalar':
    case 'plan.patch_text':
    case 'plan.delete':
    case 'plan.set_parent': {
      const plan = adapter.getPlan(op.planUuid);
      return {
        planUuid: op.planUuid,
        revision: plan?.revision ?? -1,
        exists: plan !== null,
      };
    }
    default:
      return null;
  }
}

function getAtomicBatchBaselineRevision(
  options: ApplyOperationOptions,
  op: Extract<SyncOperationPayload, { baseRevision?: number }>,
  target: BaseRevisionTarget
): number {
  if (
    (op.type === 'plan.update_task_text' || op.type === 'plan.remove_task') &&
    target.taskUuid &&
    options.atomicBatchTaskBaseRevisions?.has(target.taskUuid)
  ) {
    return options.atomicBatchTaskBaseRevisions.get(target.taskUuid)!;
  }
  if (
    (op.type === 'plan.set_scalar' ||
      op.type === 'plan.patch_text' ||
      op.type === 'plan.delete' ||
      op.type === 'plan.set_parent' ||
      op.type === 'plan.promote_task') &&
    options.atomicBatchPlanBaseRevisions?.has(target.planUuid)
  ) {
    return options.atomicBatchPlanBaseRevisions.get(target.planUuid)!;
  }
  return target.revision;
}

function shouldSkipProjectionBaseRevision(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { baseRevision?: number }>,
  target: BaseRevisionTarget
): boolean {
  if (typeof op.baseRevision !== 'number') {
    return false;
  }
  if (!target.exists || op.baseRevision > target.revision) {
    return true;
  }
  if (op.baseRevision === target.revision) {
    return false;
  }

  switch (op.type) {
    case 'plan.set_scalar':
      return !projectionScalarPrestateMatches(adapter, op);
    case 'plan.patch_text':
      return !projectionPlanTextPrestateMatches(adapter, op);
    case 'plan.update_task_text':
      return !projectionTaskTextPrestateMatches(adapter, op);
    case 'plan.remove_task':
      return false;
    case 'plan.set_parent':
      return !projectionParentPrestateMatches(adapter, op);
    case 'plan.delete':
    case 'plan.promote_task':
      return true;
    default:
      return false;
  }
}

function projectionScalarPrestateMatches(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>
): boolean {
  if (!('baseValue' in op) || op.baseValue === undefined) {
    return false;
  }
  const plan = adapter.getPlan(op.planUuid);
  if (!plan) {
    return false;
  }
  const current = (plan as unknown as Record<string, unknown>)[op.field];
  const expected = normalizePlanScalarAdapterValue(adapter, op.field, op.baseValue);
  return current === expected;
}

function projectionPlanTextPrestateMatches(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>
): boolean {
  const plan = adapter.getPlan(op.planUuid);
  if (!plan) {
    return false;
  }
  const column = PLAN_TEXT_COLUMNS[op.field];
  return ((plan[column] ?? '') as string).toString() === op.base;
}

function projectionTaskTextPrestateMatches(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>
): boolean {
  const task = adapter.getTasks(op.planUuid).find((item) => item.uuid === op.taskUuid);
  if (!task) {
    return false;
  }
  const column = TASK_TEXT_COLUMNS[op.field];
  return (task[column] ?? '').toString() === op.base;
}

function projectionParentPrestateMatches(
  adapter: ApplyOperationToAdapter,
  op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>
): boolean {
  if (!('previousParentUuid' in op)) {
    return false;
  }
  return (adapter.getPlan(op.planUuid)?.parent_uuid ?? null) === (op.previousParentUuid ?? null);
}

function normalizePlanScalarAdapterValue(
  adapter: ApplyOperationToAdapter,
  field: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>['field'],
  value: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>['value']
): unknown {
  if (field === 'epic' || field === 'simple' || field === 'tdd' || field === 'temp') {
    if (value === null || value === undefined) {
      return null;
    }
    return value ? 1 : 0;
  }
  if (field === 'discovered_from') {
    return adapter.resolveLocalPlanId(value as string | null);
  }
  return value;
}

export function clonePlanWithBump(
  plan: ApplyOperationToPlan,
  patch: Partial<ApplyOperationToPlan>,
  options: ApplyOperationOptions = {}
): ApplyOperationToPlan {
  return {
    ...plan,
    ...patch,
    revision: (patch.revision as number | undefined) ?? plan.revision + 1,
    updated_at: options.skipUpdatedAt
      ? plan.updated_at
      : (options.sourceUpdatedAt ?? new Date().toISOString()),
  };
}

export function requireAdapterPlan(
  adapter: ApplyOperationToAdapter,
  planUuid: string
): ApplyOperationToPlan {
  const plan = adapter.getPlan(planUuid);
  if (!plan || plan.project_id !== adapter.project.id) {
    applyOperationToPrecondition(`Unknown plan ${planUuid}`);
  }
  return plan;
}

export function requireAdapterTask(
  adapter: ApplyOperationToAdapter,
  taskUuid: string,
  planUuid: string
): ApplyOperationToTask {
  const task = adapter.getTasks(planUuid).find((item) => item.uuid === taskUuid);
  if (!task) {
    applyOperationToPrecondition(`Unknown task ${taskUuid}`);
  }
  return task;
}

function validateAdapterPlanOperation(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope
): void {
  const op = envelope.op;
  switch (op.type) {
    case 'plan.create': {
      if (getAdapterPlanForCreateDuplicateCheck(adapter, op.planUuid)) {
        return;
      }
      const taskUuids = new Set<string>();
      for (const task of op.tasks) {
        if (taskUuids.has(task.taskUuid) || adapter.getTaskByUuid(task.taskUuid)) {
          applyOperationToPrecondition('Duplicate task UUIDs in plan.create');
        }
        taskUuids.add(task.taskUuid);
      }
      if (op.parentUuid) {
        requireAdapterPlan(adapter, op.parentUuid);
        validateAdapterParentEdge(adapter, op.parentUuid, op.planUuid);
      }
      if (op.discoveredFrom && adapter.baseRevisionMode !== 'projection') {
        requireAdapterPlan(adapter, op.discoveredFrom);
      }
      if (op.dependencies.some((dependencyUuid) => dependencyUuid === op.planUuid)) {
        applyOperationToPrecondition('Adding dependency would create a cycle');
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireAdapterPlan(adapter, dependencyUuid);
        if (dependencyReachesAdapter(adapter, dependencyUuid, op.planUuid)) {
          applyOperationToPrecondition('Adding dependency would create a cycle');
        }
        if (
          op.parentUuid &&
          (dependencyUuid === op.parentUuid ||
            dependencyReachesAdapter(adapter, dependencyUuid, op.parentUuid))
        ) {
          applyOperationToPrecondition('Setting parent would create a dependency cycle');
        }
      }
      return;
    }
    case 'plan.set_scalar':
      if (op.field === 'discovered_from' && typeof op.value === 'string') {
        requireAdapterPlan(adapter, op.value);
      }
      return;
    case 'plan.add_task': {
      requireAdapterPlan(adapter, op.planUuid);
      const existing = adapter.getTaskByUuid(op.taskUuid);
      if (existing) {
        applyOperationToPrecondition(`Duplicate task UUID ${op.taskUuid}`);
      }
      return;
    }
    case 'plan.add_dependency':
      requireAdapterPlan(adapter, op.planUuid);
      requireAdapterPlan(adapter, op.dependsOnPlanUuid);
      if (
        op.planUuid === op.dependsOnPlanUuid ||
        dependencyReachesAdapter(adapter, op.dependsOnPlanUuid, op.planUuid)
      ) {
        applyOperationToPrecondition('Adding dependency would create a cycle');
      }
      return;
    case 'plan.remove_dependency':
      requireAdapterPlan(adapter, op.planUuid);
      requireAdapterPlan(adapter, op.dependsOnPlanUuid);
      return;
    case 'plan.set_parent':
      requireAdapterPlan(adapter, op.planUuid);
      if (op.newParentUuid) {
        requireAdapterPlan(adapter, op.newParentUuid);
        validateAdapterParentEdge(adapter, op.newParentUuid, op.planUuid);
      }
      return;
    case 'plan.promote_task':
      requireAdapterPlan(adapter, op.sourcePlanUuid);
      requireAdapterTask(adapter, op.taskUuid, op.sourcePlanUuid);
      if (adapter.getPlan(op.newPlanUuid)) {
        return;
      }
      if (op.parentUuid) {
        requireAdapterPlan(adapter, op.parentUuid);
        validateAdapterParentEdge(adapter, op.parentUuid, op.newPlanUuid);
      }
      for (const dependencyUuid of new Set(op.dependencies)) {
        requireAdapterPlan(adapter, dependencyUuid);
        if (
          dependencyUuid === op.newPlanUuid ||
          dependencyReachesAdapter(adapter, dependencyUuid, op.newPlanUuid)
        ) {
          applyOperationToPrecondition('Adding dependency would create a cycle');
        }
      }
      return;
    default:
      return;
  }
}

function dependencyReachesAdapter(
  adapter: ApplyOperationToAdapter,
  startPlanUuid: string,
  targetPlanUuid: string
): boolean {
  const visited = new Set<string>();
  const stack = [startPlanUuid];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    stack.push(...adapter.getDependencies(current).map((row) => row.depends_on_uuid));
  }
  return false;
}

function parentChainReachesAdapter(
  adapter: ApplyOperationToAdapter,
  startParentUuid: string,
  targetPlanUuid: string
): boolean {
  let current: string | null = startParentUuid;
  const visited = new Set<string>();
  while (current) {
    if (current === targetPlanUuid) {
      return true;
    }
    if (visited.has(current)) {
      return false;
    }
    visited.add(current);
    current = adapter.getPlan(current)?.parent_uuid ?? null;
  }
  return false;
}

function validateAdapterParentEdge(
  adapter: ApplyOperationToAdapter,
  parentUuid: string,
  childUuid: string
): void {
  if (
    parentUuid === childUuid ||
    parentChainReachesAdapter(adapter, parentUuid, childUuid) ||
    dependencyReachesAdapter(adapter, childUuid, parentUuid)
  ) {
    applyOperationToPrecondition('Setting parent would create a cycle');
  }
}

function applyOperationToPlanCreate(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.create' }> },
  options: ApplyOperationOptions
): Mutation[] {
  const op = envelope.op;
  if (getAdapterPlanForCreateDuplicateCheck(adapter, op.planUuid)) {
    return [];
  }
  if (op.parentUuid) {
    requireAdapterPlan(adapter, op.parentUuid);
  }
  if (op.discoveredFrom && adapter.baseRevisionMode !== 'projection') {
    requireAdapterPlan(adapter, op.discoveredFrom);
  }
  for (const dependencyUuid of new Set(op.dependencies)) {
    requireAdapterPlan(adapter, dependencyUuid);
  }
  const plan: ApplyOperationToPlan = {
    uuid: op.planUuid,
    project_id: adapter.project.id,
    plan_id: adapter.resolvePlanCreateNumericPlanId(
      op.numericPlanId,
      options.preserveRequestedPlanIds
    ),
    title: op.title,
    goal: op.goal ?? null,
    note: op.note ?? null,
    details: op.details ?? null,
    status: op.status ?? 'pending',
    priority: op.priority ?? null,
    branch: op.branch ?? null,
    simple: typeof op.simple === 'boolean' ? (op.simple ? 1 : 0) : null,
    tdd: typeof op.tdd === 'boolean' ? (op.tdd ? 1 : 0) : null,
    discovered_from: adapter.resolveLocalPlanId(op.discoveredFrom),
    issue: JSON.stringify(op.issue),
    pull_request: JSON.stringify(op.pullRequest),
    assigned_to: op.assignedTo ?? null,
    base_branch: op.baseBranch ?? null,
    base_commit: null,
    base_change_id: null,
    temp: typeof op.temp === 'boolean' ? (op.temp ? 1 : 0) : null,
    docs: JSON.stringify(op.docs),
    changed_files: JSON.stringify(op.changedFiles),
    plan_generated_at: op.planGeneratedAt ?? null,
    review_issues: JSON.stringify(op.reviewIssues),
    docs_updated_at: op.docsUpdatedAt ?? null,
    lessons_applied_at: op.lessonsAppliedAt ?? null,
    parent_uuid: op.parentUuid ?? null,
    epic: op.epic ? 1 : 0,
    revision: 1,
    created_at: options.sourceCreatedAt ?? new Date().toISOString(),
    updated_at: options.sourceUpdatedAt ?? new Date().toISOString(),
  };
  adapter.setPlan(plan);
  adapter.setTasks(
    op.planUuid,
    op.tasks.map((task, index) => ({
      uuid: task.taskUuid,
      plan_uuid: op.planUuid,
      task_index: index,
      title: task.title,
      description: task.description,
      done: task.done ? 1 : 0,
      revision: 1,
    }))
  );
  adapter.setTags(
    op.planUuid,
    [...new Set(op.tags)].map((tag) => ({ plan_uuid: op.planUuid, tag }))
  );
  adapter.setDependencies(
    op.planUuid,
    [...new Set(op.dependencies)].map((dependsOnUuid) => ({
      plan_uuid: op.planUuid,
      depends_on_uuid: dependsOnUuid,
    }))
  );
  const mutations: Mutation[] = [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: 1 },
  ];
  if (op.parentUuid) {
    const deps = adapter.getDependencies(op.parentUuid);
    if (!deps.some((dep) => dep.depends_on_uuid === op.planUuid)) {
      adapter.setDependencies(op.parentUuid, [
        ...deps,
        { plan_uuid: op.parentUuid, depends_on_uuid: op.planUuid },
      ]);
      const parent = requireAdapterPlan(adapter, op.parentUuid);
      adapter.setPlan(clonePlanWithBump(parent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${op.parentUuid}`,
        revision: parent.revision + 1,
      });
    }
  }
  return mutations;
}

function getAdapterPlanForCreateDuplicateCheck(
  adapter: ApplyOperationToAdapter,
  planUuid: string
): ApplyOperationToPlan | null {
  return adapter.getPlanForCreateDuplicateCheck?.(planUuid) ?? adapter.getPlan(planUuid);
}

function applyOperationToPlanScalar(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_scalar' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const value =
    envelope.op.field === 'epic'
      ? envelope.op.value
        ? 1
        : 0
      : envelope.op.field === 'discovered_from'
        ? adapter.resolveLocalPlanId(envelope.op.value as string | null)
        : envelope.op.value;
  if ((plan as unknown as Record<string, unknown>)[envelope.op.field] === value) {
    return [];
  }
  adapter.setPlan(clonePlanWithBump(plan, { [envelope.op.field]: value }, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToPlanText(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.patch_text' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = PLAN_TEXT_COLUMNS[envelope.op.field];
  const current = ((plan[column] ?? '') as string).toString();
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    applyOperationToPrecondition('text merge failed');
  }
  if (merged === current) {
    return [];
  }
  adapter.setPlan(clonePlanWithBump(plan, { [column]: merged }, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToAddTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  if (tasks.some((task) => task.uuid === envelope.op.taskUuid)) {
    return [];
  }
  const index = envelope.op.taskIndex ?? tasks.length;
  const shifted = tasks.map((task) =>
    task.task_index >= index ? { ...task, task_index: task.task_index + 1 } : task
  );
  adapter.setTasks(
    envelope.op.planUuid,
    [
      ...shifted,
      {
        uuid: envelope.op.taskUuid,
        plan_uuid: envelope.op.planUuid,
        task_index: index,
        title: envelope.op.title,
        description: envelope.op.description ?? '',
        done: envelope.op.done ? 1 : 0,
        revision: 1,
      },
    ].sort((a, b) => a.task_index - b.task_index)
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: 1 },
  ];
}

function applyOperationToTaskText(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.update_task_text' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const column = TASK_TEXT_COLUMNS[envelope.op.field];
  const current = task[column] ?? '';
  const merged = mergeText(current, envelope.op.base, envelope.op.new);
  if (merged === null) {
    applyOperationToPrecondition('text merge failed');
  }
  if (merged === current) {
    return [];
  }
  adapter.setTasks(
    envelope.op.planUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid
        ? { ...item, [column]: merged, revision: item.revision + 1 }
        : item
    )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToMarkTaskDone(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.mark_task_done' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.planUuid);
  const done = envelope.op.done ? 1 : 0;
  if (task.done === done) {
    return [];
  }
  adapter.setTasks(
    envelope.op.planUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid ? { ...item, done, revision: item.revision + 1 } : item
    )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToRemoveTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.remove_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  const task = tasks.find((item) => item.uuid === envelope.op.taskUuid);
  if (!task) {
    return [];
  }
  adapter.onTaskDeleted?.(envelope.op.taskUuid, task.revision);
  adapter.setTasks(
    envelope.op.planUuid,
    tasks
      .filter((item) => item.uuid !== envelope.op.taskUuid)
      .map((item) =>
        item.task_index > task.task_index ? { ...item, task_index: item.task_index - 1 } : item
      )
  );
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    { targetType: 'plan', targetKey: `plan:${envelope.op.planUuid}`, revision: plan.revision + 1 },
  ];
}

function applyOperationToDependency(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_dependency' | 'plan.remove_dependency' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  requireAdapterPlan(adapter, envelope.op.dependsOnPlanUuid);
  const deps = adapter.getDependencies(envelope.op.planUuid);
  const exists = deps.some((dep) => dep.depends_on_uuid === envelope.op.dependsOnPlanUuid);
  const next =
    envelope.op.type === 'plan.add_dependency'
      ? exists
        ? deps
        : [
            ...deps,
            { plan_uuid: envelope.op.planUuid, depends_on_uuid: envelope.op.dependsOnPlanUuid },
          ]
      : deps.filter((dep) => dep.depends_on_uuid !== envelope.op.dependsOnPlanUuid);
  if (next === deps || next.length === deps.length) {
    return [];
  }
  adapter.setDependencies(envelope.op.planUuid, next);
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToTag(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_tag' | 'plan.remove_tag' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tags = adapter.getTags(envelope.op.planUuid);
  const exists = tags.some((tag) => tag.tag === envelope.op.tag);
  const next =
    envelope.op.type === 'plan.add_tag'
      ? exists
        ? tags
        : [...tags, { plan_uuid: envelope.op.planUuid, tag: envelope.op.tag }]
      : tags.filter((tag) => tag.tag !== envelope.op.tag);
  if (next === tags || next.length === tags.length) {
    return [];
  }
  adapter.setTags(envelope.op.planUuid, next);
  adapter.setPlan(clonePlanWithBump(plan, {}, options));
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToListItem(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.add_list_item' | 'plan.remove_list_item' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const column = LIST_COLUMNS[envelope.op.list];
  const current = parseJsonArray(plan[column]);
  const valueText = canonicalJsonStringify(envelope.op.value);
  const index = current.findIndex((item) => canonicalJsonStringify(item) === valueText);
  // Primitive (string) list items allow duplicates; object items deduplicate on identity.
  const isPrimitive = typeof envelope.op.value !== 'object' || envelope.op.value === null;
  const next =
    envelope.op.type === 'plan.add_list_item'
      ? isPrimitive || index === -1
        ? [...current, envelope.op.value]
        : current
      : index === -1
        ? current
        : current.filter((_, itemIndex) => itemIndex !== index);
  if (next === current) {
    return [];
  }
  adapter.setPlan(
    clonePlanWithBump(plan, { [column]: next.length === 0 ? null : JSON.stringify(next) }, options)
  );
  return [{ targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 }];
}

function applyOperationToPlanDelete(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & { op: Extract<SyncOperationPayload, { type: 'plan.delete' }> }
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  const tasks = adapter.getTasks(envelope.op.planUuid);
  adapter.onPlanDeleted?.(envelope.op.planUuid);
  adapter.deletePlan(envelope.op.planUuid);
  return [
    { targetType: 'plan', targetKey: envelope.targetKey, revision: plan.revision + 1 },
    ...tasks
      .filter(
        (task): task is ApplyOperationToTask & { uuid: string } => typeof task.uuid === 'string'
      )
      .map((task) => ({
        targetType: 'task',
        targetKey: `task:${task.uuid}`,
        revision: task.revision + 1,
      })),
  ];
}

function applyOperationToSetParent(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.set_parent' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const plan = requireAdapterPlan(adapter, envelope.op.planUuid);
  if (envelope.op.newParentUuid) {
    requireAdapterPlan(adapter, envelope.op.newParentUuid);
  }
  if (plan.parent_uuid === envelope.op.newParentUuid) {
    return [];
  }
  const mutations: Mutation[] = [];
  const oldParentUuid = plan.parent_uuid;
  adapter.setPlan(clonePlanWithBump(plan, { parent_uuid: envelope.op.newParentUuid }, options));
  mutations.push({
    targetType: 'plan',
    targetKey: envelope.targetKey,
    revision: plan.revision + 1,
  });
  if (oldParentUuid) {
    const oldDeps = adapter.getDependencies(oldParentUuid);
    const nextOldDeps = oldDeps.filter((dep) => dep.depends_on_uuid !== envelope.op.planUuid);
    if (nextOldDeps.length !== oldDeps.length) {
      adapter.setDependencies(oldParentUuid, nextOldDeps);
      const oldParent = requireAdapterPlan(adapter, oldParentUuid);
      adapter.setPlan(clonePlanWithBump(oldParent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${oldParentUuid}`,
        revision: oldParent.revision + 1,
      });
    }
  }
  if (envelope.op.newParentUuid) {
    const newDeps = adapter.getDependencies(envelope.op.newParentUuid);
    if (!newDeps.some((dep) => dep.depends_on_uuid === envelope.op.planUuid)) {
      adapter.setDependencies(envelope.op.newParentUuid, [
        ...newDeps,
        { plan_uuid: envelope.op.newParentUuid, depends_on_uuid: envelope.op.planUuid },
      ]);
      const newParent = requireAdapterPlan(adapter, envelope.op.newParentUuid);
      adapter.setPlan(clonePlanWithBump(newParent, {}, options));
      mutations.push({
        targetType: 'plan',
        targetKey: `plan:${envelope.op.newParentUuid}`,
        revision: newParent.revision + 1,
      });
    }
  }
  return mutations;
}

function applyOperationToPromoteTask(
  adapter: ApplyOperationToAdapter,
  envelope: SyncOperationEnvelope & {
    op: Extract<SyncOperationPayload, { type: 'plan.promote_task' }>;
  },
  options: ApplyOperationOptions
): Mutation[] {
  const sourcePlan = requireAdapterPlan(adapter, envelope.op.sourcePlanUuid);
  const tasks = adapter.getTasks(envelope.op.sourcePlanUuid);
  const task = requireAdapterTask(adapter, envelope.op.taskUuid, envelope.op.sourcePlanUuid);
  if (adapter.getPlan(envelope.op.newPlanUuid)) {
    return [];
  }
  const createEnvelope = {
    ...envelope,
    targetKey: `plan:${envelope.op.newPlanUuid}`,
    op: {
      type: 'plan.create' as const,
      planUuid: envelope.op.newPlanUuid,
      numericPlanId: envelope.op.numericPlanId,
      title: envelope.op.title,
      details: envelope.op.description,
      parentUuid: envelope.op.parentUuid,
      issue: [],
      pullRequest: [],
      docs: [],
      changedFiles: [],
      reviewIssues: [],
      tags: envelope.op.tags,
      dependencies: envelope.op.dependencies,
      tasks: [],
    },
  };
  const mutations = applyOperationToPlanCreate(adapter, createEnvelope, options);
  adapter.setTasks(
    envelope.op.sourcePlanUuid,
    tasks.map((item) =>
      item.uuid === envelope.op.taskUuid && item.done !== 1
        ? { ...item, done: 1, revision: item.revision + 1 }
        : item
    )
  );
  adapter.setPlan(clonePlanWithBump(sourcePlan, {}, options));
  mutations.push(
    { targetType: 'task', targetKey: `task:${envelope.op.taskUuid}`, revision: task.revision + 1 },
    {
      targetType: 'plan',
      targetKey: `plan:${envelope.op.sourcePlanUuid}`,
      revision: sourcePlan.revision + 1,
    }
  );
  return mutations;
}
