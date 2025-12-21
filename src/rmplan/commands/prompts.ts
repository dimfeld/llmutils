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

type PromptCommandOptions = {
  plan?: string;
  allowMultiplePlans?: boolean;
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
    args: { plan?: string; allowMultiplePlans?: unknown },
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

export async function buildPromptText(
  promptName: string,
  args: { plan?: string; allowMultiplePlans?: boolean },
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

  const plan = normalizePlanIdentifier(options.plan) ?? normalizePlanIdentifier(planArg);
  const promptText = await buildPromptText(
    promptName,
    {
      plan,
      allowMultiplePlans: options.allowMultiplePlans,
    },
    context
  );

  const output = promptText.endsWith('\n') ? promptText : `${promptText}\n`;
  writeStdout(output);
}
