// Command handler for 'tim agent' and 'tim run'
// Automatically executes steps in a plan YAML file

import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'node:fs/promises';
import { promptConfirm } from '../../../common/input.js';
import { getCurrentBranchName, getGitRoot, getTrunkBranch } from '../../../common/git.js';
import { logSpawn } from '../../../common/process.js';
import {
  boldMarkdownHeaders,
  closeLogFile,
  error,
  log,
  openLogFile,
  sendStructured,
  warn,
} from '../../../logging.js';
import { executePostApplyCommand } from '../../actions.js';
import { loadEffectiveConfig, loadGlobalConfigForNotifications } from '../../configLoader.js';
import { getDefaultConfig, resolveTasksDir } from '../../configSchema.js';
import { getCombinedTitleFromSummary } from '../../display_utils.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../../executors/index.js';
import type { ExecutorCommonOptions } from '../../executors/types.js';
import type { PlanSchema } from '../../planSchema.js';
import {
  findNextPlan,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
  writePlanFile,
} from '../../plans.js';
import { findMostRecentlyUpdatedPlan } from '../prompts.js';
import { findNextActionableItem } from '../../plans/find_next.js';
import { markStepDone, markTaskDone } from '../../plans/mark_done.js';
import { prepareNextStep } from '../../plans/prepare_step.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { buildDescriptionFromPlan } from '../../display_utils.js';
import { findNextReadyDependency } from '../find_next_dependency.js';
import { executeBatchMode } from './batch_mode.js';
import { sendFailureReport, timestamp } from './agent_helpers.js';
import { markParentInProgress } from './parent_plans.js';
import { executeStubPlan } from './stub_plan.js';
import { SummaryCollector } from '../../summary/collector.js';
import { writeOrDisplaySummary } from '../../summary/display.js';
import { autoClaimPlan, isAutoClaimEnabled } from '../../assignments/auto_claim.js';
import { runUpdateDocs } from '../update-docs.js';
import { runUpdateLessons } from '../update-lessons.js';
import { handleReviewCommand } from '../review.js';
import { ensureUuidsAndReferences } from '../../utils/references.js';
import { sendNotification } from '../../notifications.js';
import { isTunnelActive } from '../../../logging/tunnel_client.js';
import { runWithHeadlessAdapterIfEnabled, type HeadlessPlanSummary } from '../../headless.js';
import {
  getWorkspaceInfoByPath,
  patchWorkspaceInfo,
  touchWorkspaceInfo,
} from '../../workspace/workspace_info.js';
import { setupWorkspace } from '../../workspace/workspace_setup.js';
import {
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../../workspace/workspace_roundtrip.js';

export async function handleAgentCommand(
  planFile: string | undefined,
  options: any,
  globalCliOptions: any
) {
  let config = getDefaultConfig();
  let resolvedPlanFile: string | undefined;
  let headlessPlanSummary: HeadlessPlanSummary | undefined;
  let didInvokeAgent = false;
  const notifyNoPlanFound = async (message: string): Promise<void> => {
    try {
      const cwd = await getGitRoot();
      await sendNotification(config, {
        command: 'agent',
        event: 'agent_done',
        status: 'success',
        message,
        cwd,
      });
    } catch (err) {
      warn(`Failed to send notification: ${err as Error}`);
    }
  };
  const notifyAgentError = async (message: string, errorMessage?: string): Promise<void> => {
    try {
      let cwd = process.cwd();
      try {
        cwd = await getGitRoot();
      } catch {
        // Fall back to process.cwd() when git root resolution fails.
      }
      await sendNotification(config, {
        command: 'agent',
        event: 'agent_done',
        status: 'error',
        message,
        errorMessage,
        cwd,
      });
    } catch (err) {
      warn(`Failed to send notification: ${err as Error}`);
    }
  };

  try {
    try {
      config = await loadEffectiveConfig(globalCliOptions.config);
    } catch (err) {
      config = await loadGlobalConfigForNotifications(globalCliOptions.config);
      throw err;
    }

    if ('nextReady' in options) {
      // Validate that --next-ready has a value (parent plan ID or file path)
      if (!options.nextReady || options.nextReady === true || options.nextReady.trim() === '') {
        throw new Error('--next-ready requires a parent plan ID or file path');
      }

      // Find the next ready dependency of the specified parent plan
      const tasksDir = await resolveTasksDir(config);
      // Convert string ID to number or resolve plan file to get numeric ID
      let parentPlanId: number;
      const planIdNumber = parseInt(options.nextReady, 10);
      if (!isNaN(planIdNumber)) {
        parentPlanId = planIdNumber;
      } else {
        // Try to resolve as a file path and get the plan ID
        const planFile = await resolvePlanFile(options.nextReady, globalCliOptions.config);
        const plan = await readPlanFile(planFile);
        if (!plan.id || typeof plan.id !== 'number') {
          throw new Error(`Plan file ${planFile} does not have a valid numeric ID`);
        }
        parentPlanId = plan.id;
      }

      const result = await findNextReadyDependency(parentPlanId, tasksDir);

      if (!result.plan) {
        log(result.message);
        await notifyNoPlanFound(`tim agent completed: ${result.message} (no work executed)`);
        return;
      }

      if (typeof result.plan.id === 'number' && result.plan.title) {
        sendStructured({
          type: 'plan_discovery',
          timestamp: timestamp(),
          planId: result.plan.id,
          title: result.plan.title,
        });
      } else {
        log(chalk.green(`Found ready plan: ${result.plan.filename}`));
      }
      resolvedPlanFile = result.plan.filename;
      headlessPlanSummary = { id: result.plan.id, title: result.plan.title };
    } else if (options.latest) {
      // Find the most recently updated plan
      const tasksDir = await resolveTasksDir(config);
      const { plans } = await readAllPlans(tasksDir);

      if (plans.size === 0) {
        const noPlanMessage = 'No plans found in tasks directory.';
        log(noPlanMessage);
        await notifyNoPlanFound(`tim agent completed: ${noPlanMessage} (no work executed)`);
        return;
      }

      const latestPlan = await findMostRecentlyUpdatedPlan(plans);

      if (!latestPlan) {
        const noPlanMessage = 'No plans found in tasks directory.';
        log(noPlanMessage);
        await notifyNoPlanFound(`tim agent completed: ${noPlanMessage} (no work executed)`);
        return;
      }

      if (typeof latestPlan.id === 'number') {
        sendStructured({
          type: 'plan_discovery',
          timestamp: timestamp(),
          planId: latestPlan.id,
          title: getCombinedTitleFromSummary(latestPlan),
        });
      } else {
        log(chalk.green(`Found latest plan: ${latestPlan.filename}`));
      }
      resolvedPlanFile = latestPlan.filename;
      headlessPlanSummary = { id: latestPlan.id, title: latestPlan.title };
    } else if (options.next || options.current) {
      // Find the next ready plan or current plan
      const tasksDir = await resolveTasksDir(config);
      const plan = await findNextPlan(tasksDir, {
        includePending: true,
        includeInProgress: options.current,
      });

      if (!plan) {
        const noPlanMessage = options.current
          ? 'No current plans found. No plans are in progress or ready to be implemented.'
          : 'No ready plans found. All pending plans have incomplete dependencies.';
        log(noPlanMessage);
        await notifyNoPlanFound(`tim agent completed: ${noPlanMessage} (no work executed)`);
        return;
      }

      if (typeof plan.id === 'number') {
        sendStructured({
          type: 'plan_discovery',
          timestamp: timestamp(),
          planId: plan.id,
          title: getCombinedTitleFromSummary(plan),
        });
      } else {
        log(chalk.green(`Found plan: ${plan.filename}`));
      }
      resolvedPlanFile = plan.filename;
      headlessPlanSummary = { id: plan.id, title: plan.title };
    } else {
      if (!planFile) {
        throw new Error(
          'Plan file is required, or use --next/--current/--next-ready/--latest to find a plan'
        );
      }
      resolvedPlanFile = await resolvePlanFile(planFile, globalCliOptions.config);
    }

    if (!resolvedPlanFile) {
      throw new Error('No plan file resolved for agent execution.');
    }

    const resolvedPlanFilePath = resolvedPlanFile;
    didInvokeAgent = true;
    if (!headlessPlanSummary) {
      try {
        const plan = await readPlanFile(resolvedPlanFilePath);
        headlessPlanSummary = {
          id: plan.id,
          title: plan.title,
        };
      } catch {
        // No-op: missing plan metadata should not block execution.
      }
    }

    await runWithHeadlessAdapterIfEnabled({
      enabled: !isTunnelActive(),
      command: 'agent',
      config,
      plan: headlessPlanSummary,
      callback: async () => timAgent(resolvedPlanFilePath, options, globalCliOptions),
    });
  } catch (err) {
    if (!didInvokeAgent) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await notifyAgentError(`tim agent failed: ${errorMessage}`, errorMessage);
    }
    throw err;
  }
}

