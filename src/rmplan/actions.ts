import yaml from 'yaml';
import { planSchema } from './planSchema.js';
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
  // 1. Load and parse the plan file
  const planText = await Bun.file(planFile).text();
  let planData: PlanSchema;
  try {
    planData = yaml.parse(planText);
  } catch (err) {
    throw new Error(`Failed to parse YAML: ${err as Error}`);
  }
  // Validate
  const valid = planSchema.safeParse(planData);
  if (!valid.success) {
    throw new Error(
      'Plan file does not match schema: ' + JSON.stringify(valid.error.issues, null, 2)
    );
  }

  // 2. Find the starting point
  let pending: PendingTaskResult | null = null;
  if (currentTask) {
    const { taskIndex, stepIndex } = currentTask;
    if (
      taskIndex >= 0 &&
      taskIndex < planData.tasks.length &&
      stepIndex >= 0 &&
      stepIndex < planData.tasks[taskIndex].steps.length
    ) {
      pending = {
        taskIndex,
        stepIndex,
        task: planData.tasks[taskIndex],
        step: planData.tasks[taskIndex].steps[stepIndex],
      };
    } else {
      throw new Error('Invalid currentTask indices');
    }
  } else {
    pending = findPendingTask(planData);
  }

  // 3. Handle no pending tasks
  if (!pending) {
    return { planComplete: true, message: 'All steps in the plan are already done.' };
  }

  let output: string[] = [];
  // 4. Mark steps/tasks as done
  const { task } = pending;
  if (options.task) {
    const pendingSteps = task.steps.filter((step) => !step.done);
    for (const step of pendingSteps) {
      step.done = true;
    }
    console.log('Marked all steps in task done\n');
    output.push(task.title);

    for (let i = 0; i < pendingSteps.length; i++) {
      const step = pendingSteps[i];
      output.push(`\n## Step ${i + 1}]\n\n${step.prompt}`);
    }
  } else {
    const numSteps = options.steps || 1;
    let nowDoneSteps = task.steps.slice(pending.stepIndex, pending.stepIndex + numSteps);
    for (const step of nowDoneSteps) {
      step.done = true;
    }

    console.log(
      `Marked ${nowDoneSteps.length} ${nowDoneSteps.length === 1 ? 'step' : 'steps'} done\n`
    );
    if (nowDoneSteps.length > 1) {
      output.push(
        `${task.title} steps ${pending.stepIndex + 1}-${pending.stepIndex + nowDoneSteps.length}`
      );
    } else if (task.steps.length > 1) {
      output.push(`${task.title} step ${pending.stepIndex + 1}`);
    } else {
      output.push(`${task.title}`);
    }

    if (nowDoneSteps.length > 1) {
      for (const step of nowDoneSteps) {
        output.push(`\n## Step ${task.steps.indexOf(step) + 1}\n\n${step.prompt}`);
      }
    } else {
      output.push(`\n${task.steps[pending.stepIndex].prompt}`);
    }
  }

  // 5. Write updated plan back
  const newPlanText = yaml.stringify(planData);
  await Bun.write(planFile, newPlanText);

  // 6. Optionally commit
  const message = output.join('\n');
  console.log(message);
  if (options.commit) {
    console.log('');
    await commitAll(message);
  }

  // 7. Check if plan is now complete
  const stillPending = findPendingTask(planData);
  const planComplete = !stillPending;

  // 8. Return result
  return { planComplete, message };
}
