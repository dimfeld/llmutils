import { buildPlanContext, resolvePlan } from '../plan_display.js';
import type { PlanSchema } from '../planSchema.js';
import type { ToolContext, ToolResult } from './context.js';
import type { GetPlanArguments } from './schemas.js';

export async function getPlanTool(
  args: GetPlanArguments,
  context: ToolContext
): Promise<ToolResult<PlanSchema>> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const text = buildPlanContext(plan, planPath, context);

  const planId = plan.id ? ` ${plan.id}` : '';
  return {
    text,
    data: plan,
    message: `Retrieved plan${planId}`,
  };
}
