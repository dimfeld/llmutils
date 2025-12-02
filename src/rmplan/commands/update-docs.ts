// Command handler for 'rmplan update-docs'
// Updates documentation based on completed plan work

import { getGitRoot } from '../../common/git.js';
import { boldMarkdownHeaders, log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import type { RmplanConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

/**
 * Build the documentation update prompt based on plan metadata and completed tasks
 */
function buildUpdateDocsPrompt(planData: PlanSchema): string {
  const parts: string[] = [];

  parts.push(
    'You have completed work on the following plan. Please find and update any relevant',
    'documentation files in the repository to reflect the changes made.\n'
  );

  parts.push(`# Plan: ${planData.title}\n`);

  if (planData.goal) {
    parts.push(`## Goal\n${planData.goal}\n`);
  }

  if (planData.details) {
    parts.push(`## Details\n${planData.details}\n`);
  }

  // Add completed tasks
  const completedTasks = planData.tasks?.filter((task) => task.done) || [];
  if (completedTasks.length > 0) {
    parts.push('## Completed Tasks\n');
    for (const task of completedTasks) {
      parts.push(`### ${task.title}`);
      if (task.description) {
        parts.push(task.description);
      }
      parts.push('');
    }
  }

  parts.push(
    '\nPlease search for relevant documentation files (README.md, docs/, CLAUDE.md, etc.)',
    'and update them to reflect these changes. Add new documentation if needed.'
  );

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
  }
): Promise<void> {
  const planData = await readPlanFile(planFilePath);
  const baseDir = options.baseDir || (await getGitRoot()) || process.cwd();

  // Build the prompt
  const prompt = buildUpdateDocsPrompt(planData);

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
    interactive: false,
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
