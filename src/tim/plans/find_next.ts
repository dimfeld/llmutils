import type { PlanSchema } from '../planSchema.js';
import { isTaskDone } from '../plans.js';

// Interface for the result of finding a pending task
export interface PendingTaskResult {
  taskIndex: number;
  task: PlanSchema['tasks'][number];
}

// Interface for incomplete task result
export interface IncompleteTaskResult {
  taskIndex: number;
  task: PlanSchema['tasks'][number];
}

// Actionable items are now just tasks
export type ActionableItem = {
  type: 'task';
  taskIndex: number;
  task: PlanSchema['tasks'][number];
};

/**
 * Finds the next pending (not completed) task in a plan.
 *
 * @param plan - The plan schema to search through
 * @returns PendingTaskResult with task index and object, or null if all tasks are done
 */
export function findPendingTask(plan: PlanSchema): PendingTaskResult | null {
  return findNextActionableItem(plan);
}

/**
 * Finds the next actionable item in a plan (an incomplete task).
 *
 * @param plan - The plan schema to search through
 * @returns ActionableItem representing a task to execute, or null if all are done
 */
export function findNextActionableItem(plan: PlanSchema): ActionableItem | null {
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const task = plan.tasks[taskIndex];

    // Skip completed tasks
    if (task.done) {
      continue;
    }

    return {
      type: 'task',
      taskIndex,
      task,
    };
  }

  return null;
}

/**
 * Gets all incomplete tasks in a plan, which are tasks where done is false or undefined.
 * This function is used by the batch mode to collect all pending work that can be
 * processed together.
 *
 * @param plan - The plan schema to search through
 * @returns Array of IncompleteTaskResult objects containing taskIndex and task for all incomplete tasks
 */
export function getAllIncompleteTasks(plan: PlanSchema): IncompleteTaskResult[] {
  const incompleteTasks: IncompleteTaskResult[] = [];

  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const task = plan.tasks[taskIndex];

    // Include tasks where done is false or undefined
    if (!isTaskDone(task)) {
      incompleteTasks.push({
        taskIndex,
        task,
      });
    }
  }

  return incompleteTasks;
}
