// Shared documentation updater used by the workspace-aware update-docs flow
// and agent/batch follow-up work.

import { getGitRoot } from '../../common/git.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { TimConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import type { PlanSchema } from '../planSchema.js';
import { materializePlan } from '../plan_materialize.js';
import { parsePlanIdFromCliArg, resolvePlanByNumericId } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';

interface UpdateDocsPromptOptions {
  justCompletedTaskIndices?: number[];
  include?: string[];
  exclude?: string[];
}

/**
 * Build the documentation update prompt based on plan metadata and completed tasks
 * @param planData - The plan data
 * @param options - Options including justCompletedTaskIndices and include/exclude patterns
 */
function buildUpdateDocsPrompt(
  planData: PlanSchema,
  options: UpdateDocsPromptOptions = {}
): string {
  const parts: string[] = [];

  const { justCompletedTaskIndices, include, exclude } = options;
  const hasJustCompleted = justCompletedTaskIndices && justCompletedTaskIndices.length > 0;
  const justCompletedSet = new Set(justCompletedTaskIndices ?? []);

  if (hasJustCompleted) {
    parts.push(
      'You have just completed work on the following tasks. Please find and update any relevant',
      'documentation files in the repository to reflect the changes made.\n'
    );
  } else {
    parts.push(
      'You have completed work on the following plan. Please find and update any relevant',
      'documentation files in the repository to reflect the changes made.\n'
    );
  }

  parts.push(`# Plan: ${planData.title}\n`);

  if (planData.goal) {
    parts.push(`## Goal\n${planData.goal}\n`);
  }

  // Separate tasks into just-completed and previously completed
  const allTasks = planData.tasks ?? [];
  const justCompletedTasks: { index: number; task: (typeof allTasks)[0] }[] = [];
  const previouslyCompletedTasks: { index: number; task: (typeof allTasks)[0] }[] = [];

  allTasks.forEach((task, index) => {
    if (justCompletedSet.has(index)) {
      justCompletedTasks.push({ index, task });
    } else if (task.done) {
      previouslyCompletedTasks.push({ index, task });
    }
  });

  // Show just-completed tasks first with clear labeling
  if (justCompletedTasks.length > 0) {
    parts.push('## Just Completed Tasks\n');
    parts.push(
      'These tasks were just completed in this iteration. Documentation updates should be related to these tasks.\n'
    );
    for (const { index, task } of justCompletedTasks) {
      parts.push(`### Task ${index + 1}: ${task.title}`);
      if (task.description) {
        parts.push(task.description);
      }
      parts.push('');
    }
  }

  // Show previously completed tasks for context
  if (previouslyCompletedTasks.length > 0) {
    parts.push('## Previously Completed Tasks\n');
    parts.push('These tasks were completed in earlier iterations (for context only).\n');
    for (const { index, task } of previouslyCompletedTasks) {
      parts.push(`### Task ${index + 1}: ${task.title}`);
      if (task.description) {
        parts.push(task.description);
      }
      parts.push('');
    }
  }

  if (planData.details) {
    parts.push(`## Details\n${planData.details}\n`);
  }

  parts.push(
    '\nPlease search for relevant documentation files (README.md, docs/, CLAUDE.md, etc.)',
    'and update them to reflect these changes. Add new documentation if needed. Think first before',
    `updating the root README or agent instructions like AGENTS.md or CLAUDE.md, since we don't want them to become too cluttered.`
  );

  parts.push(
    '\n## Level of Detail',
    '',
    'Documentation is a map, not the territory. It should point the reader to the relevant code, page, or',
    'module and explain concepts, behavior, and decisions that a reader cannot easily get from reading the',
    'code. It should not try to be a full replacement for reading the code itself.',
    'Keep updates concise and at a high level. It is fine, and often best, to make',
    'a small update or no update at all if the existing documentation is still accurate.',
    '',
    'Write about:',
    '- What a feature does and why it exists, from the point of view of a user or a developer working in this area',
    '- Important behavior, constraints, invariants, and non-obvious gotchas',
    '- How the main pieces fit together, at the level of modules or subsystems',
    '- Configuration options and commands that users interact with',
    '',
    'Do not write:',
    '- Exhaustive lists of which functions or files call a function, or what each function does internally',
    '- Descriptions of each button, field, or element in a UI',
    '- Step-by-step walkthroughs of the implementation, or line-level details that will go stale quickly',
    '- A changelog of what was changed in this plan. Describe the current state of the system instead',
    '- Repeated information that is already covered elsewhere in the documentation. Link to it instead',
    '',
    'Mention a specific function, file, or type only when a reader needs it as an entry point. Prefer a short',
    'paragraph or a few bullets over a long section. When in doubt, leave it out.',
    '',
    'Exception: when a behavior is surprising, unexpected, or unintuitive, document it with enough detail',
    'that a reader will not be caught off guard, even if that means going into specifics about a',
    'particular function, UI element, or code path.'
  );

  // Add include/exclude guidance
  if (include && include.length > 0) {
    parts.push('\n## Files to Include');
    parts.push('Only edit documentation files matching these descriptions:');
    for (const pattern of include) {
      parts.push(`- ${pattern}`);
    }
  }

  if (exclude && exclude.length > 0) {
    parts.push('\n## Files to Exclude');
    parts.push('Never edit documentation files matching these descriptions:');
    for (const pattern of exclude) {
      parts.push(`- ${pattern}`);
    }
  }

  return parts.join('\n');
}

