import { commitAll } from '../../../common/process.js';
import { boldMarkdownHeaders, log, warn } from '../../../logging.js';
import { executePostApplyCommand } from '../../actions.js';
import { type TimConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { setPlanStatusById, writePlanFile } from '../../plans.js';
import type { PlanSchema } from '../../planSchema.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { isShuttingDown } from '../../shutdown_state.js';
import { getCompletionStatus } from '../../plans/plan_state_utils.js';
import { removePlanAssignment } from '../../assignments/remove_plan_assignment.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';
import { handleReviewCommand } from '../review.js';

export interface StubPlanExecutionResult {
  tasksAppended?: number;
}

export async function executeStubPlan({
  config,
  baseDir,
  planFilePath,
  planData,
  executor,
  commit,
  dryRun = false,
  executionMode = 'normal',
  finalReview,
  configPath,
}: {
  config: TimConfig;
  baseDir: string;
  planFilePath: string;
  planData: PlanSchema;
  executor: Executor;
  commit: boolean;
  dryRun?: boolean;
  executionMode?: 'normal' | 'simple' | 'tdd';
  finalReview?: boolean;
  configPath?: string;
}): Promise<StubPlanExecutionResult> {
  // Update plan status to in_progress
  if (!isShuttingDown()) {
    planData.status = 'in_progress';
    planData.updatedAt = new Date().toISOString();
    await writePlanFile(planFilePath, planData);
  }

  // If this plan has a parent, mark it as in_progress too
  if (planData.parent && !isShuttingDown()) {
    await markParentInProgress(planData.parent, config);
  }

  if (isShuttingDown()) {
    return {};
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
    return {};
  }

  if (isShuttingDown()) {
    return {};
  }

  // Execute the consolidated prompt
  await executor.execute(directPrompt, {
    planId: planData.id?.toString() ?? 'unknown',
    planTitle: planData.title ?? 'Untitled Plan',
    planFilePath: planFilePath,
    executionMode,
  });

  // Execute post-apply commands if configured and no error occurred
  if (isShuttingDown()) {
    return {};
  }

  if (config.postApplyCommands && config.postApplyCommands.length > 0) {
    log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
    for (const commandConfig of config.postApplyCommands) {
      if (isShuttingDown()) {
        return {};
      }
      const commandSucceeded = await executePostApplyCommand(commandConfig, baseDir);
      if (!commandSucceeded) {
        throw new Error(`Required command "${commandConfig.title}" failed`);
      }
    }
  }

  // Mark plan as complete only if no error occurred
  if (isShuttingDown()) {
    return {};
  }
  if (typeof planData.id !== 'number') {
    throw new Error('Stub plan is missing a numeric plan ID');
  }
  const completionStatus = getCompletionStatus(config);
  await setPlanStatusById(planData.id, completionStatus, baseDir, planFilePath);
  log('Plan executed directly and marked as complete!');

  // Run final review if enabled
  if (isShuttingDown()) {
    return {};
  }

  if (finalReview !== false) {
    log(boldMarkdownHeaders('\n## Running Final Review\n'));
    try {
      const reviewResult = await handleReviewCommand(
        planFilePath,
        { cwd: baseDir },
        {
          parent: { opts: () => ({ config: configPath }) },
        }
      );

      if (reviewResult.tasksAppended > 0) {
        if (isShuttingDown()) {
          return {};
        }
        await setPlanStatusById(planData.id, 'in_progress', baseDir, planFilePath);
        return { tasksAppended: reviewResult.tasksAppended };
      }
    } catch (err) {
      warn(`Final review failed: ${err as Error}`);
      // Don't fail the agent - plan execution succeeded
    }
  }

  if (completionStatus === 'done') {
    await removePlanAssignment(planData, baseDir);
  }

  // Check if parent plan should be marked done only after review confirms the child stayed complete.
  if (planData.parent && !isShuttingDown()) {
    await checkAndMarkParentDone(planData.parent, config, baseDir);
  }

  // Check if commit was requested
  if (isShuttingDown()) {
    return {};
  }

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

  return {};
}
