import { z } from 'zod/v4';
import { prioritySchema } from '../planSchema.js';

// Simplified task schema for tool parameters
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
        'Task title to search for (partial match, case-insensitive). Preferred over taskIndex.'
      ),
    taskIndex: z.number().int().optional().describe('Task index (0-based). Prefer using taskTitle'),
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
  .describe('Create a new plan file');

export type CreatePlanArguments = z.infer<typeof createPlanParameters>;

export type AddPlanTaskArguments = z.infer<typeof addPlanTaskParameters>;

export type RemovePlanTaskArguments = z.infer<typeof removePlanTaskParameters>;
