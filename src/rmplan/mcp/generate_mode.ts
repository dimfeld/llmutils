import path from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import { z } from 'zod/v4';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeGenerationPrompt,
} from '../prompt.js';
import {
  normalizeContainerToEpic,
  prioritySchema,
  type PlanSchema,
  type TaskSchema,
} from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import { resolveTasksDir } from '../configSchema.js';
import { buildPlanContext, resolvePlan } from '../plan_display.js';
import { mcpGetPlan } from '../commands/show.js';
import { mcpListReadyPlans } from '../commands/ready.js';
import { readAllPlans, writePlanFile, clearPlanCache } from '../plans.js';
import { findTaskByTitle } from '../utils/task_operations.js';
import { mergeTasksIntoPlan, updateDetailsWithinDelimiters } from '../plan_merge.js';
import { loadCompactPlanPrompt } from './prompts/compact_plan.js';
import { filterAndSortReadyPlans, formatReadyPlansAsJson } from '../ready_plans.js';
import { generateNumericPlanId } from '../id_utils.js';
import { generatePlanFilename } from '../utils/filename.js';
import { validateTags } from '../utils/tags.js';

export interface GenerateModeRegistrationContext {
  config: RmplanConfig;
  configPath?: string;
  gitRoot: string;
}

const questionText = `Ask one concise, high-impact question at a time that will help you improve the plan's tasks and execution details. As you figure things out, update the details in the plan file if necessary. Ask as many questions as you need to figure things out, since it improves the implementation quality.`;

function parseBooleanOption(value: unknown, defaultValue = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (!value) {
    return defaultValue;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (
      normalized === '' ||
      normalized === 'false' ||
      normalized === '0' ||
      normalized === 'no' ||
      normalized === 'n'
    ) {
      return false;
    }
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') {
      return true;
    }
  }

  return Boolean(value);
}

export async function loadResearchPrompt(
  args: { plan?: string; allowMultiplePlans?: unknown },
  context: GenerateModeRegistrationContext
) {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan ?? '', context);

  const allowMultiplePlans = parseBooleanOption(args.allowMultiplePlans, true);
  const parentPlanId = typeof plan.id === 'number' ? plan.id : undefined;

  // If plan has simple: true, skip research and use simple generation flow
  if (plan.simple) {
    return loadGeneratePrompt({ plan: args.plan, allowMultiplePlans }, context);
  }

  const contextBlock = buildPlanContext(plan, planPath, context);

  const multiplePlansGuidance = allowMultiplePlans
    ? `

# Multiple Plan Creation

If you determine that the scope of this plan is large enough that it would benefit from being broken down into multiple independent plans, you should create additional plans. Consider creating multiple plans when:

1. The work can be naturally divided into separate phases or parts that can be merged independently
2. Different aspects of the work could be worked on in parallel by different agents
3. The plan has distinct areas of functionality that have minimal interdependencies
4. Breaking it down would reduce cognitive load and make each plan more focused

When creating multiple plans:
- Use the create-plan tool to create each new plan with appropriate title, goal, details, and priority
- Set the parent field to ${parentPlanId !== undefined ? parentPlanId : 'the current plan ID'} for all child plans
- Use the dependencies field to specify which plans should be completed before others
- Document the relationship between plans in each plan's details section
- Each plan should be independently implementable and testable
- Each plan should deliver real, demonstrable functionality that works end-to-end

IMPORTANT: Do NOT split plans by architectural layers (frontend/backend, UI/API, client/server). Each plan should deliver a complete, working feature that spans all necessary layers. Split by feature areas or functional domains instead, ensuring each plan produces real, testable value.

Only create multiple plans if it genuinely improves the project organization. For smaller or tightly coupled features, a single plan is preferred.`
    : '';

  const text = `${generateClaudeCodePlanningPrompt(contextBlock, {
    includeNextInstructionSentence: false,
    withBlockingSubissues: false,
    parentPlanId,
  })}${multiplePlansGuidance}

${generateClaudeCodeResearchPrompt(`Once your research is complete`)}

Add your guide directly to the plan file at ${planPath} under a "## Implementation Guide" heading. You can directly edit this file; don't use the rmplan MCP tools for adding this guide. Be verbose in your findings - the more insights you include from your exploration, the better.

When done, collaborate with your human partner to refine this plan. ${questionText}`;

  // The line above about directly editing the file is because it doesn't seem to output as much research when using MCP
  // tools compared to directly editing the file

  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

