import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import {
  generateClaudeCodePlanningPrompt,
  generateClaudeCodeResearchPrompt,
  generateClaudeCodeGenerationPrompt,
} from '../prompt.js';
import type { RmplanConfig } from '../configSchema.js';
import { resolveTasksDir } from '../configSchema.js';
import { buildPlanContext, resolvePlan } from '../plan_display.js';
import { mcpGetPlan } from '../commands/show.js';
import { mcpListReadyPlans } from '../commands/ready.js';
import { readAllPlans, clearPlanCache } from '../plans.js';
import { loadCompactPlanPrompt } from './prompts/compact_plan.js';
import { filterAndSortReadyPlans, formatReadyPlansAsJson } from '../ready_plans.js';
import {
  addPlanTaskTool,
  createPlanTool,
  generateTasksParameters,
  listReadyPlansParameters,
  managePlanTaskTool,
  managePlanTaskParameters,
  updatePlanDetailsParameters,
  updatePlanDetailsTool,
  updatePlanTaskTool,
  updatePlanTasksTool,
  createPlanParameters,
  getPlanParameters,
  removePlanTaskTool,
} from '../tools/index.js';
import type {
  AddPlanTaskArguments,
  CreatePlanArguments,
  GenerateTasksArguments,
  ManagePlanTaskArguments,
  RemovePlanTaskArguments,
  UpdatePlanDetailsArguments,
  ToolResult,
} from '../tools/index.js';
import { normalizeContainerToEpic } from '../planSchema.js';

export {
  addPlanTaskParameters,
  createPlanParameters,
  generateTasksParameters,
  getPlanParameters,
  listReadyPlansParameters,
  managePlanTaskParameters,
  removePlanTaskParameters,
  updatePlanDetailsParameters,
} from '../tools/schemas.js';
export type {
  AddPlanTaskArguments,
  CreatePlanArguments,
  GenerateTasksArguments,
  GetPlanArguments,
  ListReadyPlansArguments,
  ManagePlanTaskArguments,
  RemovePlanTaskArguments,
  UpdatePlanDetailsArguments,
} from '../tools/schemas.js';

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

Use the rmplan update-plan-tasks tool to save the generated plan with the following structure:
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

type UpdatePlanTaskArguments = {
  plan: string;
  taskTitle?: string;
  taskIndex?: number;
  newTitle?: string;
  newDescription?: string;
  done?: boolean;
};

function toMcpResult(result: ToolResult): string {
  return result.text;
}

export async function mcpManagePlanTask(
  args: ManagePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const result = await managePlanTaskTool(args, { ...context, log: execContext?.log });
  return toMcpResult(result);
}

export async function mcpAddPlanTask(
  args: AddPlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const result = await addPlanTaskTool(args, { ...context, log: execContext?.log });
  return toMcpResult(result);
}

export async function mcpRemovePlanTask(
  args: RemovePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const result = await removePlanTaskTool(args, { ...context, log: execContext?.log });
  return toMcpResult(result);
}

export async function mcpUpdatePlanTask(
  args: UpdatePlanTaskArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const result = await updatePlanTaskTool(args, { ...context, log: execContext?.log });
  return toMcpResult(result);
}

export async function mcpUpdatePlanDetails(
  args: UpdatePlanDetailsArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const result = await updatePlanDetailsTool(args, context);
  return toMcpResult(result);
}

export async function mcpUpdatePlanTasks(
  args: GenerateTasksArguments,
  context: GenerateModeRegistrationContext,
  execContext: { log: GenerateModeExecutionLogger }
): Promise<string> {
  const result = await updatePlanTasksTool(args, { ...context, log: execContext.log });
  return toMcpResult(result);
}

export async function mcpCreatePlan(
  args: CreatePlanArguments,
  context: GenerateModeRegistrationContext,
  execContext?: { log: GenerateModeExecutionLogger }
): Promise<string> {
  clearPlanCache();

  args = normalizeContainerToEpic(args);

  const title = args.title.trim();
  if (!title) {
    throw new UserError('Plan title cannot be empty.');
  }

  try {
    const result = await createPlanTool(args, { ...context, log: execContext?.log });
    return toMcpResult(result);
  } catch (error) {
    if (error instanceof UserError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(message);
  }
}

interface RegisterOptions {
  registerTools?: boolean;
}

export function registerGenerateMode(
  server: FastMCP,
  context: GenerateModeRegistrationContext,
  options: RegisterOptions = {}
): void {
  const { registerTools = true } = options;
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

  if (registerTools) {
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
  }

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
