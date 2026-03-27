import type { PlanSchema } from './planSchema.js';

/**
 * Get all direct dependencies of a plan, including both explicit dependencies
 * (from the dependencies array) and child plans (plans with parent field).
 *
 * @param planId - The ID of the plan to get dependencies for
 * @param allPlans - Map of all available plans
 * @returns Array of plan IDs that are direct dependencies
 */
export function getDirectDependencies(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): number[] {
  const directDeps = new Set<number>();
  const plan = allPlans.get(planId);

  if (!plan) {
    return [];
  }

  // Add explicit dependencies from the dependencies array
  if (plan.dependencies && plan.dependencies.length > 0) {
    for (const depId of plan.dependencies) {
      directDeps.add(depId);
    }
  }

  // Find child plans (plans where parent equals the current plan ID)
  for (const [childId, childPlan] of allPlans) {
    if (childPlan.parent === planId) {
      directDeps.add(childId);
    }
  }

  return Array.from(directDeps);
}