export async function loadQuestionsPrompt(
  args: { plan?: string },
  context: GenerateModeRegistrationContext
) {
  clearPlanCache();
  let contextBlock = '';
  if (args.plan) {
    const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
    contextBlock = buildPlanContext(plan, planPath, context) + '\n\n';
  }

  const text = `${contextBlock}You are collaborating with a human partner to refine this plan. ${questionText}`;

  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

export async function loadPlanPrompt(
  args: { plan: string },
  context: GenerateModeRegistrationContext
) {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const contextBlock = buildPlanContext(plan, planPath, context);

  const text = `${contextBlock}\n\nWait for your human collaborator to review the plan and provide further instructions before taking any additional action.`;

  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

export async function loadGeneratePrompt(
  args: { plan?: string; allowMultiplePlans?: unknown },
  context: GenerateModeRegistrationContext
) {
  clearPlanCache();
  let contextBlock = '';
  let parentPlanId: number | undefined;
  if (args.plan) {
    const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
    contextBlock = buildPlanContext(plan, planPath, context);
    parentPlanId = typeof plan.id === 'number' ? plan.id : undefined;
  }

  const allowMultiplePlans = parseBooleanOption(args.allowMultiplePlans, true);

  const multiplePlansGuidance = allowMultiplePlans
    ? `

# Multiple Plan Creation

If you determine that the scope of this plan is large enough that it would benefit from being broken down into multiple independent plans, you should create additional plans. Consider creating multiple plans when:

1. The work can be naturally divided into separate phases or parts that can be merged independently
2. Different aspects of the work could be worked on in parallel by different agents
3. The plan has distinct areas of functionality that have minimal interdependencies
4. Breaking it down would reduce cognitive load and make each plan more focused

When creating multiple plans:
- Use the create-plan tool to create each new plan with appropriate title, goal, details, and priority
- Set the parent field to ${parentPlanId !== undefined ? parentPlanId : 'the current plan ID'} for all child plans
- Use the dependencies field to specify which plans should be completed before others
- Document the relationship between plans in each plan's details section
- Each plan should be independently implementable and testable
- Each plan should deliver real, demonstrable functionality that works end-to-end

IMPORTANT: Do NOT split plans by architectural layers (frontend/backend, UI/API, client/server). Each plan should deliver a complete, working feature that spans all necessary layers. Split by feature areas or functional domains instead, ensuring each plan produces real, testable value.

Only create multiple plans if it genuinely improves the project organization. For smaller or tightly coupled features, a single plan is preferred.`
    : '';

  const text = `${generateClaudeCodeGenerationPrompt(contextBlock, {
    includeMarkdownFormat: false,
    withBlockingSubissues: false,
  })}${multiplePlansGuidance}

Use the update-plan-tasks tool to save the generated plan with the following structure:
- title: The overall project title
- goal: The overall project goal
- details: Comprehensive project details including acceptance criteria, technical considerations, and any research findings
- priority: The priority level (low|medium|high|urgent)
- tasks: An array of tasks, where each task has:
  - title: A concise task title
  - description: Detailed task description

The list of tasks should correspond to the steps in your step-by-step guide.`;

  return {
    messages: [
      {
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text,
        },
      },
    ],
  };
}

// Simplified task schema for MCP tool parameters
const taskSchema = z.object({
  title: z.string().describe('Short title for the task'),
  description: z.string().describe('Detailed description of what needs to be done'),
  done: z.boolean().optional().describe('Whether this task is completed (default: false)'),
});

export const addPlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    title: z.string().min(1, 'Task title cannot be empty.').describe('Task title to add'),
    description: z
      .string()
      .min(1, 'Task description cannot be empty.')
      .describe('Detailed description for the new task'),
  })
  .describe('Add a task to a plan');

