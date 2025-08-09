import { commitAll } from '../../../common/process.js';
import { boldMarkdownHeaders, log } from '../../../logging.js';
import { executePostApplyCommand } from '../../actions.js';
import { type RmplanConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { setPlanStatus, writePlanFile } from '../../plans.js';
import type { PlanSchema } from '../../planSchema.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';

export async function executeStubPlan({
  config,
  baseDir,
  planFilePath,
  planData,
  executor,
  commit,
  dryRun = false,
}: {
  config: RmplanConfig;
  baseDir: string;
  planFilePath: string;
  planData: PlanSchema;
  executor: Executor;
  commit: boolean;
  dryRun?: boolean;
}) {
  // Update plan status to in_progress
  planData.status = 'in_progress';
  planData.updatedAt = new Date().toISOString();
  await writePlanFile(planFilePath, planData);

  // If this plan has a parent, mark it as in_progress too
  if (planData.parent) {
    await markParentInProgress(planData.parent, config);
  }

  // Build execution prompt using the unified function
  const directPrompt = await buildExecutionPromptWithoutSteps({
    executor,
    planData,
    planFilePath,
    baseDir,
    config,
    filePathPrefix: executor.filePathPrefix,
    includeCurrentPlanContext: true,
  });

  if (!directPrompt.trim()) {
    throw new Error('Plan has no goal or details to execute directly');
  }

  log(boldMarkdownHeaders('\n## Execution\n'));
  log('Using combined goal and details as prompt:');
  log(directPrompt);

  if (dryRun) {
    log('\n--dry-run mode: Would execute the above prompt');
    return;
  }

  // Execute the consolidated prompt
  await executor.execute(directPrompt, {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Untitled Plan',
    planFilePath: planFilePath,
  });

  // Execute post-apply commands if configured and no error occurred
  if (config.postApplyCommands && config.postApplyCommands.length > 0) {
    log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
    for (const commandConfig of config.postApplyCommands) {
      const commandSucceeded = await executePostApplyCommand(commandConfig, baseDir);
      if (!commandSucceeded) {
        throw new Error(`Required command "${commandConfig.title}" failed`);
      }
    }
  }

  // Mark plan as complete only if no error occurred
  await setPlanStatus(planFilePath, 'done');
  log('Plan executed directly and marked as complete!');

  // Check if parent plan should be marked done
  if (planData.parent) {
    await checkAndMarkParentDone(planData.parent, config, baseDir);
  }

  // Check if commit was requested
  if (commit) {
    const commitMessage = [planData.title, planData.goal, planData.details]
      .filter(Boolean)
      .join('\n\n');
    const exitCode = await commitAll(commitMessage, baseDir);
    if (exitCode === 0) {
      log('Changes committed successfully');
    } else {
      throw new Error('Commit failed');
    }
  }
}