async function updatePlanBranchMetadata(planFilePath: string, baseDir: string): Promise<void> {
  try {
    const planData = await readPlanFile(planFilePath);
    const gitRootForBranch = await getGitRoot(baseDir);
    const currentBranch = await getCurrentBranchName(baseDir);
    const trunkBranch = await getTrunkBranch(gitRootForBranch);
    if (currentBranch && currentBranch !== trunkBranch && planData.branch !== currentBranch) {
      planData.branch = currentBranch;
      await writePlanFile(planFilePath, planData);
    }
  } catch (err) {
    warn(`Failed to update plan branch metadata: ${err as Error}`);
  }
}

export async function timAgent(planFile: string, options: any, globalCliOptions: any) {
  let currentPlanFile = planFile;
  let config = getDefaultConfig();
  let currentBaseDir = process.cwd();
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let executionError: Error | undefined;
  let hadExecutionFailure = false;
  let failureReason: Error | undefined;
  let lastKnownPlan: PlanSchema | undefined;
  const recordFailure = (err: unknown): void => {
    if (failureReason) return;
    if (err instanceof Error) {
      failureReason = err;
      return;
    }
    failureReason = new Error(typeof err === 'string' ? err : String(err));
  };

  try {
    config = await loadEffectiveConfig(globalCliOptions.config);
    currentPlanFile = await resolvePlanFile(planFile, globalCliOptions.config);

    // Ensure all plans have UUIDs and complete reference entries before starting
    const tasksDir = await resolveTasksDir(config);
    const validationResult = await ensureUuidsAndReferences(tasksDir);
    if (validationResult.errors.length > 0) {
      validationResult.errors.forEach((err) => warn(`Validation warning: ${err}`));
    }

    if (options.log !== false) {
      const parsed = path.parse(currentPlanFile);
      let logFilePath = path.join(parsed.dir, parsed.name + '-agent-output.md');
      openLogFile(logFilePath);
    }

    // Determine the base directory for operations
    currentBaseDir = await getGitRoot();
    const initialPlanData = await readPlanFile(currentPlanFile);

    const workspaceResult = await setupWorkspace(
      {
        workspace: options.workspace,
        autoWorkspace: options.autoWorkspace,
        newWorkspace: options.newWorkspace,
        nonInteractive: options.nonInteractive,
        requireWorkspace: options.requireWorkspace,
        planUuid: initialPlanData.uuid,
        base: options.base,
      },
      currentBaseDir,
      currentPlanFile,
      config,
      'tim agent'
    );

    currentBaseDir = workspaceResult.baseDir;
    currentPlanFile = workspaceResult.planFile;
    touchedWorkspacePath = currentBaseDir;
    roundTripContext = await prepareWorkspaceRoundTrip({
      workspacePath: currentBaseDir,
      workspaceSyncEnabled: options.workspaceSync !== false,
    });

    if (roundTripContext) {
      await runPreExecutionWorkspaceSync(roundTripContext);
    }

    // Use orchestrator from CLI options, fallback to config defaultOrchestrator, or fallback to DEFAULT_EXECUTOR
    // Note: defaultOrchestrator and defaultExecutor are independent - agent command uses defaultOrchestrator
    const executorName = options.orchestrator || config.defaultOrchestrator || DEFAULT_EXECUTOR;
    const agentExecutionModel =
      options.model ||
      config.models?.execution ||
      defaultModelForExecutor(executorName, 'execution');

    // Determine subagent executor: CLI --executor flag -> config defaultSubagentExecutor -> 'dynamic'
    const subagentExecutor = (options.executor || config.defaultSubagentExecutor || 'dynamic') as
      | 'codex-cli'
      | 'claude-code'
      | 'dynamic';

    // Determine dynamic subagent instructions: CLI flag -> config -> default
    const dynamicSubagentInstructions =
      options.dynamicInstructions ||
      config.dynamicSubagentInstructions ||
      'Prefer claude-code for frontend tasks, codex-cli for backend tasks.';

    // Check if the plan needs preparation
    const planData = await readPlanFile(currentPlanFile);
    lastKnownPlan = planData;

    // Update workspace description from plan data (if running in a tracked workspace)
    await updateWorkspaceDescriptionFromPlan(currentBaseDir, planData, config);

    // Check if plan has simple field set and respect it
    // CLI flags take precedence: explicit --simple or --no-simple override plan field
    const hasExplicitSimpleFlag = 'simple' in options && options.simple !== undefined;
    if (!hasExplicitSimpleFlag && planData.simple === true) {
      options.simple = true;
    }
    // Check if plan has tdd field set and respect it
    // CLI flags take precedence: explicit --tdd or --no-tdd override plan field
    const hasExplicitTddFlag = 'tdd' in options && options.tdd !== undefined;
    if (!hasExplicitTddFlag && planData.tdd === true) {
      options.tdd = true;
    }

    const executorConfigEntry =
      config.executors && executorName in config.executors
        ? (config.executors as Record<string, unknown>)[executorName]
        : undefined;
    const configSimpleMode =
      executorConfigEntry && typeof executorConfigEntry === 'object'
        ? (executorConfigEntry as { simpleMode?: unknown }).simpleMode
        : undefined;
    const simpleModeEnabled = options.simple === true || configSimpleMode === true;
    const tddModeEnabled = options.tdd === true;
    const noninteractive = options.nonInteractive === true;
    const terminalInputEnabled =
      !noninteractive &&
      process.stdin.isTTY === true &&
      options.terminalInput !== false &&
      config.terminalInput !== false;

    const sharedExecutorOptions: ExecutorCommonOptions = {
      baseDir: currentBaseDir,
      model: agentExecutionModel,
      noninteractive: noninteractive ? true : undefined,
      terminalInput: terminalInputEnabled,
      simpleMode: simpleModeEnabled ? true : undefined,
      reviewExecutor: options.reviewExecutor,
      subagentExecutor,
      dynamicSubagentInstructions,
    };

    const executor = options.simple
      ? buildExecutorAndLog(executorName, sharedExecutorOptions, config, { simpleMode: true })
      : buildExecutorAndLog(executorName, sharedExecutorOptions, config);
    const executionMode: 'normal' | 'simple' | 'tdd' = tddModeEnabled
      ? 'tdd'
      : simpleModeEnabled
        ? 'simple'
        : 'normal';

    // Determine updateDocs mode: CLI option overrides config
    const updateDocsMode: 'never' | 'after-iteration' | 'after-completion' =
      options.updateDocs || config.updateDocs?.mode || 'never';

    if (isAutoClaimEnabled()) {
      if (planData.uuid) {
        try {
          await autoClaimPlan(
            { plan: { ...planData, filename: currentPlanFile }, uuid: planData.uuid },
            { cwdForIdentity: currentBaseDir }
          );
        } catch (err) {
          const label = planData.id ?? planData.uuid;
          warn(`Failed to auto-claim plan ${label}: ${err as Error}`);
        }
      } else {
        warn(`Plan at ${currentPlanFile} is missing a UUID; skipping auto-claim.`);
      }
    }

    // Initialize execution summary collection
    // Default enabled unless explicitly disabled by CLI or env var
    // TIM_SUMMARY_ENABLED can be set to '0' or 'false' (case-insensitive) to disable by default
    const envSummary = process.env.TIM_SUMMARY_ENABLED;
    const envSummaryEnabled =
      envSummary == null ? true : !(envSummary.toLowerCase() === 'false' || envSummary === '0');
    const summaryEnabled = options.summary === false ? false : envSummaryEnabled;
    const summaryFilePath: string | undefined = options.summaryFile;
    const summaryCollector = new SummaryCollector({
      planId: planData.id?.toString() ?? 'unknown',
      planTitle: planData.title ?? 'Untitled Plan',
      planFilePath: currentPlanFile,
      mode: options.serialTasks ? 'serial' : 'batch',
    });
    if (summaryEnabled) summaryCollector.recordExecutionStart(currentBaseDir);
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
        const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
        if (!commandSucceeded) {
          return commandConfig.title;
        }
      }

      return null;
    };

    // Check if this is a true stub plan (no tasks at all)
    const needsPreparation = !planData.tasks.length;

    if (needsPreparation) {
      // This is a true stub plan with no tasks - handle it specially
      // Direct execution branch for true stub plans (no tasks)
      try {
        await updatePlanBranchMetadata(currentPlanFile, currentBaseDir);
        await executeStubPlan({
          config,
          baseDir: currentBaseDir,
          planFilePath: currentPlanFile,
          planData,
          executor,
          commit: true,
          dryRun: options.dryRun,
          executionMode,
          finalReview: options.finalReview,
          configPath: globalCliOptions.config,
        });
      } catch (err) {
        error('Direct execution failed:', err);
        if (summaryEnabled) summaryCollector.addError(err);
        throw err;
      } finally {
        if (summaryEnabled) {
          summaryCollector.recordExecutionEnd();
          await summaryCollector.trackFileChanges(currentBaseDir);
          await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
        }
        await closeLogFile();
      }
      return;
    }

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;

    // Check if batch mode is enabled (default is true, disabled by --serial-tasks)
    if (!options.serialTasks) {
      try {
        await updatePlanBranchMetadata(currentPlanFile, currentBaseDir);
        const res = await executeBatchMode(
          {
            config,
            baseDir: currentBaseDir,
            currentPlanFile,
            executor,
            dryRun: options.dryRun,
            executorName,
            maxSteps,
            executionMode,
            updateDocsMode,
            applyLessons: options.applyLessons,
            finalReview: options.finalReview,
            configPath: globalCliOptions.config,
          },
          summaryEnabled ? summaryCollector : undefined
        );
        return res;
      } catch (err) {
        if (summaryEnabled) summaryCollector.addError(err);
        throw err;
      } finally {
        if (summaryEnabled) {
          summaryCollector.recordExecutionEnd();
          await summaryCollector.trackFileChanges(currentBaseDir);
          await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
        }
        await closeLogFile();
      }
    }

    log('Starting agent to execute plan:', currentPlanFile);
    try {
      let hasError = false;

      // Track initial state to determine whether to skip final review
      // We skip final review if we started with no tasks completed and finished in a single iteration
      const initialCompletedTaskCount = planData.tasks.filter((t) => t.done).length;

      let stepCount = 0;
      while (stepCount < maxSteps) {
        stepCount++;

        const planData = await readPlanFile(currentPlanFile);
        lastKnownPlan = planData;
        let planFileNeedsUpdate = false;

        // Check if status needs to be updated from 'pending' to 'in progress'
        if (planData.status === 'pending') {
          planData.status = 'in_progress';
          planData.updatedAt = new Date().toISOString();
          planFileNeedsUpdate = true;

          // If this plan has a parent, mark it as in_progress too
          if (planData.parent) {
            await markParentInProgress(planData.parent, config);
          }
        }

        // Keep branch metadata current while processing plans.
        try {
          const gitRootForBranch = await getGitRoot(currentBaseDir);
          const currentBranch = await getCurrentBranchName(currentBaseDir);
          const trunkBranch = await getTrunkBranch(gitRootForBranch);
          if (currentBranch && currentBranch !== trunkBranch && planData.branch !== currentBranch) {
            planData.branch = currentBranch;
            planFileNeedsUpdate = true;
          }
        } catch (err) {
          warn(`Failed to update plan branch metadata: ${err as Error}`);
        }

        if (planFileNeedsUpdate) {
          await writePlanFile(currentPlanFile, planData);
        }

        const actionableItem = findNextActionableItem(planData);
        if (!actionableItem) {
          sendStructured({
            type: 'task_completion',
            timestamp: timestamp(),
            planComplete: true,
          });
          break;
        }

        // Branch based on the type of actionable item
        if (actionableItem.type === 'task') {
          // Simple task without steps
          sendStructured({
            type: 'agent_iteration_start',
            timestamp: timestamp(),
            iterationNumber: stepCount,
            taskTitle: actionableItem.task.title,
            taskDescription: actionableItem.task.description,
          });

          // Build the prompt for the simple task using the unified function
          const taskPrompt = await buildExecutionPromptWithoutSteps({
            executor,
            planData,
            planFilePath: currentPlanFile,
            baseDir: currentBaseDir,
            config,
            task: {
              title: actionableItem.task.title,
              description: actionableItem.task.description,
            },
            filePathPrefix: executor.filePathPrefix,
            includeCurrentPlanContext: false, // Don't include current plan context since it's already in project context
          });

          if (options.dryRun) {
            log(boldMarkdownHeaders('\n## Dry Run - Generated Prompt\n'));
            log(taskPrompt);
            log('\n--dry-run mode: Would execute the above prompt');
            break;
          }

          try {
            sendStructured({
              type: 'agent_step_start',
              timestamp: timestamp(),
              phase: 'execution',
              executor: executorName,
              stepNumber: stepCount,
            });
            const start = Date.now();
            const output = await executor.execute(taskPrompt, {
              planId: planData.id?.toString() ?? 'unknown',
              planTitle: planData.title ?? 'Untitled Plan',
              planFilePath: currentPlanFile,
              executionMode,
              captureOutput: summaryEnabled ? 'result' : 'none',
            });
            // Detect executor-declared failure and stop early
            const ok = output ? output.success !== false : true;
            if (!ok) {
              const fd = output?.failureDetails;
              sendFailureReport(fd?.problems || 'Executor reported failure.', {
                requirements: fd?.requirements,
                problems: fd?.problems,
                solutions: fd?.solutions,
                sourceAgent: fd?.sourceAgent,
              });
              hasError = true;
              recordFailure(fd?.problems || 'Executor reported failure.');
            }
            sendStructured({
              type: 'agent_step_end',
              timestamp: timestamp(),
              phase: 'execution',
              success: ok,
              summary: ok ? 'Task execution completed.' : 'Task execution failed.',
            });
            if (summaryEnabled) {
              const end = Date.now();
              summaryCollector.addStepResult({
                title: `Task ${actionableItem.taskIndex + 1}: ${actionableItem.task.title}`,
                executor: executorName,
                output: output ?? undefined,
                success: ok,
                startedAt: new Date(start).toISOString(),
                endedAt: new Date(end).toISOString(),
                durationMs: end - start,
              });
            }
            if (hasError) break;
          } catch (err) {
            error('Task execution failed:', err);
            hasError = true;
            recordFailure(err);
            if (summaryEnabled) {
              summaryCollector.addStepResult({
                title: `Task ${actionableItem.taskIndex + 1}: ${actionableItem.task.title}`,
                executor: executorName,
                success: false,
                errorMessage: String(err instanceof Error ? err.message : err),
              });
            }
            sendStructured({
              type: 'agent_step_end',
              timestamp: timestamp(),
              phase: 'execution',
              success: false,
              summary: `Task execution threw: ${String(err instanceof Error ? err.message : err)}`,
            });
            break;
          }

          // Run post-apply commands if configured
          const failedPostApplyCommand = await runPostApplyCommands();
          if (failedPostApplyCommand) {
            error(`Agent stopping because required command "${failedPostApplyCommand}" failed.`);
            hasError = true;
            recordFailure(`Post-apply command failed: ${failedPostApplyCommand}`);
            if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
            break;
          }

          // Update docs if configured for after-iteration mode
          if (updateDocsMode === 'after-iteration') {
            try {
              await runUpdateDocs(currentPlanFile, config, {
                executor: config.updateDocs?.executor,
                model: config.updateDocs?.model,
                baseDir: currentBaseDir,
                justCompletedTaskIndices: [actionableItem.taskIndex],
              });
            } catch (err) {
              error('Failed to update documentation:', err);
              // Don't stop execution for documentation update failures
            }

            const failedAfterDocsPostApplyCommand = await runPostApplyCommands();
            if (failedAfterDocsPostApplyCommand) {
              error(
                `Agent stopping because required command "${failedAfterDocsPostApplyCommand}" failed.`
              );
              hasError = true;
              recordFailure(`Post-apply command failed: ${failedAfterDocsPostApplyCommand}`);
              if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
              break;
            }
          }

          // Mark the task as done
          try {
            log(boldMarkdownHeaders('\n## Marking task done\n'));
            const markResult = await markTaskDone(
              currentPlanFile,
              actionableItem.taskIndex,
              { commit: true },
              currentBaseDir,
              config
            );
            // Defer file change tracking to the end for efficiency

            if (markResult.planComplete) {
              sendStructured({
                type: 'task_completion',
                timestamp: timestamp(),
                taskTitle: actionableItem.task.title,
                planComplete: true,
              });

              // Update docs if configured for after-completion mode
              if (updateDocsMode === 'after-completion') {
                try {
                  await runUpdateDocs(currentPlanFile, config, {
                    executor: config.updateDocs?.executor,
                    model: config.updateDocs?.model,
                    baseDir: currentBaseDir,
                  });
                } catch (err) {
                  error('Failed to update documentation:', err);
                  // Don't stop execution for documentation update failures
                }

                const failedAfterCompletionDocsPostApplyCommand = await runPostApplyCommands();
                if (failedAfterCompletionDocsPostApplyCommand) {
                  error(
                    `Agent stopping because required command "${failedAfterCompletionDocsPostApplyCommand}" failed.`
                  );
                  hasError = true;
                  recordFailure(
                    `Post-apply command failed: ${failedAfterCompletionDocsPostApplyCommand}`
                  );
                  if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
                  break;
                }
              }

              // Run final review if enabled
              // Skip if we started with no completed tasks and finished in a single iteration
              const shouldSkipFinalReview =
                options.finalReview === false ||
                (initialCompletedTaskCount === 0 && stepCount === 1);
              let planStillCompleteAfterReview = true;
              if (!shouldSkipFinalReview) {
                sendStructured({
                  type: 'workflow_progress',
                  timestamp: timestamp(),
                  phase: 'final-review',
                  message: 'Running final review',
                });
                try {
                  const reviewResult = await handleReviewCommand(
                    currentPlanFile,
                    {},
                    {
                      parent: { opts: () => ({ config: globalCliOptions.config }) },
                    }
                  );

                  // If tasks were appended, ask if user wants to continue
                  if (reviewResult?.tasksAppended && reviewResult.tasksAppended > 0) {
                    // Read the updated plan to get the plan ID
                    const updatedPlanData = await readPlanFile(currentPlanFile);
                    const planIdStr = updatedPlanData.id ? ` ${updatedPlanData.id}` : '';
                    const shouldContinue = await promptConfirm({
                      message: `${reviewResult.tasksAppended} new task(s) added from review to plan${planIdStr}. You can edit the plan first if needed. Continue running?`,
                      default: true,
                    });

                    if (shouldContinue) {
                      continue; // Continue the loop to process new tasks
                    }

                    // New tasks were appended but execution is not continuing,
                    // so the plan is no longer complete.
                    planStillCompleteAfterReview = false;
                  }
                } catch (err) {
                  warn(`Final review failed: ${err as Error}`);
                  // Don't fail the agent - plan execution succeeded
                }
              }

              if (
                planStillCompleteAfterReview &&
                (config.updateDocs?.applyLessons || options.applyLessons)
              ) {
                try {
                  await runUpdateLessons(currentPlanFile, config, {
                    executor: config.updateDocs?.executor,
                    model: config.updateDocs?.model,
                    baseDir: currentBaseDir,
                  });
                } catch (err) {
                  error('Failed to apply lessons learned:', err as Error);
                  // Don't stop execution for lessons update failures
                }

                const failedAfterLessonsPostApplyCommand = await runPostApplyCommands();
                if (failedAfterLessonsPostApplyCommand) {
                  error(
                    `Agent stopping because required command "${failedAfterLessonsPostApplyCommand}" failed.`
                  );
                  hasError = true;
                  recordFailure(`Post-apply command failed: ${failedAfterLessonsPostApplyCommand}`);
                  if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
                  break;
                }
              } else if (
                !planStillCompleteAfterReview &&
                (config.updateDocs?.applyLessons || options.applyLessons)
              ) {
                log(
                  'Skipping lessons-learned documentation update because review added new tasks.'
                );
              }

              break;
            }
            sendStructured({
              type: 'task_completion',
              timestamp: timestamp(),
              taskTitle: actionableItem.task.title,
              planComplete: false,
            });
          } catch (err) {
            error('Failed to mark task as done:', err);
            hasError = true;
            recordFailure(err);
            if (summaryEnabled) summaryCollector.addError(err);
            break;
          }

          continue;
        }

        // Handle step execution (existing logic)
        const pendingTaskInfo = {
          taskIndex: actionableItem.taskIndex,
          task: actionableItem.task,
        };

        const stepPreparationResult = await prepareNextStep(
          config,
          currentPlanFile,
          {
            filePathPrefix: executor.filePathPrefix,
          },
          currentBaseDir
        ).catch((err) => {
          error('Failed to prepare next step:', err);
          hasError = true;
          recordFailure(err);
          if (summaryEnabled) summaryCollector.addError(err);
          return null;
        });

        if (!stepPreparationResult) {
          break;
        }

        sendStructured({
          type: 'agent_iteration_start',
          timestamp: timestamp(),
          iterationNumber: stepCount,
          taskTitle: pendingTaskInfo.task.title,
          taskDescription: pendingTaskInfo.task.description,
        });

        const { taskIndex } = stepPreparationResult;

        let contextContent: string;

        sendStructured({
          type: 'workflow_progress',
          timestamp: timestamp(),
          phase: 'context',
          message: 'Using direct prompt as context',
        });
        contextContent = stepPreparationResult.prompt;
        log(contextContent);

        if (options.dryRun) {
          log('\n--dry-run mode: Would execute the above context');
          break;
        }

        try {
          sendStructured({
            type: 'agent_step_start',
            timestamp: timestamp(),
            phase: 'execution',
            executor: executorName,
            stepNumber: stepCount,
          });
          const start = Date.now();
          const output = await executor.execute(contextContent, {
            planId: planData.id?.toString() ?? 'unknown',
            planTitle: planData.title ?? 'Untitled Plan',
            planFilePath: currentPlanFile,
            executionMode,
            captureOutput: summaryEnabled ? 'result' : 'none',
          });
          const ok = output ? output.success !== false : true;
          if (!ok) {
            const fd = output?.failureDetails;
            sendFailureReport(fd?.problems || 'Executor reported failure.', {
              requirements: fd?.requirements,
              problems: fd?.problems,
              solutions: fd?.solutions,
              sourceAgent: fd?.sourceAgent,
            });
            hasError = true;
            recordFailure(fd?.problems || 'Executor reported failure.');
          }
          sendStructured({
            type: 'agent_step_end',
            timestamp: timestamp(),
            phase: 'execution',
            success: ok,
            summary: ok ? 'Step execution completed.' : 'Step execution failed.',
          });
          if (summaryEnabled) {
            const end = Date.now();
            summaryCollector.addStepResult({
              title: `${pendingTaskInfo.task.title}`,
              executor: executorName,
              success: ok,
              output: output ?? undefined,
              startedAt: new Date(start).toISOString(),
              endedAt: new Date(end).toISOString(),
              durationMs: end - start,
            });
          }
          if (hasError) break;
        } catch (err) {
          error('Execution step failed:', err);
          hasError = true;
          recordFailure(err);
          if (summaryEnabled) {
            summaryCollector.addStepResult({
              title: `${pendingTaskInfo.task.title}`,
              executor: executorName,
              success: false,
              errorMessage: String(err instanceof Error ? err.message : err),
            });
          }
          sendStructured({
            type: 'agent_step_end',
            timestamp: timestamp(),
            phase: 'execution',
            success: false,
            summary: `Step execution threw: ${String(err instanceof Error ? err.message : err)}`,
          });
          break;
        }

        const failedPostApplyCommand = await runPostApplyCommands();
        if (failedPostApplyCommand) {
          error(`Agent stopping because required command "${failedPostApplyCommand}" failed.`);
          hasError = true;
          recordFailure(`Post-apply command failed: ${failedPostApplyCommand}`);
          if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
          break;
        }

        // Update docs if configured for after-iteration mode
        if (updateDocsMode === 'after-iteration') {
          try {
            await runUpdateDocs(currentPlanFile, config, {
              executor: config.updateDocs?.executor,
              model: config.updateDocs?.model,
              baseDir: currentBaseDir,
              justCompletedTaskIndices: [taskIndex],
            });
          } catch (err) {
            error('Failed to update documentation:', err);
            // Don't stop execution for documentation update failures
          }

          const failedAfterDocsPostApplyCommand = await runPostApplyCommands();
          if (failedAfterDocsPostApplyCommand) {
            error(
              `Agent stopping because required command "${failedAfterDocsPostApplyCommand}" failed.`
            );
            hasError = true;
            recordFailure(`Post-apply command failed: ${failedAfterDocsPostApplyCommand}`);
            if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
            break;
          }
        }

        let markResult;
        try {
          log(boldMarkdownHeaders('\n## Marking done\n'));
          markResult = await markStepDone(
            currentPlanFile,
            { commit: true },
            { taskIndex },
            currentBaseDir,
            config
          );
          // Defer file change tracking to the end for efficiency
          sendStructured({
            type: 'task_completion',
            timestamp: timestamp(),
            taskTitle: pendingTaskInfo.task.title,
            planComplete: markResult.planComplete,
          });
          if (markResult.planComplete) {
            // Update docs if configured for after-completion mode
            if (updateDocsMode === 'after-completion') {
              try {
                await runUpdateDocs(currentPlanFile, config, {
                  executor: config.updateDocs?.executor,
                  model: config.updateDocs?.model,
                  baseDir: currentBaseDir,
                });
              } catch (err) {
                error('Failed to update documentation:', err);
                // Don't stop execution for documentation update failures
              }

              const failedAfterCompletionDocsPostApplyCommand = await runPostApplyCommands();
              if (failedAfterCompletionDocsPostApplyCommand) {
                error(
                  `Agent stopping because required command "${failedAfterCompletionDocsPostApplyCommand}" failed.`
                );
                hasError = true;
                recordFailure(
                  `Post-apply command failed: ${failedAfterCompletionDocsPostApplyCommand}`
                );
                if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
                break;
              }
            }

            if (config.updateDocs?.applyLessons || options.applyLessons) {
              try {
                await runUpdateLessons(currentPlanFile, config, {
                  executor: config.updateDocs?.executor,
                  model: config.updateDocs?.model,
                  baseDir: currentBaseDir,
                });
              } catch (err) {
                error('Failed to apply lessons learned:', err as Error);
                // Don't stop execution for lessons update failures
              }

              const failedAfterLessonsPostApplyCommand = await runPostApplyCommands();
              if (failedAfterLessonsPostApplyCommand) {
                error(
                  `Agent stopping because required command "${failedAfterLessonsPostApplyCommand}" failed.`
                );
                hasError = true;
                recordFailure(`Post-apply command failed: ${failedAfterLessonsPostApplyCommand}`);
                if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
                break;
              }
            }

            break;
          }
        } catch (err) {
          error('Failed to mark step as done:', err);
          hasError = true;
          recordFailure(err);
          if (summaryEnabled) summaryCollector.addError(err);
          break;
        }
      }

      if (hasError) {
        throw new Error('Agent stopped due to error.');
      }
    } finally {
      if (summaryEnabled) {
        summaryCollector.recordExecutionEnd();
        await summaryCollector.trackFileChanges(currentBaseDir);
        await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
      }
      await closeLogFile();
    }
  } catch (err) {
    hadExecutionFailure = true;
    executionError = failureReason ?? (err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    let workspaceSyncError: Error | undefined;
    if (roundTripContext) {
      try {
        const planTitle = lastKnownPlan?.title || path.parse(currentPlanFile).name;
        await runPostExecutionWorkspaceSync(roundTripContext, planTitle);
      } catch (err) {
        workspaceSyncError = err instanceof Error ? err : new Error(String(err));
        if (!executionError) {
          executionError = workspaceSyncError;
        } else {
          warn(`Workspace sync failed after execution error: ${workspaceSyncError}`);
        }
      }
    }

    if (touchedWorkspacePath) {
      try {
        touchWorkspaceInfo(touchedWorkspacePath);
      } catch (err) {
        warn(`Failed to update workspace last used time: ${err as Error}`);
      }
    }

    let planForNotification = lastKnownPlan;
    try {
      planForNotification = await readPlanFile(currentPlanFile);
    } catch (err) {
      if (!planForNotification) {
        warn(`Failed to read plan for notification: ${err as Error}`);
      }
    }

    const planSummary = planForNotification ? getCombinedTitleFromSummary(planForNotification) : '';
    const status = executionError ? 'error' : 'success';
    let message = `tim agent ${executionError ? 'failed' : 'completed'}`;
    if (planSummary) {
      message += `: ${planSummary}`;
    }
    if (executionError?.message) {
      message += ` (${executionError.message})`;
    }

    try {
      await sendNotification(config, {
        command: 'agent',
        event: 'agent_done',
        status,
        message,
        errorMessage: executionError?.message,
        cwd: currentBaseDir,
        plan: planForNotification,
        planFile: currentPlanFile,
      });
    } catch (err) {
      warn(`Failed to send notification: ${err as Error}`);
    }

    if (!hadExecutionFailure && workspaceSyncError) {
      throw workspaceSyncError;
    }
  }
}

/**
 * Updates the workspace description from plan data.
 * Only updates if the current directory is a tracked workspace.
 * Failures are logged as warnings but do not abort the agent.
 */
async function updateWorkspaceDescriptionFromPlan(
  baseDir: string,
  planData: PlanSchema,
  _config: { paths?: { trackingFile?: string } }
): Promise<void> {
  try {
    // Check if the current directory is a tracked workspace
    const workspaceMetadata = getWorkspaceInfoByPath(baseDir);
    if (!workspaceMetadata) {
      // Not a tracked workspace, skip silently
      return;
    }

    // Build description from plan
    const description = buildDescriptionFromPlan(planData);
    const planId = planData.id ? String(planData.id) : '';
    const prefixedDescription = planId ? `${planId} - ${description}` : description;
    const planTitle = getCombinedTitleFromSummary(planData);

    // Update workspace metadata
    patchWorkspaceInfo(baseDir, {
      description: prefixedDescription,
      planId,
      planTitle: planTitle || '',
      issueUrls: planData.issue && planData.issue.length > 0 ? [...planData.issue] : [],
    });
  } catch (err) {
    // Warn but do not abort
    warn(`Failed to update workspace description: ${err as Error}`);
  }
}
