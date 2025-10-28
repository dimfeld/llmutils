import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import { z } from 'zod/v4';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeGenerationPrompt,
} from '../prompt.js';
import { prioritySchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import { buildPlanContext, resolvePlan } from '../plan_display.js';
import { mcpGetPlan } from '../commands/show.js';
import { mcpAppendResearch } from '../commands/research.js';
import { mcpListReadyPlans } from '../commands/ready.js';
import { mcpUpdatePlanDetails, mcpUpdatePlanTasks } from '../commands/update.js';

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
