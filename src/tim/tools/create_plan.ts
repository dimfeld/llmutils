import path from 'node:path';
import { resolveTasksDir } from '../configSchema.js';
import { generateNumericPlanId } from '../id_utils.js';
import type { PlanSchema } from '../planSchema.js';
import { generatePlanFilename } from '../utils/filename.js';
import { validateTags } from '../utils/tags.js';
import { clearPlanCache, readAllPlans, writePlanFile } from '../plans.js';
import type { ToolContext, ToolResult } from './context.js';
import type { CreatePlanArguments } from './schemas.js';

export async function createPlanTool(
  args: CreatePlanArguments,
  context: ToolContext
): Promise<ToolResult<{ id: number; path: string }>> {
  clearPlanCache();
  const title = args.title.trim();
  if (!title) {
    throw new Error('Plan title cannot be empty.');
  }

  let planTags: string[] = [];
  try {
    planTags = validateTags(args.tags, context.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  }

  const tasksDir = await resolveTasksDir(context.config);
  const nextId = await generateNumericPlanId(tasksDir);
  const parentPlan =
    args.parent === undefined ? undefined : (await readAllPlans(tasksDir)).plans.get(args.parent);

  if (args.parent !== undefined && !parentPlan) {
    throw new Error(`Parent plan ${args.parent} not found`);
  }

  const plan: PlanSchema = {
    id: nextId,
    title,
    goal: args.goal,
    details: args.details,
    priority: args.priority,
    parent: args.parent,
    dependencies: args.dependsOn || [],
    discoveredFrom: args.discoveredFrom,
    assignedTo: args.assignedTo,
    issue: args.issue || [],
    docs: args.docs || [],
    tags: planTags,
    epic: args.epic ?? false,
    temp: args.temp || false,
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
  };

  const filename = generatePlanFilename(nextId, title);
  const planPath = path.join(tasksDir, filename);

  await writePlanFile(planPath, plan);

  if (parentPlan) {
    if (!parentPlan.dependencies) {
      parentPlan.dependencies = [];
    }
    if (!parentPlan.dependencies.includes(nextId)) {
      parentPlan.dependencies.push(nextId);
      parentPlan.updatedAt = new Date().toISOString();

      if (parentPlan.status === 'done') {
        parentPlan.status = 'in_progress';
        context.log?.info('Parent plan status changed', {
          parentId: parentPlan.id,
          oldStatus: 'done',
          newStatus: 'in_progress',
        });
      }

      await writePlanFile(parentPlan.filename, parentPlan);
      context.log?.info('Updated parent plan dependencies', {
        parentId: parentPlan.id,
        childId: nextId,
      });
    }
  }

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  context.log?.info('Created plan', {
    planId: nextId,
    planPath: relativePath,
  });

  const text = `Created plan ${nextId} at ${relativePath}`;
  return {
    text,
    data: { id: nextId, path: relativePath },
    message: text,
  };
}
