import * as path from 'path';

import type { PlanSchema } from './planSchema.js';

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 5,
  high: 4,
  medium: 3,
  low: 2,
  maybe: 1,
};

export const READY_PLAN_SORT_FIELDS = ['priority', 'id', 'title', 'created', 'updated'] as const;

export type ReadyPlanSortField = (typeof READY_PLAN_SORT_FIELDS)[number];

export interface ReadyPlanFilterOptions {
  pendingOnly?: boolean;
  priority?: PlanSchema['priority'];
  limit?: number;
  sortBy?: ReadyPlanSortField;
  reverse?: boolean;
}

export type EnrichedReadyPlan<T extends PlanSchema = PlanSchema> = T & {
  filename: string;
};

function getDependency<T>(plans: Map<number, T>, dependency: number | string): T | undefined {
  if (typeof dependency === 'number') {
    return plans.get(dependency);
  }

  if (typeof dependency === 'string' && /^\d+$/.test(dependency)) {
    return plans.get(Number.parseInt(dependency, 10));
  }

  return undefined;
}

export function isReadyPlan<T extends PlanSchema>(
  plan: T,
  allPlans: Map<number, T>,
  pendingOnly: boolean
): boolean {
  const status = plan.status ?? 'pending';
  const statusMatch = pendingOnly
    ? status === 'pending'
    : status === 'pending' || status === 'in_progress';

  if (!statusMatch) {
    return false;
  }

  if (!plan.tasks || plan.tasks.length === 0) {
    return false;
  }

  if (!plan.dependencies || plan.dependencies.length === 0) {
    return true;
  }

  return plan.dependencies.every((dependency) => {
    const dependencyPlan = getDependency(allPlans, dependency);
    return dependencyPlan?.status === 'done';
  });
}

function compareIds(aId: PlanSchema['id'], bId: PlanSchema['id']): number {
  if (typeof aId === 'number' && typeof bId === 'number') {
    return aId - bId;
  }

  if (typeof aId === 'number') {
    return -1;
  }

  if (typeof bId === 'number') {
    return 1;
  }

  const aSafe = aId ?? '';
  const bSafe = bId ?? '';
  return aSafe.localeCompare(bSafe);
}

function comparePriority(a: PlanSchema, b: PlanSchema): number {
  const aPriority = a.priority ? (PRIORITY_ORDER[a.priority] ?? 0) : 0;
  const bPriority = b.priority ? (PRIORITY_ORDER[b.priority] ?? 0) : 0;
  return aPriority - bPriority;
}

function comparePlans<T extends PlanSchema>(
  a: T,
  b: T,
  sortBy: ReadyPlanSortField,
  reverse: boolean
): number {
  let comparison = 0;

  switch (sortBy) {
    case 'title': {
      const aValue = (a.title || a.goal || '').toLowerCase();
      const bValue = (b.title || b.goal || '').toLowerCase();
      comparison = aValue.localeCompare(bValue);
      break;
    }
    case 'id': {
      comparison = compareIds(a.id, b.id);
      break;
    }
    case 'created': {
      const aValue = a.createdAt ?? '';
      const bValue = b.createdAt ?? '';
      comparison = aValue.localeCompare(bValue);
      if (comparison === 0) {
        comparison = compareIds(a.id, b.id);
      }
      break;
    }
    case 'updated': {
      const aValue = a.updatedAt ?? '';
      const bValue = b.updatedAt ?? '';
      comparison = aValue.localeCompare(bValue);
      if (comparison === 0) {
        comparison = compareIds(a.id, b.id);
      }
      break;
    }
    case 'priority':
    default: {
      const priorityComparison = comparePriority(b, a);
      if (priorityComparison !== 0) {
        comparison = priorityComparison;
      } else {
        comparison = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
        if (comparison === 0) {
          comparison = compareIds(a.id, b.id);
        }
      }
      break;
    }
  }

  const sortMultiplier = reverse ? -1 : 1;

  return comparison * sortMultiplier;
}

export function sortReadyPlans<T extends PlanSchema>(
  plans: T[],
  sortBy: ReadyPlanSortField = 'priority',
  reverse = false
): T[] {
  const candidates = [...plans];
  candidates.sort((a, b) => comparePlans(a, b, sortBy, reverse));
  return candidates;
}

export function filterAndSortReadyPlans<T extends PlanSchema>(
  allPlans: Map<number, T>,
  options: ReadyPlanFilterOptions = {}
): T[] {
  const pendingOnly = options.pendingOnly ?? false;

  let candidates = Array.from(allPlans.values()).filter((plan) =>
    isReadyPlan(plan, allPlans, pendingOnly)
  );

  if (options.priority) {
    candidates = candidates.filter((plan) => plan.priority === options.priority);
  }

  const sortBy = options.sortBy ?? 'priority';
  const reverse = options.reverse ?? false;
  candidates = sortReadyPlans(candidates, sortBy, reverse);

  if (options.limit && options.limit > 0) {
    candidates = candidates.slice(0, options.limit);
  }

  return candidates;
}

export interface ReadyPlanJsonOptions {
  gitRoot?: string;
}

export function formatReadyPlansAsJson<T extends PlanSchema>(
  plans: Array<EnrichedReadyPlan<T>>,
  options: ReadyPlanJsonOptions = {}
): string {
  const { gitRoot } = options;
  const result = {
    count: plans.length,
    plans: plans.map((plan) => ({
      id: plan.id,
      title: plan.title || plan.goal || '',
      goal: plan.goal || '',
      priority: plan.priority,
      status: plan.status,
      taskCount: plan.tasks?.length ?? 0,
      completedTasks: plan.tasks?.filter((task) => task.done).length ?? 0,
      dependencies: plan.dependencies ?? [],
      assignedTo: plan.assignedTo,
      filename: gitRoot ? path.relative(gitRoot, plan.filename) : plan.filename,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    })),
  };

  return JSON.stringify(result, null, 2);
}
