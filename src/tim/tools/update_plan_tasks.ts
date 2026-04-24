import path from 'node:path';
import { withPlanAutoSync } from '../plan_materialize.js';
import { resolvePlan } from '../plan_display.js';
import { mergeTasksIntoPlan } from '../plan_merge.js';
import { findNextActionableItem } from '../plans/find_next.js';
import { writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import type { ToolContext, ToolResult } from './context.js';
import type { GenerateTasksArguments } from './schemas.js';

export async function updatePlanTasksTool(
  args: GenerateTasksArguments,
  context: ToolContext
): Promise<ToolResult<{ path: string; taskCount: number }>> {
  // Resolve plan to get its numeric ID for withPlanAutoSync
  const { plan: initialPlan } = await resolvePlan(args.plan, context);
  if (typeof initialPlan.id !== 'number') {
    throw new Error('Resolved plan is missing a numeric ID.');
  }

  try {
    context.log?.info('Merging generated plan data');

    // Normalize tasks: convert legacy aliases to 'description'
    const normalizedTasks = args.tasks.map((task) => ({
      title: task.title,
      description: (task.description ?? task.detail ?? task.details)!,
      done: task.done ?? false,
    }));

    const newPlanData: Partial<PlanSchema> = {
      tasks: normalizedTasks,
    };

    if (args.title !== undefined) newPlanData.title = args.title;
    if (args.goal !== undefined) newPlanData.goal = args.goal;
    if (args.details !== undefined) newPlanData.details = args.details;
    if (args.priority !== undefined) newPlanData.priority = args.priority;

    let relativePath = `plan ${initialPlan.id}`;
    let taskCount = 0;
    await withPlanAutoSync(initialPlan.id, context.gitRoot, async () => {
      const { plan, planPath } = await resolvePlan(args.plan, context);
      const updatedPlan = await mergeTasksIntoPlan(newPlanData, plan);

      if (
        (plan.status === 'done' || plan.status === 'needs_review') &&
        findNextActionableItem(updatedPlan) !== null
      ) {
        updatedPlan.status = 'in_progress';
      }

      await writePlanFile(planPath, updatedPlan, { cwdForIdentity: context.gitRoot });
      relativePath = planPath
        ? path.relative(context.gitRoot, planPath) || planPath
        : `plan ${plan.id}`;
      taskCount = updatedPlan.tasks.length;
    });

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
