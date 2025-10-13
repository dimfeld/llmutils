import path from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import { z } from 'zod/v4';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeGenerationPrompt,
} from '../prompt.js';
import { appendResearchToPlan } from '../research_utils.js';
import { readPlanFile, writePlanFile, resolvePlanFile, isTaskDone } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { planSchema, prioritySchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';

export interface GenerateModeRegistrationContext {
  config: RmplanConfig;
  configPath?: string;
  gitRoot: string;
}

function formatExistingTasks(plan: PlanSchema): string | undefined {
  if (!plan.tasks?.length) {
    return undefined;
  }

  const taskSummaries = plan.tasks.map((task, index) => {
    const title = task.title || `Task ${index + 1}`;
    const stepCount = task.steps?.length ?? 0;
    const fileCount = task.files?.length ?? 0;
    const extra: string[] = [];
    if (stepCount > 0) {
      extra.push(`${stepCount} step${stepCount === 1 ? '' : 's'}`);
    }
    if (fileCount > 0) {
      extra.push(`${fileCount} file${fileCount === 1 ? '' : 's'}`);
    }
    const suffix = extra.length ? ` (${extra.join(', ')})` : '';
    return `- ${title}${suffix}`;
  });

  return `### Existing Tasks\n${taskSummaries.join('\n')}`;
}

function buildPlanContext(
  plan: PlanSchema,
  planPath: string,
  context: GenerateModeRegistrationContext
): string {
  const relativePath = path.relative(context.gitRoot, planPath) || planPath;
  const parts: string[] = [
    `Plan file: ${relativePath}`,
    `Plan ID: ${plan.id}`,
    `Status: ${plan.status}`,
    `Priority: ${plan.priority}`,
  ];

  if (plan.title) {
    parts.push(`Title: ${plan.title}`);
  }
  if (plan.goal) {
    parts.push(`Goal:\n${plan.goal}`);
  }
  if (plan.issue?.length) {
    parts.push(`Linked issues:\n${plan.issue.join('\n')}`);
  }
  if (plan.docs?.length) {
    parts.push(`Documentation references:\n${plan.docs.join('\n')}`);
  }

  const existingTasks = formatExistingTasks(plan);
  if (existingTasks) {
    parts.push(existingTasks);
  }

  if (plan.details) {
    parts.push(`Details:\n${plan.details.trim()}`);
  }

  return parts.join('\n\n');
}

async function resolvePlan(
  planArg: string,
  context: GenerateModeRegistrationContext
): Promise<{
  plan: PlanSchema;
  planPath: string;
}> {
  const planPath = await resolvePlanFile(planArg, context.configPath);
  const plan = await readPlanFile(planPath);
  return { plan, planPath };
}

const questionText = `Ask one concise, high-impact question at a time that will help you improve the plan's tasks and execution details. Avoid repeating information already captured. As you figure things out, update the details in the plan file if necessary.`;

export async function loadResearchPrompt(
  args: { plan?: string },
  context: GenerateModeRegistrationContext
) {
  const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
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

const GENERATED_START_DELIMITER = '<!-- rmplan-generated-start -->';
const GENERATED_END_DELIMITER = '<!-- rmplan-generated-end -->';

/**
 * Extracts the research section (## Research) position from markdown details if present.
 * Returns the index where the research section starts, or undefined if not found.
 */
function findResearchSectionStart(details: string): number | undefined {
  const researchMatch = details.match(/^## Research$/m);
  return researchMatch?.index;
}

/**
 * Merges new details into the original details using delimiters to track generated content.
 * - If delimiters exist, replaces content between them
 * - If delimiters don't exist, inserts them and new content before the Research section (or at the end)
 * This preserves manually-added content like research sections while allowing the tool to update its own content.
 */
function mergeDetails(
  newDetails: string | undefined,
  originalDetails: string | undefined
): string | undefined {
  if (!newDetails) {
    return originalDetails;
  }

  if (!originalDetails) {
    // No original details, wrap new details in delimiters
    return `${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
  }

  // Check if delimiters already exist in the original
  const startIndex = originalDetails.indexOf(GENERATED_START_DELIMITER);
  const endIndex = originalDetails.indexOf(GENERATED_END_DELIMITER);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Delimiters exist - replace content between them
    const before = originalDetails.slice(0, startIndex);
    const after = originalDetails.slice(endIndex + GENERATED_END_DELIMITER.length);
    return `${before}${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}${after}`;
  }

  // Delimiters don't exist - insert them before the Research section or at the end
  const researchStart = findResearchSectionStart(originalDetails);

  if (researchStart !== undefined) {
    // Insert before the Research section
    const before = originalDetails.slice(0, researchStart).trim();
    const after = originalDetails.slice(researchStart).trim();
    return `${before}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}\n\n${after}`;
  } else {
    // No research section - append at the end
    return `${originalDetails.trim()}\n\n${GENERATED_START_DELIMITER}\n${newDetails.trim()}\n${GENERATED_END_DELIMITER}`;
  }
}

async function mergeTasksIntoPlan(
  newPlanData: Partial<PlanSchema>,
  originalPlan: PlanSchema
): Promise<PlanSchema> {
  // Validate the new plan data against the schema
  const result = planSchema.safeParse({
    ...originalPlan,
    ...newPlanData,
    // Ensure tasks is always an array
    tasks: newPlanData.tasks || [],
  });

  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new UserError(`Plan data failed validation: ${errors}`);
  }

  const newPlan = result.data;

  // Preserve all metadata from the original plan
  const updatedPlan: PlanSchema = {
    ...newPlan,
    id: originalPlan.id,
    parent: originalPlan.parent,
    container: originalPlan.container,
    baseBranch: originalPlan.baseBranch,
    changedFiles: originalPlan.changedFiles,
    pullRequest: originalPlan.pullRequest,
    issue: originalPlan.issue,
    docs: originalPlan.docs,
    assignedTo: originalPlan.assignedTo,
    rmfilter: originalPlan.rmfilter,
    dependencies: originalPlan.dependencies,
    project: originalPlan.project,
    generatedBy: 'agent',
    createdAt: originalPlan.createdAt,
    updatedAt: new Date().toISOString(),
    planGeneratedAt: new Date().toISOString(),
    status: originalPlan.status,
    promptsGeneratedAt: new Date().toISOString(),
    // Only override these if provided in newPlanData
    priority: newPlanData.priority !== undefined ? newPlanData.priority : originalPlan.priority,
    title: newPlanData.title !== undefined ? newPlanData.title : originalPlan.title,
    goal: newPlanData.goal !== undefined ? newPlanData.goal : originalPlan.goal,
    details: mergeDetails(newPlanData.details, originalPlan.details),
  };

  // Merge tasks while preserving completed ones
  const originalTasks = originalPlan.tasks || [];
  const newTasks = newPlan.tasks || [];

  // Build a map of completed tasks
  const completedTasks = new Map<number, PlanSchema['tasks'][0]>();
  originalTasks.forEach((task, index) => {
    if (isTaskDone(task)) {
      completedTasks.set(index, task);
    }
  });

  // Parse task IDs from new tasks to match with original tasks
  const taskIdRegex = /\[TASK-(\d+)\]/;
  const mergedTasks: PlanSchema['tasks'] = [];

  // First, add all completed tasks in their original positions
  for (const [index, task] of completedTasks) {
    mergedTasks[index] = task;
  }

  // Then process new tasks
  newTasks.forEach((newTask) => {
    const match = newTask.title.match(taskIdRegex);
    if (match) {
      const taskIndex = parseInt(match[1]) - 1; // Convert to 0-based index
      // Remove the task ID from the title
      newTask.title = newTask.title.replace(taskIdRegex, '').trim();

      // Only update if this was not a completed task
      if (!completedTasks.has(taskIndex)) {
        mergedTasks[taskIndex] = newTask;
      }
    } else {
      let matchingTitleTask = originalTasks.findIndex((task) => task.title === newTask.title);
      if (matchingTitleTask >= 0) {
        if (!completedTasks.has(matchingTitleTask)) {
          mergedTasks[matchingTitleTask] = newTask;
        }
      } else {
        // New task without ID - add to the end
        mergedTasks.push(newTask);
      }
    }
  });

  // Filter out any undefined entries
  updatedPlan.tasks = mergedTasks.filter((task) => task !== undefined);

  return updatedPlan;
}

export async function handleGenerateTasksTool(
  args: GenerateTasksArguments,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);

  try {
    execContext.log.info('Merging generated plan data');

    // Build partial plan data from arguments
    const newPlanData: Partial<PlanSchema> = {
      tasks: args.tasks as PlanSchema['tasks'],
    };

    // Only include optional fields if they were provided
    if (args.title !== undefined) newPlanData.title = args.title;
    if (args.goal !== undefined) newPlanData.goal = args.goal;
    if (args.details !== undefined) newPlanData.details = args.details;
    if (args.priority !== undefined) newPlanData.priority = args.priority;

    // Merge with the existing plan
    const updatedPlan = await mergeTasksIntoPlan(newPlanData, plan);

    // Write the updated plan back to the file
    await writePlanFile(planPath, updatedPlan);

    const relativePath = path.relative(context.gitRoot, planPath) || planPath;
    const taskCount = updatedPlan.tasks.length;
    return `Successfully updated plan at ${relativePath} with ${taskCount} task${taskCount === 1 ? '' : 's'}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to update plan: ${message}`);
  }
}

export const getPlanParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to retrieve'),
  })
  .describe('Retrieve the full plan text for a given plan ID or file path');

export type GetPlanArguments = z.infer<typeof getPlanParameters>;

export async function handleGetPlanTool(
  args: GetPlanArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const { plan, planPath } = await resolvePlan(args.plan, context);
  return buildPlanContext(plan, planPath, context);
}

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

export async function handleAppendResearchTool(
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

type GenerateModeExecutionLogger = {
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
      'Update an rmplan file with generated tasks and details. Takes pre-generated plan content (in markdown or YAML format) and merges it into the existing plan file, preserving metadata and completed tasks.',
    parameters: generateTasksParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args, execContext) =>
      handleGenerateTasksTool(args, context, {
        log: wrapLogger(execContext.log, '[update-plan-tasks] '),
      }),
  });

  server.addTool({
    name: 'append-plan-research',
    description: 'Append research findings to the plan details under a Research section.',
    parameters: appendResearchParameters,
    annotations: {
      destructiveHint: true,
      readOnlyHint: false,
    },
    execute: async (args) => handleAppendResearchTool(args, context),
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
    execute: async (args) => handleGetPlanTool(args, context),
  });
}
