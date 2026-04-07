import { commitAll } from '../../../common/process.js';
import { getWorkingCopyStatus, type WorkingCopyStatus } from '../../../common/git.js';
import { promptConfirm } from '../../../common/input.js';
import { boldMarkdownHeaders, error, log, sendStructured, warn } from '../../../logging.js';
import chalk from 'chalk';
import { executePostApplyCommand } from '../../actions.js';
import { type TimConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { readPlanFile, setPlanStatusById, writePlanFile } from '../../plans.js';
import { getAllIncompleteTasks } from '../../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';
import { sendFailureReport, timestamp } from './agent_helpers.js';
import type { SummaryCollector } from '../../summary/collector.js';
import { runUpdateDocs } from '../update-docs.js';
import { runUpdateLessons } from '../update-lessons.js';
import { handleReviewCommand } from '../review.js';
import { isShuttingDown } from '../../shutdown_state.js';
import { materializePlan, syncMaterializedPlan } from '../../plan_materialize.js';
import { getCompletionStatus } from '../../plans/plan_state_utils.js';
import { removePlanAssignment } from '../../assignments/remove_plan_assignment.js';

const FAST_NOOP_BATCH_RETRY_MS = 5 * 60 * 1000;

function workingCopyStatusesMatch(
  beforeStatus: WorkingCopyStatus,
  afterStatus: WorkingCopyStatus
): boolean {
  if (beforeStatus.checkFailed || afterStatus.checkFailed) {
    return false;
  }

  if (beforeStatus.hasChanges !== afterStatus.hasChanges) {
    return false;
  }

  if (!beforeStatus.hasChanges) {
    return true;
  }

  if (beforeStatus.diffHash && afterStatus.diffHash) {
    return beforeStatus.diffHash === afterStatus.diffHash;
  }

  return beforeStatus.output === afterStatus.output;
}

export async function executeBatchMode(
  {
    currentPlanFile,
    config,
    executor,
    baseDir,
    dryRun = false,
    maxSteps = Infinity,
    executorName,
    executionMode = 'normal',
    updateDocsMode = 'never',
    applyLessons = false,
    finalReview,
    configPath,
    terminalInput,
    reviewThreadContext,
  }: {
    currentPlanFile: string;
    config: TimConfig;
    executor: Executor;
    baseDir: string;
    dryRun?: boolean;
    maxSteps?: number;
    executorName?: string;
    executionMode?: 'normal' | 'simple' | 'tdd';
    updateDocsMode?: 'never' | 'after-iteration' | 'after-completion' | 'manual';
    applyLessons?: boolean;
    finalReview?: boolean;
    configPath?: string;
    terminalInput?: boolean;
    reviewThreadContext?: string;
  },
  summaryCollector?: SummaryCollector
) {
  const runPostApplyCommands = async (): Promise<string | null> => {
    if (!config.postApplyCommands || config.postApplyCommands.length === 0) {
      return null;
    }

    sendStructured({
      type: 'workflow_progress',
      timestamp: timestamp(),
      phase: 'post-apply',
      message: 'Running post-apply commands',
    });
    for (const commandConfig of config.postApplyCommands) {
      if (isShuttingDown()) {
        return null;
      }
      const commandSucceeded = await executePostApplyCommand(commandConfig, baseDir);
      if (!commandSucceeded) {
        return commandConfig.title;
      }
    }

    return null;
  };

  sendStructured({
    type: 'workflow_progress',
    timestamp: timestamp(),
    phase: 'batch',
    message: `Starting batch mode execution: ${currentPlanFile}`,
  });
  try {
    let hasError = false;
    let iteration = 0;

    // Track initial state to determine whether to skip final review
    // We skip final review if we started with no tasks completed and finished in a single iteration
    const initialPlanData = await readPlanFile(currentPlanFile);
    const planId = initialPlanData.id;
    const initialCompletedTaskCount = initialPlanData.tasks.filter((t) => t.done).length;

    // Batch mode: continue until no incomplete tasks remain
    while (iteration < maxSteps) {
      if (isShuttingDown()) {
        break;
      }

      // Sync plan file to DB and rematerialize from DB to pick up any changes
      // (e.g. user edits made between iterations while at a prompt)
      await syncMaterializedPlan(planId, baseDir);

      // Read the (potentially rematerialized) plan file to get updated state
      const planData = await readPlanFile(currentPlanFile);

      // Check if status needs to be updated from 'pending' to 'in progress'
      if (planData.status === 'pending' && !isShuttingDown()) {
        planData.status = 'in_progress';
        planData.updatedAt = new Date().toISOString();
        if (isShuttingDown()) {
          break;
        }
        await writePlanFile(currentPlanFile, planData);

        // If this plan has a parent, mark it as in_progress too
        if (planData.parent && !isShuttingDown()) {
          await markParentInProgress(planData.parent, config);
        }
      }

      // Get all incomplete tasks
      const incompleteTasks = getAllIncompleteTasks(planData);

      // If no incomplete tasks remain, exit the loop
      if (incompleteTasks.length === 0) {
        sendStructured({
          type: 'task_completion',
          timestamp: timestamp(),
          planComplete: true,
        });
        break;
      }

      sendStructured({
        type: 'agent_iteration_start',
        timestamp: timestamp(),
        iterationNumber: iteration + 1,
        taskTitle: `${incompleteTasks.length} task(s) selected`,
        taskDescription: incompleteTasks.map((taskResult) => taskResult.task.title).join(', '),
      });

      // Format all incomplete tasks into a single prompt for the executor
      const taskDescriptions = incompleteTasks
        .map((taskResult) => {
          const { taskIndex, task } = taskResult;
          let taskDescription = `Task ${taskIndex + 1}: ${task.title}`;
          if (task.description) {
            taskDescription += `\nDescription: ${task.description}`;
          }
          return taskDescription;
        })
        .join('\n\n');

      // Build the batch prompt that includes the plan context and all incomplete task details
      const batchPrompt = await buildExecutionPromptWithoutSteps({
        executor,
        planData,
        planFilePath: currentPlanFile,
        baseDir,
        config,
        task: {
          title: `${incompleteTasks.length} Tasks`,
          description: `Please select and complete a logical subset of the following incomplete tasks that makes sense to work on together.

IMPORTANT: It's better to choose a small number of closely related tasks that form an atomic unit than to take on too many at once. Focus on what can be completed well in a single iteration.

Available tasks:\n\n${taskDescriptions}`,
          files: [], // Files will be included via plan context
        },
        filePathPrefix: executor.filePathPrefix,
        includeCurrentPlanContext: true,
        batchMode: true,
      });

      let finalPrompt = batchPrompt;
      if (reviewThreadContext) {
        finalPrompt = reviewThreadContext + '\n\n' + finalPrompt;
      }

      if (dryRun) {
        log(boldMarkdownHeaders('\n## Batch Mode Dry Run - Generated Prompt\n'));
        log(finalPrompt);
        log('\n--dry-run mode: Would execute the above prompt');
        break;
      }

      if (isShuttingDown()) {
        break;
      }

      const workingCopyStatusBeforeRun = await getWorkingCopyStatus(baseDir);
      let executionDurationMs = 0;

      try {
        sendStructured({
          type: 'agent_step_start',
          timestamp: timestamp(),
          phase: 'execution',
          executor: executorName,
          stepNumber: iteration + 1,
        });
        const start = Date.now();
        const output = await executor.execute(finalPrompt, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: currentPlanFile,
          batchMode: true,
          executionMode,
          captureOutput: summaryCollector ? 'result' : 'none',
          retryFastNoopOrchestratorTurn: true,
        });
        iteration += 1;
        const ok = output ? (output as any).success !== false : true;
        if (!ok) {
          const fd = output?.failureDetails;
          sendFailureReport(fd?.problems || 'Executor reported failure.', {
            requirements: fd?.requirements,
            problems: fd?.problems,
            solutions: fd?.solutions,
            sourceAgent: fd?.sourceAgent,
          });
        }
        sendStructured({
          type: 'agent_step_end',
          timestamp: timestamp(),
          phase: 'execution',
          success: ok,
          summary: ok ? 'Batch executor step completed.' : 'Batch executor step failed.',
        });
        if (summaryCollector) {
          const end = Date.now();
          executionDurationMs = end - start;
          // Coerce executor output to normalized shape for predictable summaries
          const normalizedOutput =
            typeof output === 'string' ? { content: output } : ((output as any) ?? undefined);
          summaryCollector.addStepResult({
            title: `Batch Iteration ${iteration}`,
            executor: executorName ?? 'executor',
            success: ok,
            output: normalizedOutput,
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(end).toISOString(),
            durationMs: end - start,
            iteration,
          });
        } else {
          executionDurationMs = Date.now() - start;
        }
        if (!ok) {
          hasError = true;
          if (summaryCollector) {
            await summaryCollector.trackFileChanges(baseDir);
            summaryCollector.setBatchIterations(iteration);
          }
          break;
        }
      } catch (err) {
        error('Batch execution failed:', err);
        hasError = true;
        iteration += 1;
        if (summaryCollector) {
          summaryCollector.addStepResult({
            title: `Batch Iteration ${iteration}`,
            executor: executorName ?? 'executor',
            success: false,
            errorMessage: String(err instanceof Error ? err.message : err),
            iteration,
          });
          summaryCollector.addError(err);
        }
        sendStructured({
          type: 'agent_step_end',
          timestamp: timestamp(),
          phase: 'execution',
          success: false,
          summary: `Batch executor step threw: ${String(err instanceof Error ? err.message : err)}`,
        });
        break;
      }

      if (isShuttingDown()) {
        break;
      }

      // After execution, re-read the plan file to get the updated state
      const updatedPlanData = await readPlanFile(currentPlanFile);
      const remainingIncompleteTasks = getAllIncompleteTasks(updatedPlanData);
      const remainingTaskIndices = new Set(remainingIncompleteTasks.map((task) => task.taskIndex));
      const completedTaskTitles = incompleteTasks
        .filter((task) => !remainingTaskIndices.has(task.taskIndex))
        .map((task) => task.task.title);
      const workingCopyStatusAfterRun = await getWorkingCopyStatus(baseDir);
      const shouldRetryImmediately =
        executionDurationMs < FAST_NOOP_BATCH_RETRY_MS &&
        workingCopyStatusesMatch(workingCopyStatusBeforeRun, workingCopyStatusAfterRun);

      log(
        `Batch iteration complete. Remaining incomplete tasks: ${remainingIncompleteTasks.length}`
      );

      if (shouldRetryImmediately) {
        log(
          'Batch iteration made no working copy changes and finished in under 5 minutes; retrying.'
        );
        sendStructured({
          type: 'workflow_progress',
          timestamp: timestamp(),
          phase: 'batch',
          message:
            'Batch iteration made no working copy changes and finished in under 5 minutes; retrying.',
        });
        continue;
      }

      // Update docs if configured for after-iteration mode
      // Calculate which tasks were just completed by comparing before/after state
      if (updateDocsMode === 'after-iteration') {
        if (isShuttingDown()) {
          break;
        }

        const justCompletedTaskIndices = incompleteTasks
          .map((t) => t.taskIndex)
          .filter((index) => !remainingTaskIndices.has(index));

        try {
          await runUpdateDocs(currentPlanFile, config, {
            executor: config.updateDocs?.executor,
            model: config.updateDocs?.model,
            baseDir,
            justCompletedTaskIndices,
            terminalInput,
          });
          const updatedPlanForTimestamp = await readPlanFile(currentPlanFile);
          updatedPlanForTimestamp.docsUpdatedAt = new Date().toISOString();
          await writePlanFile(currentPlanFile, updatedPlanForTimestamp);
        } catch (err) {
          error('Failed to update documentation:', err);
          // Don't stop execution for documentation update failures
        }
      }

      if (isShuttingDown()) {
        break;
      }

      // Run post-apply commands if configured
      const failedPostApplyCommand = await runPostApplyCommands();
      if (failedPostApplyCommand) {
        error(`Batch mode stopping because required command "${failedPostApplyCommand}" failed.`);
        hasError = true;
        if (summaryCollector) summaryCollector.addError('Post-apply command failed');
        break;
      }

      // If all tasks are now marked done, update the plan status to 'done'
      const finished = remainingIncompleteTasks.length === 0;
      if (finished) {
        sendStructured({
          type: 'task_completion',
          timestamp: timestamp(),
          taskTitle: completedTaskTitles.join(', ') || 'Batch mode iteration',
          planComplete: true,
        });

        if (isShuttingDown()) {
          break;
        }

        if (typeof updatedPlanData.id !== 'number') {
          throw new Error(`Batch mode plan is missing a numeric ID: ${currentPlanFile}`);
        }

        const completionStatus = getCompletionStatus(config);
        await setPlanStatusById(updatedPlanData.id, completionStatus, baseDir, currentPlanFile);

        // Update docs if configured for after-completion mode
        if (updateDocsMode === 'after-completion') {
          if (isShuttingDown()) {
            break;
          }

          try {
            await runUpdateDocs(currentPlanFile, config, {
              executor: config.updateDocs?.executor,
              model: config.updateDocs?.model,
              baseDir,
              terminalInput,
            });
            const updatedPlanForTimestamp = await readPlanFile(currentPlanFile);
            updatedPlanForTimestamp.docsUpdatedAt = new Date().toISOString();
            await writePlanFile(currentPlanFile, updatedPlanForTimestamp);
          } catch (err) {
            error('Failed to update documentation:', err);
            // Don't stop execution for documentation update failures
          }

          if (!isShuttingDown()) {
            const failedAfterCompletionDocsPostApplyCommand = await runPostApplyCommands();
            if (failedAfterCompletionDocsPostApplyCommand) {
              error(
                `Batch mode stopping because required command "${failedAfterCompletionDocsPostApplyCommand}" failed.`
              );
              hasError = true;
              if (summaryCollector) summaryCollector.addError('Post-apply command failed');
              break;
            }
          }
        }

        if (isShuttingDown()) {
          break;
        }

        // Run final review if enabled
        // Skip if we started with no completed tasks and finished in a single iteration
        const shouldSkipFinalReview =
          finalReview === false || (initialCompletedTaskCount === 0 && iteration === 1);
        let planStillCompleteAfterReview = true;
        if (!shouldSkipFinalReview) {
          const isNonInteractiveReview = terminalInput === false;
          sendStructured({
            type: 'workflow_progress',
            timestamp: timestamp(),
            phase: 'final-review',
            message: 'Running final review',
          });
          try {
            const reviewResult = await handleReviewCommand(
              currentPlanFile,
              isNonInteractiveReview
                ? { cwd: baseDir, saveIssues: true, noAutofix: true }
                : { cwd: baseDir },
              {
                parent: { opts: () => ({ config: configPath }) },
              }
            );

            if (isNonInteractiveReview && (reviewResult?.issuesSaved ?? 0) > 0) {
              planStillCompleteAfterReview = false;
              await setPlanStatusById(updatedPlanData.id, 'needs_review', baseDir, currentPlanFile);
            } else if (reviewResult?.tasksAppended && reviewResult.tasksAppended > 0) {
              // If tasks were appended, ask if user wants to continue
              const planIdStr = updatedPlanData.id ? ` ${updatedPlanData.id}` : '';

              // The user may edit the plan during the prompt below, so make sure the DB is up to date here.
              // The review command handles this properly; this is just a safeguard.
              await syncMaterializedPlan(updatedPlanData.id, baseDir, { skipRematerialize: true });

              let shouldContinue = false;
              if (!isShuttingDown()) {
                shouldContinue = await promptConfirm({
                  message: `${reviewResult.tasksAppended} new task(s) added from review to plan${planIdStr}. You can edit the plan first if needed. Continue running?`,
                  default: true,
                });
              }

              // Rematerialize in case the user edited the plan while the prompt was open.
              await materializePlan(updatedPlanData.id, baseDir);

              if (shouldContinue) {
                continue; // Continue the loop to process new tasks
              }

              // New tasks were appended but execution is not continuing,
              // so the plan is no longer complete.
              planStillCompleteAfterReview = false;
              await setPlanStatusById(updatedPlanData.id, 'in_progress', baseDir, currentPlanFile);
            }
          } catch (err) {
            warn(`Final review failed: ${err as Error}`);
            // Don't fail the agent - plan execution succeeded
          }
        }

        if (isShuttingDown()) {
          break;
        }

        if (completionStatus === 'done' && planStillCompleteAfterReview) {
          await removePlanAssignment(updatedPlanData, baseDir);
        }

        if (
          planStillCompleteAfterReview &&
          updateDocsMode !== 'manual' &&
          (config.updateDocs?.applyLessons || applyLessons)
        ) {
          if (isShuttingDown()) {
            break;
          }

          try {
            const applied = await runUpdateLessons(currentPlanFile, config, {
              executor: config.updateDocs?.executor,
              model: config.updateDocs?.model,
              baseDir,
              terminalInput,
            });
            if (applied) {
              const updatedPlanForTimestamp = await readPlanFile(currentPlanFile);
              updatedPlanForTimestamp.lessonsAppliedAt = new Date().toISOString();
              await writePlanFile(currentPlanFile, updatedPlanForTimestamp);
            }
          } catch (err) {
            error('Failed to apply lessons learned:', err as Error);
            // Don't stop execution for lessons update failures
          }

          if (!isShuttingDown()) {
            const failedAfterLessonsPostApplyCommand = await runPostApplyCommands();
            if (failedAfterLessonsPostApplyCommand) {
              error(
                `Batch mode stopping because required command "${failedAfterLessonsPostApplyCommand}" failed.`
              );
              hasError = true;
              if (summaryCollector) summaryCollector.addError('Post-apply command failed');
              break;
            }
          }
        } else if (
          !planStillCompleteAfterReview &&
          (config.updateDocs?.applyLessons || applyLessons)
        ) {
          log('Skipping lessons-learned documentation update because review added new tasks.');
        }

        if (isShuttingDown()) {
          break;
        }

        // Handle parent plan updates similar to existing logic
        if (updatedPlanData.parent && !isShuttingDown() && planStillCompleteAfterReview) {
          await checkAndMarkParentDone(updatedPlanData.parent, config, baseDir);
        }

        if (isShuttingDown()) {
          break;
        }

        // Sync plan file changes to DB before committing
        await syncMaterializedPlan(updatedPlanData.id, baseDir);

        await commitAll(`Plan complete: ${planData.title}`, baseDir);
        if (summaryCollector) {
          await summaryCollector.trackFileChanges(baseDir);
          summaryCollector.setBatchIterations(iteration);
        }
        break;
      } else {
        if (isShuttingDown()) {
          break;
        }

        // Sync plan file changes to DB before committing
        await syncMaterializedPlan(updatedPlanData.id, baseDir);

        await commitAll('Finish batch tasks iteration', baseDir);
        if (summaryCollector) {
          await summaryCollector.trackFileChanges(baseDir);
          summaryCollector.setBatchIterations(iteration);
        }
      }
    }

    if (hasError) {
      throw new Error('Batch mode stopped due to error.');
    }
  } finally {
    // Logging lifecycle is managed by the caller (timAgent)
  }
}
