import * as path from 'path';
import yaml from 'yaml';
import { boldMarkdownHeaders, closeLogFile, error, log, openLogFile, warn } from '../logging.ts';
import { getGitRoot, logSpawn } from '../rmfilter/utils.ts';
import {
  executePostApplyCommand,
  findPendingTask,
  markStepDone,
  prepareNextStep,
} from './actions.ts';
import { loadEffectiveConfig } from './configLoader.ts';
import { buildExecutorAndLog } from './executors/index.ts';
import type { ExecutorCommonOptions } from './executors/types.ts';
import { planSchema } from './planSchema.ts';
import { WorkspaceManager } from './workspace_manager.ts';

export async function rmplanAgent(planFile: string, options: any, globalCliOptions: any) {
  const config = await loadEffectiveConfig(globalCliOptions.config);

  const agentExecutionModel = options.model || config.models?.execution;

  let parsed = path.parse(planFile);
  if (parsed.ext === '.md' || parsed.ext === '.' || !parsed.ext) {
    parsed.base = parsed.name + '.yml';
    parsed.ext = 'yml';
    planFile = path.join(parsed.dir, parsed.base);
  }

  if (!options['no-log']) {
    let logFilePath = path.join(parsed.dir, parsed.name + '-agent-output.md');
    openLogFile(logFilePath);
  }

  // Determine the base directory for operations
  let baseDir = await getGitRoot();

  // Handle workspace creation if a task ID is provided
  if (options.workspaceTaskId) {
    log(`Workspace task ID provided: ${options.workspaceTaskId}`);

    const originalPlanFile = path.resolve(planFile);

    // Verify the original plan file exists
    try {
      // Use stat to check if file exists
      try {
        await Bun.file(originalPlanFile).text();
      } catch {
        error(`Original plan file ${originalPlanFile} does not exist or is empty.`);
        process.exit(1);
      }
    } catch (err) {
      error(`Error checking original plan file: ${String(err)}`);
      process.exit(1);
    }

    // Create a workspace using the WorkspaceManager
    const workspaceManager = new WorkspaceManager(baseDir);
    const workspace = await workspaceManager.createWorkspace(
      options.workspaceTaskId,
      originalPlanFile,
      config
    );

    if (workspace) {
      log(boldMarkdownHeaders('\n## Workspace Information'));
      log(`Task ID: ${options.workspaceTaskId}`);
      log(`Workspace Path: ${workspace.path}`);
      log(`Original Plan: ${originalPlanFile}`);

      // Validate that the workspace is properly initialized
      try {
        const gitStatus = await logSpawn(['git', 'status'], {
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
      const workspacePlanFile = path.join(workspace.path, path.basename(planFile));
      try {
        log(`Copying plan file to workspace: ${workspacePlanFile}`);
        await Bun.write(workspacePlanFile, await Bun.file(originalPlanFile).text());

        // Update the planFile to use the copy in the workspace
        planFile = workspacePlanFile;
        log(`Using plan file in workspace: ${planFile}`);
      } catch (err) {
        error(`Failed to copy plan file to workspace: ${String(err)}`);
        error('Continuing with original plan file.');
      }

      // Use the workspace path as the base directory for operations
      baseDir = workspace.path;
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

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir,
    model: agentExecutionModel,
  };
  const executor = buildExecutorAndLog(options.executor, sharedExecutorOptions, config);

  log('Starting agent to execute plan:', planFile);
  try {
    let hasError = false;

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
    let stepCount = 0;
    while (stepCount < maxSteps) {
      stepCount++;

      const fileContent = await Bun.file(planFile).text();
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
      const pendingTaskInfo = findPendingTask(planData);
      if (!pendingTaskInfo) {
        log('Plan complete!');
        break;
      }

      log(
        boldMarkdownHeaders(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, Step ${pendingTaskInfo.stepIndex + 1}...`
        )
      );

      const executorStepOptions = executor.prepareStepOptions?.() ?? {};
      const stepPreparationResult = await prepareNextStep(config, planFile, {
        previous: true,
        ...executorStepOptions,
        model: executorStepOptions.model || agentExecutionModel,
        selectSteps: false,
      }).catch((err) => {
        error('Failed to prepare next step:', err);
        hasError = true;
        return null;
      });

      if (!stepPreparationResult) {
        break;
      }

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
          const commandSucceeded = await executePostApplyCommand(commandConfig);
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
          planFile,
          { steps: 1, commit: true },
          { taskIndex, stepIndex }
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

    await closeLogFile();

    if (hasError) {
      error('Agent stopped due to error.');
      process.exit(1);
    }
  } catch (err) {
    error('Unexpected error during agent execution:', err);
    error('Agent stopped due to error.');
    process.exit(1);
  }
}
