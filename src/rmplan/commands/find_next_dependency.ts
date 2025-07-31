import { traversePlanDependencies, getDirectDependencies } from '../dependency_traversal.js';
import { readAllPlans } from '../plans.js';
import { isPlanReady } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { debugLog } from '../../logging.js';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';

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
      message: chalk.red(`Directory not found: ${directory}`) + 
        '\n' + chalk.yellow('→ Try:') +
        '\n  • Check the path is correct' +
        '\n  • Check directory permissions' +
        '\n  • Use an absolute path if using relative paths',
    };
  }

  // Load all plans to get full plan objects
  const { plans } = await readAllPlans(directory);

  // Check if parent plan exists
  const parentPlan = plans.get(parentPlanId);
  if (!parentPlan) {
    return {
      plan: null,
      message: chalk.red(`Plan not found: ${parentPlanId}`) +
        '\n' + chalk.yellow('→ Try:') +
        '\n  • Run ' + chalk.cyan('rmplan list') + ' to see available plans' +
        '\n  • Check the plan ID is correct' +
        '\n  • Ensure the plan file exists in the specified directory',
    };
  }

  // Collect all dependencies using BFS
  const allDependencies = new Set<number>();
  const queue: number[] = [parentPlanId];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const currentId = queue.shift()!;

    // Check for circular dependencies
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    // Skip the starting plan itself
    if (currentId !== parentPlanId) {
      allDependencies.add(currentId);
    }

    // Add direct dependencies to the queue
    const directDeps = getDirectDependencies(currentId, plans);
    queue.push(...directDeps);
  }

  // Filter candidates to only include pending or in_progress plans
  const candidates = Array.from(allDependencies)
    .map((id) => plans.get(id))
    .filter((plan): plan is PlanSchema & { filename: string } => {
      if (!plan) return false;
      const status = plan.status || 'pending';
      return status === 'pending' || status === 'in_progress';
    });

  // Filter out plans with 'maybe' priority and check readiness
  const readyCandidates = candidates.filter((plan) => {
    // Skip plans with 'maybe' priority
    if (plan.priority === 'maybe') {
      debugLog(`[find_next_dependency] Skipping plan ${plan.id} with 'maybe' priority`);
      return false;
    }

    const status = plan.status || 'pending';

    // In-progress plans are always ready
    if (status === 'in_progress') {
      return true;
    }

    // For pending plans, check for tasks and dependencies
    if (!plan.tasks || plan.tasks.length === 0) {
      debugLog(`[find_next_dependency] Skipping pending plan ${plan.id} - no tasks defined`);
      return false;
    }

    // Check if all dependencies are done
    if (!plan.dependencies || plan.dependencies.length === 0) {
      return true;
    }

    return plan.dependencies.every((depId) => {
      const depPlan = plans.get(depId);
      return depPlan && depPlan.status === 'done';
    });
  });

  if (readyCandidates.length === 0) {
    // Provide detailed explanation of why no dependencies are ready
    const allDependencyPlans = Array.from(allDependencies)
      .map((id) => plans.get(id))
      .filter((plan): plan is PlanSchema & { filename: string } => plan !== null);

    let reason = '';
    
    if (allDependencyPlans.length === 0) {
      reason = 'No dependencies found for this plan';
    } else {
      const doneCount = allDependencyPlans.filter(p => (p?.status || 'pending') === 'done').length;
      const pendingNoTasks = allDependencyPlans.filter(p => 
        ((p?.status || 'pending') === 'pending') && (!p?.tasks || p.tasks.length === 0)
      ).length;
      const maybeCount = allDependencyPlans.filter(p => p?.priority === 'maybe').length;
      const blockedCount = allDependencyPlans.filter(p => {
        const status = p?.status || 'pending';
        if (status !== 'pending') return false;
        if (!p?.dependencies || p.dependencies.length === 0) return false;
        return p.dependencies.some(depId => {
          const depPlan = plans.get(depId);
          return !depPlan || (depPlan.status || 'pending') !== 'done';
        });
      }).length;

      if (doneCount === allDependencyPlans.length) {
        reason = chalk.green('All dependencies are complete') + ' - ready to work on the parent plan';
      } else if (pendingNoTasks > 0) {
        reason = `${pendingNoTasks} dependencies have no actionable tasks`;
        reason += '\n' + chalk.yellow('→ Try:') + ' Run ' + chalk.cyan('rmplan prepare') + ' to add detailed steps';
      } else if (maybeCount === allDependencyPlans.length - doneCount) {
        reason = 'All pending dependencies have "maybe" priority';
        reason += '\n' + chalk.yellow('→ Try:') + ' Review and update priorities for dependencies that should be implemented';
      } else if (blockedCount > 0) {
        reason = `${blockedCount} dependencies are blocked by incomplete prerequisites`;
        reason += '\n' + chalk.yellow('→ Try:') + ' Work on the blocking dependencies first, or check the dependency chain';
      } else {
        reason = 'Dependencies exist but none are ready to work on';
      }
    }

    return {
      plan: null,
      message: chalk.yellow('No ready dependencies found') + '\n' + reason,
    };
  }

  // Sort by status first (in_progress > pending), then priority, then by ID
  readyCandidates.sort((a, b) => {
    // Status order - in_progress comes first
    const aStatus = a.status || 'pending';
    const bStatus = b.status || 'pending';

    if (aStatus !== bStatus) {
      // in_progress should come before pending
      if (aStatus === 'in_progress') return -1;
      if (bStatus === 'in_progress') return 1;
    }

    // Define priority order - higher number means higher priority
    const priorityOrder: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
    const aPriority = a.priority ? priorityOrder[a.priority] || 0 : 0;
    const bPriority = b.priority ? priorityOrder[b.priority] || 0 : 0;

    // Sort by priority descending (highest first)
    if (aPriority !== bPriority) {
      return bPriority - aPriority;
    }

    // If priorities are the same, sort by ID ascending
    const aId = a.id || 0;
    const bId = b.id || 0;

    if (typeof aId === 'number' && typeof bId === 'number') {
      return aId - bId;
    }
    return 0;
  });

  const selectedPlan = readyCandidates[0];

  // Return appropriate message based on plan status
  if (selectedPlan.status === 'in_progress') {
    debugLog(
      `[find_next_dependency] Found in-progress plan ${selectedPlan.id}: ${selectedPlan.title}`
    );
    return {
      plan: selectedPlan,
      message: `Found in-progress plan: ${selectedPlan.title} (ID: ${selectedPlan.id})`,
    };
  } else {
    debugLog(`[find_next_dependency] Found ready plan ${selectedPlan.id}: ${selectedPlan.title}`);
    return {
      plan: selectedPlan,
      message: `Found ready plan: ${selectedPlan.title} (ID: ${selectedPlan.id})`,
    };
  }
}
