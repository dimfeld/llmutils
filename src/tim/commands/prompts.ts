import chalk from 'chalk';
import { log } from '../../logging.js';
import { writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanPathContext } from '../path_resolver.js';
import {
  loadGeneratePrompt,
  loadPlanPrompt,
  loadQuestionsPrompt,
  loadResearchPrompt,
  type GenerateModeRegistrationContext,
} from '../mcp/generate_mode.js';
import { loadCompactPlanPrompt } from '../mcp/prompts/compact_plan.js';
import { readAllPlans, readPlanFile, resolvePlanFile } from '../plans.js';
import { getCombinedTitle } from '../display_utils.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import type { PlanSchema } from '../planSchema.js';
import * as fs from 'node:fs/promises';

type PromptCommandOptions = {
  plan?: string;
  nextReady?: string;
  latest?: boolean;
  allowMultiplePlans?: boolean;
  // Review-specific options
  taskIndex?: string | string[];
  taskTitle?: string | string[];
  instructions?: string;
  instructionsFile?: string;
  focus?: string;
  base?: string;
};

type PromptMessage = {
  content?:
    | {
        type?: string;
        text?: string;
      }
    | string;
};

type PromptResult =
  | {
      messages?: PromptMessage[];
    }
  | string;

type PromptDefinition = {
  name: string;
  requiresPlan: boolean;
  supportsAllowMultiplePlans: boolean;
  load: (
    args: {
      plan?: string;
      allowMultiplePlans?: unknown;
      // Review-specific options
      taskIndex?: string | string[];
      taskTitle?: string | string[];
      instructions?: string;
      instructionsFile?: string;
      focus?: string;
      base?: string;
    },
    context: GenerateModeRegistrationContext
  ) => PromptResult | Promise<PromptResult>;
};

const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'generate-plan',
    requiresPlan: true,
    supportsAllowMultiplePlans: true,
    load: (args, context) =>
      loadResearchPrompt({ plan: args.plan, allowMultiplePlans: args.allowMultiplePlans }, context),
  },
  {
    name: 'generate-plan-simple',
    requiresPlan: false,
    supportsAllowMultiplePlans: true,
    load: (args, context) =>
      loadGeneratePrompt({ plan: args.plan, allowMultiplePlans: args.allowMultiplePlans }, context),
  },
  {
    name: 'plan-questions',
    requiresPlan: false,
    supportsAllowMultiplePlans: false,
    load: (args, context) => loadQuestionsPrompt({ plan: args.plan }, context),
  },
  {
    name: 'load-plan',
    requiresPlan: true,
    supportsAllowMultiplePlans: false,
    load: (args, context) => loadPlanPrompt({ plan: args.plan ?? '' }, context),
  },
  {
    name: 'compact-plan',
    requiresPlan: true,
    supportsAllowMultiplePlans: false,
    load: (args, context) => loadCompactPlanPrompt({ plan: args.plan ?? '' }, context),
  },
  {
    name: 'review',
    requiresPlan: true,
    supportsAllowMultiplePlans: false,
    load: async (args, context) => {
      const { buildReviewPromptFromOptions } = await import('./review.js');
      return await buildReviewPromptFromOptions(
        args.plan ?? '',
        {
          taskIndex: args.taskIndex,
          taskTitle: args.taskTitle,
          instructions: args.instructions,
          instructionsFile: args.instructionsFile,
          focus: args.focus,
          base: args.base,
        },
        { config: context.configPath }
      );
    },
  },
];

const PROMPT_LOOKUP = new Map(PROMPT_DEFINITIONS.map((entry) => [entry.name, entry]));

function getAvailablePromptNames(): string[] {
  return PROMPT_DEFINITIONS.map((entry) => entry.name);
}

function extractPromptText(result: PromptResult): string {
  if (typeof result === 'string') {
    return result;
  }

  const messages = result?.messages ?? [];
  const textBlocks = messages
    .map((message) => {
      if (!message?.content) {
        return '';
      }
      if (typeof message.content === 'string') {
        return message.content;
      }
      if (typeof message.content.text === 'string') {
        return message.content.text;
      }
      return '';
    })
    .filter((text) => text.length > 0);

  if (textBlocks.length === 0) {
    throw new Error('Prompt output did not include any text content.');
  }

  return textBlocks.join('\n\n');
}

