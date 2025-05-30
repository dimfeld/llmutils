import * as path from 'path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import yaml from 'yaml';
import { boldMarkdownHeaders, closeLogFile, error, log, openLogFile, warn } from '../logging.ts';
import { getGitRoot, logSpawn } from '../rmfilter/utils.ts';
import {
  executePostApplyCommand,
  findPendingTask,
  markStepDone,
  prepareNextStep,
  preparePhase,
} from './actions.ts';
import { loadEffectiveConfig } from './configLoader.ts';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from './executors/index.ts';
import type { ExecutorCommonOptions } from './executors/types.ts';
import { planSchema } from './planSchema.ts';
import { createWorkspace } from './workspace/workspace_manager.ts';
import { WorkspaceAutoSelector } from './workspace/workspace_auto_selector.ts';
import { WorkspaceLock } from './workspace/workspace_lock.ts';
import { findWorkspacesByTaskId } from './workspace/workspace_tracker.ts';

export async function rmplanAgent(planFile: string, options: any, globalCliOptions: any) {
  // Initialize currentPlanFile (absolute path)
  let currentPlanFile = path.resolve(planFile);

  const config = await loadEffectiveConfig(globalCliOptions.config);

  let parsed = path.parse(currentPlanFile);
  if (parsed.ext === '.md' || parsed.ext === '.' || !parsed.ext) {
    parsed.base = parsed.name + '.yml';
    parsed.ext = 'yml';
    currentPlanFile = path.join(parsed.dir, parsed.base);
  }

  // Verify the original plan file exists
  try {
    // Use stat to check if file exists
    try {
      await Bun.file(currentPlanFile).text();
    } catch {
      error(`Plan file ${currentPlanFile} does not exist or is empty.`);
      process.exit(1);
    }
  } catch (err) {
    error(`Error checking plan file: ${String(err)}`);
    process.exit(1);
  }

  if (!options['no-log']) {
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
          error(
            `Workspace with task ID '${options.workspace}' exists but is locked, and --new-workspace was not specified. Cannot proceed.`
          );
          process.exit(1);
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
        error(
          `No workspace found for task ID '${options.workspace}' and --new-workspace was not specified. Cannot proceed.`
        );
        process.exit(1);
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
        error('Workspace creation was required but failed. Exiting.');
        process.exit(1);
      }
    }
  }

  // Check if the plan needs preparation
  try {
    const fileContent = await Bun.file(currentPlanFile).text();
    const parsed = yaml.parse(fileContent);
    const planResult = planSchema.safeParse(parsed);

    if (planResult.success) {
      const planData = planResult.data;

      // Check if prompts have been generated
      const needsPreparation =
        !planData.promptsGeneratedAt ||
        planData.tasks.some((task) => !task.steps || task.steps.length === 0);

      if (needsPreparation) {
        log('Plan needs preparation. Generating detailed steps and prompts...');
        try {
          await preparePhase(currentPlanFile, config, {
            model: options.model,
            direct: options.direct,
          });
          log('Successfully prepared the plan with detailed steps.');
        } catch (err) {
          error('Failed to automatically prepare the plan:', err);
          error('You may need to run "rmplan prepare" manually.');
          process.exit(1);
        }
      }
    }
  } catch (err) {
    warn('Could not check if plan needs preparation:', err);
    // Continue anyway - the main loop will catch any issues
  }

  // Use executor from CLI options, fallback to config defaultExecutor, or fallback to CopyOnlyExecutor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const agentExecutionModel =
    options.model || config.models?.execution || defaultModelForExecutor(executorName, 'execution');

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: currentBaseDir,
    model: agentExecutionModel,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  log('Starting agent to execute plan:', currentPlanFile);
  try {
    let hasError = false;

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
    let stepCount = 0;
    while (stepCount < maxSteps) {
      stepCount++;

      const fileContent = await Bun.file(currentPlanFile).text();
      let parsed;
      try {
        parsed = yaml.parse(fileContent);
      } catch (err) {
        error('Failed to parse YAML:', err);
        process.exit(1);
      }

      const planResult = planSchema.safeParse(parsed);
      if (!planResult.success) {
        error('Validation errors:', JSON.stringify(planResult.error.issues, null, 2));
        process.exit(1);
      }

      const planData = planResult.data;

      // Check if status needs to be updated from 'pending' to 'in progress'
      if (planData.status === 'pending') {
        planData.status = 'in_progress';
        planData.updatedAt = new Date().toISOString();
        await Bun.write(currentPlanFile, yaml.stringify(planData));
      }

      const pendingTaskInfo = findPendingTask(planData);
      if (!pendingTaskInfo) {
        log('Plan complete!');
        break;
      }

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
          break;
        }
        contextContent = await Bun.file(rmfilterOutputPath).text();
        // Clean up rmfilter output path if needed, or handle in executor
      } else {
        log(boldMarkdownHeaders('\n## Using Direct Prompt as Context\n'));
        contextContent = stepPreparationResult.prompt;
        log(contextContent);
      }

      try {
        log(boldMarkdownHeaders('\n## Execution\n'));
        await executor.execute(contextContent);
      } catch (err) {
        error('Execution step failed:', err);
        hasError = true;
        break;
      }

      // ---> NEW: Execute Post-Apply Commands <---
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
          break;
        }
      }
      // ---> END NEW SECTION <---
      let markResult;
      try {
        log(boldMarkdownHeaders('\n## Marking done\n'));
        markResult = await markStepDone(
          currentPlanFile,
          { steps: 1, commit: true },
          { taskIndex, stepIndex },
          currentBaseDir
        );
        log(`Marked step as done: ${markResult.message.split('\n')[0]}`);
        if (markResult.planComplete) {
          log('Plan fully completed!');
          break;
        }
      } catch (err) {
        error('Failed to mark step as done:', err);
        hasError = true;
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
      error('Agent stopped due to error.');
      process.exit(1);
    }
  } catch (err) {
    error('Unexpected error during agent execution:', err);
    error('Agent stopped due to error.');
    process.exit(1);
  } finally {
    await closeLogFile();
  }
}