export const removePlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    taskTitle: z
      .string()
      .optional()
      .describe('Task title to search for (partial match, case-insensitive).'),
    taskIndex: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Task index (0-based) to remove.'),
  })
  .superRefine((value, ctx) => {
    if (value.taskTitle === undefined && value.taskIndex === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either taskTitle or taskIndex to remove a task.',
        path: ['taskTitle'],
      });
    }
  })
  .describe('Remove a task from a plan');

export const generateTasksParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to update'),
    title: z.string().optional().describe('Plan title'),
    goal: z.string().optional().describe('High-level goal of the plan'),
    details: z.string().optional().describe('Additional details about the plan in markdown format'),
    priority: prioritySchema.optional().describe('Priority level for the plan'),
    tasks: z.array(taskSchema).describe('List of tasks to be completed'),
  })
  .describe('Update a plan file with generated tasks and details');

export type GenerateTasksArguments = z.infer<typeof generateTasksParameters>;

export const getPlanParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to retrieve'),
  })
  .describe('Retrieve the full plan text for a given plan ID or file path');

export type GetPlanArguments = z.infer<typeof getPlanParameters>;

export const updatePlanDetailsParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to update'),
    details: z.string().describe('New details text to add or replace within the generated section'),
    append: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'If true, append the new details to existing generated content. If false, replace existing generated content (default: false)'
      ),
  })
  .describe('Update plan details within the delimiter-bounded generated section');

export type UpdatePlanDetailsArguments = z.infer<typeof updatePlanDetailsParameters>;

export const managePlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    action: z.enum(['add', 'update', 'remove']).describe('Action to perform on the task'),
    // Task identification (for update and remove)
    taskTitle: z
      .string()
      .optional()
      .describe(
        'Task title to search for (partial match, case-insensitive). Preferred over index.'
      ),
    taskIndex: z.number().int().optional().describe('Task index (0-based)'),
    // Task creation/update fields
    title: z.string().optional().describe('Task title (required for add, optional for update)'),
    description: z
      .string()
      .optional()
      .describe('Task description (required for add, optional for update)'),
    done: z.boolean().optional().describe('Mark task as done or not done (update only)'),
  })
  .describe('Manage tasks in a plan: add, update, or remove');

export type ManagePlanTaskArguments = z.infer<typeof managePlanTaskParameters>;

// Legacy types for internal functions
type AddPlanTaskArguments = z.infer<typeof addPlanTaskParameters>;

type RemovePlanTaskArguments = z.infer<typeof removePlanTaskParameters>;

type UpdatePlanTaskArguments = {
  plan: string;
  taskTitle?: string;
  taskIndex?: number;
  newTitle?: string;
  newDescription?: string;
  done?: boolean;
};

