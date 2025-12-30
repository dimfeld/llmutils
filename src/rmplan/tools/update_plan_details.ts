import path from 'node:path';
import { resolvePlan } from '../plan_display.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { updateDetailsWithinDelimiters } from '../plan_merge.js';
import type { ToolContext, ToolResult } from './context.js';
import type { UpdatePlanDetailsArguments } from './schemas.js';

export async function updatePlanDetailsTool(
  args: UpdatePlanDetailsArguments,
  context: ToolContext
): Promise<ToolResult<{ path: string }>> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const updatedDetails = updateDetailsWithinDelimiters(args.details, plan.details, args.append);

  const updatedPlan: PlanSchema = {
    ...plan,
    details: updatedDetails,
    updatedAt: new Date().toISOString(),
  };

  await writePlanFile(planPath, updatedPlan);

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  const action = args.append ? 'Appended to' : 'Updated';
  const text = `${action} details in ${relativePath}`;

  return {
    text,
    data: { path: relativePath },
    message: text,
  };
}
