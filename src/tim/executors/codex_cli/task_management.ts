import { z as z3 } from 'zod/v3';
import { generateObject } from 'ai';
import { createModel } from '../../../common/model_factory';
import { readPlanFile } from '../../plans';
import { setTaskDone } from '../../plans/mark_done';
import type { ExecutePlanInfo } from '../types';
import type { TimConfig } from '../../configSchema';
import { log, warn } from '../../../logging';
import { resolve } from 'path';

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
  gitRoot: string
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
  implementerOutput: string,
  planInfo: ExecutePlanInfo,
  gitRoot: string
): Promise<string[]> {
  try {
    const planFilePath = planInfo.planFilePath.trim();
    if (!planFilePath) {
      return [];
    }

    // Skip entirely during tests or when explicitly disabled. This prevents
    // slow, flaky external model calls from running inside unit tests.
    const disableAutoMark =
      process.env.NODE_ENV === 'test' ||
      process.env.TIM_DISABLE_AUTO_MARK === '1' ||
      process.env.TIM_DISABLE_AUTO_MARK === 'true';
    if (disableAutoMark) {
      warn('Skipping automatic task completion parsing in test/disabled mode');
      return [];
    }

    // Skip if no Google API key is available to avoid network calls in test/dev
    const hasGoogleKey = !!process.env.GOOGLE_API_KEY || !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    if (!hasGoogleKey) {
      warn('Skipping automatic task completion parsing due to missing Google API key');
      return [];
    }

    const plan = await readPlanFile(planFilePath);
    const tasks = (plan.tasks ?? []).map((t: any) => ({
      title: t.title as string,
      description: (t.description as string) ?? '',
      done: t.done === true,
      steps: Array.isArray(t.steps)
        ? t.steps.map((s: any) => ({ prompt: s?.prompt ?? '', done: s?.done === true }))
        : [],
    }));

    const pending = tasks.filter((t) => !t.done);
    if (pending.length === 0) return [];

    const model = await createModel('google/gemini-2.5-flash');

    const prompt = `You are given:
- A software project plan consisting of tasks (with titles, optional descriptions, and steps)
- The implementer agent's output (what was implemented)

Goal: Identify which tasks from the plan were FULLY completed by the implementation. Only select a task if the implementer output clearly indicates the task is fully done (not partially). Use EXACT title matching from the provided task list.

Rules:
- Consider a task complete only if the implementation and tests are evidently finished for that task.
- If uncertain, do not select it.
- Return strict JSON with field "completed_titles" as an array of strings (the exact task titles). No commentary.

Plan tasks (pending only):
${JSON.stringify(pending, null, 2)}

Implementer output:
${implementerOutput}

Return JSON only, like: {"completed_titles": ["Task A", "Task B"]}`;

    const CompletedTasksSchema = z3.object({
      completed_titles: z3.array(z3.string()),
    });

    const res = await generateObject({
      model,
      schema: CompletedTasksSchema,
      prompt,
      temperature: 0.1,
    });

    const pendingTitles = new Set(pending.map((t) => t.title));
    const validCompletedTitles = res.object.completed_titles.filter((title) =>
      pendingTitles.has(title)
    );

    return validCompletedTitles;
  } catch (e) {
    warn(
      `Skipping automatic task completion parsing due to error: ${e instanceof Error ? e.message : String(e)}`
    );
    return [];
  }
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
      await setTaskDone(
        planFilePath,
        { taskIdentifier: title, commit: false },
        gitRoot,
        timConfig
      );
      log(`Marked task done (from implementer analysis): ${title}`);
    } catch (e) {
      warn(
        `Failed to mark task done for title "${title}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
