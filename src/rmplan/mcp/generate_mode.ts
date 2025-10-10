import path from 'node:path';
import { FastMCP, UserError } from 'fastmcp';
import type { SerializableValue } from 'fastmcp';
import { z } from 'zod';
import yaml from 'yaml';
import { planPrompt, simplePlanPrompt, generateClaudeCodeResearchPrompt } from '../prompt.js';
import { appendResearchToPlan } from '../research_utils.js';
import { readPlanFile, writePlanFile, resolvePlanFile, isTaskDone } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { planSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import { DEFAULT_RUN_MODEL, runStreamingPrompt } from '../llm_utils/run_and_apply.js';
import { convertMarkdownToYaml, findYamlStart } from '../process_markdown.js';
import { fixYaml } from '../fix_yaml.js';

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
  if (plan.details) {
    parts.push(`Details:\n${plan.details.trim()}`);
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

  return parts.join('\n\n');
}

function buildPlanPromptBody(plan: PlanSchema): string {
  const sections: string[] = [];

  if (plan.title) {
    sections.push(`# ${plan.title}`);
  }

  if (plan.goal) {
    sections.push(`## Goal\n${plan.goal}`);
  }

  if (plan.details) {
    sections.push(`## Details\n${plan.details.trim()}`);
  }

  if (plan.tasks?.length) {
    const taskLines = plan.tasks.map((task, index) => {
      const title = task.title || `Task ${index + 1}`;
      return `- ${title}`;
    });
    sections.push(`## Existing Tasks\n${taskLines.join('\n')}`);
  }

  return sections.join('\n\n');
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

export async function loadResearchPrompt(
  args: { plan?: string },
  context: GenerateModeRegistrationContext
) {
  const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
  const contextBlock = buildPlanContext(plan, planPath, context);

  const text = `${contextBlock}\n\nUse the following template to capture research for this plan:\n\n${generateClaudeCodeResearchPrompt()}`;

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
  const { plan, planPath } = await resolvePlan(args.plan ?? '', context);
  const contextBlock = buildPlanContext(plan, planPath, context);

  const text = `${contextBlock}\n\nYou are collaborating with a human partner to refine this plan. Ask one concise, high-impact question at a time that will help you improve the plan's tasks and execution details. Avoid repeating information already captured. Wait for the user to respond before asking a follow-up.`;

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

export const generateTasksParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to generate tasks for'),
    simple: z.boolean().optional().describe('Use the simplified single-phase planning prompt'),
    direct: z
      .boolean()
      .optional()
      .describe('Call the configured model directly instead of returning a planning prompt'),
    model: z
      .string()
      .optional()
      .describe('Model identifier to use when direct generation is enabled'),
  })
  .describe('Options for generating tasks for a plan');

export type GenerateTasksArguments = z.infer<typeof generateTasksParameters>;

async function loadPlanningDocument(context: GenerateModeRegistrationContext): Promise<string> {
  const instructionsPath = context.config.planning?.instructions;
  if (!instructionsPath) {
    return '';
  }

  const absolutePath = path.isAbsolute(instructionsPath)
    ? instructionsPath
    : path.join(context.gitRoot, instructionsPath);

  const file = Bun.file(absolutePath);
  try {
    return await file.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to read planning instructions from ${absolutePath}: ${message}`);
  }
}

async function parseAndMergeTasks(
  generatedText: string,
  originalPlan: PlanSchema,
  config: RmplanConfig
): Promise<PlanSchema> {
  let convertedYaml: string;

  try {
    // First try to see if it's YAML already
    const maybeYaml = findYamlStart(generatedText);
    const parsedObject = yaml.parse(maybeYaml, { strict: false });
    convertedYaml = yaml.stringify(parsedObject);
  } catch {
    // Not valid YAML, convert from markdown
    convertedYaml = await convertMarkdownToYaml(generatedText, config, true);
  }

  // Parse and fix the YAML
  let parsedYaml;
  try {
    parsedYaml = await fixYaml(convertedYaml, 5, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to parse generated YAML: ${message}`);
  }

  // Validate against the plan schema
  const result = planSchema.safeParse(parsedYaml);
  if (!result.success) {
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new UserError(`Generated plan failed validation: ${errors}`);
  }

  const newPlan = result.data;

  // Preserve all metadata from the original plan
  const updatedPlan: PlanSchema = {
    ...newPlan,
    id: originalPlan.id,
    createdAt: originalPlan.createdAt,
    updatedAt: new Date().toISOString(),
    planGeneratedAt: new Date().toISOString(),
    status: originalPlan.status,
    priority: originalPlan.priority || newPlan.priority,
    title: originalPlan.title || newPlan.title,
    goal: originalPlan.goal || newPlan.goal,
  };

  // Preserve fields that should not be overwritten
  if (originalPlan.parent !== undefined) updatedPlan.parent = originalPlan.parent;
  if (originalPlan.container !== undefined) updatedPlan.container = originalPlan.container;
  if (originalPlan.baseBranch !== undefined) updatedPlan.baseBranch = originalPlan.baseBranch;
  if (originalPlan.changedFiles !== undefined) updatedPlan.changedFiles = originalPlan.changedFiles;
  if (originalPlan.pullRequest !== undefined) updatedPlan.pullRequest = originalPlan.pullRequest;
  if (originalPlan.assignedTo !== undefined) updatedPlan.assignedTo = originalPlan.assignedTo;
  if (originalPlan.docs !== undefined) updatedPlan.docs = originalPlan.docs;
  if (originalPlan.issue !== undefined) updatedPlan.issue = originalPlan.issue;
  if (originalPlan.rmfilter !== undefined) updatedPlan.rmfilter = originalPlan.rmfilter;
  if (originalPlan.dependencies !== undefined) updatedPlan.dependencies = originalPlan.dependencies;
  if (originalPlan.project !== undefined) updatedPlan.project = originalPlan.project;
  if (originalPlan.generatedBy !== undefined) updatedPlan.generatedBy = originalPlan.generatedBy;

  // Update promptsGeneratedAt if prompts were generated
  if (newPlan.tasks[0]?.steps?.[0]?.prompt) {
    updatedPlan.promptsGeneratedAt = new Date().toISOString();
  } else {
    updatedPlan.promptsGeneratedAt = originalPlan.promptsGeneratedAt;
  }

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
      // New task without ID - add to the end
      mergedTasks.push(newTask);
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
  const basePromptBody = buildPlanPromptBody(plan);
  const planningDoc = await loadPlanningDocument(context);
  const combinedBody = planningDoc
    ? `${basePromptBody}\n\n## Planning Rules\n\n${planningDoc}`
    : basePromptBody;
  const promptText = args.simple ? simplePlanPrompt(combinedBody) : planPrompt(combinedBody);

  const shouldCallModel = args.direct ?? context.config.planning?.direct_mode ?? false;

  if (!shouldCallModel) {
    const relativePath = path.relative(context.gitRoot, planPath) || planPath;
    return [
      'Direct model generation is disabled. Copy the prompt below into your preferred model to generate tasks.',
      `Plan: ${relativePath}`,
      '',
      promptText,
    ].join('\n');
  }

  const modelId = args.model ?? DEFAULT_RUN_MODEL;

  try {
    execContext.log.info('Generating tasks using direct model invocation', { modelId });
    const { text } = await runStreamingPrompt({
      input: promptText,
      model: modelId,
    });

    const generatedText = text.trim();
    execContext.log.info('Parsing and merging generated tasks into plan');

    // Parse the generated text and merge with the existing plan
    const updatedPlan = await parseAndMergeTasks(generatedText, plan, context.config);

    // Write the updated plan back to the file
    await writePlanFile(planPath, updatedPlan);

    const relativePath = path.relative(context.gitRoot, planPath) || planPath;
    const taskCount = updatedPlan.tasks.length;
    return `Successfully updated plan at ${relativePath} with ${taskCount} task${taskCount === 1 ? '' : 's'}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UserError(`Failed to generate and update tasks: ${message}`);
  }
}

export const appendResearchParameters = z
  .object({
    plan: z.string().describe('Plan ID or file path to update'),
    research: z.string().describe('Research notes to append under the Research section'),
    heading: z
      .string()
      .optional()
      .describe('Override the section heading (defaults to "## Research")'),
    timestamp: z
      .boolean()
      .optional()
      .describe('Include an automatic timestamp heading (default: true)'),
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
    insertedAt: args.timestamp === false ? false : undefined,
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
    name: 'perform-research',
    description:
      'Collect research notes and findings for a plan using the standard rmplan research template.',
    arguments: [
      {
        name: 'plan',
        description: 'Plan ID or file path to investigate',
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
        required: true,
      },
    ],
    load: async (args) => loadQuestionsPrompt({ plan: args.plan }, context),
  });

  server.addTool({
    name: 'generate-plan-tasks',
    description: 'Generate detailed rmplan tasks for the provided plan description.',
    parameters: generateTasksParameters,
    annotations: {
      destructiveHint: false,
      readOnlyHint: true,
    },
    execute: async (args, execContext) =>
      handleGenerateTasksTool(args, context, {
        log: wrapLogger(execContext.log, '[generate-plan-tasks] '),
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
}
