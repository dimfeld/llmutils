import { select } from '@inquirer/prompts';
import os from 'node:os';
import path from 'path';
import yaml from 'yaml';
import { Resolver } from '../dependency_graph/resolve.js';
import { ImportWalker } from '../dependency_graph/walk_imports.js';
import { extractFileReferencesFromInstructions } from '../rmfilter/instructions.js';
import { commitAll, getGitRoot, quiet } from '../rmfilter/utils.js';
import { Extractor } from '../treesitter/extract.js';
import type { PostApplyCommand } from './configSchema.js';
import type { PlanSchema } from './planSchema.js';
import { planSchema } from './planSchema.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { error, log, warn, writeStderr, writeStdout } from '../logging.js';
import { convertMarkdownToYaml, findYamlStart } from './cleanup.js';

interface PrepareNextStepOptions {
  rmfilter?: boolean;
  previous?: boolean;
  withImports?: boolean;
  withAllImports?: boolean;
  selectSteps?: boolean;
  rmfilterArgs?: string[];
  autofind?: boolean;
}

// Interface for the result of finding a pending task
export interface PendingTaskResult {
  taskIndex: number;
  stepIndex: number;
  task: PlanSchema['tasks'][number];
  step: PlanSchema['tasks'][number]['steps'][number];
}

// Finds the next pending task and step in the plan
export function findPendingTask(plan: PlanSchema): PendingTaskResult | null {
  for (let taskIndex = 0; taskIndex < plan.tasks.length; taskIndex++) {
    const task = plan.tasks[taskIndex];
    for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
      const step = task.steps[stepIndex];
      if (!step.done) {
        return { taskIndex, stepIndex, task, step };
      }
    }
  }
  return null;
}

