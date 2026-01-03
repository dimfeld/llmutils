import chalk from 'chalk';
import { log, warn } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { findTaskByTitle, selectTaskInteractive } from '../utils/task_operations.js';

export interface RemoveTaskOptions {
  title?: string;
  index?: number;
  interactive?: boolean;
}

type PlanTask = NonNullable<PlanSchema['tasks']>[number];

export async function handleRemoveTaskCommand(
  plan: string,
  options: RemoveTaskOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent?.opts?.() ?? {};

  await loadEffectiveConfig(globalOpts.config);

  const planPath = await resolvePlanFile(plan, globalOpts.config);
  const planData = await readPlanFile(planPath);

  if (!Array.isArray(planData.tasks) || planData.tasks.length === 0) {
    throw new Error('Plan has no tasks to remove.');
  }

  const selectionModeCount = [
    options.title ? 1 : 0,
    options.index !== undefined ? 1 : 0,
    options.interactive ? 1 : 0,
  ].reduce((acc, value) => acc + value, 0);

  if (selectionModeCount === 0) {
    throw new Error('Specify one of --title, --index, or --interactive to choose a task.');
  }
  if (selectionModeCount > 1) {
    throw new Error(
      'Please use only one of --title, --index, or --interactive when removing a task.'
    );
  }

  const index = await resolveTaskIndex(planData.tasks, options);

  if (index < 0 || index >= planData.tasks.length) {
    throw new Error(
      `Task index ${index + 1} is out of bounds for plan with ${planData.tasks.length} tasks (valid range: 1-${planData.tasks.length}).`
    );
  }

  const previousLength = planData.tasks.length;
  const [removedTask] = planData.tasks.splice(index, 1);

  if (!removedTask) {
    throw new Error(`Failed to remove task at index ${index + 1}.`);
  }

  planData.updatedAt = new Date().toISOString();
  await writePlanFile(planPath, planData);

  const planIdentifier = planData.id ? `plan ${planData.id}` : 'plan';
  log(
    chalk.green(
      `✓ Removed task "${removedTask.title}" from ${planIdentifier} (${planPath}); it was previously at index ${index + 1}.`
    )
  );

  if (index < previousLength - 1) {
    warn(
      chalk.yellow(
        `Indices of ${previousLength - index - 1} subsequent task(s) have shifted after removal.`
      )
    );
  }
}

async function resolveTaskIndex(tasks: PlanTask[], options: RemoveTaskOptions): Promise<number> {
  if (options.title) {
    const index = findTaskByTitle(tasks, options.title);
    if (index === -1) {
      throw new Error(`No task found with title containing "${options.title}".`);
    }
    return index;
  }

  if (options.index !== undefined) {
    if (!Number.isInteger(options.index) || options.index < 0) {
      throw new Error('--index must be a non-negative integer.');
    }
    return options.index;
  }

  if (options.interactive) {
    try {
      return await selectTaskInteractive(tasks);
    } catch (err: any) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new Error('Interactive task selection cancelled.');
      }
      throw err;
    }
  }

  throw new Error('Unable to resolve task index.');
}
