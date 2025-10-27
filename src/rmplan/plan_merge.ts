import { isTaskDone } from './plans.js';
import type { PlanSchema } from './planSchema.js';
import { planSchema } from './planSchema.js';

export const GENERATED_START_DELIMITER = '<!-- rmplan-generated-start -->';
export const GENERATED_END_DELIMITER = '<!-- rmplan-generated-end -->';

/**
 * Extracts the research section (## Research) position from markdown details if present.
 * Returns the index where the research section starts, or undefined if not found.
 */
export function findResearchSectionStart(details?: string): number | undefined {
  if (!details) {
    return undefined;
  }

  const match = /^## Research$/m.exec(details);
  return match?.index;
}

/**
 * Merges new details into the original details using delimiters to track generated content.
 * - If delimiters exist, replaces content between them.
 * - If delimiters don't exist, inserts them and new content before the Research section (or at the end).
 * This preserves manually-added content like research sections while allowing the tool to update its own content.
 */
export function mergeDetails(
  newDetails: string | undefined,
  originalDetails: string | undefined
): string | undefined {
  if (!newDetails) {
    return originalDetails;
  }

  if (!originalDetails) {
    // No original details, wrap new details in delimiters.
    return `${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
  }

  // Check if delimiters already exist in the original.
  const startIndex = originalDetails.indexOf(GENERATED_START_DELIMITER);
  const endIndex = originalDetails.indexOf(GENERATED_END_DELIMITER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Delimiters exist - replace content between them.
    const before = originalDetails.slice(0, startIndex);
    const after = originalDetails.slice(endIndex + GENERATED_END_DELIMITER.length);
    return `${before}${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}${after}`;
  }

  // Delimiters don't exist - insert them before the Research section or at the end.
  const researchStart = findResearchSectionStart(originalDetails);

  if (researchStart !== undefined) {
    // Insert before the Research section.
    const before = originalDetails.slice(0, researchStart).trim();
    const after = originalDetails.slice(researchStart).trim();
    return `${before}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}\n\n${after}`;
  }

  // No research section - append at the end.
  return `${originalDetails.trim()}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
}

/**
 * Updates plan details within the delimiter-bounded generated section.
 * If append is true, appends to existing generated content.
 * If append is false, replaces existing generated content.
 */
export function updateDetailsWithinDelimiters(
  newDetails: string,
  originalDetails: string | undefined,
  append: boolean
): string {
  if (!originalDetails) {
    // No original details, wrap new details in delimiters.
    return `${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
  }

  // Check if delimiters already exist in the original.
  const startIndex = originalDetails.indexOf(GENERATED_START_DELIMITER);
  const endIndex = originalDetails.indexOf(GENERATED_END_DELIMITER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Delimiters exist - update content between them.
    const before = originalDetails.slice(0, startIndex);
    const after = originalDetails.slice(endIndex + GENERATED_END_DELIMITER.length);
    const existingGenerated = originalDetails
      .slice(startIndex + GENERATED_START_DELIMITER.length, endIndex)
      .trim();

    const updatedGenerated =
      append && existingGenerated ? `${existingGenerated}\n\n${newDetails.trim()}` : newDetails.trim();

    return `${before}${GENERATED_START_DELIMITER}\n${updatedGenerated}\n${GENERATED_END_DELIMITER}${after}`;
  }

  // Delimiters don't exist - insert them before the Research section or at the end.
  const researchStart = findResearchSectionStart(originalDetails);

  if (researchStart !== undefined) {
    // Insert before the Research section.
    const before = originalDetails.slice(0, researchStart).trim();
    const after = originalDetails.slice(researchStart).trim();
    return `${before}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}\n\n${after}`;
  }

  // No research section - append at the end.
  return `${originalDetails.trim()}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
}

/**
 * Merges a partial plan update into the original plan, preserving metadata and completed tasks.
 */
export async function mergeTasksIntoPlan(
  newPlanData: Partial<PlanSchema>,
  originalPlan: PlanSchema
): Promise<PlanSchema> {
  const result = planSchema.safeParse({
    ...originalPlan,
    ...newPlanData,
    // Ensure tasks is always an array.
    tasks: newPlanData.tasks || [],
  });

  if (!result.success) {
    const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    throw new Error(`Plan data failed validation: ${errors}`);
  }

  const newPlan = result.data;

  const updatedPlan: PlanSchema = {
    ...newPlan,
    id: originalPlan.id,
    parent: originalPlan.parent,
    container: originalPlan.container,
    baseBranch: originalPlan.baseBranch,
    changedFiles: originalPlan.changedFiles,
    pullRequest: originalPlan.pullRequest,
    issue: originalPlan.issue,
    docs: originalPlan.docs,
    assignedTo: originalPlan.assignedTo,
    rmfilter: originalPlan.rmfilter,
    dependencies: originalPlan.dependencies,
    project: originalPlan.project,
    generatedBy: 'agent',
    createdAt: originalPlan.createdAt,
    updatedAt: new Date().toISOString(),
    planGeneratedAt: new Date().toISOString(),
    status: originalPlan.status,
    promptsGeneratedAt: new Date().toISOString(),
    priority: newPlanData.priority !== undefined ? newPlanData.priority : originalPlan.priority,
    title: newPlanData.title !== undefined ? newPlanData.title : originalPlan.title,
    goal: newPlanData.goal !== undefined ? newPlanData.goal : originalPlan.goal,
    details: mergeDetails(newPlanData.details, originalPlan.details),
  };

  const originalTasks = originalPlan.tasks || [];
  const newTasks = newPlan.tasks || [];

  const completedTasks = new Map<number, PlanSchema['tasks'][0]>();
  originalTasks.forEach((task, index) => {
    if (isTaskDone(task)) {
      completedTasks.set(index, task);
    }
  });

  const taskIdRegex = /\[TASK-(\d+)\]/;
  const mergedTasks: PlanSchema['tasks'] = [];

  for (const [index, task] of completedTasks) {
    mergedTasks[index] = task;
  }

  newTasks.forEach((newTask) => {
    const match = newTask.title.match(taskIdRegex);
    if (match) {
      const taskIndex = Number.parseInt(match[1], 10) - 1;
      newTask.title = newTask.title.replace(taskIdRegex, '').trim();

      if (!completedTasks.has(taskIndex)) {
        mergedTasks[taskIndex] = newTask;
      }
    } else {
      const matchingTitleTask = originalTasks.findIndex((task) => task.title === newTask.title);
      if (matchingTitleTask >= 0) {
        if (!completedTasks.has(matchingTitleTask)) {
          mergedTasks[matchingTitleTask] = newTask;
        }
      } else {
        mergedTasks.push(newTask);
      }
    }
  });

  updatedPlan.tasks = mergedTasks.filter((task) => task !== undefined);
  return updatedPlan;
}
