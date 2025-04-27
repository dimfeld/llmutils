import yaml from 'yaml';
import type { PlanSchema } from './planSchema.js';
import { commitAll } from '../rmfilter/utils.js';

// Interface for the result of finding a pending task
export interface PendingTaskResult {
  taskIndex: number;
  stepIndex: number;
  task: PlanSchema['tasks'][number];
  step: PlanSchema['tasks'][number]['steps'][number];
}

// Finds the next pending task and step in the plan
export function findPendingTask(plan: PlanSchema): PendingTaskResult | null {
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const task = plan.tasks[taskIndex];
    for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
      const step = task.steps[stepIndex];
      if (!step.done) {
        return { taskIndex, stepIndex, task, step };
      }
    }
  }
  return null;
}

// Asynchronously marks steps as done in the plan file
export async function markStepDone(
  planFile: string,
  options: { task?: boolean; steps?: number; commit?: boolean },
  currentTask?: { taskIndex: number; stepIndex: number }
): Promise<{ planComplete: boolean; message: string }> {
  // Implementation will be filled in next step
  throw new Error('markStepDone not yet implemented');
}
