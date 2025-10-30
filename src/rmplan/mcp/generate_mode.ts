import path from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import { z } from 'zod/v4';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeGenerationPrompt,
} from '../prompt.js';
import { prioritySchema, type PlanSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import { buildPlanContext, resolvePlan } from '../plan_display.js';
import { mcpGetPlan } from '../commands/show.js';
import { mcpListReadyPlans } from '../commands/ready.js';
import { writePlanFile } from '../plans.js';
import { findTaskByTitle } from '../utils/task_operations.js';
import { mergeTasksIntoPlan, updateDetailsWithinDelimiters } from '../plan_merge.js';
import { appendResearchToPlan } from '../research_utils.js';

export interface GenerateModeRegistrationContext {
  config: RmplanConfig;
  configPath?: string;
  gitRoot: string;
}

const questionText = `Ask one concise, high-impact question at a time that will help you improve the plan's tasks and execution details. Avoid repeating information already captured. As you figure things out, update the details in the plan file if necessary.`;

export async function loadResearchPrompt(
  args: { plan?: string },
  context: GenerateModeRegistrationContext
) {
  const { plan, planPath } = await resolvePlan(args.plan ?? '', context);

  // If plan has simple: true, skip research and use simple generation flow
  if (plan.simple) {
    return loadGeneratePrompt(args, context);
  }

  const contextBlock = buildPlanContext(plan, planPath, context);

  const text = `${generateClaudeCodePlanningPrompt(contextBlock, false)}

${generateClaudeCodeResearchPrompt(`Once your research is complete`)}

Use the append-plan-research tool to add the output to the plan. It is fine to send a lot of text to this tool at once.

When done, collaborate with your human partner to refine this plan. ${questionText}`;

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
  args: { plan?: string },
  context: GenerateModeRegistrationContext
) {
  let contextBlock = '';
  if (args.plan) {
    const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
    contextBlock = buildPlanContext(plan, planPath, context);
  }

  const text = `${generateClaudeCodeGenerationPrompt(contextBlock, false)}

Use the update-plan-tasks tool to save the generated plan with the following structure:
- title: The overall project title
- goal: The overall project goal
- details: Comprehensive project details including acceptance criteria, technical considerations, and any research findings
- priority: The priority level (low|medium|high|urgent)
- tasks: An array of tasks, where each task has:
  - title: A concise task title
  - description: Detailed task description`;

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

export const appendResearchParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to update'),
    research: z.string().describe('Extensive research notes to append under the Research section'),
    heading: z
      .string()
      .optional()
      .describe('Override the section heading (defaults to "## Research")'),
    timestamp: z
      .boolean()
      .optional()
      .describe('Include an automatic timestamp heading (default: false)'),
  })
  .describe('Options for appending research notes to a plan');

export type AppendResearchArguments = z.infer<typeof appendResearchParameters>;

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

export const addPlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    title: z.string().describe('Task title'),
    description: z.string().describe('Task description'),
    files: z.array(z.string()).optional().describe('Related file paths'),
    docs: z.array(z.string()).optional().describe('Documentation paths'),
  })
  .describe('Add a new task to an existing plan');

export type AddPlanTaskArguments = z.infer<typeof addPlanTaskParameters>;

export const removePlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    taskIndex: z
      .number()
      .optional()
      .describe('Task index (0-based). Indices of later tasks shift after removal.'),
    taskTitle: z
      .string()
      .optional()
      .describe(
        'Task title to search for (partial match, case-insensitive). Preferred over index.'
      ),
  })
  .describe('Remove a task from a plan by title (preferred) or index.');

export type RemovePlanTaskArguments = z.infer<typeof removePlanTaskParameters>;

export const updatePlanTaskParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path'),
    taskTitle: z.string().describe('Task title to search for (partial match, case-insensitive)'),
    newTitle: z.string().optional().describe('New task title'),
    newDescription: z.string().optional().describe('New task description'),
    done: z.boolean().optional().describe('Mark task as done or not done'),
  })
  .describe('Update an existing task in a plan by title (preferred) or index.');

export type UpdatePlanTaskArguments = z.infer<typeof updatePlanTaskParameters>;

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
  })
  .describe('List all ready plans that can be executed');

export type ListReadyPlansArguments = z.infer<typeof listReadyPlansParameters>;

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

export async function mcpAddPlanTask(
  args: AddPlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  type PlanTask = NonNullable<PlanSchema['tasks']>[number];
  type PlanTaskWithMetadata = PlanTask & { files?: string[]; docs?: string[]; steps?: unknown[] };

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
  const newTask: PlanTaskWithMetadata = {
    title,
    description,
    done: false,
    files: normalizeList(args.files),
    docs: normalizeList(args.docs),
    steps: [],
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

export async function mcpAppendResearch(
  args: AppendResearchArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  const updated = appendResearchToPlan(plan, args.research, {
    heading: args.heading,
    insertedAt: args.timestamp === true ? new Date() : false,
  });

  await writePlanFile(planPath, updated);

  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  return `Appended research to ${relativePath}`;
}

export async function mcpUpdatePlanDetails(
  args: UpdatePlanDetailsArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
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
    ],
    load: async (args) => loadResearchPrompt({ plan: args.plan }, context),
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
    ],
    load: async (args) => loadGeneratePrompt({ plan: args.plan }, context),
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
    name: 'add-plan-task',
    description: 'Add a new task to an existing plan.',
    parameters: addPlanTaskParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) => {
      try {
        return await mcpAddPlanTask(args, context, {
          log: wrapLogger(execContext.log, '[add-plan-task] '),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'remove-plan-task',
    description: 'Remove a task from a plan by title (preferred) or index.',
    parameters: removePlanTaskParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) => {
      try {
        return await mcpRemovePlanTask(args, context, {
          log: wrapLogger(execContext.log, '[remove-plan-task] '),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'update-plan-task',
    description:
      'Update a single existing task in a plan by title index. Can update the title, description, and/or done status.',
    parameters: updatePlanTaskParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) => {
      try {
        return await mcpUpdatePlanTask(args, context, {
          log: wrapLogger(execContext.log, '[update-plan-task] '),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new UserError(message);
      }
    },
  });

  server.addTool({
    name: 'append-plan-research',
    description: 'Append research findings to the plan details under a Research section.',
    parameters: appendResearchParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args) => mcpAppendResearch(args, context),
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
      'List all plans that are ready to be executed. A plan is ready when it has status ' +
      '"pending" or "in_progress", contains tasks, and all its dependencies are marked as ' +
      '"done". Returns JSON with plan details including ID, title, priority, task counts, and dependencies.',
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
}