function normalizePlanIdentifier(plan: string | undefined): string | undefined {
  if (!plan) {
    return undefined;
  }

  const trimmed = plan.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export type PlanWithFilename = PlanSchema & { filename: string };

const MIN_TIMESTAMP = Number.NEGATIVE_INFINITY;

export function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export async function getPlanTimestamp(plan: PlanWithFilename): Promise<number> {
  const updatedAt = parseIsoTimestamp(plan.updatedAt);
  if (updatedAt !== undefined) {
    return updatedAt;
  }

  const createdAt = parseIsoTimestamp(plan.createdAt);
  if (createdAt !== undefined) {
    return createdAt;
  }

  try {
    const fileStats = await fs.stat(plan.filename);
    return fileStats.mtimeMs;
  } catch {
    return MIN_TIMESTAMP;
  }
}

export async function findMostRecentlyUpdatedPlan<T extends PlanWithFilename>(
  plans: Map<number, T>
): Promise<T | null> {
  let latestPlan: T | null = null;
  let latestTimestamp = MIN_TIMESTAMP;

  for (const candidate of plans.values()) {
    // Only consider plans with an updatedAt field
    if (!candidate.updatedAt) {
      continue;
    }

    const timestamp = await getPlanTimestamp(candidate);
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
      latestPlan = candidate;
    }
  }

  return latestPlan;
}

export async function buildPromptText(
  promptName: string,
  args: {
    plan?: string;
    allowMultiplePlans?: boolean;
    // Review-specific options
    taskIndex?: string | string[];
    taskTitle?: string | string[];
    instructions?: string;
    instructionsFile?: string;
    focus?: string;
    base?: string;
  },
  context: GenerateModeRegistrationContext
): Promise<string> {
  const definition = PROMPT_LOOKUP.get(promptName);
  if (!definition) {
    const available = getAvailablePromptNames().join(', ');
    throw new Error(`Unknown prompt "${promptName}". Available prompts: ${available}`);
  }

  const plan = normalizePlanIdentifier(args.plan);
  if (definition.requiresPlan && !plan) {
    throw new Error(`Prompt "${promptName}" requires a plan ID or file path.`);
  }

  const allowMultiplePlans = definition.supportsAllowMultiplePlans
    ? args.allowMultiplePlans
    : undefined;

  const result = await definition.load(
    {
      plan,
      allowMultiplePlans,
      taskIndex: args.taskIndex,
      taskTitle: args.taskTitle,
      instructions: args.instructions,
      instructionsFile: args.instructionsFile,
      focus: args.focus,
      base: args.base,
    },
    context
  );

  return extractPromptText(result);
}

export async function handlePromptsCommand(
  promptName: string | undefined,
  planArg: string | undefined,
  options: PromptCommandOptions,
  command: any
): Promise<void> {
  if (!promptName) {
    const available = getAvailablePromptNames().join('\n');
    const output = available.endsWith('\n') ? available : `${available}\n`;
    writeStdout(output);
    return;
  }

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const pathContext = await resolvePlanPathContext(config);

  const context: GenerateModeRegistrationContext = {
    config,
    configPath: globalOpts.config,
    gitRoot: pathContext.gitRoot,
  };

  // Validate input options first
  let planOptionsSet = [planArg, options.plan, options.nextReady, options.latest].reduce(
    (acc, val) => acc + (val ? 1 : 0),
    0
  );

  // Manual conflict check for --plan, --next-ready, and --latest
  if (planOptionsSet > 1) {
    throw new Error(
      'You must provide at most one of [plan], --plan <plan>, --next-ready <planIdOrPath>, or --latest'
    );
  }

  let plan = normalizePlanIdentifier(options.plan) ?? normalizePlanIdentifier(planArg);

  // Handle --next-ready option - find and operate on next ready dependency
  if (options.nextReady) {
    const tasksDir = pathContext.tasksDir;
    // Convert string ID to number or resolve plan file to get numeric ID
    let parentPlanId: number;
    const planIdNumber = parseInt(options.nextReady, 10);
    if (!isNaN(planIdNumber)) {
      parentPlanId = planIdNumber;
    } else {
      // Try to resolve as a file path and get the plan ID
      const planFile = await resolvePlanFile(options.nextReady, globalOpts.config);
      const parentPlan = await readPlanFile(planFile);
      if (!parentPlan.id) {
        throw new Error(`Plan file ${planFile} does not have a valid ID`);
      }
      parentPlanId = parentPlan.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));

    // Set the resolved plan as the target
    plan = result.plan.filename;
  } else if (options.latest) {
    const { plans } = await readAllPlans(pathContext.tasksDir);

    if (plans.size === 0) {
      log('No plans found in tasks directory.');
      return;
    }

    const latestPlan = await findMostRecentlyUpdatedPlan(plans);

    if (!latestPlan) {
      log('No plans found in tasks directory.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || latestPlan.filename;

    log(chalk.green(`Found latest plan: ${label}`));

    plan = latestPlan.filename;
  }

  const promptText = await buildPromptText(
    promptName,
    {
      plan,
      allowMultiplePlans: options.allowMultiplePlans ?? true,
      taskIndex: options.taskIndex,
      taskTitle: options.taskTitle,
      instructions: options.instructions,
      instructionsFile: options.instructionsFile,
      focus: options.focus,
      base: options.base,
    },
    context
  );

  const output = promptText.endsWith('\n') ? promptText : `${promptText}\n`;
  writeStdout(output);
}