/**
 * Core logic for updating documentation based on a plan
 */
export async function runUpdateDocs(
  planDataOrPath: PlanSchema | string,
  planFilePathOrConfig: string | TimConfig,
  configOrOptions:
    | TimConfig
    | {
        executor?: string;
        model?: string;
        baseDir?: string;
        configPath?: string;
        justCompletedTaskIndices?: number[];
        nonInteractive?: boolean;
        terminalInput?: boolean;
      },
  maybeOptions?: {
    executor?: string;
    model?: string;
    baseDir?: string;
    configPath?: string;
    justCompletedTaskIndices?: number[];
    nonInteractive?: boolean;
    terminalInput?: boolean;
  }
): Promise<void> {
  const options = maybeOptions ?? (configOrOptions as NonNullable<typeof maybeOptions>);
  let planData: PlanSchema;
  let planFilePath: string;
  let effectiveConfig: TimConfig;
  let resolvedBaseDir = options.baseDir;
  if (typeof planDataOrPath === 'string') {
    const repoRoot = options.baseDir ?? (await resolveRepoRoot(options.configPath, process.cwd()));
    const planId = parsePlanIdFromCliArg(planDataOrPath);
    const resolvedPlan = await resolvePlanByNumericId(planId, repoRoot);
    planData = resolvedPlan.plan;
    planFilePath = resolvedPlan.planPath ?? (await materializePlan(resolvedPlan.plan.id, repoRoot));
    effectiveConfig = planFilePathOrConfig as TimConfig;
    resolvedBaseDir = repoRoot;
  } else {
    planData = planDataOrPath;
    planFilePath = planFilePathOrConfig as string;
    effectiveConfig = configOrOptions as TimConfig;
  }
  const baseDir = resolvedBaseDir || (await getGitRoot()) || process.cwd();
  const excludePatterns = [...(effectiveConfig.updateDocs?.exclude ?? [])];

  // Build the prompt
  const prompt = buildUpdateDocsPrompt(planData, {
    justCompletedTaskIndices: options.justCompletedTaskIndices,
    include: effectiveConfig.updateDocs?.include,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
  });

  // Determine executor and model
  const executorName =
    options.executor ||
    effectiveConfig.updateDocs?.executor ||
    effectiveConfig.defaultExecutor ||
    DEFAULT_EXECUTOR;

  const model =
    options.model ||
    effectiveConfig.updateDocs?.model ||
    effectiveConfig.models?.execution ||
    defaultModelForExecutor(executorName, 'execution');

  // Create executor
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir,
    model,
    noninteractive: options.nonInteractive ? true : undefined,
    terminalInput: options.terminalInput,
    timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(effectiveConfig, baseDir, {
      planId: planData.id,
      planUuid: planData.uuid,
      planFilePath,
      branch: planData.branch,
    }),
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, effectiveConfig);

  // Execute the documentation update
  log(boldMarkdownHeaders('\n## Updating Documentation\n'));
  await executor.execute(prompt, {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Documentation Update',
    planFilePath,
    executionMode: 'bare',
    captureOutput: 'none',
  });
}

/**
 * Legacy direct entry point retained for internal callers/tests.
 */
export async function handleUpdateDocsCommand(
  planId: number | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (!planId) {
    throw new Error('A numeric plan ID is required');
  }

  const repoRoot = await resolveRepoRoot(globalOpts.config, (await getGitRoot()) || process.cwd());
  const { plan, planPath } = await resolvePlanByNumericId(planId, repoRoot);
  const resolvedPlanFile = planPath ?? (await materializePlan(plan.id, repoRoot));
  const baseDir = repoRoot;

  await runUpdateDocs(plan, resolvedPlanFile, config, {
    executor: options.executor,
    model: options.model,
    baseDir,
    configPath: globalOpts.config,
  });

  log('\n✅ Documentation update complete');
}
