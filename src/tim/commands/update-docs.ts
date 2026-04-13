// Shared documentation updater used by the workspace-aware update-docs flow
// and agent/batch follow-up work.

import * as path from 'path';
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
import { parsePlanIdFromCliArg, resolvePlanFromDb } from '../plans.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';

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
    const repoRoot =
      options.baseDir ??
      (await resolveRepoRootForPlanArg(planDataOrPath, process.cwd(), options.configPath));
    const resolvedPlan = await resolvePlanFromDb(planDataOrPath, repoRoot);
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
  planFile: string | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (!planFile) {
    throw new Error('A numeric plan ID is required');
  }
  const planIdArg = String(parsePlanIdFromCliArg(planFile));

  const repoRoot = await resolveRepoRootForPlanArg(
    planIdArg,
    (await getGitRoot()) || process.cwd(),
    globalOpts.config
  );
  const { plan, planPath } = await resolvePlanFromDb(planIdArg, repoRoot);
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
