import chalk from 'chalk';
import { editor } from '@inquirer/prompts';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { promptForTaskInfo, type TaskInput } from '../utils/task_operations.js';

export interface AddTaskOptions {
  title?: string;
  description?: string;
  editor?: boolean;
  files?: string[];
  docs?: string[];
  interactive?: boolean;
}

type PlanTask = NonNullable<PlanSchema['tasks']>[number];
type PlanTaskWithMetadata = PlanTask & {
  files?: string[];
  docs?: string[];
  steps?: unknown[];
};

export async function handleAddTaskCommand(
  plan: string,
  options: AddTaskOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent?.opts?.() ?? {};

  await loadEffectiveConfig(globalOpts.config);

  const planPath = await resolvePlanFile(plan, globalOpts.config);
  const planData = await readPlanFile(planPath);

  const taskInfo = await collectTaskInput(options);

  const tasks = Array.isArray(planData.tasks) ? planData.tasks : [];
  const newTask: PlanTaskWithMetadata = {
    title: taskInfo.title,
    description: taskInfo.description,
    done: false,
    files: taskInfo.files ?? [],
    docs: taskInfo.docs ?? [],
    steps: [],
  };

  tasks.push(newTask);
  planData.tasks = tasks;
  planData.updatedAt = new Date().toISOString();

  await writePlanFile(planPath, planData);

  const index = tasks.length - 1;
  const planIdentifier = planData.id ? `plan ${planData.id}` : 'plan';

  log(
    chalk.green(
      `✓ Added task "${newTask.title}" at index ${index} to ${planIdentifier} (${planPath})`
    )
  );
}

async function collectTaskInput(options: AddTaskOptions): Promise<TaskInput> {
  if (options.interactive) {
    try {
      return await promptForTaskInfo({
        title: options.title,
        description: options.description,
        files: options.files,
        docs: options.docs,
      });
    } catch (err: any) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new Error('Interactive task creation cancelled.');
      }
      throw err;
    }
  }

  const title = options.title?.trim();
  if (!title) {
    throw new Error('Task title is required unless using --interactive.');
  }

  let description = options.description ?? '';
  if (options.editor) {
    try {
      description = await editor({
        message: 'Task description (opens editor):',
        default: options.description ?? '',
        waitForUserInput: false,
      });
    } catch (err: any) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new Error('Task description editor cancelled.');
      }
      throw err;
    }
  }

  if (!description.trim()) {
    throw new Error(
      'Task description is required unless using --interactive or providing one via --editor.'
    );
  }

  return {
    title: title.trim(),
    description: description.trim(),
    files: normalizeStringList(options.files),
    docs: normalizeStringList(options.docs),
  };
}

function normalizeStringList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => value.trim())
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}
