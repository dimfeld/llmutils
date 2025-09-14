// Command handler for 'rmplan agent' and 'rmplan run'
// Automatically executes steps in a plan YAML file

import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as path from 'path';
import { getGitRoot } from '../../../common/git.js';
import { logSpawn } from '../../../common/process.js';
import {
  boldMarkdownHeaders,
  closeLogFile,
  error,
  log,
  openLogFile,
  warn,
} from '../../../logging.js';
import { executePostApplyCommand } from '../../actions.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { resolveTasksDir } from '../../configSchema.js';
import { getCombinedTitleFromSummary } from '../../display_utils.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../../executors/index.js';
import type { ExecutorCommonOptions } from '../../executors/types.js';
import { findNextPlan, readPlanFile, resolvePlanFile, writePlanFile } from '../../plans.js';
import { findNextActionableItem } from '../../plans/find_next.js';
import { markStepDone, markTaskDone } from '../../plans/mark_done.js';
import { preparePhase } from '../../plans/prepare_phase.js';
import { prepareNextStep } from '../../plans/prepare_step.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { WorkspaceAutoSelector } from '../../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../../workspace/workspace_lock.js';
import { createWorkspace } from '../../workspace/workspace_manager.js';
import { findWorkspacesByTaskId } from '../../workspace/workspace_tracker.js';
import { findNextReadyDependency } from '../find_next_dependency.js';
import { executeBatchMode } from './batch_mode.js';
import { markParentInProgress } from './parent_plans.js';
import { executeStubPlan } from './stub_plan.js';
import { SummaryCollector } from '../../summary/collector.js';

export async function handleAgentCommand(
  planFile: string | undefined,
  options: any,
  globalCliOptions: any
) {
  const config = await loadEffectiveConfig(globalCliOptions.config);
  let resolvedPlanFile: string;

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
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));
    resolvedPlanFile = result.plan.filename;
  } else if (options.next || options.current) {
    // Find the next ready plan or current plan
    const tasksDir = await resolveTasksDir(config);
    const plan = await findNextPlan(tasksDir, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        log('No current plans found. No plans are in progress or ready to be implemented.');
      } else {
        log('No ready plans found. All pending plans have incomplete dependencies.');
      }
      return;
    }

    const message = options.current
      ? `Found current plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`
      : `Found next ready plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`;
    log(chalk.green(message));
    resolvedPlanFile = plan.filename;
  } else {
    if (!planFile) {
      throw new Error('Plan file is required, or use --next/--current/--next-ready to find a plan');
    }
    resolvedPlanFile = planFile;
  }

  await rmplanAgent(resolvedPlanFile, options, globalCliOptions);
}

