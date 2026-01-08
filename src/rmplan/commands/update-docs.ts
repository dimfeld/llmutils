// Command handler for 'rmplan update-docs'
// Updates documentation based on completed plan work

import * as path from 'path';
import { getGitRoot } from '../../common/git.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { RmplanConfig } from '../configSchema.js';
import { resolveTasksDir } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

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
  planFilePath: string,
  config: RmplanConfig,
  options: {
    executor?: string;
    model?: string;
    baseDir?: string;
    justCompletedTaskIndices?: number[];
  }
): Promise<void> {
  const planData = await readPlanFile(planFilePath);
  const baseDir = options.baseDir || (await getGitRoot()) || process.cwd();

  // Build exclude list from config and automatically exclude tasks directory
  const excludePatterns = [...(config.updateDocs?.exclude ?? [])];

  // Add tasks directory to exclude list if not using external storage
  if (!config.isUsingExternalStorage) {
    const tasksDir = await resolveTasksDir(config);
    // Make the path relative to baseDir for clearer messaging
    const relativeTasksDir = path.relative(baseDir, tasksDir);
    excludePatterns.push(`Plan files in ${relativeTasksDir || tasksDir}`);
  }

  // Build the prompt
  const prompt = buildUpdateDocsPrompt(planData, {
    justCompletedTaskIndices: options.justCompletedTaskIndices,
    include: config.updateDocs?.include,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
  });

  // Determine executor and model
  const executorName =
    options.executor || config.updateDocs?.executor || config.defaultExecutor || DEFAULT_EXECUTOR;

  const model =
    options.model ||
    config.updateDocs?.model ||
    config.models?.execution ||
    defaultModelForExecutor(executorName, 'execution');

  // Create executor
  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir,
    model,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

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
 * Command handler for the standalone update-docs command
 */
export async function handleUpdateDocsCommand(
  planFile: string | undefined,
  options: any,
  command: any
) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (!planFile) {
    throw new Error('Plan file or ID is required');
  }

  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const baseDir = (await getGitRoot()) || process.cwd();

  await runUpdateDocs(resolvedPlanFile, config, {
    executor: options.executor,
    model: options.model,
    baseDir,
  });

  log('\n✅ Documentation update complete');
}
