import path from 'node:path';
import { resolvePlan } from '../plan_display.js';
import { clearPlanCache, writePlanFile } from '../plans.js';
import type { PlanSchema, TaskSchema } from '../planSchema.js';
import { findTaskByTitle } from '../utils/task_operations.js';
import type { ToolContext, ToolResult } from './context.js';
import type {
  AddPlanTaskArguments,
  ManagePlanTaskArguments,
  RemovePlanTaskArguments,
} from './schemas.js';

type UpdatePlanTaskArguments = {
  plan: string;
  taskTitle?: string;
  taskIndex?: number;
  newTitle?: string;
  newDescription?: string;
  done?: boolean;
};

export async function managePlanTaskTool(
  args: ManagePlanTaskArguments,
  context: ToolContext
): Promise<ToolResult<{ action: ManagePlanTaskArguments['action'] }>> {
  switch (args.action) {
    case 'add': {
      if (!args.title || !args.description) {
        throw new Error('title and description are required for add action');
      }
      const result = await addPlanTaskTool(
        {
          plan: args.plan,
          title: args.title,
          description: args.description,
        },
        context
      );
      return {
        ...result,
        data: { action: 'add', ...(result.data ?? {}) },
      };
    }
    case 'update': {
      const result = await updatePlanTaskTool(
        {
          plan: args.plan,
          taskTitle: args.taskTitle,
          taskIndex: args.taskIndex,
          newTitle: args.title,
          newDescription: args.description,
          done: args.done,
        },
        context
      );
      return {
        ...result,
        data: { action: 'update', ...(result.data ?? {}) },
      };
    }
    case 'remove': {
      const result = await removePlanTaskTool(
        {
          plan: args.plan,
          taskTitle: args.taskTitle,
          taskIndex: args.taskIndex,
        },
        context
      );
      return {
        ...result,
        data: { action: 'remove', ...(result.data ?? {}) },
      };
    }
  }
}

export async function addPlanTaskTool(
  args: AddPlanTaskArguments,
  context: ToolContext
): Promise<ToolResult<{ index: number }>> {
  clearPlanCache();

  const { plan, planPath } = await resolvePlan(args.plan, context);

  const title = args.title.trim();
  const description = args.description.trim();
  if (!title) {
    throw new Error('Task title cannot be empty.');
  }
  if (!description) {
    throw new Error('Task description cannot be empty.');
  }

  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const newTask: TaskSchema = {
    title,
    description,
    done: false,
  };

  tasks.push(newTask);
  plan.tasks = tasks;
  plan.updatedAt = new Date().toISOString();

  await writePlanFile(planPath, plan);

  const index = tasks.length - 1;
  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  context.log?.info('Added task to plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
  });

  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;
  const text = `Added task "${title}" to ${planIdentifier} at index ${index}.`;

  return {
    text,
    data: { index },
    message: text,
  };
}

export async function removePlanTaskTool(
  args: RemovePlanTaskArguments,
  context: ToolContext
): Promise<ToolResult<{ index: number; shifted: number }>> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Plan has no tasks to remove.');
  }

  const index = resolveTaskIndex(plan.tasks, args, 'remove');
  if (index < 0 || index >= plan.tasks.length) {
    throw new Error(
      `Task index ${index} is out of bounds for plan with ${plan.tasks.length} task(s).`
    );
  }

  const previousLength = plan.tasks.length;
  const [removedTask] = plan.tasks.splice(index, 1);
  if (!removedTask) {
    throw new Error(`Failed to remove task at index ${index}.`);
  }

  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planPath, plan);

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  context.log?.info('Removed task from plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
  });

  const shiftedCount = index < previousLength - 1 ? previousLength - index - 1 : 0;
  const shiftWarning =
    shiftedCount > 0 ? ` Indices of ${shiftedCount} subsequent task(s) have shifted.` : '';
  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;

  const text = `Removed task "${removedTask.title}" from ${planIdentifier} (index ${index}).${shiftWarning}`;

  return {
    text,
    data: { index, shifted: shiftedCount },
    message: text,
  };
}

export async function updatePlanTaskTool(
  args: UpdatePlanTaskArguments,
  context: ToolContext
): Promise<ToolResult<{ index: number }>> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('Plan has no tasks to update.');
  }

  if (args.newTitle === undefined && args.newDescription === undefined && args.done === undefined) {
    throw new Error(
      'At least one of newTitle, newDescription, or done must be provided to update a task.'
    );
  }

  const index = resolveTaskIndex(plan.tasks, args, 'update');
  if (index < 0 || index >= plan.tasks.length) {
    throw new Error(
      `Task index ${index} is out of bounds for plan with ${plan.tasks.length} task(s).`
    );
  }

  const task = plan.tasks[index];
  if (!task) {
    throw new Error(`Task at index ${index} not found.`);
  }

  const oldTitle = task.title;
  const updates: string[] = [];

  if (args.newTitle !== undefined) {
    const trimmedTitle = args.newTitle.trim();
    if (!trimmedTitle) {
      throw new Error('New task title cannot be empty.');
    }
    task.title = trimmedTitle;
    updates.push(`title to "${trimmedTitle}"`);
  }

  if (args.newDescription !== undefined) {
    const trimmedDescription = args.newDescription.trim();
    if (!trimmedDescription) {
      throw new Error('New task description cannot be empty.');
    }
    task.description = trimmedDescription;
    updates.push('description');
  }

  if (args.done !== undefined) {
    task.done = args.done;
    updates.push(`done status to ${args.done}`);
  }

  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planPath, plan);

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  context.log?.info('Updated task in plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
    updates: updates.join(', '),
  });

  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;
  const updatesText = updates.length > 0 ? ` Updated: ${updates.join(', ')}.` : '';
  const text = `Updated task "${oldTitle}" in ${planIdentifier} (index ${index}).${updatesText}`;

  return {
    text,
    data: { index },
    message: text,
  };
}

function resolveTaskIndex(
  tasks: PlanSchema['tasks'],
  args: { taskTitle?: string; taskIndex?: number },
  operation: 'remove' | 'update'
): number {
  if (args.taskTitle) {
    const index = findTaskByTitle(tasks, args.taskTitle);
    if (index === -1) {
      throw new Error(`No task found with title containing "${args.taskTitle}".`);
    }
    return index;
  }

  if (args.taskIndex !== undefined) {
    if (!Number.isInteger(args.taskIndex) || args.taskIndex < 0) {
      throw new Error('taskIndex must be a non-negative integer.');
    }
    return args.taskIndex;
  }

  throw new Error(`Provide either taskTitle or taskIndex to ${operation} a task.`);
}
