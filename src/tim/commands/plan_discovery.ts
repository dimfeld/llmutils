import { debugLog } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { findMostRecentlyUpdatedPlan } from './prompts.js';
import { loadPlansFromDb } from '../plans_db.js';
import { isReadyPlan } from '../ready_plans.js';
import type { PlanSchema } from '../planSchema.js';

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 5,
  high: 4,
  medium: 3,
  low: 2,
  maybe: 1,
};

export interface NextReadyDependencyResult {
  plan: PlanSchema | null;
  message: string;
}

export async function loadDbPlans(
  tasksDir: string,
  repoRoot: string
): Promise<Map<number, PlanSchema>> {
  const repository = await getRepositoryIdentity({ cwd: repoRoot });
  return loadPlansFromDb(
    getLegacyAwareSearchDir(repository.gitRoot, tasksDir),
    repository.repositoryId
  ).plans;
}

export async function findLatestPlanFromDb(
  tasksDir: string,
  repoRoot: string
): Promise<PlanSchema | null> {
  const plans = await loadDbPlans(tasksDir, repoRoot);
  if (plans.size === 0) {
    return null;
  }

  return findMostRecentlyUpdatedPlan(plans);
}

export async function findNextPlanFromDb(
  tasksDir: string,
  repoRoot: string,
  options: { includePending?: boolean; includeInProgress?: boolean } = { includePending: true }
): Promise<PlanSchema | null> {
  const plans = await loadDbPlans(tasksDir, repoRoot);
  return findNextPlanFromCollection(plans, options);
}

function getDirectDependencies(planId: number, plans: Map<number, PlanSchema>): number[] {
  const dependencies = new Set<number>();
  const plan = plans.get(planId);

  if (!plan) {
    return [];
  }

  for (const dependency of plan.dependencies ?? []) {
    if (typeof dependency === 'number') {
      dependencies.add(dependency);
    }
  }

  for (const [childId, childPlan] of plans) {
    if (childPlan.parent === planId) {
      dependencies.add(childId);
    }
  }

  return Array.from(dependencies);
}

function compareByPriorityAndId(a: PlanSchema, b: PlanSchema): number {
  const aPriority = a.priority ? PRIORITY_ORDER[a.priority] || 0 : 0;
  const bPriority = b.priority ? PRIORITY_ORDER[b.priority] || 0 : 0;
  if (aPriority !== bPriority) {
    return bPriority - aPriority;
  }

  return a.id - b.id;
}

function compareByStatusPriorityAndId(a: PlanSchema, b: PlanSchema): number {
  const aStatus = a.status || 'pending';
  const bStatus = b.status || 'pending';
  if (aStatus !== bStatus) {
    if (aStatus === 'in_progress') return -1;
    if (bStatus === 'in_progress') return 1;
  }

  return compareByPriorityAndId(a, b);
}

export function findNextPlanFromCollection(
  plans: Map<number, PlanSchema>,
  options: { includePending?: boolean; includeInProgress?: boolean } = { includePending: true }
): PlanSchema | null {
  const includePending = options.includePending ?? false;
  const includeInProgress = options.includeInProgress ?? false;

  const candidates = Array.from(plans.values())
    .filter((plan) => {
      const status = plan.status || 'pending';
      if (plan.priority === 'maybe') {
        return false;
      }
      if (includeInProgress && status === 'in_progress') {
        return true;
      }
      if (includePending && status === 'pending') {
        return true;
      }
      return false;
    })
    .filter((plan) => isReadyPlan(plan, plans, !includeInProgress))
    .sort((a, b) => {
      if (includePending && includeInProgress) {
        return compareByStatusPriorityAndId(a, b);
      }

      return compareByPriorityAndId(a, b);
    });

  return candidates[0] ?? null;
}

export function findNextReadyDependencyFromCollection(
  parentPlanId: number,
  plans: Map<number, PlanSchema>,
  includeEmptyPlans = false
): NextReadyDependencyResult {
  debugLog(`[plan_discovery] Finding next ready dependency for plan ${parentPlanId}`);
  const parentPlan = plans.get(parentPlanId);
  if (!parentPlan) {
    return {
      plan: null,
      message: `Plan not found: ${parentPlanId}\nTry:\n  • Run tim list to see available plans\n  • Check the plan ID is correct`,
    };
  }

  const allDependencies = new Set<number>();
  const queue: number[] = [parentPlanId];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    if (currentId !== parentPlanId) {
      allDependencies.add(currentId);
    }

    queue.push(...getDirectDependencies(currentId, plans));
  }

  if (allDependencies.size === 0 && parentPlan.status !== 'done') {
    return {
      plan: parentPlan,
      message: 'No dependencies - ready to work on this plan',
    };
  }

  const readyCandidates = Array.from(allDependencies)
    .map((id) => plans.get(id))
    .filter((plan): plan is PlanSchema => Boolean(plan))
    .filter((plan) => {
      const status = plan.status || 'pending';
      if (status !== 'pending' && status !== 'in_progress') {
        return false;
      }
      if (plan.priority === 'maybe') {
        return false;
      }
      if (status === 'in_progress') {
        return true;
      }
      if (!includeEmptyPlans && (!plan.tasks || plan.tasks.length === 0)) {
        return false;
      }

      return isReadyPlan(plan, plans, false);
    })
    .sort(compareByStatusPriorityAndId);

  if (readyCandidates.length > 0) {
    return {
      plan: readyCandidates[0],
      message: 'Found ready dependency',
    };
  }

  const allDependencyPlans = Array.from(allDependencies)
    .map((id) => plans.get(id))
    .filter((plan): plan is PlanSchema => Boolean(plan));

  const blockedPlan = allDependencyPlans
    .filter((plan) => {
      const status = plan.status || 'pending';
      return status === 'pending' || status === 'in_progress';
    })
    .sort(compareByStatusPriorityAndId)[0];

  if (blockedPlan) {
    return {
      plan: null,
      message: `No ready dependencies found. Closest pending dependency is ${blockedPlan.id} (${blockedPlan.title ?? blockedPlan.goal ?? 'Untitled'}).`,
    };
  }

  if (parentPlan.status !== 'done') {
    return {
      plan: parentPlan,
      message: 'All dependencies complete - ready to work on this plan',
    };
  }

  return {
    plan: null,
    message: 'No ready dependencies found.',
  };
}

export async function findNextReadyDependencyFromDb(
  parentPlanId: number,
  tasksDir: string,
  repoRoot: string,
  includeEmptyPlans = false
): Promise<NextReadyDependencyResult> {
  const plans = await loadDbPlans(tasksDir, repoRoot);
  return findNextReadyDependencyFromCollection(parentPlanId, plans, includeEmptyPlans);
}

export function toHeadlessPlanSummary(plan: Pick<PlanSchema, 'id' | 'uuid' | 'title'>) {
  return {
    id: plan.id,
    uuid: plan.uuid,
    title: plan.title,
  };
}
