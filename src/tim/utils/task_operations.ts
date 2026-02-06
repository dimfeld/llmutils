import { input, select, editor } from '@inquirer/prompts';
import chalk from 'chalk';
import type { PlanSchema } from '../planSchema.js';

export interface TaskInput {
  title: string;
  description: string;
}

export type Task = NonNullable<PlanSchema['tasks']>[number];

/**
 * Find the index of the first task whose title contains the provided search string.
 * Matching is case-insensitive and uses substring search.
 */
export function findTaskByTitle(tasks: Task[], title: string): number {
  const query = title.trim().toLowerCase();
  if (!query) {
    return -1;
  }

  return tasks.findIndex((task) => task.title.trim().toLowerCase().includes(query));
}

/**
 * Prompt the user to select a task interactively and return its index.
 */
export async function selectTaskInteractive(tasks: Task[]): Promise<number> {
  if (!tasks.length) {
    throw new Error('Plan has no tasks to select from.');
  }

  const terminalRows = typeof process.stdout.rows === 'number' ? process.stdout.rows : 24;

  return await select({
    message: 'Select a task:',
    choices: tasks.map((task, index) => ({
      name: formatTaskChoice(task, index),
      value: index,
    })),
    pageSize: Math.min(tasks.length, Math.max(terminalRows - 4, 5)),
  });
}

/**
 * Prompt the user for task information, using defaults when provided.
 */
export async function promptForTaskInfo(initial: Partial<TaskInput> = {}): Promise<TaskInput> {
  const title = await input({
    message: 'Task title:',
    default: initial.title ?? '',
    validate: (value) => Boolean(value.trim()) || 'Title is required.',
  });

  const description = await editor({
    message: 'Task description (opens editor):',
    default: initial.description ?? '',
  });

  if (!description.trim()) {
    throw new Error('Task description cannot be empty.');
  }

  return {
    title: title.trim(),
    description: description.trim(),
  };
}

function formatTaskChoice(task: Task, index: number): string {
  const status = task.done ? chalk.green('✓') : chalk.gray('•');
  const title = task.title.trim() || '(untitled task)';
  return `${status} [${index + 1}] ${title}`; // Display 1-based index to user
}