export const listReadyPlansParameters = z
  .object({
    priority: prioritySchema
      .optional()
      .describe('Filter by priority level (low|medium|high|urgent|maybe)'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum number of plans to return (default: all)'),
    pendingOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe('Show only pending plans, exclude in_progress (default: false)'),
    sortBy: z
      .enum(['priority', 'id', 'title', 'created', 'updated'])
      .optional()
      .default('priority')
      .describe('Sort field (default: priority)'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Filter to plans that include any of the provided tags'),
    epic: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Filter to plans belonging to this epic (directly or indirectly)'),
  })
  .describe('List all ready plans that can be executed');

export type ListReadyPlansArguments = z.infer<typeof listReadyPlansParameters>;

export const createPlanParameters = z
  .object({
    title: z.string().describe('Plan title'),
    goal: z.string().optional().describe('High-level goal'),
    details: z.string().optional().describe('Plan details (markdown)'),
    priority: prioritySchema.optional().describe('Priority level'),
    parent: z.number().optional().describe('Parent plan ID'),
    dependsOn: z
      .array(z.number())
      .optional()
      .describe('Plan IDs blocking this plan, including direct children'),
    discoveredFrom: z.number().optional().describe('Plan ID this was discovered from'),
    assignedTo: z.string().optional().describe('Username to assign plan to'),
    issue: z.array(z.string()).optional().describe('Task tracker issue URLs'),
    docs: z.array(z.string()).optional().describe('Documentation file paths'),
    tags: z.array(z.string()).optional().describe('Tags to assign to the plan'),
    container: z.boolean().optional().describe('Deprecated legacy flag. Use epic instead.'),
    epic: z
      .boolean()
      .optional()
      .describe(
        'Mark plan as an epic for organizing children plans with no implementation work in the plan itself'
      ),
    temp: z.boolean().optional().describe('Mark as temporary plan'),
  })
  .transform((value) => normalizeContainerToEpic(value))
  .describe('Create a new plan file');

export type CreatePlanArguments = z.infer<typeof createPlanParameters>;

export type GenerateModeExecutionLogger = {
  debug: (message: string, data?: SerializableValue) => void;
  error: (message: string, data?: SerializableValue) => void;
  info: (message: string, data?: SerializableValue) => void;
  warn: (message: string, data?: SerializableValue) => void;
};

function wrapLogger(log: GenerateModeExecutionLogger, prefix: string): GenerateModeExecutionLogger {
  return {
    debug: (message, data) => log.debug(`${prefix}${message}`, data),
    error: (message, data) => log.error(`${prefix}${message}`, data),
    info: (message, data) => log.info(`${prefix}${message}`, data),
    warn: (message, data) => log.warn(`${prefix}${message}`, data),
  };
}

export async function mcpManagePlanTask(
  args: ManagePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();
  switch (args.action) {
    case 'add': {
      if (!args.title || !args.description) {
        throw new UserError('title and description are required for add action');
      }
      return mcpAddPlanTask(
        {
          plan: args.plan,
          title: args.title,
          description: args.description,
        },
        context,
        execContext
      );
    }
    case 'update': {
      return mcpUpdatePlanTask(
        {
          plan: args.plan,
          taskTitle: args.taskTitle,
          taskIndex: args.taskIndex,
          newTitle: args.title,
          newDescription: args.description,
          done: args.done,
        },
        context,
        execContext
      );
    }
    case 'remove': {
      return mcpRemovePlanTask(
        {
          plan: args.plan,
          taskTitle: args.taskTitle,
          taskIndex: args.taskIndex,
        },
        context,
        execContext
      );
    }
  }
}

export async function mcpAddPlanTask(
  args: AddPlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();

  const { plan, planPath } = await resolvePlan(args.plan, context);

  const title = args.title.trim();
  const description = args.description.trim();
  if (!title) {
    throw new UserError('Task title cannot be empty.');
  }
  if (!description) {
    throw new UserError('Task description cannot be empty.');
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
  execContext?.log.info('Added task to plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
  });

  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;
  return `Added task "${title}" to ${planIdentifier} at index ${index}.`;
}

export async function mcpRemovePlanTask(
  args: RemovePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new UserError('Plan has no tasks to remove.');
  }

  const index = resolveRemovalIndex(plan.tasks, args);
  if (index < 0 || index >= plan.tasks.length) {
    throw new UserError(
      `Task index ${index} is out of bounds for plan with ${plan.tasks.length} task(s).`
    );
  }

  const previousLength = plan.tasks.length;
  const [removedTask] = plan.tasks.splice(index, 1);
  if (!removedTask) {
    throw new UserError(`Failed to remove task at index ${index}.`);
  }

  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planPath, plan);

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  execContext?.log.info('Removed task from plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
  });

  const shiftedCount = index < previousLength - 1 ? previousLength - index - 1 : 0;
  const shiftWarning =
    shiftedCount > 0 ? ` Indices of ${shiftedCount} subsequent task(s) have shifted.` : '';
  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;

  return `Removed task "${removedTask.title}" from ${planIdentifier} (index ${index}).${shiftWarning}`;
}

