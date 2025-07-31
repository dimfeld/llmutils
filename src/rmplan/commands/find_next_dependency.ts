import { traversePlanDependencies } from '../dependency_traversal.js';
import { readAllPlans } from '../plans.js';
import { isPlanReady } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { debugLog } from '../../logging.js';
import * as fs from 'node:fs/promises';

/**
 * Result type for findNextReadyDependency function
 */
export interface NextReadyDependencyResult {
  /**
   * The plan that is ready to be worked on, including its filename
   */
  plan: (PlanSchema & { filename: string }) | null;
  /**
   * Human-readable message describing the result
   */
  message: string;
}

/**
 * Finds the next ready or pending dependency for a given parent plan.
 *
 * This function traverses the dependency graph of the specified parent plan using
 * breadth-first search and returns the first dependency that is actionable:
 * - For "pending" plans: The plan must have all its dependencies marked as "done"
 * - For "in_progress" plans: The plan is already being worked on and is immediately actionable
 *
 * The function handles various edge cases:
 * - Invalid plan IDs (returns null with appropriate message)
 * - Plans with no dependencies (returns null indicating no dependencies found)
 * - Circular dependencies (handled by the traversal function)
 * - Missing dependency files or invalid directory paths
 *
 * @param parentPlanId - The ID of the parent plan to find dependencies for
 * @param directory - The directory containing plan files (defaults to current directory)
 * @returns A NextReadyDependencyResult containing the ready plan (or null) and a descriptive message
 *
 * @example
 * ```typescript
 * const result = await findNextReadyDependency(123, './plans');
 * if (result.plan) {
 *   console.log(`Found ready plan: ${result.plan.title} (${result.plan.filename})`);
 * } else {
 *   console.log(result.message);
 * }
 * ```
 */
export async function findNextReadyDependency(
  parentPlanId: number,
  directory: string = '.'
): Promise<NextReadyDependencyResult> {
  debugLog(`[find_next_dependency] Finding next ready dependency for plan ${parentPlanId}`);

  // Validate directory exists
  try {
    await fs.access(directory);
  } catch (err) {
    return {
      plan: null,
      message: `Directory not found: ${directory}`,
    };
  }

  // Load all plans to get full plan objects
  const { plans } = await readAllPlans(directory);

  // Check if parent plan exists
  const parentPlan = plans.get(parentPlanId);
  if (!parentPlan) {
    return {
      plan: null,
      message: `Plan not found: ${parentPlanId}`,
    };
  }

  // Use the traversal function to find candidates
  const traversalResult = await traversePlanDependencies(parentPlanId, directory);

  if (traversalResult.planId === null) {
    // No ready dependencies found
    return {
      plan: null,
      message: traversalResult.message || 'No ready or pending dependencies found',
    };
  }

  // Get the full plan object
  const readyPlan = plans.get(traversalResult.planId);
  if (!readyPlan) {
    // This shouldn't happen if traversal is working correctly, but handle it gracefully
    return {
      plan: null,
      message: `Internal error: Could not load plan ${traversalResult.planId}`,
    };
  }

  // For in-progress plans, they are immediately actionable
  if (readyPlan.status === 'in_progress') {
    debugLog(`[find_next_dependency] Found in-progress plan ${readyPlan.id}: ${readyPlan.title}`);
    return {
      plan: readyPlan,
      message: `Found in-progress plan: ${readyPlan.title} (ID: ${readyPlan.id})`,
    };
  }

  // For pending plans, double-check that they are actually ready using isPlanReady
  // This provides an additional validation layer
  if (isPlanReady(readyPlan, plans)) {
    debugLog(`[find_next_dependency] Confirmed plan ${readyPlan.id} is ready: ${readyPlan.title}`);
    return {
      plan: readyPlan,
      message: `Found ready plan: ${readyPlan.title} (ID: ${readyPlan.id})`,
    };
  } else {
    // If isPlanReady disagrees with traversal, log for debugging
    debugLog(
      `[find_next_dependency] Warning: Traversal found plan ${readyPlan.id} but isPlanReady returned false`
    );
    return {
      plan: null,
      message: `No dependencies are ready to be worked on`,
    };
  }
}
