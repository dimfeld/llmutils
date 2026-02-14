import type { PlanSchema } from '../planSchema.js';

/**
 * A plan with its filename for hierarchy traversal
 */
export type PlanWithFilename = PlanSchema & { filename: string };

/**
 * Gets the chain of parent plans from immediate parent to root.
 * Returns an array of parent plans ordered from immediate parent to root.
 * Includes cycle detection to prevent infinite loops.
 *
 * @param plan - The plan to get parents for
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of parent plans from immediate parent to root
 */
export function getParentChain<T extends PlanSchema>(plan: T, allPlans: Map<number, T>): T[] {
  const parents: T[] = [];
  const visited = new Set<number>();

  let currentPlan = plan;

  while (currentPlan.parent) {
    // Check for cycles
    if (visited.has(currentPlan.parent)) {
      // Cycle detected, stop traversal
      break;
    }

    const parentPlan = allPlans.get(currentPlan.parent);
    if (!parentPlan) {
      // Parent not found, stop traversal
      break;
    }

    visited.add(currentPlan.parent);
    parents.push(parentPlan);
    currentPlan = parentPlan;
  }

  return parents;
}

/**
 * Checks whether a plan belongs under a given epic (directly or indirectly).
 * This only inspects the parent chain, so callers should compare plan.id
 * separately if they want to include the epic plan itself.
 */
export function isUnderEpic<T extends PlanSchema>(
  plan: T,
  epicId: number,
  allPlans: Map<number, T>
): boolean {
  if (!plan.parent) {
    return false;
  }

  const parentChain = getParentChain(plan, allPlans);
  return parentChain.some((parent) => parent.id === epicId);
}

/**
 * Gets direct children of a plan (only immediate children, not recursive).
 *
 * @param planId - The ID of the plan to get children for
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of direct child plans sorted by ID
 */
export function getDirectChildren(
  planId: number,
  allPlans: Map<number, PlanWithFilename>
): PlanWithFilename[] {
  const children = Array.from(allPlans.values())
    .filter((plan) => plan.parent === planId)
    .sort((a, b) => (a.id || 0) - (b.id || 0));

  return children;
}

/**
 * Recursively finds all descendants of a plan.
 * Uses breadth-first traversal with cycle detection.
 * Returns results sorted by ID for consistent ordering.
 *
 * @param planId - The ID of the plan to get descendants for
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of all descendant plans sorted by ID
 */
export function getAllChildren(
  planId: number,
  allPlans: Map<number, PlanWithFilename>
): PlanWithFilename[] {
  const allChildren: PlanWithFilename[] = [];
  const visited = new Set<number>();
  const queue: number[] = [planId];

  // Mark the starting plan as visited to avoid including it in results
  visited.add(planId);

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    // Find direct children of current plan
    const directChildren = Array.from(allPlans.values()).filter(
      (plan) => plan.parent === currentId
    );

    for (const child of directChildren) {
      const childId = child.id;
      if (!childId) continue;

      // Check for cycles
      if (visited.has(childId)) {
        continue;
      }

      visited.add(childId);
      allChildren.push(child);
      queue.push(childId);
    }
  }

  // Sort by ID for consistent ordering
  return allChildren.sort((a, b) => (a.id || 0) - (b.id || 0));
}

/**
 * Gets all completed children of a plan (recursive).
 * Filters getAllChildren to only include plans with status === 'done'.
 *
 * @param planId - The ID of the plan to get completed children for
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of completed descendant plans sorted by ID
 */
export function getCompletedChildren(
  planId: number,
  allPlans: Map<number, PlanWithFilename>
): PlanWithFilename[] {
  const allChildren = getAllChildren(planId, allPlans);
  return allChildren.filter((plan) => plan.status === 'done');
}

/**
 * Gets all pending children of a plan (recursive).
 * Filters getAllChildren to only include plans with status === 'pending' or 'in_progress'.
 *
 * @param planId - The ID of the plan to get pending children for
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of pending descendant plans sorted by ID
 */
export function getPendingChildren(
  planId: number,
  allPlans: Map<number, PlanWithFilename>
): PlanWithFilename[] {
  const allChildren = getAllChildren(planId, allPlans);
  return allChildren.filter((plan) => plan.status === 'pending' || plan.status === 'in_progress');
}

/**
 * Checks if a plan has any cycles in its parent chain.
 * This is useful for validation and debugging.
 *
 * @param plan - The plan to check for cycles
 * @param allPlans - Map of all plans keyed by ID
 * @returns true if a cycle is detected, false otherwise
 */
export function hasCycleInParentChain(
  plan: PlanWithFilename,
  allPlans: Map<number, PlanWithFilename>
): boolean {
  const visited = new Set<number>();
  let currentPlan = plan;

  while (currentPlan.parent) {
    if (visited.has(currentPlan.parent)) {
      return true; // Cycle detected
    }

    const parentPlan = allPlans.get(currentPlan.parent);
    if (!parentPlan) {
      break; // Parent not found, no cycle
    }

    visited.add(currentPlan.parent);
    currentPlan = parentPlan;
  }

  return false;
}

/**
 * Gets the root plan(s) in a hierarchy.
 * A root plan is one that has no parent.
 *
 * @param allPlans - Map of all plans keyed by ID
 * @returns Array of root plans sorted by ID
 */
export function getRootPlans(allPlans: Map<number, PlanWithFilename>): PlanWithFilename[] {
  return Array.from(allPlans.values())
    .filter((plan) => !plan.parent)
    .sort((a, b) => (a.id || 0) - (b.id || 0));
}
