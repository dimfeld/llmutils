import { clearPlanCache, readAllPlans } from '../plans.js';
import { resolveTasksDir } from '../configSchema.js';
import { filterAndSortReadyPlans, formatReadyPlansAsJson } from '../ready_plans.js';
import { normalizeTags } from '../utils/tags.js';
import type { ToolContext, ToolResult } from './context.js';
import type { ListReadyPlansArguments } from './schemas.js';
import type { EnrichedReadyPlan } from '../ready_plans.js';
import type { PlanSchema } from '../planSchema.js';

type ReadyPlansResult = {
  count: number;
  plans: Array<{
    id: PlanSchema['id'];
    title: string;
    goal: string;
    priority?: PlanSchema['priority'];
    status?: PlanSchema['status'];
    taskCount: number;
    completedTasks: number;
    needsGenerate: boolean;
    dependencies: PlanSchema['dependencies'];
    assignedTo?: string;
    filename: string;
    createdAt?: string;
    updatedAt?: string;
    tags: string[];
  }>;
};

export async function listReadyPlansTool(
  args: ListReadyPlansArguments,
  context: ToolContext
): Promise<ToolResult<ReadyPlansResult>> {
  try {
    clearPlanCache();
    const tasksDir = await resolveTasksDir(context.config);
    // Bypass the in-memory cache so tool clients always see the latest edits.
    const { plans } = await readAllPlans(tasksDir, false);

    let readyPlans = filterAndSortReadyPlans(plans, {
      pendingOnly: args.pendingOnly ?? false,
      priority: args.priority,
      sortBy: args.sortBy ?? 'priority',
      epicId: args.epic,
    });

    const desiredTags = normalizeTags(args.tags);
    if (desiredTags.length > 0) {
      const tagFilter = new Set(desiredTags);
      readyPlans = readyPlans.filter((plan) => {
        const planTags = normalizeTags(plan.tags);
        if (planTags.length === 0) {
          return false;
        }
        return planTags.some((tag) => tagFilter.has(tag));
      });
    }

    if (args.limit && args.limit > 0) {
      readyPlans = readyPlans.slice(0, args.limit);
    }

    const jsonOutput = formatReadyPlansAsJson(readyPlans as Array<EnrichedReadyPlan<PlanSchema>>, {
      gitRoot: context.gitRoot,
    });
    const parsedOutput = JSON.parse(jsonOutput) as ReadyPlansResult;

    return {
      text: jsonOutput,
      data: parsedOutput,
      message: `Found ${parsedOutput.count} ready plan${parsedOutput.count === 1 ? '' : 's'}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to list ready plans: ${message}`);
  }
}