export async function mcpUpdatePlanTask(
  args: UpdatePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new UserError('Plan has no tasks to update.');
  }

  // Ensure at least one update field is provided
  if (args.newTitle === undefined && args.newDescription === undefined && args.done === undefined) {
    throw new UserError(
      'At least one of newTitle, newDescription, or done must be provided to update a task.'
    );
  }

  const index = resolveTaskIndex(plan.tasks, args, 'update');
  if (index < 0 || index >= plan.tasks.length) {
    throw new UserError(
      `Task index ${index} is out of bounds for plan with ${plan.tasks.length} task(s).`
    );
  }

  const task = plan.tasks[index];
  if (!task) {
    throw new UserError(`Task at index ${index} not found.`);
  }

  const oldTitle = task.title;
  const updates: string[] = [];

  if (args.newTitle !== undefined) {
    const trimmedTitle = args.newTitle.trim();
    if (!trimmedTitle) {
      throw new UserError('New task title cannot be empty.');
    }
    task.title = trimmedTitle;
    updates.push(`title to "${trimmedTitle}"`);
  }

  if (args.newDescription !== undefined) {
    const trimmedDescription = args.newDescription.trim();
    if (!trimmedDescription) {
      throw new UserError('New task description cannot be empty.');
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
  execContext?.log.info('Updated task in plan', {
    planId: plan.id ?? null,
    planPath: relativePath,
    index,
    updates: updates.join(', '),
  });

  const planIdentifier = plan.id ? `plan ${plan.id}` : relativePath;
  const updatesText = updates.length > 0 ? ` Updated: ${updates.join(', ')}.` : '';

  return `Updated task "${oldTitle}" in ${planIdentifier} (index ${index}).${updatesText}`;
}

function resolveRemovalIndex(tasks: PlanSchema['tasks'], args: RemovePlanTaskArguments): number {
  return resolveTaskIndex(tasks, args, 'remove');
}

function resolveTaskIndex(
  tasks: PlanSchema['tasks'],
  args: { taskTitle?: string; taskIndex?: number },
  operation: 'remove' | 'update'
): number {
  if (args.taskTitle) {
    const index = findTaskByTitle(tasks, args.taskTitle);
    if (index === -1) {
      throw new UserError(`No task found with title containing "${args.taskTitle}".`);
    }
    return index;
  }

  if (args.taskIndex !== undefined) {
    if (!Number.isInteger(args.taskIndex) || args.taskIndex < 0) {
      throw new UserError('taskIndex must be a non-negative integer.');
    }
    return args.taskIndex;
  }

  throw new UserError(`Provide either taskTitle or taskIndex to ${operation} a task.`);
}

function normalizeList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => value.trim())
    .filter((value, index, arr) => value.length > 0 && arr.indexOf(value) === index);
}

export async function mcpUpdatePlanDetails(
  args: UpdatePlanDetailsArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
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
  return `${action} details in ${relativePath}`;
}

export async function mcpUpdatePlanTasks(
  args: GenerateTasksArguments,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();
  const { plan, planPath } = await resolvePlan(args.plan, context);

  try {
    execContext.log.info('Merging generated plan data');

    const newPlanData: Partial<PlanSchema> = {
      tasks: args.tasks as PlanSchema['tasks'],
    };

    if (args.title !== undefined) newPlanData.title = args.title;
    if (args.goal !== undefined) newPlanData.goal = args.goal;
    if (args.details !== undefined) newPlanData.details = args.details;
    if (args.priority !== undefined) newPlanData.priority = args.priority;

    const updatedPlan = await mergeTasksIntoPlan(newPlanData, plan);

    await writePlanFile(planPath, updatedPlan);

    const relativePath = path.relative(context.gitRoot, planPath) || planPath;
    const taskCount = updatedPlan.tasks.length;
    return `Successfully updated plan at ${relativePath} with ${taskCount} task${taskCount === 1 ? '' : 's'}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to update plan: ${message}`);
  }
}