// Prepares the next step(s) from a plan YAML for execution
export async function prepareNextStep(
  planFile: string,
  options: PrepareNextStepOptions = {}
): Promise<{
  prompt: string;
  promptFilePath: string | null;
  taskIndex: number;
  stepIndex: number;
  numStepsSelected: number;
  rmfilterArgs: string[] | undefined;
}> {
  const {
    rmfilter = false,
    previous = false,
    withImports = false,
    withAllImports = false,
    selectSteps = true,
    rmfilterArgs = [],
    autofind = false,
  } = options;

  if (withImports && withAllImports) {
    throw new Error('Cannot use both --with-imports and --with-all-imports. Please choose one.');
  }

  const performImportAnalysis = withImports || withAllImports;

  // 1. Load and parse the plan file
  const fileContent = await Bun.file(planFile).text();
  const parsed = yaml.parse(fileContent);
  const plan = planSchema.safeParse(parsed);
  if (!plan.success) {
    throw new Error('Validation errors: ' + JSON.stringify(plan.error.issues, null, 2));
  }

  const planData = plan.data;
  const result = findPendingTask(planData);
  if (!result) {
    throw new Error('No pending steps found in the plan.');
  }
  const activeTask = result.task;
  // Strip parenthetical comments from filenames (e.g., "file.ts (New File)" -> "file.ts")
  const cleanFiles = activeTask.files.map((file) => file.replace(/\s*\([^)]*\)\s*$/, '').trim());

  const gitRoot = await getGitRoot();
  let files = (
    await Promise.all(
      cleanFiles.map(async (file) => {
        const fullPath = path.resolve(gitRoot, file);
        return (await Bun.file(fullPath).exists()) ? fullPath : null;
      })
    )
  ).filter((x) => x != null);

  // 2. Separate completed and pending steps
  const completedSteps = activeTask.steps.filter((step) => step.done);
  const pendingSteps = activeTask.steps.filter((step) => !step.done);

  if (pendingSteps.length === 0) {
    throw new Error('No pending steps in the current task.');
  }

  // 3. Implement step selection
  let selectedPendingSteps: typeof pendingSteps;
  if (!selectSteps) {
    selectedPendingSteps = [pendingSteps[0]];
  } else if (pendingSteps.length === 1) {
    selectedPendingSteps = [pendingSteps[0]];
    log(
      `Automatically selected the only pending step: [1] ${pendingSteps[0].prompt.split('\n')[0]}...`
    );
  } else {
    const maxWidth = process.stdout.columns - 12;
    const selectedIndex = await select({
      message: 'Run up to which step?',
      choices: pendingSteps.map((step, index) => ({
        name:
          step.prompt.split('\n')[0].length > maxWidth
            ? `[${index + 1}] ${step.prompt.split('\n')[0].slice(0, maxWidth)}...`
            : `[${index + 1}] ${step.prompt.split('\n')[0]}`,
        description: '\n' + step.prompt,
        value: index,
      })),
    });
    selectedPendingSteps = pendingSteps.slice(0, selectedIndex + 1);
  }

  // 4. Perform import analysis
  let candidateFilesForImports: string[] = [];
  if (performImportAnalysis) {
    const prompts = selectedPendingSteps.map((step) => step.prompt).join('\n');
    const { files: filesFromPrompt } = await extractFileReferencesFromInstructions(
      gitRoot,
      prompts
    );

    if (filesFromPrompt.length > 0) {
      // If prompt has files, use them. Assume they are absolute or resolvable from gitRoot.
      // Ensure they are absolute paths.
      candidateFilesForImports = filesFromPrompt.map((f) => path.resolve(gitRoot, f));
      if (!quiet) {
        log(`Using ${candidateFilesForImports.length} files found in prompt for import analysis.`);
      }
    } else {
      // Fallback to task files if prompt has no files.
      candidateFilesForImports = files.map((f) => path.resolve(gitRoot, f));
      if (!quiet) {
        log(
          `No files found in prompt, using ${candidateFilesForImports.length} task files for import analysis.`
        );
      }
    }
    // Filter out any non-existent files just in case
    candidateFilesForImports = (
      await Promise.all(
        candidateFilesForImports.map(async (f) => ((await Bun.file(f).exists()) ? f : null))
      )
    ).filter((f) => f !== null);

    if (!rmfilter) {
      const resolver = await Resolver.new(gitRoot);
      const walker = new ImportWalker(new Extractor(), resolver);
      const expandedFiles = await Promise.all(
        candidateFilesForImports.map(async (file) => {
          const filePath = path.resolve(gitRoot, file);
          const results = new Set<string>();
          try {
            if (withAllImports) {
              await walker.getImportTree(filePath, results);
            } else {
              const definingFiles = await walker.getDefiningFiles(filePath);
              definingFiles.forEach((imp) => results.add(imp));
              results.add(filePath);
            }
          } catch (error) {
            warn(`Warning: Error processing imports for ${filePath}:`, error);
          }
          return Array.from(results);
        })
      );
      files = [...files, ...expandedFiles.flat()];
      files = Array.from(new Set(files)).sort();
    }
  }

  // Autofind relevant files based on task details
  if (autofind) {
    if (!quiet) {
      log('[Autofind] Searching for relevant files based on task details...');
    }
    // Construct a natural language query string
    const queryParts = [
      `Goal: ${planData.goal}`,
      `Details: ${planData.details}`,
      `Task: ${activeTask.title}`,
      `Description: ${activeTask.description}`,
    ].filter((part) => part != null && part.trim() !== '');
    const query = queryParts.join('\n\n');

    // Define the RmfindOptions
    const rmfindOptions: RmfindOptions = {
      baseDir: gitRoot,
      query: query,
      classifierModel: process.env.RMFIND_CLASSIFIER_MODEL || process.env.RMFIND_MODEL,
      grepGeneratorModel: process.env.RMFIND_GREP_GENERATOR_MODEL || process.env.RMFIND_MODEL,
      globs: [], // Look in the base directory
      quiet: quiet,
    };

    try {
      const rmfindResult = await findFilesCore(rmfindOptions);
      if (rmfindResult && rmfindResult.files.length > 0) {
        if (!quiet) {
          log(`[Autofind] Found ${rmfindResult.files.length} potentially relevant files:`);
          rmfindResult.files.forEach((f) => log(`  - ${path.relative(gitRoot, f)}`));
        }
        // Merge and deduplicate found files with existing files
        const combinedFiles = new Set([...files, ...rmfindResult.files]);
        // Update the main 'files' variable with the merged list
        files = Array.from(combinedFiles).sort();
      }
    } catch (error) {
      warn(
        `[Autofind] Warning: Failed to find files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 5. Build the LLM prompt
  const promptParts: string[] = [
    `# Project Goal: ${planData.goal}\n\n## Project Details:\n\n${planData.details}\n`,
    `## Current Task: ${activeTask.title}\n\nDescription: ${activeTask.description}\n`,
  ];
  if (previous && completedSteps.length > 0) {
    promptParts.push('## Completed Subtasks in this Task:');
    completedSteps.forEach((step) => promptParts.push(`- [DONE] ${step.prompt.split('\n')[0]}...`));
  }
  if (!rmfilter) {
    promptParts.push(
      '## Relevant Files\n\nThese are relevant files for the next subtasks. If you think additional files are relevant, you can update them as well.'
    );
    files.forEach((file) => promptParts.push(`- ${path.relative(gitRoot, file)}`));
  }
  promptParts.push('\n## Selected Next Subtasks to Implement:\n');
  // Some models (Gemini Pro 2.5 especially) will infer what the next step is and do it as part of the current step, then get confused when we
  // start the next step and generate a bad diff when they try to make the changes again. This helps to prevent that.
  promptParts.push(
    `**Important**: When thinking about these tasks, consider that some part of them may have already been completed by an overeager engineer implementing the previous step. If you look at a file and it seems like a change has already been done, that is ok; just move on and don't try to make the edit again.\n`
  );
  selectedPendingSteps.forEach((step, index) =>
    promptParts.push(`- [${index + 1}] ${step.prompt}`)
  );
  const llmPrompt = promptParts.join('\n');

  // 6. Handle rmfilter
  let promptFilePath: string | null = null;
  let finalRmfilterArgs: string[] | undefined;
  if (rmfilter) {
    promptFilePath = path.join(
      os.tmpdir(),
      `rmplan-next-prompt-${Date.now()}-${crypto.randomUUID()}.md`
    );
    await Bun.write(promptFilePath, llmPrompt);

    const baseRmfilterArgs = ['--gitroot', '--instructions', `@${promptFilePath}`];
    // Convert the potentially updated 'files' list (task + autofound) to relative paths
    const relativeFiles = files.map((f) => path.relative(gitRoot, f));

    if (performImportAnalysis) {
      // If import analysis is needed, construct the import command block
      const relativeCandidateFiles = candidateFilesForImports.map((f) => path.relative(gitRoot, f));
      const importCommandBlockArgs = ['--', ...relativeCandidateFiles];
      if (withImports) importCommandBlockArgs.push('--with-imports');
      else if (withAllImports) importCommandBlockArgs.push('--with-all-imports');
      // Pass base args, files (task+autofound), import block, separator, user args
      finalRmfilterArgs = [
        ...baseRmfilterArgs,
        ...relativeFiles,
        ...importCommandBlockArgs,
        '--',
        ...rmfilterArgs,
      ];
    } else {
      // Pass base args, files (task+autofound), separator, user args
      finalRmfilterArgs = [...baseRmfilterArgs, ...relativeFiles, '--', ...rmfilterArgs];
    }
  }

  // 7. Return result
  return {
    prompt: llmPrompt,
    promptFilePath,
    taskIndex: result.taskIndex,
    stepIndex: result.stepIndex,
    numStepsSelected: selectedPendingSteps.length,
    rmfilterArgs: finalRmfilterArgs,
  };
}

// Asynchronously marks steps as done in the plan file
export async function markStepDone(
  planFile: string,
  options: { task?: boolean; steps?: number; commit?: boolean },
  currentTask?: { taskIndex: number; stepIndex: number }
): Promise<{ planComplete: boolean; message: string }> {
  // 1. Load and parse the plan file
  const planText = await Bun.file(planFile).text();
  let planData: PlanSchema;
  try {
    planData = yaml.parse(planText);
  } catch (err) {
    throw new Error(`Failed to parse YAML: ${err as Error}`);
  }
  // Validate
  const valid = planSchema.safeParse(planData);
  if (!valid.success) {
    throw new Error(
      'Plan file does not match schema: ' + JSON.stringify(valid.error.issues, null, 2)
    );
  }

  // 2. Find the starting point
  let pending: PendingTaskResult | null = null;
  if (currentTask) {
    const { taskIndex, stepIndex } = currentTask;
    if (
      taskIndex >= 0 &&
      taskIndex < planData.tasks.length &&
      stepIndex >= 0 &&
      stepIndex < planData.tasks[taskIndex].steps.length
    ) {
      pending = {
        taskIndex,
        stepIndex,
        task: planData.tasks[taskIndex],
        step: planData.tasks[taskIndex].steps[stepIndex],
      };
    } else {
      throw new Error('Invalid currentTask indices');
    }
  } else {
    pending = findPendingTask(planData);
  }

  // 3. Handle no pending tasks
  if (!pending) {
    return { planComplete: true, message: 'All steps in the plan are already done.' };
  }

  let output: string[] = [];
  // 4. Mark steps/tasks as done
  const { task } = pending;
  if (options.task) {
    const pendingSteps = task.steps.filter((step) => !step.done);
    for (const step of pendingSteps) {
      step.done = true;
    }
    log('Marked all steps in task done\n');
    output.push(task.title);

    for (let i = 0; i < pendingSteps.length; i++) {
      const step = pendingSteps[i];
      output.push(`\n## Step ${i + 1}]\n\n${step.prompt}`);
    }
  } else {
    const numSteps = options.steps || 1;
    let nowDoneSteps = task.steps.slice(pending.stepIndex, pending.stepIndex + numSteps);
    for (const step of nowDoneSteps) {
      step.done = true;
    }

    log(`Marked ${nowDoneSteps.length} ${nowDoneSteps.length === 1 ? 'step' : 'steps'} done\n`);
    if (nowDoneSteps.length > 1) {
      output.push(
        `${task.title} steps ${pending.stepIndex + 1}-${pending.stepIndex + nowDoneSteps.length}`
      );
    } else if (task.steps.length > 1) {
      output.push(`${task.title} step ${pending.stepIndex + 1}`);
    } else {
      output.push(`${task.title}`);
    }

    if (nowDoneSteps.length > 1) {
      for (const step of nowDoneSteps) {
        output.push(`\n## Step ${task.steps.indexOf(step) + 1}\n\n${step.prompt}`);
      }
    } else {
      output.push(`\n${task.steps[pending.stepIndex].prompt}`);
    }
  }

  // 5. Write updated plan back
  const newPlanText = yaml.stringify(planData);
  await Bun.write(planFile, newPlanText);

  // 6. Optionally commit
  const message = output.join('\n');
  log(message);
  if (options.commit) {
    log('');
    await commitAll(message);
  }

  // 7. Check if plan is now complete
  const stillPending = findPendingTask(planData);
  const planComplete = !stillPending;

  // 8. Return result
  return { planComplete, message };
}

/**
 * Executes a single post-apply command as defined in the configuration.
 * @param commandConfig The configuration object for the command.
 * @returns A promise resolving to `true` if the command succeeded or if failure was allowed,
 *          and `false` if the command failed and failure was not allowed.
 */
export async function executePostApplyCommand(commandConfig: PostApplyCommand): Promise<boolean> {
  let gitRoot: string;
  try {
    gitRoot = await getGitRoot();
    if (!gitRoot) {
      // getGitRoot usually falls back to cwd, but handle defensively
      throw new Error('Could not determine Git repository root.');
    }
  } catch (e) {
    error(
      `e getting Git root for post-apply command: ${e instanceof Error ? e.message : String(e)}`
    );
    return false; // Indicate failure
  }

  const cwd = commandConfig.workingDirectory
    ? path.resolve(gitRoot, commandConfig.workingDirectory)
    : gitRoot;

  const env = {
    ...process.env, // Start with current environment
    ...(commandConfig.env || {}), // Merge/override with command-specific env vars
  };

  log(`\nRunning post-apply command: "${commandConfig.title}"...`);

  // Use sh -c or cmd /c for robust command string execution
  const isWindows = process.platform === 'win32';
  const shellCommand = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';
  const cmdArray = [shellCommand, shellFlag, commandConfig.command];
  const hideOutputOnSuccess = commandConfig.hideOutputOnSuccess;

  // Buffer output if hideOutputOnSuccess is true, otherwise inherit
  const outputBuffers: string[] = [];
  const proc = Bun.spawn(cmdArray, {
    cwd: cwd,
    env: env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  async function readStdout() {
    const stdoutDecoder = new TextDecoder();
    for await (const value of proc.stdout) {
      let output = stdoutDecoder.decode(value, { stream: true });
      if (hideOutputOnSuccess) {
        outputBuffers.push(output);
      } else {
        writeStdout(output);
      }
    }
  }

  async function readStderr() {
    const stderrDecoder = new TextDecoder();
    for await (const value of proc.stderr) {
      let output = stderrDecoder.decode(value, { stream: true });
      if (hideOutputOnSuccess) {
        outputBuffers.push(output);
      } else {
        writeStderr(output);
      }
    }
  }

  await Promise.all([readStdout(), readStderr()]);

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    // If command failed, show buffered output if hideOutputOnSuccess is true
    if (commandConfig.hideOutputOnSuccess) {
      if (outputBuffers.length > 0) {
        log('Command output on failure:');
        outputBuffers.forEach((output) => writeStdout(output));
        writeStdout('\n');
      } else {
        log('Command produced no output on failure.');
      }
    }
    error(`Error: Post-apply command "${commandConfig.title}" failed with exit code ${exitCode}.`);
    if (commandConfig.allowFailure) {
      warn(
        `Warning: Failure of command "${commandConfig.title}" is allowed according to configuration.`
      );
      return true; // Indicate successful handling (failure ignored)
    } else {
      return false; // Indicate failure that should stop the process
    }
  }

  log(`Post-apply command "${commandConfig.title}" completed successfully.`);
  return true; // Indicate success
}

export async function extractMarkdownToYaml(inputText: string, quiet: boolean): Promise<string> {
  let validatedPlan: unknown;
  let convertedYaml: string;

  try {
    // First try to see if it's YAML already.
    let maybeYaml = findYamlStart(inputText);
    const parsedObject = yaml.parse(maybeYaml);
    convertedYaml = yaml.stringify(parsedObject);
  } catch {
    // Print output if not quiet
    const streamToConsole = !quiet;
    const numLines = inputText.split('\n').length;
    if (!quiet) {
      warn(`\n## Converting ${numLines} lines of Markdown to YAML\n`);
    }
    convertedYaml = await convertMarkdownToYaml(inputText, !streamToConsole);
  }

  // Parse and validate the YAML
  try {
    const parsedObject = yaml.parse(convertedYaml);
    const result = planSchema.safeParse(parsedObject);
    if (!result.success) {
      error('Validation errors after LLM conversion:', result.error);
      // Save the failed YAML for debugging
      await Bun.write('rmplan-validation-failure.yml', convertedYaml);
      console.error('Invalid YAML (saved to rmplan-validation-failure.yml):', convertedYaml);
      throw new Error('Validation failed');
    }
    validatedPlan = result.data;
  } catch (e) {
    // Save the failed YAML for debugging
    await Bun.write('rmplan-conversion-failure.yml', convertedYaml);
    error(
      'Failed to parse YAML output from LLM conversion. Saved raw output to rmplan-conversion-failure.yml'
    );
    error('Parsing error:', e);
    throw e;
  }

  return yaml.stringify(validatedPlan);
}
