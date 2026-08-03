import type { PlanSchema } from '../planSchema.js';
import { isTaskDone } from '../plans.js';

export type TaskIndexFilter = string | string[] | undefined;

interface ParsedTaskIndexes {
  /** Zero-based indexes, matching the internal task-array representation. */
  indexes: number[];
  invalidTokens: string[];
}

/** A task with its original plan-absolute, 1-based index. */
export interface IndexedPlanTask {
  index: number;
  task: PlanSchema['tasks'][number];
}

/**
 * The result of resolving a raw task-index filter against a plan.
 *
 * Selected incomplete and completed tasks are kept in separate buckets so
 * callers can apply their own policy to completed selections. The remaining
 * collections use the same plan-absolute, 1-based index convention.
 */
export interface TaskIndexResolution {
  indexedTasks: IndexedPlanTask[];
  incompleteTasks: IndexedPlanTask[];
  selectedTasks: IndexedPlanTask[];
  completedTasks: IndexedPlanTask[];
  invalidTokens: string[];
  unknownIndexes: number[];
}

export interface SubagentTaskScope {
  /** Selected tasks with their original 1-based plan indexes. */
  tasks: IndexedPlanTask[];
  scopeNote: string;
}

/**
 * Splits a repeatable or comma-separated task-index option into tokens.
 *
 * This is shared with review task scoping so both commands use the same
 * Commander value normalization.
 */
export function normalizeTaskFilterInput(value: TaskIndexFilter): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Parses plan-absolute, 1-based task indexes into zero-based array indexes.
 * Invalid tokens are returned so the caller can provide command-specific error
 * details. Module-private: `resolveTaskIndexes` is the entry point, so callers
 * cannot parse indexes without also applying the shared resolution rules.
 */
function parseTaskIndexes(value: TaskIndexFilter): ParsedTaskIndexes {
  const tokens = normalizeTaskFilterInput(value);
  const indexes: number[] = [];
  const invalidTokens: string[] = [];

  for (const token of tokens) {
    const parsed = Number(token);
    if (!Number.isInteger(parsed) || parsed < 1) {
      invalidTokens.push(token);
      continue;
    }
    indexes.push(parsed - 1);
  }

  return { indexes, invalidTokens };
}

/**
 * Resolves raw plan-absolute task indexes into indexed task buckets.
 *
 * Completed selections are returned separately instead of being rejected so
 * callers can choose their own policy. The review command permits them while
 * the subagent command rejects them.
 */
export function resolveTaskIndexes(
  planData: PlanSchema,
  taskIndex: TaskIndexFilter
): TaskIndexResolution {
  const indexedTasks: IndexedPlanTask[] = planData.tasks.map((task, index) => ({
    index: index + 1,
    task,
  }));
  const incompleteTasks = indexedTasks.filter(({ task }) => !isTaskDone(task));
  const { indexes, invalidTokens } = parseTaskIndexes(taskIndex);
  const selectedTasks = new Map<number, IndexedPlanTask>();
  const completedTasks = new Map<number, IndexedPlanTask>();
  const unknownIndexes: number[] = [];

  for (const zeroBasedIndex of indexes) {
    const index = zeroBasedIndex + 1;
    const indexedTask = indexedTasks[zeroBasedIndex];
    if (!indexedTask) {
      unknownIndexes.push(index);
      continue;
    }

    if (isTaskDone(indexedTask.task)) {
      completedTasks.set(index, indexedTask);
    } else {
      selectedTasks.set(index, indexedTask);
    }
  }

  return {
    indexedTasks,
    incompleteTasks,
    selectedTasks: [...selectedTasks.values()].sort(compareIndexedPlanTasks),
    completedTasks: [...completedTasks.values()].sort(compareIndexedPlanTasks),
    invalidTokens: [...new Set(invalidTokens)],
    unknownIndexes: [...new Set(unknownIndexes)],
  };
}

/**
 * Resolves the incomplete tasks selected by a subagent's task-index filter.
 * Indexes are plan-absolute and include completed tasks when counting.
 *
 * Call this only when a task-index filter was supplied; an empty filter is an
 * error rather than an implicit "all incomplete tasks" scope.
 */
export function resolveSubagentTaskScope(
  planData: PlanSchema,
  options: { taskIndex: TaskIndexFilter }
): SubagentTaskScope {
  const resolution = resolveTaskIndexes(planData, options.taskIndex);
  const errorParts: string[] = [];

  if (resolution.invalidTokens.length > 0) {
    errorParts.push(`Invalid task indexes: ${resolution.invalidTokens.join(', ')}`);
  }
  if (resolution.unknownIndexes.length > 0) {
    errorParts.push(`Unknown task indexes: ${sortIndexes(resolution.unknownIndexes).join(', ')}`);
  }
  if (resolution.completedTasks.length > 0) {
    errorParts.push(
      `Already completed task indexes: ${sortIndexes(
        resolution.completedTasks.map(({ index }) => index)
      ).join(', ')}`
    );
  }
  if (
    resolution.selectedTasks.length === 0 &&
    resolution.completedTasks.length === 0 &&
    resolution.invalidTokens.length === 0 &&
    resolution.unknownIndexes.length === 0
  ) {
    errorParts.push('No task indexes were provided');
  }

  if (errorParts.length > 0) {
    throw new Error(
      `${errorParts.join('; ')}. Valid incomplete task indexes: ${formatTaskIndexes(
        resolution.incompleteTasks.map(({ index }) => index)
      )}`
    );
  }

  return {
    tasks: resolution.selectedTasks,
    scopeNote: `This subagent run is scoped to exactly these plan tasks: ${formatTaskIndexes(
      resolution.selectedTasks.map(({ index }) => index)
    )}. Other plan work is out of scope.`,
  };
}

function compareIndexedPlanTasks(first: IndexedPlanTask, second: IndexedPlanTask): number {
  return first.index - second.index;
}

function sortIndexes(indexes: number[]): number[] {
  return [...indexes].sort((first, second) => first - second);
}

function formatTaskIndexes(indexes: number[]): string {
  return indexes.length > 0 ? indexes.join(', ') : 'none';
}