export async function mcpCreatePlan(
  args: CreatePlanArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();
  const title = args.title.trim();
  if (!title) {
    throw new UserError('Plan title cannot be empty.');
  }

  let planTags: string[] = [];
  try {
    planTags = validateTags(args.tags, context.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(message);
  }

  const tasksDir = await resolveTasksDir(context.config);
  const nextId = await generateNumericPlanId(tasksDir);

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

  // Update parent plan dependencies to maintain bidirectional relationship
  if (args.parent !== undefined) {
    const { plans } = await readAllPlans(tasksDir);
    const parentPlan = plans.get(args.parent);
    if (!parentPlan) {
      throw new UserError(`Parent plan ${args.parent} not found`);
    }

    // Add this plan's ID to the parent's dependencies
    if (!parentPlan.dependencies) {
      parentPlan.dependencies = [];
    }
    if (!parentPlan.dependencies.includes(nextId)) {
      parentPlan.dependencies.push(nextId);
      parentPlan.updatedAt = new Date().toISOString();

      if (parentPlan.status === 'done') {
        parentPlan.status = 'in_progress';
        execContext?.log.info('Parent plan status changed', {
          parentId: parentPlan.id,
          oldStatus: 'done',
          newStatus: 'in_progress',
        });
      }

      // Write the updated parent plan
      await writePlanFile(parentPlan.filename, parentPlan);
      execContext?.log.info('Updated parent plan dependencies', {
        parentId: parentPlan.id,
        childId: nextId,
      });
    }
  }

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  execContext?.log.info('Created plan', {
    planId: nextId,
    planPath: relativePath,
  });

  return `Created plan ${nextId} at ${relativePath}`;
}

export function registerGenerateMode(
  server: FastMCP,
  context: GenerateModeRegistrationContext
): void {
  server.addPrompt({
    name: 'generate-plan',
    description:
      'Generate a detailed implementation plan with research. Performs research, collects findings, and generates tasks after collaborating with the user.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to generate',
        required: true,
      },
      {
        name: 'allowMultiplePlans',
        description:
          'Set to true to allow the agent to create multiple independent plans if the scope is large enough to benefit from breaking it down into phases or parts that can be merged independently.',
        required: false,
      },
    ],
    load: async (args) =>
      loadResearchPrompt({ plan: args.plan, allowMultiplePlans: args.allowMultiplePlans }, context),
  });

  server.addPrompt({
    name: 'plan-questions',
    description: 'Ask focused questions to collaborate with the user on refining a plan.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to discuss with the user',
        required: false,
      },
    ],
    load: async (args) => loadQuestionsPrompt({ plan: args.plan }, context),
  });

  server.addPrompt({
    name: 'compact-plan',
    description:
      'Summarize a completed plan for archival by generating the compaction YAML output for review.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to compact',
        required: true,
      },
    ],
    load: async (args) => {
      if (!args.plan) {
        throw new UserError('Plan ID or file path is required for this prompt');
      }
      return loadCompactPlanPrompt({ plan: args.plan }, context);
    },
  });

  server.addPrompt({
    name: 'load-plan',
    description:
      'Load a plan and share its current details, then wait for the human collaborator before taking additional action.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to load',
        required: true,
      },
    ],
    load: async (args) => {
      if (!args.plan) {
        return `Plan ID or file path is required for this prompt`;
      }
      return loadPlanPrompt({ plan: args.plan }, context);
    },
  });

  server.addPrompt({
    name: 'generate-plan-simple',
    description:
      'Generate tasks for a plan without research phase. Goes directly to task generation using the Claude Code generation prompt and update-plan-tasks tool.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to generate tasks for',
        required: false,
      },
      {
        name: 'allowMultiplePlans',
        description:
          'Set to true to allow the agent to create multiple independent plans if the scope is large enough to benefit from breaking it down into phases or parts that can be merged independently.',
        required: false,
      },
    ],
    load: async (args) =>
      loadGeneratePrompt({ plan: args.plan, allowMultiplePlans: args.allowMultiplePlans }, context),
  });

  server.addTool({
    name: 'update-plan-tasks',
    description:
      'Update an rmplan file with generated tasks and details. Takes pre-generated plan content and merges it into the existing plan file, preserving metadata and completed tasks.',
    parameters: generateTasksParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) => {
      try {
        return await mcpUpdatePlanTasks(args, context, {
          log: wrapLogger(execContext.log, '[update-plan-tasks] '),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'manage-plan-task',
    description:
      'Manage tasks in a plan. Use action="add" to create a new task, action="update" to modify an existing task (by title or index), or action="remove" to delete a task.',
    parameters: managePlanTaskParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) => {
      try {
        return await mcpManagePlanTask(args, context, {
          log: wrapLogger(execContext.log, '[manage-plan-task] '),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'get-plan',
    description:
      'Retrieve the full plan details by numeric ID or file path. Returns the plan metadata, goal, details, tasks, and related information.',
    parameters: getPlanParameters,
    annotations: {
      destructiveHint: false,
      readOnlyHint: true,
    },
    execute: async (args) => mcpGetPlan(args, context),
  });

  server.addTool({
    name: 'update-plan-details',
    description:
      'Update plan details within the delimiter-bounded generated section. Can either append to or replace existing generated content while preserving manually-added sections like Research.',
    parameters: updatePlanDetailsParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args) => {
      try {
        return await mcpUpdatePlanDetails(args, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'list-ready-plans',
    description:
      'List all plans that are ready to be worked on. A plan is ready when it has status ' +
      '"pending" or "in_progress" and all its dependencies are marked as "done". ' +
      'This includes stub plans without tasks (awaiting task generation) and ' +
      'plans with existing tasks ready for implementation. ' +
      'Returns JSON with plan details including ID, title, priority, task counts, and dependencies.',
    parameters: listReadyPlansParameters,
    annotations: {
      destructiveHint: false,
      readOnlyHint: true,
    },
    execute: async (args) => {
      try {
        return await mcpListReadyPlans(args, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'create-plan',
    description:
      'Create a new rmplan plan file with specified properties. Do not use this tool as part of your internal "plan mode".',
    parameters: createPlanParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) =>
      mcpCreatePlan(args, context, {
        log: wrapLogger(execContext.log, '[create-plan] '),
      }),
  });

  // Add MCP resources for browsing plan data
  server.addResource({
    uri: 'rmplan://plans/list',
    name: 'All Plans',
    description: 'List of all plans in the repository',
    mimeType: 'application/json',
    async load() {
      clearPlanCache();
      const tasksDir = await resolveTasksDir(context.config);
      const { plans } = await readAllPlans(tasksDir);

      const planList = Array.from(plans.values()).map((plan) => ({
        id: plan.id,
        title: plan.title,
        goal: plan.goal,
        status: plan.status,
        priority: plan.priority,
        parent: plan.parent,
        dependencies: plan.dependencies,
        assignedTo: plan.assignedTo,
        taskCount: plan.tasks?.length || 0,
        completedTasks: plan.tasks?.filter((t) => t.done).length || 0,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      }));

      return {
        text: JSON.stringify(planList, null, 2),
      };
    },
  });

  server.addResourceTemplate({
    uriTemplate: 'rmplan://plans/{planId}',
    name: 'Plan Details',
    description: 'Full details of a specific plan including tasks and details',
    mimeType: 'application/json',
    arguments: [
      {
        name: 'planId',
        description: 'Plan ID or file path',
        required: true,
      },
    ],
    async load(args) {
      clearPlanCache();
      const { plan } = await resolvePlan(args.planId, context);
      return {
        text: JSON.stringify(plan, null, 2),
      };
    },
  });

  server.addResource({
    uri: 'rmplan://plans/ready',
    name: 'Ready Plans',
    description: 'Plans ready to execute (all dependencies satisfied)',
    mimeType: 'application/json',
    async load() {
      clearPlanCache();
      const tasksDir = await resolveTasksDir(context.config);
      const { plans } = await readAllPlans(tasksDir);

      const readyPlans = filterAndSortReadyPlans(plans, {
        pendingOnly: false,
        sortBy: 'priority',
      });

      const enrichedPlans = readyPlans.map((plan) => {
        const planId = typeof plan.id === 'number' ? plan.id : 0;
        return {
          ...plan,
          filename: plans.get(planId)?.filename || '',
        };
      });

      const jsonOutput = formatReadyPlansAsJson(enrichedPlans, {
        gitRoot: context.gitRoot,
      });

      return {
        text: jsonOutput,
      };
    },
  });
}
