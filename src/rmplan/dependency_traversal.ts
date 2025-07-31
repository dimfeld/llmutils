import { readAllPlans } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { isPlanPending, isPlanInProgress } from './plans/plan_state_utils.js';
import { debugLog } from '../logging.js';
import * as fs from 'node:fs/promises';

export interface TraversalResult {
  planId: number | null;
  message?: string;
}

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

/**
 * Traverses plan dependencies using breadth-first search to find the first
 * plan that is in a "ready" or "pending" state.
 *
 * @param planId - The ID of the parent plan to start traversal from
 * @param directory - The directory containing plan files
 * @returns TraversalResult with the ID of the first ready/pending dependency, or null if none found
 */
export async function traversePlanDependencies(
  planId: number,
  directory: string
): Promise<TraversalResult> {
  debugLog(
    `[dependency_traversal] Starting traversal for plan ${planId} in directory ${directory}`
  );

  // Validate that the directory exists
  try {
    await fs.access(directory);
  } catch (err) {
    return {
      planId: null,
      message: `Directory not found: ${directory}`,
    };
  }
  const { plans } = await readAllPlans(directory);

  const plan = plans.get(planId);
  if (!plan) {
    return {
      planId: null,
      message: `Plan not found: ${planId}`,
    };
  }

  // Use BFS to find the first ready/pending dependency
  const queue: number[] = [planId];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    // Check for circular dependencies
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    const currentPlan = plans.get(currentId);
    if (!currentPlan) {
      continue;
    }

    // Skip the starting plan itself
    if (currentId !== planId) {
      // Check if this plan is ready or pending
      if (isPlanPending(currentPlan) || isPlanInProgress(currentPlan)) {
        debugLog(`[dependency_traversal] Found ${currentPlan.status} plan: ${currentId}`);
        // For pending plans, we need to check if all its dependencies are done
        // Note: In-progress plans are already being worked on, so they don't need
        // their dependencies checked - they're ready to continue work immediately
        if (isPlanPending(currentPlan)) {
          // Check for edge case: pending plan with no tasks
          if (!currentPlan.tasks || currentPlan.tasks.length === 0) {
            debugLog(
              `[dependency_traversal] Skipping pending plan ${currentId} - no tasks defined`
            );
            const directDeps = getDirectDependencies(currentId, plans);
            queue.push(...directDeps);
            continue;
          }

          if (currentPlan.dependencies && currentPlan.dependencies.length > 0) {
            const allDepsDone = currentPlan.dependencies.every((depId) => {
              const depPlan = plans.get(depId);
              return depPlan && depPlan.status === 'done';
            });

            if (!allDepsDone) {
              debugLog(
                `[dependency_traversal] Plan ${currentId} is not ready - has incomplete dependencies`
              );
              // This plan is not ready yet, continue searching
              const directDeps = getDirectDependencies(currentId, plans);
              queue.push(...directDeps);
              continue;
            }
          }
        }

        // Found a ready plan
        debugLog(`[dependency_traversal] Found ready plan: ${currentId}`);
        return {
          planId: currentId,
        };
      }
    }

    // Add direct dependencies to the queue
    const directDeps = getDirectDependencies(currentId, plans);
    queue.push(...directDeps);
  }

  // No ready/pending dependencies found
  debugLog(`[dependency_traversal] No ready or pending dependencies found for plan ${planId}`);
  return {
    planId: null,
    message: 'No ready or pending dependencies found',
  };
}
