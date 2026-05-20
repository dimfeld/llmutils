import { parsePlanIdFromCliArg } from '../../plans';
import { setTaskDone } from '../../plans/mark_done';
import type { ExecutePlanInfo } from '../types';
import type { TimConfig } from '../../configSchema';
import { log, warn } from '../../../logging';
import { basename, resolve } from 'path';

/** Categorize tasks in a plan into completed and pending lists */
export function categorizeTasks(plan: { tasks?: Array<{ title: string; done?: boolean }> }): {
  completed: Array<{ title: string }>;
  pending: Array<{ title: string }>;
} {
  const tasks = plan.tasks ?? [];
  const completed = tasks.filter((t) => t.done === true).map((t) => ({ title: t.title }));
  const pending = tasks.filter((t) => t.done !== true).map((t) => ({ title: t.title }));
  return { completed, pending };
}

export function logTaskStatus(
  header: string,
  completed: Array<{ title: string }>,
  pending: Array<{ title: string }>,
  _gitRoot: string
) {
  log(`${header}:`);
  if (completed.length) {
    log(
      `- Completed tasks (${completed.length}):${completed.map((t) => `\n  - ${t.title}`).join('')}`
    );
  } else {
    log('- Completed tasks (0)');
  }
  if (pending.length) {
    log(`- Pending tasks (${pending.length}):${pending.map((t) => `\n  - ${t.title}`).join('')}`);
  } else {
    log('- Pending tasks (0)');
  }
}

/**
 * Analyze the implementer output with Gemini 2.5 Flash to determine which plan tasks
 * have been fully completed. Returns an array of task titles that were completed.
 * This is a conservative, best-effort step and will return empty array on any failure.
 */
export async function parseCompletedTasksFromImplementer(
  _implementerOutput: string,
  _planInfo: ExecutePlanInfo,
  _gitRoot: string
): Promise<string[]> {
  throw new Error('No longer implemented');
}

/**
 * Append a review notes section to the bottom of a plan file.
 * Used when tasks are marked done despite unresolved review issues,
 * so the review feedback and affected tasks are preserved in the plan.
 */
export async function appendReviewNotesToPlan(
  planFilePath: string,
  reviewContent: string,
  taskTitles: string[]
): Promise<void> {
  try {
    const absolutePath = resolve(planFilePath);
    const existing = await Bun.file(absolutePath).text();

    const taskList = taskTitles.map((t) => `- ${t}`).join('\n');
    const section = [
      '',
      '## Unresolved Review Issues',
      '',
      '### Tasks Worked On',
      '',
      taskList,
      '',
      '### Review Output',
      '',
      reviewContent,
      '',
    ].join('\n');

    await Bun.write(absolutePath, existing.trimEnd() + '\n' + section);
    log('Appended unresolved review notes to plan file.');
  } catch (e) {
    warn(
      `Failed to append review notes to plan file: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * Mark the specified tasks as done in the plan file.
 * This is a best-effort operation that logs warnings on failure.
 */
export async function markTasksAsDone(
  planFilePath: string,
  taskTitles: string[],
  gitRoot: string,
  timConfig: TimConfig
): Promise<void> {
  for (const title of taskTitles) {
    try {
      const planId = parsePlanIdFromCliArg(basename(planFilePath).replace(/\.plan\.md$/, ''));
      await setTaskDone(planId, { taskIdentifier: title, commit: false }, gitRoot, timConfig);
      log(`Marked task done (from implementer analysis): ${title}`);
    } catch (e) {
      warn(
        `Failed to mark task done for title "${title}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