export async function rmplanAgent(planFile: string, options: any, globalCliOptions: any) {
  let currentPlanFile = await resolvePlanFile(planFile, globalCliOptions.config);
  const config = await loadEffectiveConfig(globalCliOptions.config);

  if (options.log !== false) {
    const parsed = path.parse(currentPlanFile);
    let logFilePath = path.join(parsed.dir, parsed.name + '-agent-output.md');
    openLogFile(logFilePath);
  }

  // Determine the base directory for operations
  let currentBaseDir = await getGitRoot();

  // Handle workspace creation or auto-selection
  if (options.workspace || options.autoWorkspace) {
    let workspace;
    let selectedWorkspace;

    if (options.autoWorkspace) {
      // Use auto-selector to find or create a workspace
      log('Auto-selecting workspace...');
      const selector = new WorkspaceAutoSelector(currentBaseDir, config);
      const taskId =
        options.workspace ||
        `${path.parse(currentBaseDir).dir.split(path.sep).pop()}-${Date.now()}`;

      selectedWorkspace = await selector.selectWorkspace(taskId, currentPlanFile, {
        interactive: !options.nonInteractive,
        preferNewWorkspace: options.newWorkspace,
      });

      if (selectedWorkspace) {
        workspace = {
          path: selectedWorkspace.workspace.workspacePath,
          originalPlanFilePath: selectedWorkspace.workspace.originalPlanFilePath,
          taskId: selectedWorkspace.workspace.taskId,
        };

        if (selectedWorkspace.isNew) {
          log(`Created new workspace for task: ${workspace.taskId}`);
        } else {
          log(`Selected existing workspace for task: ${selectedWorkspace.workspace.taskId}`);
          if (selectedWorkspace.clearedStaleLock) {
            log('(Cleared stale lock)');
          }
        }
      }
    } else {
      // Manual workspace handling - check if workspace exists first
      const trackingFilePath = config.paths?.trackingFile;
      const existingWorkspaces = await findWorkspacesByTaskId(options.workspace, trackingFilePath);

      if (existingWorkspaces.length > 0) {
        // Find the first available workspace (not locked)
        let availableWorkspace = null;
        for (const ws of existingWorkspaces) {
          const lockInfo = await WorkspaceLock.getLockInfo(ws.workspacePath);
          if (!lockInfo || (await WorkspaceLock.isLockStale(lockInfo))) {
            availableWorkspace = ws;
            break;
          }
        }

        if (availableWorkspace) {
          log(`Using existing workspace for task: ${options.workspace}`);
          workspace = {
            path: availableWorkspace.workspacePath,
            originalPlanFilePath: availableWorkspace.originalPlanFilePath,
            taskId: availableWorkspace.taskId,
          };
        } else {
          throw new Error(
            `Workspace with task ID '${options.workspace}' exists but is locked, and --new-workspace was not specified. Cannot proceed.`
          );
        }
      } else if (options.newWorkspace) {
        // No existing workspace, create a new one
        log(`Creating workspace for task: ${options.workspace}`);
        workspace = await createWorkspace(
          currentBaseDir,
          options.workspace,
          currentPlanFile,
          config
        );
      } else {
        throw new Error(
          `No workspace found for task ID '${options.workspace}' and --new-workspace was not specified. Cannot proceed.`
        );
      }
    }

    if (workspace) {
      log(boldMarkdownHeaders('\n## Workspace Information'));
      log(`Task ID: ${options.workspace}`);
      log(`Workspace Path: ${workspace.path}`);
      log(`Original Plan: ${currentPlanFile}`);

      // Validate that the workspace is properly initialized
      try {
        const gitStatus = logSpawn(['git', 'status'], {
          cwd: workspace.path,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (gitStatus.exitCode !== 0) {
          warn(
            `Workspace at ${workspace.path} may not be properly initialized. Git operations failed.`
          );
        }
      } catch (err) {
        warn(`Error validating workspace: ${String(err)}`);
      }

      // Copy the plan file to the workspace
      const workspacePlanFile = path.join(workspace.path, currentPlanFile);
      try {
        log(`Copying plan file to workspace: ${workspacePlanFile}`);
        await Bun.write(workspacePlanFile, await Bun.file(currentPlanFile).text());

        // Update the planFile to use the copy in the workspace
        currentPlanFile = workspacePlanFile;
        log(`Using plan file in workspace: ${currentPlanFile}`);
      } catch (err) {
        error(`Failed to copy plan file to workspace: ${String(err)}`);
        error('Continuing with original plan file.');
      }

      // Use the workspace path as the base directory for operations
      currentBaseDir = workspace.path;
      log(`Using workspace as base directory: ${workspace.path}`);

      // Acquire lock if we didn't already (auto-selector doesn't create new workspaces)
      if (selectedWorkspace && !selectedWorkspace.isNew) {
        try {
          await WorkspaceLock.acquireLock(
            workspace.path,
            `rmplan agent --workspace ${workspace.taskId}`
          );
          WorkspaceLock.setupCleanupHandlers(workspace.path);
        } catch (error) {
          log(`Warning: Failed to acquire workspace lock: ${String(error)}`);
        }
      }

      log('---');
    } else {
      error('Failed to create workspace. Continuing in the current directory.');
      // If workspace creation is explicitly required, exit
      if (options.requireWorkspace) {
        throw new Error('Workspace creation was required but failed. Exiting.');
      }
    }
  }

  // Use executor from CLI options, fallback to config defaultExecutor, or fallback to CopyOnlyExecutor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const agentExecutionModel =
    options.model || config.models?.execution || defaultModelForExecutor(executorName, 'execution');

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: currentBaseDir,
    model: agentExecutionModel,
    interactive: options.interactiveExecutor,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // Check if the plan needs preparation
  const planData = await readPlanFile(currentPlanFile);

  // Initialize execution summary collection
  // Default enabled unless explicitly disabled by CLI or env var
  // RMPLAN_SUMMARY_ENABLED can be set to '0' or 'false' (case-insensitive) to disable by default
  const envSummary = process.env.RMPLAN_SUMMARY_ENABLED;
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
  if (summaryEnabled) summaryCollector.recordExecutionStart();

  // Check if this is a true stub plan (no tasks at all)
  const needsPreparation = !planData.tasks.length;

  if (needsPreparation) {
    // This is a true stub plan with no tasks - handle it specially
    let shouldGenerateSteps = true; // Default behavior

    if (!options.nonInteractive) {
      // Interactive mode - ask user what to do
      const choice = await select({
        message: 'This plan lacks detailed steps. How would you like to proceed?',
        choices: [
          {
            name: 'Generate detailed steps first',
            value: 'generate',
            description: 'Create step-by-step instructions before execution',
          },
          {
            name: 'Run the simple plan directly',
            value: 'direct',
            description: 'Execute using just the high-level goal and details',
          },
        ],
      });

      shouldGenerateSteps = choice === 'generate';
    }

    if (shouldGenerateSteps) {
      log('Plan needs preparation. Generating detailed steps and prompts...');
      try {
        await preparePhase(currentPlanFile, config, {
          model: options.model,
          direct: options.direct,
        });
        log('Successfully prepared the plan with detailed steps.');
      } catch (err) {
        if (summaryEnabled) summaryCollector.addError(err);
        throw new Error(`Failed to automatically prepare the plan: ${err as Error}`);
      }
    } else {
      log('Proceeding to execute plan directly using high-level description.');

      // Direct execution branch for true stub plans (no tasks)
      try {
        await executeStubPlan({
          config,
          baseDir: currentBaseDir,
          planFilePath: currentPlanFile,
          planData,
          executor,
          commit: true,
          dryRun: options.dryRun,
        });
      } catch (err) {
        error('Direct execution failed:', err);
        if (summaryEnabled) summaryCollector.addError(err);
        throw err;
      } finally {
        if (summaryEnabled) {
          summaryCollector.recordExecutionEnd();
          await summaryCollector.trackFileChanges(currentBaseDir);
          const { writeOrDisplaySummary } = await import('../../summary/display.js');
          await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
        }
        await closeLogFile();
      }
      return;
    }
  } else if (
    planData.tasks.length > 0 &&
    planData.tasks.some((task) => !task.steps || task.steps.length === 0)
  ) {
    // This plan has simple tasks (tasks without steps)
    let shouldGenerateSteps = true; // Default behavior

    if (!options.nonInteractive) {
      // Interactive mode - ask user what to do
      const choice = await select({
        message: 'This plan lacks detailed steps. How would you like to proceed?',
        choices: [
          {
            name: 'Generate detailed steps first',
            value: 'generate',
            description: 'Create step-by-step instructions before execution',
          },
          {
            name: 'Run the simple plan directly',
            value: 'direct',
            description: 'Execute using just the high-level goal and details',
          },
        ],
      });

      shouldGenerateSteps = choice === 'generate';
    }

    if (shouldGenerateSteps) {
      log('Plan needs preparation. Generating detailed steps and prompts...');
      try {
        await preparePhase(currentPlanFile, config, {
          model: options.model,
          direct: options.direct,
        });
        log('Successfully prepared the plan with detailed steps.');
      } catch (err) {
        if (summaryEnabled) summaryCollector.addError(err);
        throw new Error(`Failed to automatically prepare the plan: ${err as Error}`);
      }
    } else {
      log('Proceeding to execute simple tasks directly.');
      // For simple tasks, proceed to the main execution loop
      // Do NOT call executeStubPlan - that's only for plans with no tasks
    }
  }

  // Check if batch mode is enabled (default is true, disabled by --serial-tasks)
  if (!options.serialTasks) {
    try {
      const res = await executeBatchMode(
        {
          config,
          baseDir: currentBaseDir,
          currentPlanFile,
          executor,
          dryRun: options.dryRun,
          executorName,
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
        const { writeOrDisplaySummary } = await import('../../summary/display.js');
        await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
      }
      await closeLogFile();
    }
  }

  log('Starting agent to execute plan:', currentPlanFile);
  try {
    let hasError = false;

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
    let stepCount = 0;
    while (stepCount < maxSteps) {
      stepCount++;

      const planData = await readPlanFile(currentPlanFile);

      // Check if status needs to be updated from 'pending' to 'in progress'
      if (planData.status === 'pending') {
        planData.status = 'in_progress';
        planData.updatedAt = new Date().toISOString();
        await writePlanFile(currentPlanFile, planData);

        // If this plan has a parent, mark it as in_progress too
        if (planData.parent) {
          await markParentInProgress(planData.parent, config);
        }
      }

      const actionableItem = findNextActionableItem(planData);
      if (!actionableItem) {
        log('Plan complete!');
        break;
      }

      // Branch based on the type of actionable item
      if (actionableItem.type === 'task') {
        // Simple task without steps
        log(
          boldMarkdownHeaders(
            `# Iteration ${stepCount}: Simple Task ${actionableItem.taskIndex + 1}...`
          )
        );
        log(`Title: ${actionableItem.task.title}`);
        if (actionableItem.task.description) {
          log(`Description: ${actionableItem.task.description}`);
        }

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
            files: actionableItem.task.files,
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
          log(boldMarkdownHeaders('\n## Execution\n'));
          const start = Date.now();
          const output = await executor.execute(taskPrompt, {
            planId: planData.id?.toString() ?? 'unknown',
            planTitle: planData.title ?? 'Untitled Plan',
            planFilePath: currentPlanFile,
            executionMode: 'normal',
            captureOutput: summaryEnabled ? 'result' : 'none',
          });
          if (summaryEnabled) {
            const end = Date.now();
            const { parseExecutorOutput, toNormalizedOutput } = await import(
              '../../summary/parsers.js'
            );
            const parsed = parseExecutorOutput(executorName, output);
            const execNameNorm = (executorName ?? '')
              .toLowerCase()
              .replace(/[_\s]+/g, '-');
            summaryCollector.addStepResult({
              title: `Task ${actionableItem.taskIndex + 1}: ${actionableItem.task.title}`,
              executor: executorName,
              executorType:
                execNameNorm === 'claude-code' ? 'interactive' : execNameNorm === 'codex-cli' ? 'cli' : undefined,
              executorPhase:
                execNameNorm === 'claude-code'
                  ? 'orchestrator'
                  : execNameNorm === 'codex-cli'
                    ? 'implementer|tester|reviewer'
                    : undefined,
              success: parsed.success,
              errorMessage: parsed.success ? undefined : parsed.error,
              output: toNormalizedOutput(parsed),
              startedAt: new Date(start).toISOString(),
              endedAt: new Date(end).toISOString(),
              durationMs: end - start,
            });
            if (!parsed.success && parsed.error) {
              summaryCollector.addError(parsed.error);
            }
          }
        } catch (err) {
          error('Task execution failed:', err);
          hasError = true;
          if (summaryEnabled) {
            const execNameNorm = (executorName ?? '')
              .toLowerCase()
              .replace(/[_\s]+/g, '-');
            summaryCollector.addStepResult({
              title: `Task ${actionableItem.taskIndex + 1}: ${actionableItem.task.title}`,
              executor: executorName,
              executorType:
                execNameNorm === 'claude-code' ? 'interactive' : execNameNorm === 'codex-cli' ? 'cli' : undefined,
              executorPhase:
                execNameNorm === 'claude-code'
                  ? 'orchestrator'
                  : execNameNorm === 'codex-cli'
                    ? 'implementer|tester|reviewer'
                    : undefined,
              success: false,
              errorMessage: String(err instanceof Error ? err.message : err),
            });
          }
          break;
        }

        // Run post-apply commands if configured
        if (config.postApplyCommands && config.postApplyCommands.length > 0) {
          log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
          for (const commandConfig of config.postApplyCommands) {
            const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
            if (!commandSucceeded) {
              error(`Agent stopping because required command "${commandConfig.title}" failed.`);
              hasError = true;
              break;
            }
          }
          if (hasError) {
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
            log('Plan fully completed!');
            break;
          }
        } catch (err) {
          error('Failed to mark task as done:', err);
          hasError = true;
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

      const executorStepOptions = executor.prepareStepOptions?.() ?? {};
      const stepPreparationResult = await prepareNextStep(
        config,
        currentPlanFile,
        {
          previous: true,
          selectSteps: false,
          model: agentExecutionModel,
          ...executorStepOptions,
          filePathPrefix: executor.filePathPrefix,
          rmfilterArgs: options.rmfilterArgs,
        },
        currentBaseDir
      ).catch((err) => {
        error('Failed to prepare next step:', err);
        hasError = true;
        if (summaryEnabled) summaryCollector.addError(err);
        return null;
      });

      if (!stepPreparationResult) {
        break;
      }

      let stepIndexes: string;
      if (stepPreparationResult.numStepsSelected === 1) {
        stepIndexes = `Step ${stepPreparationResult.stepIndex + 1}`;
      } else {
        const endIndex =
          stepPreparationResult.stepIndex + stepPreparationResult.numStepsSelected + 1;
        stepIndexes = `Steps ${stepPreparationResult.stepIndex + 1}-${endIndex}`;
      }

      log(
        boldMarkdownHeaders(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, ${stepIndexes}...`
        )
      );

      const { promptFilePath, taskIndex, stepIndex, rmfilterArgs } = stepPreparationResult;

      let contextContent: string;

      if (executorStepOptions.rmfilter) {
        if (!promptFilePath || !rmfilterArgs) {
          error(
            'Executor requires rmfilter, but no prompt file path or rmfilter args were generated by prepareNextStep.'
          );
          hasError = true;
          if (summaryEnabled)
            summaryCollector.addError(
              'Executor requires rmfilter, but prepareNextStep did not provide required data'
            );
          break;
        }
        log(boldMarkdownHeaders('\n## Generating Context with rmfilter\n'));
        const rmfilterOutputPath = promptFilePath.replace('.md', '.xml');
        const proc = logSpawn(['rmfilter', '--output', rmfilterOutputPath, ...rmfilterArgs], {
          cwd: currentBaseDir,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        const exitRes = await proc.exited;
        if (exitRes !== 0) {
          error(`rmfilter exited with code ${exitRes}`);
          hasError = true;
          if (summaryEnabled) {
            const end = Date.now();
            summaryCollector.addError(`rmfilter exited with code ${exitRes}`);
            summaryCollector.addStepResult({
              title: `${stepIndexes}: ${pendingTaskInfo.task.title}`,
              executor: executorName,
              // Treat as CLI tool failure before executor runs
              success: false,
              errorMessage: `rmfilter exited with code ${exitRes}`,
              endedAt: new Date(end).toISOString(),
            });
          }
          break;
        }
        contextContent = await Bun.file(rmfilterOutputPath).text();
        // Clean up rmfilter output path if needed, or handle in executor
      } else {
        log(boldMarkdownHeaders('\n## Using Direct Prompt as Context\n'));
        contextContent = stepPreparationResult.prompt;
        log(contextContent);
      }

      if (options.dryRun) {
        log(boldMarkdownHeaders('\n## Dry Run - Generated Context\n'));
        if (!executorStepOptions.rmfilter) {
          log('(Context already shown above)');
        } else {
          log(contextContent);
        }
        log('\n--dry-run mode: Would execute the above context');
        break;
      }

      try {
        log(boldMarkdownHeaders('\n## Execution\n'));
        const start = Date.now();
        const output = await executor.execute(contextContent, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: currentPlanFile,
          executionMode: 'normal',
          captureOutput: summaryEnabled ? 'result' : 'none',
        });
        if (summaryEnabled) {
          const end = Date.now();
          const { parseExecutorOutput, toNormalizedOutput } = await import(
            '../../summary/parsers.js'
          );
          const parsed = parseExecutorOutput(executorName, output);
          const execNameNorm = (executorName ?? '')
            .toLowerCase()
            .replace(/[_\s]+/g, '-');
          summaryCollector.addStepResult({
            title: `${stepIndexes}: ${pendingTaskInfo.task.title}`,
            executor: executorName,
            executorType:
              execNameNorm === 'claude-code' ? 'interactive' : execNameNorm === 'codex-cli' ? 'cli' : undefined,
            executorPhase:
              execNameNorm === 'claude-code'
                ? 'orchestrator'
                : execNameNorm === 'codex-cli'
                  ? 'implementer|tester|reviewer'
                  : undefined,
            success: parsed.success,
            errorMessage: parsed.success ? undefined : parsed.error,
            output: toNormalizedOutput(parsed),
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(end).toISOString(),
            durationMs: end - start,
          });
          if (!parsed.success && parsed.error) {
            summaryCollector.addError(parsed.error);
          }
        }
      } catch (err) {
        error('Execution step failed:', err);
        hasError = true;
        if (summaryEnabled) {
          const execNameNorm = (executorName ?? '')
            .toLowerCase()
            .replace(/[_\s]+/g, '-');
          summaryCollector.addStepResult({
            title: `${stepIndexes}: ${pendingTaskInfo.task.title}`,
            executor: executorName,
            executorType:
              execNameNorm === 'claude-code' ? 'interactive' : execNameNorm === 'codex-cli' ? 'cli' : undefined,
            executorPhase:
              execNameNorm === 'claude-code'
                ? 'orchestrator'
                : execNameNorm === 'codex-cli'
                  ? 'implementer|tester|reviewer'
                  : undefined,
            success: false,
            errorMessage: String(err instanceof Error ? err.message : err),
          });
        }
        break;
      }

      if (config.postApplyCommands && config.postApplyCommands.length > 0) {
        log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
        for (const commandConfig of config.postApplyCommands) {
          const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
          if (!commandSucceeded) {
            // Error logging is handled within executePostApplyCommand
            error(`Agent stopping because required command "${commandConfig.title}" failed.`);
            hasError = true;
            break;
          }
        }
        if (hasError) {
          if (summaryEnabled) summaryCollector.addError('Post-apply command failed');
          break;
        }
      }

      let markResult;
      try {
        log(boldMarkdownHeaders('\n## Marking done\n'));
        markResult = await markStepDone(
          currentPlanFile,
          { steps: stepPreparationResult.numStepsSelected, commit: true },
          { taskIndex, stepIndex },
          currentBaseDir,
          config
        );
        // Defer file change tracking to the end for efficiency
        log(`Marked step as done: ${markResult.message.split('\n')[0]}`);
        if (markResult.planComplete) {
          log('Plan fully completed!');
          break;
        }
      } catch (err) {
        error('Failed to mark step as done:', err);
        hasError = true;
        if (summaryEnabled) summaryCollector.addError(err);
        break;
      } finally {
        if (promptFilePath && executorStepOptions.rmfilter) {
          // Only unlink if rmfilter was supposed to use it
          try {
            await Bun.file(promptFilePath).unlink();
          } catch (e) {
            warn('Warning: failed to clean up temp file:', promptFilePath);
          }
        }
      }
    }

    if (hasError) {
      throw new Error('Agent stopped due to error.');
    }
  } finally {
    if (summaryEnabled) {
      summaryCollector.recordExecutionEnd();
      await summaryCollector.trackFileChanges(currentBaseDir);
      const { writeOrDisplaySummary } = await import('../../summary/display.js');
      await writeOrDisplaySummary(summaryCollector.getExecutionSummary(), summaryFilePath);
    }
    await closeLogFile();
  }
}
