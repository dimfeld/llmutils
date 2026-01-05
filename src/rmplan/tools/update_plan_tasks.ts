import path from 'node:path';
import { resolvePlan } from '../plan_display.js';
import { mergeTasksIntoPlan } from '../plan_merge.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import type { ToolContext, ToolResult } from './context.js';
import type { GenerateTasksArguments } from './schemas.js';

export async function updatePlanTasksTool(
  args: GenerateTasksArguments,
  context: ToolContext
): Promise<ToolResult<{ path: string; taskCount: number }>> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  try {
    context.log?.info('Merging generated plan data');

    // Normalize tasks: convert 'detail' to 'description' for backwards compatibility
    const normalizedTasks = args.tasks.map((task) => ({
      title: task.title,
      description: (task.description ?? task.detail)!,
      done: task.done ?? false,
    }));

    const newPlanData: Partial<PlanSchema> = {
      tasks: normalizedTasks,
    };

    if (args.title !== undefined) newPlanData.title = args.title;
    if (args.goal !== undefined) newPlanData.goal = args.goal;
    if (args.details !== undefined) newPlanData.details = args.details;
    if (args.priority !== undefined) newPlanData.priority = args.priority;

    const updatedPlan = await mergeTasksIntoPlan(newPlanData, plan);

    await writePlanFile(planPath, updatedPlan);

    const relativePath = path.relative(context.gitRoot, planPath) || planPath;
    const taskCount = updatedPlan.tasks.length;
    const text = `Successfully updated plan at ${relativePath} with ${taskCount} task${
      taskCount === 1 ? '' : 's'
    }`;

    return {
      text,
      data: { path: relativePath, taskCount },
      message: text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update plan: ${message}`);
  }
}
