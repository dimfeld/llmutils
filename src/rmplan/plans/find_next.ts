import type { PlanSchema } from '../planSchema.js';

// Interface for the result of finding a pending task
export interface PendingTaskResult {
  taskIndex: number;
  stepIndex: number;
  task: PlanSchema['tasks'][number];
  step: PlanSchema['tasks'][number]['steps'][number];
}

// Discriminated union for actionable items (either a step or a simple task)
export type ActionableItem =
  | {
      type: 'step';
      taskIndex: number;
      stepIndex: number;
      task: PlanSchema['tasks'][number];
      step: PlanSchema['tasks'][number]['steps'][number];
    }
  | {
      type: 'task';
      taskIndex: number;
      task: PlanSchema['tasks'][number];
    };

/**
 * Finds the next pending (not completed) task and step in a plan.
 * This function is maintained for backward compatibility and now uses
 * findNextActionableItem internally, filtering for step-type items only.
 *
 * @param plan - The plan schema to search through
 * @returns PendingTaskResult with task/step indices and objects, or null if all steps are done
 * @deprecated Use findNextActionableItem instead for more flexible task handling
 */
export function findPendingTask(plan: PlanSchema): PendingTaskResult | null {
  const actionableItem = findNextActionableItem(plan);

  // Only return if it's a step type (maintain backward compatibility)
  if (actionableItem && actionableItem.type === 'step') {
    return {
      taskIndex: actionableItem.taskIndex,
      stepIndex: actionableItem.stepIndex,
      task: actionableItem.task,
      step: actionableItem.step,
    };
  }

  // Continue searching for steps in remaining tasks if we found a simple task
  if (actionableItem && actionableItem.type === 'task') {
    // Search from the next task onward for any tasks with steps
    for (let taskIndex = actionableItem.taskIndex + 1; taskIndex < plan.tasks.length; taskIndex++) {
      const task = plan.tasks[taskIndex];

      // Skip completed tasks
      if (task.done) {
        continue;
      }

      // Look for undone steps in this task
      if (task.steps && task.steps.length > 0) {
        for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
          const step = task.steps[stepIndex];
          if (!step.done) {
            return { taskIndex, stepIndex, task, step };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Finds the next actionable item in a plan, which can be either a step or a simple task.
 * This function supports both complex tasks with steps and simple tasks without steps.
 *
 * @param plan - The plan schema to search through
 * @returns ActionableItem representing either a step or simple task to execute, or null if all are done
 */
export function findNextActionableItem(plan: PlanSchema): ActionableItem | null {
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const task = plan.tasks[taskIndex];

    // Skip completed tasks
    if (task.done) {
      continue;
    }

    // If task has no steps, return it as a simple task
    if (!task.steps || task.steps.length === 0) {
      return {
        type: 'task',
        taskIndex,
        task,
      };
    }

    // If task has steps, find the first undone step
    for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
      const step = task.steps[stepIndex];
      if (!step.done) {
        return {
          type: 'step',
          taskIndex,
          stepIndex,
          task,
          step,
        };
      }
    }
  }

  return null;
}
